// Credits, promo codes, tiers and payments.
//
// Everything here is real except the two networks it can't reach: the model
// provider and Stripe, both of which are mocked at their HTTP boundary. What's
// under test is the part that decides who gets to spend what — the logic that,
// if wrong, either gives the product away or charges someone twice.
//
// Run on its own (it sets env vars): node --test test/billing.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 4198;
const WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';

process.env.GROQ_API_KEY = 'gsk_test_not_real';
process.env.GROQ_BASE_URL = `http://127.0.0.1:${PORT}/groq`;
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PORT}/anthropic`;
process.env.STRIPE_SECRET_KEY = 'sk_test_not_real';
process.env.STRIPE_BASE_URL = `http://127.0.0.1:${PORT}/stripe`;
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ROMP_FREE_CREDITS = '3';
process.env.ROMP_PROMOS = 'TESTCODE:5:2:2099-01-01,TINY:1:1';

const { ROOT, exampleConfig } = await import('../server/registry.js');
// Each run starts from an empty ledger; these are files on disk locally.
rmSync(join(ROOT, 'data'), { recursive: true, force: true });

const { handleApi } = await import('../server/api.js');
const credits = await import('../server/credits.js');
const payments = await import('../server/payments.js');

// ── mock upstreams ─────────────────────────────────────────────────────

