// The API, with no transport attached.
//
// Both entry points call this: the local Node server (server/index.js) and the
// Netlify Function (netlify/functions/api.mjs). Keeping the routing here means
// the two deployments can't drift — there is only one implementation of what
// /api/publish does.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, catalog, get } from './registry.js';
import { generate, edit, blank } from './generate.js';
import { anyConfigured, providerStatus, resolveProvider, PROVIDERS } from './llm.js';
import * as credits from './credits.js';
import * as payments from './payments.js';
import { allPromos } from './promos.js';
import { validate, defaultsFor } from '../shared/schema.js';
import { checkLevel } from '../shared/levelcheck.js';
import { buildBundle, bundleFiles } from './bundle.js';
import { defaultPage } from '../arcade/render.js';
import * as store from './store.js';
import * as storage from './storage.js';
import * as netlify from './netlify.js';
import * as dns from './dns.js';

const arcadeSchema = JSON.parse(readFileSync(join(ROOT, 'arcade', 'schema.json'), 'utf8'));

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
};
export const mimeFor = (path) => MIME[path.split('.').pop()?.toLowerCase()] ?? 'application/octet-stream';

const ok = (body) => ({ status: 200, body });
const bad = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

const TIERS = new Set(['fast', 'best']);
const pickTier = (raw) => (TIERS.has(raw) ? raw : 'fast');

/**
 * @param req { method, pathname, searchParams, body }
 * @returns { status, body }  — body is JSON-serialisable
 */
