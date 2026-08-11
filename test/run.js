import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { templates, ROOT, catalog, schemaBrief, exampleConfig } from '../server/registry.js';
import { validate, defaultsFor } from '../shared/schema.js';
import { checkLevel, repairLevel, searchOpts } from '../shared/levelcheck.js';
import { checkReachable } from '../shared/reachability.js';
import { extractJson } from '../server/anthropic.js';
import { slugify } from '../server/store.js';
import { buildBundle } from '../server/bundle.js';
import { defaultPage, renderArcadePage, renderGamePage } from '../arcade/render.js';
import { generateOffline, classifyOffline } from '../server/offline.js';
import { simulate } from './harness.js';

const all = [...templates.values()];
const arcadeSchema = JSON.parse(readFileSync(join(ROOT, 'arcade', 'schema.json'), 'utf8'));

// ── the library is internally consistent ────────────────────────────────────

test('every template ships engine, schema, and at least two examples', () => {
  assert.ok(all.length >= 4, 'expected at least four templates');
  for (const t of all) {
    assert.ok(t.schema.version, `${t.id}: no version`);
    assert.ok(t.schema.label && t.schema.blurb, `${t.id}: missing label/blurb`);
    assert.ok(t.examples.length >= 2, `${t.id}: needs 2+ example configs, has ${t.examples.length}`);
    assert.ok(schemaBrief(t.id).includes(t.id), `${t.id}: schema brief did not render`);
  }
});

test('the classifier catalog covers every installed template', () => {
  // The drift the spec warns about: a prompt listing templates that don't exist,
  // or templates the classifier can never pick.
  assert.deepEqual(
    catalog().map((c) => c.template_id).sort(),
    all.map((t) => t.id).sort()
  );
});

test('declared mechanicHooks match what each engine actually implements', () => {
  for (const t of all) {
    const source = readFileSync(t.enginePath, 'utf8');
    const declared = Object.keys(t.schema.mechanicHooks ?? {});
    const match = source.match(/const HOOKS = \[([^\]]*)\]/);
    if (!match) continue; // arena templates without a hook list
    const implemented = match[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    assert.deepEqual(declared.sort(), implemented.sort(), `${t.id}: schema hooks and engine HOOKS disagree`);
  }
});

// ── example configs are a regression suite ──────────────────────────────────

test('every example config validates with zero errors', () => {
  for (const t of all) {
    for (const ex of t.examples) {
      const { _note, ...cfg } = ex.config;
      const res = validate(cfg, t.schema);
      assert.equal(res.errors.length, 0, `${t.id}/${ex.name}: ${JSON.stringify(res.errors)}`);
      assert.equal(res.clamps.length, 0, `${t.id}/${ex.name} clamped: ${JSON.stringify(res.clamps)}`);
    }
  }
});

test('every example level is winnable', () => {
  for (const t of all) {
    if (!t.schema.reachability) continue;
    for (const ex of t.examples) {
      const res = checkLevel(t.schema, validate(ex.config, t.schema).config);
      assert.ok(res.ok, `${t.id}/${ex.name}: ${res.reasons.join('; ')}`);
    }
  }
});

test('every example runs for 20 seconds of game time without throwing', async () => {
  for (const t of all) {
    const { default: makeGame } = await import(t.enginePath);
    for (const ex of t.examples) {
      const cfg = validate(ex.config, t.schema).config;
      const rt = simulate(makeGame, cfg, { steps: 2400 });
      assert.ok(rt.hudCalls > 0, `${t.id}/${ex.name}: never updated the HUD`);
    }
  }
});

test('engines survive a config pinned to every schema minimum and maximum', async () => {
  // Safe ranges are only safe if both ends are actually playable. This is the
  // test that would have caught gravity=1600 with jumpPower=140.
  const extremes = (spec) => {
    if (spec.type === 'object') {
      return [
        Object.fromEntries(Object.entries(spec.fields).map(([k, s]) => [k, extremes(s)[0]])),
        Object.fromEntries(Object.entries(spec.fields).map(([k, s]) => [k, extremes(s)[1]])),
      ];
    }
    if (spec.type === 'number' || spec.type === 'int') return [spec.min, spec.max];
    return [defaultsFor(spec), defaultsFor(spec)];
  };

  for (const t of all) {
    const { default: makeGame } = await import(t.enginePath);
    const [lo, hi] = extremes(t.schema.config);
    for (const [name, raw] of [['min', lo], ['max', hi]]) {
      // Grids and enums come from defaults; only numbers go to their limits.
      const merged = { ...structuredClone(exampleConfig(t.id)), ...raw };
      for (const key of Object.keys(raw)) {
        if (raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) {
          merged[key] = { ...exampleConfig(t.id)[key], ...raw[key] };
        }
      }
      if (merged.level) merged.level.grid = exampleConfig(t.id).level.grid;
      const res = validate(merged, t.schema);
      assert.equal(res.errors.length, 0, `${t.id} ${name}: ${JSON.stringify(res.errors)}`);
      simulate(makeGame, res.config, { steps: 900 });
    }
  }
});

