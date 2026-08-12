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
import { hasKey, MODEL } from './anthropic.js';
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
const bad = (status, error) => ({ status, body: { error } });

/**
 * @param req { method, pathname, searchParams, body }
 * @returns { status, body }  — body is JSON-serialisable
 */
export async function handleApi(req) {
  const { method, pathname, searchParams = new URLSearchParams(), body = {} } = req;

  if (pathname === '/api/health') {
    return ok({
      ok: true,
      model: hasKey() ? MODEL : null,
      ai: hasKey(),
      netlify: netlify.hasToken(),
      storage: storage.backendName(),
      rootDomain: process.env.RUMPUS_ROOT_DOMAIN ?? null,
      templates: catalog().length,
    });
  }

  if (pathname === '/api/templates') return ok({ templates: catalog(), ai: hasKey() });

  if (pathname === '/api/template') {
    const t = get(searchParams.get('id'));
    return t ? ok(blank(t.id)) : bad(404, 'unknown template');
  }

  if (pathname === '/api/arcade-schema') return ok(arcadeSchema);

  if (pathname === '/api/generate' && method === 'POST') {
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return bad(400, 'Say what kind of game you want.');
    if (prompt.length > 2000) return bad(400, 'That idea is too long — trim it to a couple of sentences.');
    return ok(await generate(prompt, body.template ?? null));
  }

  if (pathname === '/api/edit' && method === 'POST') {
    if (!body.templateId || !body.config || !body.instruction) {
      return bad(400, 'edit needs templateId, config and instruction');
    }
    return ok(await edit({
      templateId: body.templateId,
      config: body.config,
      instruction: String(body.instruction).slice(0, 1000),
      title: body.title,
    }));
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

/** Serve one file out of a published bundle. */
export async function serveBundleFile(slug, rest) {
  const rel = !rest || rest === '/' ? 'index.html' : rest.replace(/^\/+/, '');
  if (rel.includes('..')) return { status: 400, contentType: MIME.txt, body: 'bad path' };
  const contents = await storage.readBundleFile(slug, rel);
  if (contents == null) return { status: 404, contentType: MIME.txt, body: 'not published yet' };
  return { status: 200, contentType: mimeFor(rel), body: contents };
}
