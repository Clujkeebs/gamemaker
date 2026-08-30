// Exercises the AI pipeline against a mock Claude endpoint.
//
// Everything here is real except the model itself: the classifier call, the
// per-template schema injection, JSON extraction, validation, the repair retry,
// the reachability pass, template_switch_required, and each fallback. What it
// deliberately does not test is answer quality — that needs the real model.
//
// Run on its own (it sets env vars): node --test test/pipeline.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const PORT = 4199;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PORT}`;

// Imported after the env is set, since the module reads it at load time.
const { generate, edit } = await import('../server/generate.js');
const { templates, exampleConfig } = await import('../server/registry.js');
const { validate } = await import('../shared/schema.js');

/** Queue of canned replies; each request pops the next one. */
let queue = [];
let seen = [];

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  seen.push(body);

  const next = queue.shift();
  if (!next) return res.writeHead(500).end('{"error":"no canned response left"}');
  if (next.status && next.status !== 200) return res.writeHead(next.status).end(next.text ?? 'boom');

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ content: [{ type: 'text', text: next.text }] }));
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
test.after(() => server.close());

const reset = (...replies) => { queue = [...replies]; seen = []; };
const reply = (text) => ({ text });
const classifierSays = (id) => reply(JSON.stringify({ template_id: id, secondary: null, why: 'test' }));
const configSays = (config, extra = {}) =>
  reply(JSON.stringify({ title: 'Test Game', description: 'A game for a test.', config, ...extra }));

const goodConfig = (id) => structuredClone(exampleConfig(id));

// ── happy path ──────────────────────────────────────────────────────────────

test('a clean model response becomes a validated game in two calls', async () => {
  // Deliberately vague: a prompt that named its genre would skip the classifier
  // call and this would silently stop testing the two-call path.
  reset(classifierSays('breakout-clone'), configSays(goodConfig('breakout-clone')));
  const game = await generate('make me something fun');

  assert.equal(game.source, 'model');
  assert.equal(game.template_id, 'breakout-clone');
  assert.equal(game.title, 'Test Game');
  assert.equal(game.notes.errors.length, 0);
  assert.equal(seen.length, 2, 'expected exactly one classify call and one config call');

  // Only the chosen template's schema is sent — not all four.
  const configSystem = seen[1].system;
  assert.ok(configSystem.includes('breakout-clone'), 'config pass did not receive its own schema');
  for (const other of ['platformer-classic', 'top-down-shooter', 'top-down-collector']) {
    assert.ok(!configSystem.includes(other), `config pass leaked the ${other} schema into context`);
  }
});

test('the classifier prompt lists every installed template', async () => {
  reset(classifierSays('platformer-classic'), configSays(goodConfig('platformer-classic')));
  await generate('jump around');
  for (const id of templates.keys()) {
    assert.ok(seen[0].system.includes(id), `classifier prompt is missing ${id}`);
  }
});

// ── the model gets things wrong ─────────────────────────────────────────────

test('out-of-range values are clamped and surfaced rather than rejected', async () => {
  const cfg = goodConfig('platformer-classic');
  cfg.physics.gravity = 9000;
  reset(classifierSays('platformer-classic'), configSays(cfg));

  const game = await generate('a very heavy game');
  assert.equal(game.source, 'model');
  assert.equal(game.config.physics.gravity, 1600);
  assert.equal(game.notes.clamps.length, 1);
  assert.equal(seen.length, 2, 'a clamp must not trigger a repair retry');
});

test('invented keys trigger exactly one repair retry, and the fix is used', async () => {
  const broken = goodConfig('platformer-classic');
  broken.physics.anti_gravity = true;
  reset(classifierSays('platformer-classic'), configSays(broken), configSays(goodConfig('platformer-classic')));

  const game = await generate('a game');
  assert.equal(game.source, 'model');
  assert.equal(game.notes.errors.length, 0, 'the repaired config should be clean');
  assert.equal(seen.length, 3, 'expected classify + config + one repair');

  // The repair turn must actually tell the model what was wrong.
  const repairTurn = seen[2].messages.at(-1).content;
  assert.ok(repairTurn.includes('anti_gravity'), `repair prompt did not name the bad key: ${repairTurn}`);
});

test('a model that fails twice falls back to the offline generator', async () => {
  reset(classifierSays('platformer-classic'), reply('I cannot do that.'), reply('Still no.'));
  const game = await generate('a cat ninja in a bamboo forest');
  assert.equal(game.source, 'offline');
  assert.match(game.notes.degraded, /did not return a usable config/);
});

test('malformed JSON is still parsed when the model wraps it in prose', async () => {
  const cfg = goodConfig('top-down-shooter');
  reset(
    reply('Sure! ```json\n' + JSON.stringify({ template_id: 'top-down-shooter', why: 'x' }) + '\n```'),
    reply('Here is the config:\n```json\n' + JSON.stringify({ title: 'T', description: 'D', config: cfg }) + '\n```\nEnjoy!')
  );
  const game = await generate('shoot things');
  assert.equal(game.source, 'model');
  assert.equal(game.template_id, 'top-down-shooter');
});