// ── validation policy ───────────────────────────────────────────────────────

test('out-of-range numbers are clamped, not rejected', () => {
  const t = templates.get('platformer-classic');
  const cfg = structuredClone(exampleConfig('platformer-classic'));
  cfg.physics.gravity = 99999;
  cfg.physics.jumpPower = -40;
  const res = validate(cfg, t.schema);
  assert.equal(res.errors.length, 0, 'clamping must not produce errors');
  assert.equal(res.config.physics.gravity, 1600);
  assert.equal(res.config.physics.jumpPower, 140);
  assert.equal(res.clamps.length, 2);
});

test('invented keys are rejected rather than merged', () => {
  const t = templates.get('platformer-classic');
  const cfg = structuredClone(exampleConfig('platformer-classic'));
  cfg.physics.antigravity = 5;
  cfg.wormholes = true;
  const res = validate(cfg, t.schema);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.path === 'physics.antigravity'));
  assert.ok(res.errors.some((e) => e.path === 'wormholes'));
  assert.equal(res.config.physics.antigravity, undefined, 'unknown key leaked into the config');
});

test('unsupported mechanic hooks are stripped and reported', () => {
  const t = templates.get('platformer-classic');
  const cfg = structuredClone(exampleConfig('platformer-classic'));
  cfg.mechanicHooks = ['doubleJump', 'grapplingHook'];
  const res = validate(cfg, t.schema);
  assert.deepEqual(res.config.mechanicHooks, ['doubleJump']);
  assert.ok(res.errors.some((e) => e.message.includes('grapplingHook')));
});

test('missing keys are filled from defaults and still produce a playable config', async () => {
  const t = templates.get('top-down-collector');
  const res = validate({ theme: { pickupName: 'gems' } }, t.schema);
  assert.equal(res.errors.length, 0);
  assert.equal(res.config.theme.pickupName, 'gems');
  assert.ok(res.config.level.grid.length > 0, 'default grid missing');
  assert.ok(res.fills.length > 0, 'fills were not recorded');
  const { default: makeGame } = await import(t.enginePath);
  simulate(makeGame, res.config, { steps: 600 });
});

test('illegal tile characters and wrong types are errors', () => {
  const t = templates.get('platformer-classic');
  const cfg = structuredClone(exampleConfig('platformer-classic'));
  cfg.level.grid = [
    '########',
    '#..Q...#',
    '#......#',
    '#.....G#',
    '#P.....#',
    '########',
  ];
  cfg.entities.player.shape = 'dragon';
  cfg.rules.lives = 'three';
  const res = validate(cfg, t.schema);
  assert.ok(res.errors.some((e) => e.message.includes('illegal tile')));
  assert.ok(res.errors.some((e) => e.path === 'entities.player.shape'));
  assert.equal(res.config.rules.lives, 3, 'coercible-looking garbage should fall back to the default');
});

test('a string number is coerced rather than failing the whole config', () => {
  const t = templates.get('breakout-clone');
  const cfg = structuredClone(exampleConfig('breakout-clone'));
  cfg.bricks.rows = '4';
  const res = validate(cfg, t.schema);
  assert.equal(res.errors.length, 0);
  assert.equal(res.config.bricks.rows, 4);
});

// ── reachability ────────────────────────────────────────────────────────────

