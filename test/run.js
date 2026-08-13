import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { templates, ROOT, catalog, schemaBrief, exampleConfig } from '../server/registry.js';
import { validate, defaultsFor } from '../shared/schema.js';
import { checkLevel, repairLevel, searchOpts } from '../shared/levelcheck.js';
import { checkReachable } from '../shared/reachability.js';
import { extractJson } from '../server/llm.js';
import { slugify } from '../server/store.js';
import { buildBundle } from '../server/bundle.js';
import { defaultPage, renderArcadePage, renderGamePage } from '../arcade/render.js';
import { generateOffline, classifyOffline } from '../server/offline.js';
import { simulate } from './harness.js';
import { composeMask, BUILD_NAMES, OVERLAY_NAMES, PICKUPS, RES } from '../shared/sprites.js';
import { STYLES, STYLE_NAMES } from '../shared/styles.js';
import { checkSokoban, structuralProblems, generateSokoban, solve as solveSokoban } from '../shared/sokoban-solve.js';
import { parseSokoban } from '../shared/sokoban.js';
import { rng } from '../shared/draw.js';

const all = [...templates.values()];
const arcadeSchema = JSON.parse(readFileSync(join(ROOT, 'arcade', 'schema.json'), 'utf8'));

// ── the library is internally consistent ──────────────────────────────────

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

// ── example configs are a regression suite ────────────────────────────────

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

// ── validation policy ─────────────────────────────────────────────────

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

// ── reachability ─────────────────────────────────────────────────────

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

// ── model-output parsing ──────────────────────────────────────────────

test('JSON survives fences, prose, and trailing chatter', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n{"a":{"b":[1,2]}}\nHope that helps!'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJson('{"s":"a } brace in a string","n":2}'), { s: 'a } brace in a string', n: 2 });
  assert.equal(extractJson('no json at all'), null);
  assert.equal(extractJson('{"broken": '), null);
});

// ── offline generator ─────────────────────────────────────────────────

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

// ── publishing ────────────────────────────────────────────────────────

test('slugs are url-safe and stable', () => {
  assert.equal(slugify("Cat Ninja's Revenge!"), 'cat-ninjas-revenge');
  assert.equal(slugify('  ¡¡¡  '), 'game');
  assert.equal(slugify('A'.repeat(80)).length <= 40, true);
  assert.equal(slugify('Trailing --- dashes ---'), 'trailing-dashes');
});