test('an unknown template from the classifier falls back to keyword matching', async () => {
  reset(reply('{"template_id":"3d-shooter-deluxe"}'), configSays(goodConfig('breakout-clone')));
  const game = await generate('make me something with a paddle in it');
  assert.equal(game.template_id, 'breakout-clone', 'should have keyword-matched instead of failing');
});

test('an API error degrades to offline instead of failing the request', async () => {
  reset({ status: 500, text: 'upstream exploded' });
  const game = await generate('a cat ninja in a bamboo forest');
  assert.equal(game.source, 'offline');
  assert.match(game.notes.degraded, /500/);
});

// ── unwinnable output ───────────────────────────────────────────────────────

test('an unwinnable generated level is detected and repaired before it renders', async () => {
  const cfg = goodConfig('top-down-collector');
  cfg.rules.win = 'reachGoal';
  cfg.rules.goalNeedsAll = false;
  cfg.level.grid = [
    '##########',
    '#P.....#G#',
    '#......#.#',
    '#......#.#',
    '#......#.#',
    '##########',
  ];
  reset(configSays(cfg)); // 'escape the maze' names its genre, so no classify call

  const game = await generate('escape the maze');
  assert.equal(game.notes.repaired, true, 'a sealed goal should have been carved open');
  const t = templates.get('top-down-collector');
  const { checkLevel } = await import('../shared/levelcheck.js');
  assert.ok(checkLevel(t.schema, game.config).ok, 'still unwinnable after repair');
});

// ── editing ─────────────────────────────────────────────────────────────────

test('an edit returns the full updated config plus a changelog note', async () => {
  const cfg = goodConfig('platformer-classic');
  cfg.physics.moveSpeed = 160;
  reset(configSays(cfg, { changelog_note: 'Sped the player up.' }));

  const result = await edit({
    templateId: 'platformer-classic',
    config: goodConfig('platformer-classic'),
    instruction: 'make it faster',
    title: 'Old Title',
  });
  assert.equal(result.config.physics.moveSpeed, 160);
  assert.equal(result.changelog_note, 'Sped the player up.');
  assert.equal(seen.length, 1, 'an edit should not re-run classification');
  assert.ok(seen[0].messages[0].content.includes('make it faster'));
});

test('an impossible edit reports template_switch_required instead of guessing', async () => {
  reset(reply(JSON.stringify({
    template_switch_required: true,
    suggested_template: 'top-down-shooter',
    reason: 'Shooting needs a shooter engine.',
  })));

  const result = await edit({
    templateId: 'platformer-classic',
    config: goodConfig('platformer-classic'),
    instruction: 'add twin-stick shooting and multiplayer',
  });
  assert.equal(result.template_switch_required, true);
  assert.equal(result.suggested_template, 'top-down-shooter');
  assert.match(result.reason, /shooter engine/i);
});

test('a suggested template that does not exist is nulled rather than passed through', async () => {
  reset(reply(JSON.stringify({
    template_switch_required: true,
    suggested_template: 'vr-metaverse',
    reason: 'Needs VR.',
  })));
  const result = await edit({
    templateId: 'platformer-classic',
    config: goodConfig('platformer-classic'),
    instruction: 'make it VR',
  });
  assert.equal(result.template_switch_required, true);
  assert.equal(result.suggested_template, null, 'the UI must not offer a switch to a template we lack');
});

test('every game the pipeline returns is one the engine can actually run', async () => {
  for (const id of templates.keys()) {
    // Naming the template makes this decisive, so only the config call happens.
    reset(configSays(goodConfig(id)));
    const game = await generate(`a game using ${id}`);
    const t = templates.get(id);
    assert.equal(validate(game.config, t.schema).errors.length, 0, `${id}: pipeline emitted an invalid config`);
    const { default: makeGame } = await import(t.enginePath);
    const { simulate } = await import('./harness.js');
    simulate(makeGame, game.config, { steps: 600 });
  }
});

test('a prompt that names its genre skips the classifier round trip', async () => {
  // Classification used to cost a model call on every single generation, even
  // when the prompt said "bricks" and "paddle" outright. Only one canned reply
  // is queued: if the pipeline still asks the classifier, it consumes this and
  // the config pass gets nothing.
  reset(configSays(goodConfig('breakout-clone')));
  const game = await generate('smash some bricks with a paddle');

  assert.equal(seen.length, 1, 'expected the classifier call to be skipped');
  assert.equal(game.source, 'model');
  assert.equal(game.template_id, 'breakout-clone');
  assert.ok(seen[0].system.includes('breakout-clone'), 'the one call made was not the config pass');
});

test('a vague or blended prompt still pays for the classifier', async () => {
  // The other half of the bargain: skipping is only safe where the keyword pass
  // is unambiguous, and a blended idea is exactly where judgement is worth a
  // round trip.
  // Asserting the call *count* is not enough: if the classifier is wrongly
  // skipped, the config pass eats the classifier's canned reply, fails to
  // validate, and the repair retry restores the count to two. Check what the
  // first call actually was.
  for (const prompt of ['a game about my dog', 'a platformer where you also shoot things']) {
    reset(classifierSays('platformer-classic'), configSays(goodConfig('platformer-classic')));
    await generate(prompt);
    assert.ok(
      seen[0]?.system?.includes('classifier stage'),
      `"${prompt}" skipped the classifier; first call was the config pass`
    );
  }
});
