// Headless stand-ins for the browser bits, so engines can be run in Node.
//
// The point is to actually execute update() and draw() thousands of times per
// template. A schema test proves a config is well-formed; only running the
// engine proves the config produces a game that doesn't throw on frame 900.

/** A canvas context that accepts anything and records nothing. */
export function fakeCtx() {
  const gradient = { addColorStop() {} };
  const target = {
    measureText: () => ({ width: 24 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    canvas: { width: 480, height: 270 },
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      // Every other canvas member is either a no-op method or a style property.
      return typeof prop === 'string' && /^[a-z]/.test(prop) ? () => {} : undefined;
    },
    set: () => true,
  });
}

/** The runtime API an engine sees, minus the browser. */
export function fakeRuntime({ W = 480, H = 270, seed = 1 } = {}) {
  const held = new Set();
  const pressed = new Set();
  let t = 0;
  const rt = {
    W, H,
    input: {
      held, pressed,
      pointer: { x: W / 2, y: H / 2, down: false, fired: false },
      down: (a) => held.has(a),
      tapped: (a) => pressed.has(a),
    },
    rand: (() => {
      let a = seed >>> 0 || 1;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let x = Math.imul(a ^ (a >>> 15), 1 | a);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
    })(),
    result: null,
    hudCalls: 0,
    win(message) { rt.result ??= { phase: 'won', message }; },
    lose(message) { rt.result ??= { phase: 'lost', message }; },
    hud() { rt.hudCalls++; },
    get time() { return t; },
    advance(dt) { t += dt; },
  };
  return rt;
}

/**
 * Run an engine for a while with plausible input, and report anything that
 * threw. Input is driven by a seeded RNG so a failure is reproducible.
 */
export function simulate(makeGame, config, { steps = 2400, seed = 7 } = {}) {
  const rt = fakeRuntime({ seed });
  const ctx = fakeCtx();
  const game = makeGame(config, rt);
  const STEP = 1 / 120;
  const ACTIONS = ['left', 'right', 'up', 'down', 'jump', 'fire', 'dash'];

  let rand = seed >>> 0 || 1;
  const rnd = () => {
    rand = (rand * 1664525 + 1013904223) >>> 0;
    return rand / 4294967296;
  };

  for (let i = 0; i < steps; i++) {
    // Change intent occasionally rather than every frame — mashing every key at
    // 120Hz exercises nothing but the input layer.
    if (i % 24 === 0) {
      rt.input.held.clear();
      for (const a of ACTIONS) if (rnd() < 0.22) rt.input.held.add(a);
      rt.input.pressed.clear();
      for (const a of ACTIONS) if (rnd() < 0.14) rt.input.pressed.add(a);
      rt.input.pointer.x = rnd() * 480;
      rt.input.pointer.y = rnd() * 270;
      rt.input.pointer.down = rnd() < 0.5;
      rt.input.pointer.fired = rnd() < 0.3;
    }
    game.update(STEP);
    rt.advance(STEP);
    if (i % 8 === 0) game.draw(ctx);
    if (rt.result) break;
  }
  game.draw(ctx);
  return rt;
}