test('a published bundle is self-contained and keeps the game separate from the page', () => {
  const game = generateOffline('a cat ninja in a bamboo forest');
  const page = defaultPage(game, defaultsFor(arcadeSchema.config));
  const { files } = buildBundle({ game, page });

  for (const expected of ['index.html', 'game.html', `templates/${game.template_id}/engine.js`, 'shared/runtime.js', '_headers']) {
    assert.ok(files[expected], `bundle is missing ${expected}`);
  }

  const indexHtml = files['index.html'];
  const gameHtml = files['game.html'];

  assert.ok(gameHtml.includes('ROMP_CONFIG'), 'game.html does not carry its config');
  assert.ok(gameHtml.includes(`templates/${game.template_id}/engine.js`), 'game.html does not load its engine');
  assert.ok(gameHtml.includes(game.template_version), 'game.html does not record the pinned engine version');

  // The separation the architecture promises: restyling the page cannot reach
  // the game, because the page contains none of it.
  assert.ok(!indexHtml.includes('ROMP_CONFIG'), 'the arcade page leaked the game config');
  assert.ok(indexHtml.includes('game.html'), 'the arcade page does not embed the game');
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

// ── art direction ────────────────────────────────────────────────────

test('every body plan, feature, and pickup composes to a well-formed mask', () => {
  for (const build of BUILD_NAMES) {
    for (const feature of [...OVERLAY_NAMES, undefined]) {
      const mask = composeMask({ build, features: feature ? [feature] : [], eyes: 'big', pattern: 'stripes' });
      assert.equal(mask.length, RES, `${build}/${feature}: wrong row count`);
      for (const row of mask) assert.equal(row.length, RES, `${build}/${feature}: ragged row`);
      assert.ok(mask.some((r) => /[BDLA]/.test(r)), `${build}/${feature}: composed to nothing`);
    }
  }
  for (const [name, rows] of Object.entries(PICKUPS)) {
    assert.equal(rows.length, RES, `pickup ${name}: wrong row count`);
    for (const row of rows) assert.equal(row.length, RES, `pickup ${name}: ragged row`);
  }
});

test('a sprite is symmetric when its body plan is front-facing, and not when it is not', () => {
  // Symmetry is what stops a composed sprite reading as a mistake. Side-facing
  // plans must NOT be symmetric or they lose their direction entirely.
  const symmetric = (mask) => mask.every((row) => row === [...row].reverse().join(''));
  assert.ok(symmetric(composeMask({ build: 'biped', features: [], eyes: 'big', pattern: 'none' })));
  assert.ok(symmetric(composeMask({ build: 'blob', features: ['crown'], eyes: 'big', pattern: 'none' })));
  assert.ok(!symmetric(composeMask({ build: 'quadruped', features: ['tail'], eyes: 'big', pattern: 'none' })));
});

test('features land on the head, not the body, for both anatomies', () => {
  // The bug this pins: front-facing ear masks applied to a side-facing body put
  // the ears over the creature's back.
  const rowsWith = (spec) => composeMask(spec);
  const front = rowsWith({ build: 'biped', features: ['earsPointed'], eyes: 'big', pattern: 'none' });
  const side = rowsWith({ build: 'quadruped', features: ['earsPointed'], eyes: 'big', pattern: 'none' });

  // Front-facing head is centred, so its ears straddle the middle columns.
  const frontEarCols = [...front[1]].flatMap((c, i) => (c !== '.' ? [i] : []));
  assert.ok(Math.min(...frontEarCols) < RES / 2 && Math.max(...frontEarCols) > RES / 2,
    'front ears did not straddle the centre');

  // Side-facing head sits on the right, so its ears must be on the right half.
  const sideEarCols = [...side[0]].flatMap((c, i) => (c !== '.' ? [i] : []));
  assert.ok(sideEarCols.length > 0, 'side ears did not render at all');
  assert.ok(Math.min(...sideEarCols) >= RES / 2, `side ears landed on the body at cols ${sideEarCols}`);
});

test('patterns never cover the eyes', () => {
  for (const pattern of ['stripes', 'spots', 'belly', 'plated']) {
    for (const build of ['biped', 'blob', 'quadruped', 'bird']) {
      const plain = composeMask({ build, features: [], eyes: 'big', pattern: 'none' });
      const marked = composeMask({ build, features: [], eyes: 'big', pattern });
      const eyesIn = (m) => m.join('').split('').filter((c) => c === 'E' || c === 'P').length;
      assert.equal(eyesIn(marked), eyesIn(plain), `${build}/${pattern} ate the face`);
    }
  }
});

test('sprite composition is deterministic', () => {
  const spec = { build: 'quadruped', features: ['earsPointed', 'tail'], eyes: 'angry', pattern: 'stripes' };
  assert.deepEqual(composeMask(spec), composeMask(structuredClone(spec)));
});

test('every style defines every layer it is supposed to govern', () => {
  for (const [id, style] of Object.entries(STYLES)) {
    assert.equal(style.id, id, `${id}: id mismatch`);
    for (const key of ['sprite', 'tile', 'hazard', 'particle', 'hud', 'overlay', 'page']) {
      assert.ok(style[key] !== undefined, `style ${id} is missing "${key}" — that layer would silently fall back`);
    }
    for (const key of ['fontStack', 'radius', 'cardRadius', 'buttonRadius', 'shadow', 'buttonShadow', 'cardBorder']) {
      assert.ok(style.page[key], `style ${id}: page.${key} missing`);
    }
    assert.ok(style.hud.font.includes('px'), `style ${id}: hud font is not a usable CSS font shorthand`);
  }
});

test('the four styles are actually distinguishable from each other', () => {
  // A style pack that duplicates another is a style that does nothing.
  const fingerprint = (s) => JSON.stringify([s.sprite.outline, s.tile.mode, s.hazard, s.particle.shape, s.page.fontStack]);
  const seen = new Set(Object.values(STYLES).map(fingerprint));
  assert.equal(seen.size, Object.keys(STYLES).length, 'two styles render identically');
});

test('the game style reaches the published page — fonts, borders and shadows', () => {
  // The promise under test: one token in the config governs the game AND the
  // page, and picking a different one visibly changes the published HTML.
  const seen = new Map();
  for (const styleId of STYLE_NAMES) {
    const game = generateOffline('a cat ninja in a bamboo forest');
    game.config.style = styleId;
    const page = defaultPage(game, defaultsFor(arcadeSchema.config));
    assert.equal(page.style, styleId, 'defaultPage did not inherit the game style');

    const html = renderArcadePage(page, game);
    const style = STYLES[styleId];
    assert.ok(html.includes(style.page.fontStack.split(',')[0].trim()), `${styleId}: page font missing`);
    assert.ok(html.includes(style.page.buttonRadius), `${styleId}: button radius missing`);
    assert.ok(html.includes(style.page.shadow), `${styleId}: shadow missing`);
    assert.ok(html.includes(`Style: ${styleId}`), `${styleId}: page did not record which style built it`);
    seen.set(styleId, html);
  }
  assert.equal(new Set(seen.values()).size, STYLE_NAMES.length, 'different styles produced identical pages');
});

test('a restyled game restyles its page even when the page stored an older style', () => {
  const game = generateOffline('a neon robot in a cyber maze');
  const page = defaultPage(game, defaultsFor(arcadeSchema.config));
  page.style = 'storybook';          // stale value, as if stored before a restyle
  game.config.style = 'clay';        // the game is the source of truth
  const html = renderArcadePage(page, game);
  assert.ok(html.includes('Style: clay'), 'the page followed its own stale style instead of the game');
  assert.ok(!html.includes('Iowan Old Style'), 'storybook font leaked into a clay page');
});

test('the arcade page palette is computed from the game palette', () => {
  const game = generateOffline('a cat ninja in a bamboo forest');
  const page = defaultPage(game, defaultsFor(arcadeSchema.config));
  assert.equal(page.theme.accent, game.config.theme.accent, 'page accent should be the game accent');
  assert.equal(page.theme.background, game.config.theme.skyBottom, 'page background should come from the game');
});

test('the offline generator picks a style and a matching cast from the prompt', () => {
  const cases = [
    ['a neon robot escaping a cyber maze', 'neon', 'biped', 'visor'],
    ['a cosy storybook fox in a woodland village', 'storybook', 'quadruped', 'tail'],
    ['a cute clay penguin waddling on the ice', 'clay', 'bird', null],
    ['a cat ninja dodging guard dogs', 'pixel', 'quadruped', 'earsPointed'],
  ];
  for (const [prompt, style, build, feature] of cases) {
    const game = generateOffline(prompt);
    assert.equal(game.config.style, style, `"${prompt}" -> style ${game.config.style}`);
    const sprite = game.config.entities?.player?.sprite;
    assert.ok(sprite, `"${prompt}": no player sprite`);
    assert.equal(sprite.build, build, `"${prompt}" -> build ${sprite.build}`);
    if (feature) assert.ok(sprite.features.includes(feature), `"${prompt}": missing feature ${feature}`);
  }
});

test('every generated config produces sprites that compose without error', () => {
  for (const prompt of ['a cat ninja', 'a robot in a factory', 'defend the base from beetles', 'break bricks']) {
    const game = generateOffline(prompt);
    for (const who of ['player', 'enemy']) {
      const spec = game.config.entities?.[who]?.sprite;
      if (!spec) continue;
      const mask = composeMask(spec);
      assert.equal(mask.length, RES);
      assert.ok(BUILD_NAMES.includes(spec.build), `${prompt}/${who}: unknown build ${spec.build}`);
      for (const f of spec.features) assert.ok(OVERLAY_NAMES.includes(f), `${prompt}/${who}: unknown feature ${f}`);
    }
  }
});

test('published bundles ship the sprite and style modules the engine needs', () => {
  const game = generateOffline('a cat ninja in a bamboo forest');
  const page = defaultPage(game, defaultsFor(arcadeSchema.config));
  const { files } = buildBundle({ game, page });
  for (const needed of ['shared/sprites.js', 'shared/styles.js', 'shared/render.js']) {
    assert.ok(files[needed], `bundle is missing ${needed} — the published game would not render`);
  }
});

// ── sokoban solvability ───────────────────────────────────────────────

test('the solver proves a trivial push puzzle solvable', () => {
  const res = checkSokoban(['#######', '#..T..#', '#..B..#', '#..P..#', '#######']);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'solved');
  assert.equal(res.pushes, 1);
});

test('a crate wedged in a corner is caught without any search', () => {
  const res = checkSokoban(['#######', '#B....#', '#....T#', '#..P..#', '#######']);
  assert.equal(res.ok, false);
  assert.match(res.reasons[0], /wedged in a corner/);
});

test('a connected but impossible puzzle is proved unsolvable', () => {
  // Every cell is reachable and no crate starts in a corner, so a flood fill
  // would happily pass this. The crate can only leave its chamber downwards,
  // and the target sits at the top of a column it can never be pushed up.
  const res = checkSokoban([
    '########',
    '#T.....#',
    '#.####.#',
    '#.#..#.#',
    '#.#B.#.#',
    '#.#..#.#',
    '#..P...#',
    '########',
  ]);
  assert.equal(res.ok, false);
  assert.equal(res.status, 'unsolvable');
  assert.match(res.reasons[0], /no sequence of pushes/);
});

test('structural problems are reported before the search runs', () => {
  assert.match(structuralProblems(parseSokoban(['####', '#B.#', '####'])).join(' '), /no player spawn/);
  assert.match(structuralProblems(parseSokoban(['#####', '#PB.#', '#####'])).join(' '), /no targets/);
  assert.match(
    structuralProblems(parseSokoban(['######', '#PB..#', '#.TT.#', '######'])).join(' '),
    /1 box\(es\) for 2 target\(s\)/
  );
});

test('a level the solver cannot settle is reported as unverified, not as broken', () => {
  // Budget deliberately starved. The honest answer is "I do not know" — calling
  // a fine level unsolvable because we ran out of states would throw it away.
  const state = parseSokoban(exampleConfig('puzzle-sokoban').level.grid);
  const res = solveSokoban(state, { cap: 1 });
  assert.equal(res.status, 'unknown');
});

test('generated push puzzles are solvable by construction', () => {
  // Reverse-pull construction means solvability is structural, not searched
  // for. If this ever fails, the construction is wrong — not the solver.
  let checked = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const rows = generateSokoban(rng(seed * 7919), { boxes: 3, pulls: 26 });
    if (!rows) continue; // degenerate roll, legitimately rejected
    const res = checkSokoban(rows);
    assert.equal(res.status, 'solved', `seed ${seed}: ${res.reasons.join('; ')}`);
    checked += 1;
  }
  assert.ok(checked >= 20, `expected most seeds to yield a puzzle, got ${checked}`);
});