let seen = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  seen.push({ url: req.url, body });

  const send = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.url.startsWith('/stripe')) {
    return send({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' });
  }
  const config = exampleConfig('platformer-classic');
  const payload = JSON.stringify({ title: 'Test Game', description: 'A test.', config });
  if (req.url.startsWith('/groq')) {
    // OpenAI shape.
    return send({ choices: [{ message: { content: payload } }] });
  }
  // Anthropic shape.
  return send({ content: [{ type: 'text', text: payload }] });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
test.after(() => server.close());

const call = (pathname, { method = 'GET', body = {}, token, ip = '1.2.3.4', rawBody, headers = {} } = {}) =>
  handleApi({ method, pathname, searchParams: new URLSearchParams(), body, token, ip, rawBody, headers, origin: 'https://romp.test' });

const newVisitor = async (ip = '1.2.3.4') => {
  const res = await call('/api/account', { ip });
  return res.body.token;
};

// ── free credits ───────────────────────────────────────────────────────

test('a new visitor gets the arrival grant, as free credits only', async () => {
  const res = await call('/api/account', { ip: '10.0.0.1' });
  assert.equal(res.body.metered, true);
  assert.equal(res.body.free, 3);
  assert.equal(res.body.paid, 0);
  assert.ok(res.body.token?.startsWith('r_'));
});

test('the same token keeps its balance across requests', async () => {
  const token = await newVisitor('10.0.0.2');
  const again = await call('/api/account', { token, ip: '10.0.0.2' });
  assert.equal(again.body.token, token);
  assert.equal(again.body.created, false);
});

test('generating spends exactly one free credit', async () => {
  const token = await newVisitor('10.0.0.3');
  const res = await call('/api/generate', { method: 'POST', token, body: { prompt: 'a cat game' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.account.free, 2, 'should have spent one');
  assert.equal(res.body.account.paid, 0);
});

test('running out of credits returns 402 rather than a free generation', async () => {
  const token = await newVisitor('10.0.0.4');
  for (let i = 0; i < 3; i++) {
    const ok = await call('/api/generate', { method: 'POST', token, body: { prompt: 'game' } });
    assert.equal(ok.status, 200, `run ${i + 1} should have been affordable`);
  }
  const broke = await call('/api/generate', { method: 'POST', token, body: { prompt: 'game' } });
  assert.equal(broke.status, 402);
  assert.equal(broke.body.outOfCredits, true);
  assert.equal(broke.body.free, 0);
});

// ── the cheap-tier restriction ──────────────────────────────────────────

test('free credits cannot buy the expensive tier', async () => {
  // This is the whole point of splitting the balances: a launch code hands out
  // spending power on the cheap provider and nothing else.
  const token = await newVisitor('10.0.0.5');
  const res = await call('/api/generate', { method: 'POST', token, body: { prompt: 'game', tier: 'best' } });
  assert.equal(res.status, 402);
  assert.equal(res.body.needsPaid, true);
  assert.match(res.body.error, /paid credits/i);
  assert.equal(res.body.free, 3, 'nothing should have been deducted');
});

test('paid credits do buy the expensive tier', async () => {
  const token = await newVisitor('10.0.0.6');
  const account = await credits.getAccount(token);
  await credits.grantPaid(account, 10, 'test');

  seen = [];
  const res = await call('/api/generate', { method: 'POST', token, body: { prompt: 'game', tier: 'best' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.account.paid, 8, 'best costs 2 paid credits');
  assert.equal(res.body.account.free, 3, 'free balance untouched');
  assert.ok(seen.some((r) => r.url.startsWith('/anthropic')), 'best tier should have called Claude');
});

test('the fast tier routes to Groq when it is configured', async () => {
  const token = await newVisitor('10.0.0.7');
  seen = [];
  const res = await call('/api/generate', { method: 'POST', token, body: { prompt: 'game', tier: 'fast' } });
  assert.equal(res.status, 200);
  assert.ok(seen.some((r) => r.url.startsWith('/groq')), 'fast tier should have called Groq');
  assert.equal(res.body.provider, 'groq');
});

test('an unknown tier falls back to fast rather than being trusted', async () => {
  const token = await newVisitor('10.0.0.8');
  const res = await call('/api/generate', { method: 'POST', token, body: { prompt: 'game', tier: 'free-for-me' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.account.free, 2, 'should have charged the fast price from free');
});

// ── promo codes ────────────────────────────────────────────────────────

test('a promo code adds free credits, once per visitor', async () => {
  const token = await newVisitor('10.0.1.1');
  const first = await call('/api/promo', { method: 'POST', token, body: { code: 'testcode' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.granted, 5);
  assert.equal(first.body.free, 8);

  const again = await call('/api/promo', { method: 'POST', token, body: { code: 'TESTCODE' } });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already used/i);
  assert.equal(again.body.free, 8, 'a rejected redeem must not change the balance');
});

test('promo credits are free credits, so they still cannot buy the best tier', async () => {
  const token = await newVisitor('10.0.1.2');
  await call('/api/promo', { method: 'POST', token, body: { code: 'TESTCODE' } });
  const res = await call('/api/generate', { method: 'POST', token, body: { prompt: 'game', tier: 'best' } });
  assert.equal(res.status, 402, 'promo credits must not unlock the expensive model');
});

test('a code stops working once it is fully claimed', async () => {
  // TINY has exactly one redemption.
  const first = await call('/api/promo', { method: 'POST', token: await newVisitor('10.0.1.3'), body: { code: 'TINY' } });
  assert.equal(first.status, 200);
  const second = await call('/api/promo', { method: 'POST', token: await newVisitor('10.0.1.4'), body: { code: 'TINY' } });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /fully claimed/i);
});

test('unknown and expired codes are refused', async () => {
  const token = await newVisitor('10.0.1.5');
  const unknown = await call('/api/promo', { method: 'POST', token, body: { code: 'NOPE' } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /doesn't exist/i);

  const { findPromo, isExpired } = await import('../server/promos.js');
  assert.equal(isExpired({ expires: '2000-01-01' }), true);
  assert.equal(isExpired({ expires: '2099-01-01' }), false);
  assert.ok(findPromo('producthunt'), 'the launch code should exist by default');
});

test('the launch codes grant a modest amount on the cheap tier', async () => {
  const { allPromos } = await import('../server/promos.js');
  for (const promo of allPromos()) {
    assert.ok(promo.credits <= 50, `${promo.code} grants ${promo.credits} — too generous for a launch code`);
    assert.ok(promo.maxRedemptions > 0, `${promo.code} has no redemption limit`);
  }
});

// ── payments ──────────────────────────────────────────────────────────

test('checkout creates a Stripe session carrying the visitor token', async () => {
  const token = await newVisitor('10.0.2.1');
  seen = [];
  const res = await call('/api/checkout', { method: 'POST', token, body: { pack: 'small' } });
  assert.equal(res.status, 200);
  assert.match(res.body.url, /checkout\.stripe\.com/);

  const sent = seen.find((r) => r.url.startsWith('/stripe'));
  assert.ok(sent, 'no request reached Stripe');
  assert.match(sent.body, /metadata%5Bromp_token%5D=r_/, 'token must ride along or the webhook cannot credit anyone');
  assert.match(sent.body, /unit_amount%5D=500/, "the small pack must charge $5.00");
});

test('an unknown pack is refused', async () => {
  const token = await newVisitor('10.0.2.2');
  const res = await call('/api/checkout', { method: 'POST', token, body: { pack: 'free-money' } });
  assert.equal(res.status, 400);
});

const signedWebhook = (event, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) => {
  const raw = JSON.stringify(event);
  const sig = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return { raw, header: `t=${timestamp},v1=${sig}` };
};

const paidEvent = (token, credits = 100, sessionId = 'cs_test_abc') => ({
  type: 'checkout.session.completed',
  data: { object: { id: sessionId, payment_status: 'paid', metadata: { romp_token: token, credits } } },
});

test('a signed webhook grants paid credits', async () => {
  const token = await newVisitor('10.0.2.3');
  const { raw, header } = signedWebhook(paidEvent(token, 100));
  const res = await call('/api/stripe-webhook', {
    method: 'POST', rawBody: raw, headers: { 'stripe-signature': header },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.granted, 100);
  assert.equal((await credits.getAccount(token)).paid, 100);
});

test('an unsigned or wrongly-signed webhook grants nothing', async () => {
  const token = await newVisitor('10.0.2.4');
  const { raw, header } = signedWebhook(paidEvent(token, 500), 'whsec_the_wrong_secret');

  const forged = await call('/api/stripe-webhook', {
    method: 'POST', rawBody: raw, headers: { 'stripe-signature': header },
  });
  assert.equal(forged.status, 400);

  const bare = await call('/api/stripe-webhook', { method: 'POST', rawBody: raw, headers: {} });
  assert.equal(bare.status, 400);

  assert.equal((await credits.getAccount(token)).paid, 0, 'credits were granted without a valid signature');
});

test('a replayed old signature is refused even though it is genuine', async () => {
  const token = await newVisitor('10.0.2.5');
  const stale = Math.floor(Date.now() / 1000) - 3600;
  const { raw, header } = signedWebhook(paidEvent(token, 500), WEBHOOK_SECRET, stale);
  const res = await call('/api/stripe-webhook', {
    method: 'POST', rawBody: raw, headers: { 'stripe-signature': header },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /tolerance/);
});

test('Stripe retrying the same event does not grant twice', async () => {
  const token = await newVisitor('10.0.2.6');
  const event = paidEvent(token, 100, 'cs_test_retry');
  for (const _ of [1, 2, 3]) {
    const { raw, header } = signedWebhook(event);
    await call('/api/stripe-webhook', { method: 'POST', rawBody: raw, headers: { 'stripe-signature': header } });
  }
  assert.equal((await credits.getAccount(token)).paid, 100, 'a retried webhook double-credited');
});

test('an unpaid session grants nothing', async () => {
  const token = await newVisitor('10.0.2.7');
  const event = {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_unpaid', payment_status: 'unpaid', metadata: { romp_token: token, credits: 999 } } },
  };
  const { raw, header } = signedWebhook(event);
  const res = await call('/api/stripe-webhook', { method: 'POST', rawBody: raw, headers: { 'stripe-signature': header } });
  assert.equal(res.body.ignored, true);
  assert.equal((await credits.getAccount(token)).paid, 0);
});

test('packs are priced in whole cents and describe themselves', () => {
  for (const pack of payments.packList()) {
    assert.ok(Number.isInteger(pack.cents) && pack.cents > 0, `${pack.id} has a bad price`);
    assert.ok(pack.credits > 0);
    assert.match(pack.price, /^\$\d+\.\d{2}$/);
  }
});

// ── the free-forever path ───────────────────────────────────────────────

test('with no provider configured nothing is metered and nothing is charged', async () => {
  const groq = process.env.GROQ_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const account = await call('/api/account');
    assert.equal(account.body.metered, false);

    const res = await call('/api/generate', { method: 'POST', body: { prompt: 'a cat ninja in a forest' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'offline');
    assert.equal(res.body.account.metered, false, 'the offline generator must never charge');
  } finally {
    process.env.GROQ_API_KEY = groq;
    process.env.ANTHROPIC_API_KEY = anthropic;
  }
});

// ── regressions: ways a visitor could be charged unfairly ───────────────────

test('"best" is not charged at a premium when it resolves to the same model', async () => {
  // With only one provider configured, "best" and "fast" are the same model.
  // Charging double for identical output is taking money for nothing.
  const anthropic = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const { effectiveTier } = await import('../server/llm.js');
    assert.equal(effectiveTier('best'), 'fast', 'best should downgrade when it is not actually better');

    const token = await newVisitor('10.0.3.1');
    const account = await credits.getAccount(token);
    await credits.grantPaid(account, 10, 'test');

    const res = await call('/api/generate', { method: 'POST', token, body: { prompt: 'game', tier: 'best' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.account.free, 2, 'should have charged one FREE credit, at the fast price');
    assert.equal(res.body.account.paid, 10, 'paid credits should be untouched');
  } finally {
    process.env.ANTHROPIC_API_KEY = anthropic;
  }
});

test('"best" is still charged at a premium when it really is a different model', async () => {
  const { effectiveTier } = await import('../server/llm.js');
  assert.equal(effectiveTier('best'), 'best', 'both providers are configured here');
});

test('a crash after charging refunds the credit', async () => {
  // The model call is already paid for by the time it runs, so anything that
  // throws past that point has taken money and delivered nothing.
  const token = await newVisitor('10.0.3.2');
  const before = (await credits.getAccount(token)).free;

  const generate = await import('../server/generate.js');
  const original = generate.generate;
  const api = await import('../server/api.js');

  // Force a non-ModelError failure by handing publish-shaped garbage to edit,
  // which throws on an unknown template before any fallback can catch it.
  await assert.rejects(
    () => api.handleApi({
      method: 'POST',
      pathname: '/api/edit',
      searchParams: new URLSearchParams(),
      token,
      ip: '10.0.3.2',
      body: { templateId: 'no-such-template', config: {}, instruction: 'go' },
    }),
    /unknown template/
  );

  assert.equal((await credits.getAccount(token)).free, before, 'the credit was not refunded after a crash');
  assert.equal(original, generate.generate, 'sanity: module not mutated');
});

test('nothing a visitor publishes contains their credit token', async () => {
  // /api/generate returns the caller's balance and token, and the editor sends
  // that whole object straight back to /api/publish. store.put currently copies
  // an explicit field list so none of it is retained — this pins that, because
  // the day someone "simplifies" it to a spread is the day tokens start
  // appearing in published bundles.
  const token = await newVisitor('10.0.3.3');
  const gen = await call('/api/generate', { method: 'POST', token, body: { prompt: 'a cat game' } });
  assert.ok(gen.body.account?.token, 'precondition: generate returns the token');

  const pub = await call('/api/publish', { method: 'POST', token, body: { game: gen.body } });
  assert.equal(pub.status, 200);
  assert.ok(!JSON.stringify(pub.body.game).includes(token), 'the visitor token was stored with the game');

  // And the artifact people actually share.
  const { readBundleFile } = await import('../server/storage.js');
  for (const file of ['index.html', 'game.html', 'romp.json']) {
    const contents = await readBundleFile(pub.body.slug, file);
    assert.ok(contents, `bundle is missing ${file}`);
    assert.ok(!contents.includes(token), `${file} in the published bundle contains the visitor token`);
  }
});