export async function handleApi(req) {
  const {
    method, pathname, searchParams = new URLSearchParams(), body = {},
    token = null, ip = null, origin = '', rawBody = '', headers = {},
  } = req;

  if (pathname === '/api/health') {
    const status = providerStatus();
    return ok({
      ok: true,
      ai: anyConfigured(),
      ...status,
      model: anyConfigured() ? PROVIDERS[resolveProvider('fast')].defaultModel : null,
      payments: payments.hasStripe(),
      paymentsTestMode: payments.hasStripe() ? payments.isTestMode() : null,
      packs: payments.packList(),
      freeOnArrival: credits.FREE_ON_ARRIVAL,
      netlify: netlify.hasToken(),
      storage: storage.backendName(),
      rootDomain: process.env.RUMPUS_ROOT_DOMAIN ?? null,
      templates: catalog().length,
    });
  }

  if (pathname === '/api/templates') return ok({ templates: catalog(), ai: anyConfigured() });

  // ── credits ───────────────────────────────────────────────────────────────

  if (pathname === '/api/account') {
    // Generation is free and local when no provider is configured, so don't
    // mint accounts or spend anything nobody needs.
    if (!anyConfigured()) return ok({ metered: false, reason: 'offline generator' });
    const { account, created, overCap } = await credits.ensureAccount(token, { ip });
    return ok({ metered: true, created, overCap: Boolean(overCap), ...credits.publicView(account) });
  }

  if (pathname === '/api/promo' && method === 'POST') {
    if (!anyConfigured()) return bad(400, 'Nothing to spend credits on — this deployment runs the offline generator.');
    const { account } = await credits.ensureAccount(token, { ip });
    const result = await credits.redeem(account, body.code);
    if (!result.ok) return bad(400, result.error, { ...credits.publicView(account) });
    return ok({
      granted: result.granted,
      capped: result.capped,
      note: result.note,
      ...credits.publicView(result.account),
    });
  }

  if (pathname === '/api/checkout' && method === 'POST') {
    if (!payments.hasStripe()) return bad(503, 'Payments are not configured on this deployment.');
    const { account } = await credits.ensureAccount(token, { ip });
    try {
      const session = await payments.createCheckout({
        pack: body.pack,
        token: account.token,
        origin: origin || 'http://localhost:4173',
      });
      return ok({ url: session.url, token: account.token });
    } catch (err) {
      return bad(400, String(err.message ?? err));
    }
  }

  // Stripe posts here. The signature is the only thing making this safe, so a
  // deployment without the secret refuses rather than trusting the body.
  if (pathname === '/api/stripe-webhook' && method === 'POST') {
    const sig = headers['stripe-signature'] ?? headers['Stripe-Signature'];
    const verified = payments.verifyWebhook(rawBody, sig);
    if (!verified.ok) return bad(400, verified.error);

    const grant = payments.creditsFromEvent(verified.event);
    if (!grant) return ok({ ignored: true });

    const account = await credits.getAccount(grant.token);
    if (!account) return ok({ ignored: true, reason: 'unknown token' });
    // Stripe retries webhooks; granting twice for one payment would be a gift.
    if ((account.purchases ?? []).some((p) => p.reason === grant.sessionId)) {
      return ok({ duplicate: true });
    }
    await credits.grantPaid(account, grant.credits, grant.sessionId);
    return ok({ granted: grant.credits });
  }

  if (pathname === '/api/template') {
    const t = get(searchParams.get('id'));
    return t ? ok(blank(t.id)) : bad(404, 'unknown template');
  }

  if (pathname === '/api/arcade-schema') return ok(arcadeSchema);

  if (pathname === '/api/generate' && method === 'POST') {
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return bad(400, 'Say what kind of game you want.');
    if (prompt.length > 2000) return bad(400, 'That idea is too long — trim it to a couple of sentences.');

    const charge = await beginCharge({ token, ip, tier: body.tier });
    if (charge.error) return charge.error;
    const game = await generate(prompt, body.template ?? null, { tier: charge.tier });
    return ok({ ...game, account: await settle(charge, game) });
  }

  if (pathname === '/api/edit' && method === 'POST') {
    if (!body.templateId || !body.config || !body.instruction) {
      return bad(400, 'edit needs templateId, config and instruction');
    }
    const charge = await beginCharge({ token, ip, tier: body.tier });
    if (charge.error) return charge.error;
    const result = await edit({
      templateId: body.templateId,
      config: body.config,
      instruction: String(body.instruction).slice(0, 1000),
      title: body.title,
      tier: charge.tier,
    });
    return ok({ ...result, account: await settle(charge, result) });
  }

  // Re-validate a config the client changed directly (the form UI path).
  if (pathname === '/api/validate' && method === 'POST') {
    const t = get(body.templateId);
    if (!t) return bad(400, 'unknown template');
    const result = validate(body.config, t.schema);
    const level = t.schema.reachability ? checkLevel(t.schema, result.config) : { ok: true, reasons: [] };
    return ok({
      ok: result.ok && level.ok,
      config: result.config,
      errors: result.errors,
      clamps: result.clamps,
      reachability: level.reasons,
    });
  }

  if (pathname === '/api/publish' && method === 'POST') {
    const game = body.game;
    if (!game?.template_id || !game?.config) return bad(400, 'publish needs a generated game');
    const t = get(game.template_id);
    if (!t) return bad(400, 'unknown template');

    // Never publish a config that hasn't been through validation, whatever the
    // client says. The published bundle is the artifact people share.
    game.config = validate(game.config, t.schema).config;

    const existing = body.id ? await store.getGame(body.id) : null;
    const id = existing ? body.id : store.newId();
    const slug = await store.allocateSlug(game.title, id);
    const page = body.page ?? defaultPage(game, defaultsFor(arcadeSchema.config));

    const { files } = buildBundle({ game, page });
    await storage.writeBundle(slug, files);

    let deployed = null;
    let deployError = null;
    if (netlify.hasToken() && body.deploy !== false) {
      try {
        deployed = await netlify.deploy({
          files: bundleFiles(files),
          siteId: existing?.deploy?.siteId,
          name: `rumpus-${slug}`,
        });
      } catch (err) {
        deployError = String(err.message ?? err);
      }
    }

    const saved = await store.put({
      id, slug,
      title: game.title,
      description: game.description,
      template_id: game.template_id,
      template_version: game.template_version,
      config: game.config,
      page,
      deploy: deployed ? { provider: 'netlify', ...deployed } : existing?.deploy ?? null,
    });

    return ok({
      id, slug,
      localUrl: `/p/${slug}/`,
      liveUrl: deployed?.url ?? null,
      subdomainUrl: store.publicUrl(slug),
      deployError,
      deployAvailable: netlify.hasToken(),
      files: Object.keys(files).length,
      page,
      game: saved,
    });
  }

  if (pathname === '/api/games') {
    const games = await store.list();
    return ok({ games: games.map(({ config, page, ...g }) => g) });
  }

  if (pathname === '/api/domain/instructions' && method === 'POST') {
    const v = dns.validateDomain(body.domain);
    if (!v.ok) return bad(400, v.error);
    const game = body.id ? await store.getGame(body.id) : null;
    const target = game?.deploy?.url?.replace(/^https?:\/\//, '') ?? `${game?.slug ?? 'your-game'}.netlify.app`;
    return ok(dns.instructionsFor(v.domain, target));
  }

  if (pathname === '/api/domain/verify' && method === 'POST') {
    const v = dns.validateDomain(body.domain);
    if (!v.ok) return bad(400, v.error);
    const game = body.id ? await store.getGame(body.id) : null;
    const target = body.target ?? game?.deploy?.url?.replace(/^https?:\/\//, '');
    if (!target) return bad(400, 'Publish the game first — there is nothing to point the domain at yet.');

    const result = await dns.verify(v.domain, target);
    let attached = null;
    if (result.state === 'verified' && game?.deploy?.siteId && netlify.hasToken()) {
      try {
        await netlify.attachDomain({ siteId: game.deploy.siteId, domain: v.domain });
        attached = true;
        await store.put({ ...game, customDomain: v.domain });
      } catch (err) {
        attached = String(err.message ?? err);
      }
    }
    return ok({ ...result, attached });
  }

  return bad(404, 'no such endpoint');
}

/**
 * Take payment before calling a model, since that's the only way to stop a
 * request that's already in flight.
 */
async function beginCharge({ token, ip, tier: rawTier }) {
  const tier = pickTier(rawTier);
  // Nothing to meter when there's no provider: the offline generator is local
  // and free, and charging for it would be a lie.
  if (!anyConfigured()) return { metered: false, tier };

  const { account } = await credits.ensureAccount(token, { ip });
  const plan = credits.affords(account, tier);
  if (!plan.ok) {
    const needsPaid = tier === 'best' && account.free > 0;
    return {
      error: {
        status: 402,
        body: {
          error: needsPaid
            ? 'Best-quality runs need paid credits. Free and promo credits cover the fast model.'
            : "You're out of credits. Redeem a code or grab a pack to keep going.",
          outOfCredits: true,
          needsPaid,
          ...credits.publicView(account),
        },
      },
    };
  }
  const spent = await credits.spend(account, tier);
  return { metered: true, tier, account: spent.account, from: spent.from, cost: spent.cost };
}

/** Refund anything the model failed to deliver, and report the new balance. */
async function settle(charge, result) {
  if (!charge.metered) return { metered: false };
  const producedNothing = result?.unavailable || (result?.source === 'offline' && result?.notes?.degraded);
  if (producedNothing) {
    await credits.refund(charge.account, charge.from, charge.cost);
  }
  return { metered: true, refunded: Boolean(producedNothing), ...credits.publicView(charge.account) };
}

/** Serve one file out of a published bundle. */
export async function serveBundleFile(slug, rest) {
  const rel = !rest || rest === '/' ? 'index.html' : rest.replace(/^\/+/, '');
  if (rel.includes('..')) return { status: 400, contentType: MIME.txt, body: 'bad path' };
  const contents = await storage.readBundleFile(slug, rel);
  if (contents == null) return { status: 404, contentType: MIME.txt, body: 'not published yet' };
  return { status: 200, contentType: mimeFor(rel), body: contents };
}