test('an unsolvable push puzzle is replaced rather than carved', () => {
  const t = templates.get('puzzle-sokoban');
  const cfg = validate(exampleConfig('puzzle-sokoban'), t.schema).config;
  cfg.level.grid = [
    '##########',
    '#B.......#',
    '#..T.....#',
    '#........#',
    '#...P....#',
    '#........#',
    '##########',
  ];
  assert.equal(checkLevel(t.schema, cfg).ok, false);
  const fixed = repairLevel(t.schema, cfg);
  assert.equal(fixed.repaired, true);
  assert.equal(fixed.check.ok, true, `still unsolvable: ${fixed.check.reasons.join('; ')}`);
  // Carving a corridor is meaningless here; the level must actually differ.
  assert.notDeepEqual(fixed.config.level.grid, cfg.level.grid);
});

test('published push puzzles do not ship the solver', () => {
  // The verifier runs before anything is written. Shipping it would be dead
  // weight in every published bundle.
  const game = generateOffline('a robot pushing crates around a warehouse');
  assert.equal(game.template_id, 'puzzle-sokoban');
  const page = defaultPage(game, defaultsFor(arcadeSchema.config));
  const { files } = buildBundle({ game, page });
  assert.ok(files['shared/sokoban.js'], 'the engine needs the rules');
  assert.ok(!files['shared/sokoban-solve.js'], 'the solver leaked into a published bundle');
});