test('a sealed goal is detected', () => {
  const grid = [
    '##########',
    '#P.....#G#',
    '#......#.#',
    '##########',
  ];
  const res = checkReachable(grid, 'flood', ['G']);
  assert.equal(res.ok, false);
  assert.equal(res.unreachable.length, 1);
  assert.match(res.reasons[0], /can't be reached/);
});

test('a level with no spawn is rejected', () => {
  const res = checkReachable(['####', '#..#', '####'], 'flood', ['G']);
  assert.equal(res.ok, false);
  assert.match(res.reasons[0], /no spawn/);
});

test('a win condition with no goal tile is caught', () => {
  const res = checkReachable(['####', '#P.#', '####'], 'flood', ['G']);
  assert.equal(res.ok, false);
  assert.match(res.reasons[0], /never be met/);
});

test('carving repairs an unwinnable level', () => {
  const t = templates.get('top-down-collector');
  const cfg = validate(exampleConfig('top-down-collector'), t.schema).config;
  cfg.rules.win = 'reachGoal';
  cfg.rules.goalNeedsAll = false; // isolate the carve: only the goal must be reachable
  cfg.level.grid = [
    '##########',
    '#P.....#G#',
    '#......#.#',
    '#......#.#',
    '#......#.#',
    '##########',
  ];
  assert.equal(checkLevel(t.schema, cfg).ok, false);
  const fixed = repairLevel(t.schema, cfg);
  assert.equal(fixed.repaired, true);
  assert.equal(fixed.check.ok, true, `still unwinnable: ${fixed.check.reasons.join('; ')}`);
});

test('jump reach is derived from physics, not hard-coded', () => {
  const t = templates.get('platformer-classic');
  const floaty = { ...exampleConfig('platformer-classic'), physics: { gravity: 380, jumpPower: 300, moveSpeed: 90, friction: 10 } };
  const heavy = { ...exampleConfig('platformer-classic'), physics: { gravity: 1500, jumpPower: 150, moveSpeed: 90, friction: 10 } };
  assert.ok(searchOpts(t.schema, floaty).maxUp > searchOpts(t.schema, heavy).maxUp,
    'low gravity must yield a taller search than high gravity');
});

// ── model-output parsing ────────────────────────────────────────────────────

test('JSON survives fences, prose, and trailing chatter', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n{"a":{"b":[1,2]}}\nHope that helps!'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJson('{"s":"a } brace in a string","n":2}'), { s: 'a } brace in a string', n: 2 });
  assert.equal(extractJson('no json at all'), null);
  assert.equal(extractJson('{"broken": '), null);
});

// ── offline generator ───────────────────────────────────────────────────────

test('offline classification picks the obvious template', () => {
  assert.equal(classifyOffline('shoot waves of aliens').template_id, 'top-down-shooter');
  assert.equal(classifyOffline('smash a wall of bricks with a paddle').template_id, 'breakout-clone');
  assert.equal(classifyOffline('collect coins in a maze while avoiding ghosts').template_id, 'top-down-collector');
  assert.equal(classifyOffline('jump between platforms over spikes').template_id, 'platformer-classic');
  // The documented tie-break: default to the simplest archetype, don't guess.
  assert.equal(classifyOffline('a game about my dog').template_id, 'platformer-classic');
});

test('the editor\'s starter prompts land on the template they are written for', () => {
  // These are the one-click chips in the UI — the first thing anyone tries, and
  // the demo path. They should not fall through to the default archetype.
  const expected = [
    ['a cat ninja wall-jumping through a bamboo forest dodging guard dogs', 'platformer-classic'],
    ['a raccoon robbing a night market while security guards patrol', 'top-down-collector'],
    ['defend a greenhouse from waves of giant beetles', 'top-down-shooter'],
    ['smash a wall of candy bricks with a bouncing gumball', 'breakout-clone'],
    ['a lost astronaut hopping between moon platforms collecting oxygen', 'platformer-classic'],
  ];
  for (const [prompt, want] of expected) {
    const got = classifyOffline(prompt);
    assert.equal(got.template_id, want, `"${prompt}" -> ${got.template_id}`);
    assert.ok(got.confident, `"${prompt}" matched nothing and fell back to the default`);
  }
});

test('offline generation produces a valid, winnable, runnable game for many prompts', async () => {
  const prompts = [
    'a cat ninja wall-jumping through a bamboo forest dodging guard dogs',
    'a raccoon robbing a night market while security guards patrol',
    'defend a greenhouse from waves of giant beetles',
    'smash a wall of candy bricks with a bouncing gumball',
    'a lost astronaut hopping between moon platforms collecting oxygen',
    'escape a haunted library maze before the ghosts find you',
    'a really hard underwater game about collecting pearls',
    'an easy chill game for kids about picking flowers',
    'x',
    'ROBOTS!!! shooting lasers in a factory, very hard',
  ];
  for (const prompt of prompts) {
    const game = generateOffline(prompt);
    const t = templates.get(game.template_id);
    assert.ok(t, `${prompt}: unknown template ${game.template_id}`);

    const res = validate(game.config, t.schema);
    assert.equal(res.errors.length, 0, `${prompt}: ${JSON.stringify(res.errors)}`);

    if (t.schema.reachability) {
      const level = checkLevel(t.schema, res.config);
      assert.ok(level.ok, `${prompt}: unwinnable — ${level.reasons.join('; ')}`);
    }
    assert.ok(game.title.length > 0 && game.title.length <= 60, `${prompt}: bad title`);

    const { default: makeGame } = await import(t.enginePath);
    simulate(makeGame, res.config, { steps: 1200 });
  }
});