test('the runner declares no level check, because it has no level to check', () => {
  assert.equal(templates.get('endless-runner').schema.reachability, null);
});

test('new templates are classified from their own vocabulary', () => {
  assert.equal(classifyOffline('an endless runner across the rooftops').template_id, 'endless-runner');
  assert.equal(classifyOffline('a robot pushing crates in a warehouse').template_id, 'puzzle-sokoban');
  assert.equal(classifyOffline('a puzzle about shoving boxes onto markers').template_id, 'puzzle-sokoban');
});

test('keyword inference matches words, not substrings', () => {
  // The bug this pins: "crates" contains "rat", so a warehouse puzzle was
  // handing the player a rodent. Every keyword list in the offline generator
  // shares this hazard, so check a few of the nastier collisions.
  const soko = generateOffline('a robot pushing crates around a warehouse');
  assert.equal(soko.config.entities.player.sprite.build, 'biped', 'crates matched "rat"');
  assert.ok(soko.config.entities.player.sprite.features.includes('visor'), 'lost the robot');

  // "police" contains "ice", which must not drag in the ice palette.
  const police = generateOffline('a police officer chasing a thief downtown');
  assert.notEqual(police.config.theme.skyTop, '#12354f', '"police" matched the ice palette');

  // Prefix matching is still wanted: "pushing" should match the "push" signal.
  assert.equal(classifyOffline('pushing blocks onto switches').template_id, 'puzzle-sokoban');
});