test('offline generation is deterministic for the same prompt', () => {
  const a = generateOffline('a cat ninja in a bamboo forest');
  const b = generateOffline('a cat ninja in a bamboo forest');
  assert.deepEqual(a.config, b.config);
});

// ── publishing ──────────────────────────────────────────────────────────────

test('slugs are url-safe and stable', () => {
  assert.equal(slugify("Cat Ninja's Revenge!"), 'cat-ninjas-revenge');
  assert.equal(slugify('  ¡¡¡  '), 'game');
  assert.equal(slugify('A'.repeat(80)).length <= 40, true);
  assert.equal(slugify('Trailing --- dashes ---'), 'trailing-dashes');
});

test('a published bundle is self-contained and keeps the game separate from the page', () => {
  const game = generateOffline('a cat ninja in a bamboo forest');
  const page = defaultPage(game, defaultsFor(arcadeSchema.config));
  const outDir = join(ROOT, 'dist', '__test__');
  const { files } = buildBundle({ game, page, outDir });

  for (const expected of ['index.html', 'game.html', `templates/${game.template_id}/engine.js`, 'shared/runtime.js', '_headers']) {
    assert.ok(files.includes(expected), `bundle is missing ${expected}`);
  }

  const indexHtml = readFileSync(join(outDir, 'index.html'), 'utf8');
  const gameHtml = readFileSync(join(outDir, 'game.html'), 'utf8');

  assert.ok(gameHtml.includes('RUMPUS_CONFIG'), 'game.html does not carry its config');
  assert.ok(gameHtml.includes(`templates/${game.template_id}/engine.js`), 'game.html does not load its engine');
  assert.ok(gameHtml.includes(game.template_version), 'game.html does not record the pinned engine version');

  // The separation the architecture promises: restyling the page cannot reach
  // the game, because the page contains none of it.
  assert.ok(!indexHtml.includes('RUMPUS_CONFIG'), 'the arcade page leaked the game config');
  assert.ok(indexHtml.includes('game.html'), 'the arcade page does not embed the game');

  rmSync(outDir, { recursive: true, force: true });
  assert.equal(existsSync(outDir), false);
});

test('the arcade page escapes user copy', () => {
  const game = generateOffline('a normal game');
  const page = defaultPage(game, defaultsFor(arcadeSchema.config));
  page.hero.title = '</title><script>alert(1)</script>';
  page.about.body = '<img src=x onerror=alert(2)>';
  const html = renderArcadePage(page, game);
  // The property that matters is that no attacker-controlled tag survives as
  // markup — the harmless text "onerror=alert(2)" appearing inside an escaped
  // entity is fine, so assert on the tags themselves.
  assert.ok(!html.includes('<script>alert(1)'), 'title escaped out of the document body');
  assert.ok(!html.includes('</script>alert'), 'title escaped out of the inline script');
  assert.ok(!html.includes('<img src=x'), 'body was not escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'expected escaped output');
  // The title is also embedded in the page's inline script; a raw "</script>"
  // there would end the block early and turn the rest into markup.
  assert.ok(html.includes('\\u003c/script'), 'inline-script JSON did not escape "<"');
});

test('page copy is regenerated from the game, including its hooks', () => {
  const game = generateOffline('a cat ninja with a double jump and a dash in a bamboo forest');
  const page = defaultPage(game, defaultsFor(arcadeSchema.config));
  assert.equal(page.hero.title, game.title);
  const steps = page.howTo.steps.join(' ').toLowerCase();
  for (const hook of game.config.mechanicHooks) {
    const word = { doubleJump: 'double jump', dash: 'dash', shoot: 'shoot' }[hook];
    if (word) assert.ok(steps.includes(word), `how-to-play never mentions ${hook}`);
  }
});

test('the standalone game page pins its engine version', () => {
  const game = generateOffline('bricks and a paddle');
  const html = renderGamePage(game);
  assert.ok(html.includes(`v${game.template_version}`));
  assert.ok(html.includes('type="module"'));
});
