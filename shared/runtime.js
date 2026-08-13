// The harness every template engine runs inside.
//
// It owns everything that isn't gameplay: canvas scaling, the fixed-timestep
// loop, input, HUD, pause/restart, win-lose overlays, and the postMessage
// channel the editor uses to hot-swap a config. Engines implement only
// update/draw, which is what keeps each one small enough to actually be tested.

import { rng, hashString, mix } from './draw.js';
import { getStyle } from './styles.js';

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  Space: 'jump', KeyZ: 'jump',
  KeyX: 'fire', KeyJ: 'fire', Enter: 'fire',
  ShiftLeft: 'dash', ShiftRight: 'dash', KeyK: 'dash',
};

export function boot(makeGame, opts = {}) {
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: false });
  const W = opts.width ?? 480;
  const H = opts.height ?? 270;
  canvas.width = W;
  canvas.height = H;

  const input = {
    held: new Set(),
    pressed: new Set(),
    pointer: { x: 0, y: 0, down: false, fired: false },
    down: (a) => input.held.has(a),
    tapped: (a) => input.pressed.has(a),
  };

  const onKey = (e, isDown) => {
    const action = KEYMAP[e.code];
    if (!action) return;
    // The game owns the arrow keys; letting them scroll the editor is a bug
    // users experience as "the controls are broken".
    e.preventDefault();
    if (isDown) {
      if (!input.held.has(action)) input.pressed.add(action);
      input.held.add(action);
      if (state.phase !== 'play' && (action === 'jump' || action === 'fire')) restart();
    } else input.held.delete(action);
  };
  addEventListener('keydown', (e) => onKey(e, true), { passive: false });
  addEventListener('keyup', (e) => onKey(e, false), { passive: false });
  addEventListener('blur', () => input.held.clear());

  const toStage = (e) => {
    const r = canvas.getBoundingClientRect();
    input.pointer.x = ((e.clientX - r.left) / r.width) * W;
    input.pointer.y = ((e.clientY - r.top) / r.height) * H;
  };
  canvas.addEventListener('pointermove', toStage);
  canvas.addEventListener('pointerdown', (e) => {
    toStage(e);
    input.pointer.down = true;
    input.pointer.fired = true;
    canvas.setPointerCapture?.(e.pointerId);
    if (state.phase !== 'play') restart();
  });
  addEventListener('pointerup', () => (input.pointer.down = false));

  let state = { phase: 'play', hud: {}, message: '' };
  let game = null;
  let config = null;
  let style = getStyle('pixel');
  let last = 0;
  let accum = 0;
  let elapsed = 0;

  const api = {
    W, H, input,
    rand: rng(1),
    win: (msg) => finish('won', msg),
    lose: (msg) => finish('lost', msg),
    hud: (obj) => (state.hud = obj),
    get time() { return elapsed; },
  };

  function finish(phase, message) {
    if (state.phase !== 'play') return;
    state.phase = phase;
    state.message = message || (phase === 'won' ? 'You win!' : 'Wiped out.');
    post({ type: 'romp:result', phase, message: state.message, time: elapsed });
  }

  function restart() {
    if (!config) return;
    elapsed = 0;
    accum = 0;
    state = { phase: 'play', hud: {}, message: '' };
    api.rand = rng(hashString(JSON.stringify(config.level ?? {}) + (config.seed ?? '')) || 1);
    game = makeGame(config, api);
    post({ type: 'romp:started' });
  }

  function load(next) {
    config = next;
    style = getStyle(next?.style);
    try {
      restart();
    } catch (err) {
      // A crash here means a bad engine or a config that slipped past validation.
      // Say so on the canvas rather than showing a frozen black rectangle.
      state.phase = 'error';
      state.message = String(err?.message || err);
      post({ type: 'romp:error', message: state.message });
    }
  }

  const STEP = 1 / 120; // Fixed timestep: physics that changes with framerate is not testable.
  function frame(now) {
    requestAnimationFrame(frame);
    if (!game) return;
    const dt = Math.min(0.25, (now - last) / 1000 || 0);
    last = now;

    if (state.phase === 'play') {
      accum += dt;
      let steps = 0;
      while (accum >= STEP && steps++ < 60) {
        try {
          game.update(STEP);
        } catch (err) {
          state.phase = 'error';
          state.message = String(err?.message || err);
          post({ type: 'romp:error', message: state.message });
          break;
        }
        elapsed += STEP;
        accum -= STEP;
        input.pressed.clear();
        input.pointer.fired = false;
      }
    }

    ctx.fillStyle = game.background ?? '#0d0f16';
    ctx.fillRect(0, 0, W, H);
    try {
      game.draw(ctx);
    } catch { /* a draw glitch shouldn't kill the loop */ }
    drawHud();
    if (state.phase !== 'play') drawOverlay();
  }

  function drawHud() {
    const entries = Object.entries(state.hud).filter(([, v]) => v !== undefined && v !== null);
    if (!entries.length) return;
    const h = style.hud;
    ctx.font = h.font;
    ctx.textBaseline = 'top';
    if (h.track) ctx.letterSpacing = `${h.track}px`;
    const boxH = 20;
    let x = 8;
    for (const [k, v] of entries) {
      const text = `${k} ${v}`;
      const w = ctx.measureText(text).width + h.padX * 2;
      ctx.fillStyle = h.bg;
      ctx.beginPath();
      ctx.roundRect(x, 7, w, boxH, Math.min(h.radius, boxH / 2));
      ctx.fill();
      ctx.fillStyle = h.fg;
      ctx.fillText(text, x + h.padX, 7 + h.padY);
      x += w + h.gap;
    }
    if (h.track) ctx.letterSpacing = '0px';
  }

  function drawOverlay() {
    const o = style.overlay;
    ctx.fillStyle = `rgba(8,9,14,${o.scrim})`;
    ctx.fillRect(0, 0, W, H);
    const tint = state.phase === 'won' ? '#7ee787' : state.phase === 'error' ? '#ff7b72' : '#ffa657';
    ctx.textAlign = 'center';
    ctx.save();
    if (o.glow) {
      ctx.shadowColor = tint;
      ctx.shadowBlur = 18;
    }
    ctx.fillStyle = tint;
    ctx.font = o.title;
    if (o.letterSpacing) ctx.letterSpacing = `${o.letterSpacing}px`;
    ctx.fillText(
      state.phase === 'won' ? 'WIN' : state.phase === 'error' ? 'BROKEN' : 'GAME OVER',
      W / 2, H / 2 - 26
    );
    ctx.restore();
    ctx.letterSpacing = '0px';
    ctx.fillStyle = '#e8eaf2';
    ctx.font = o.body;
    wrap(ctx, state.message, W / 2, H / 2 + 6, W - 60, 17);
    ctx.fillStyle = 'rgba(232,234,242,0.55)';
    ctx.font = o.body;
    ctx.fillText('press space or click to play again', W / 2, H - 26);
    ctx.textAlign = 'left';
  }

  function wrap(c, text, x, y, maxW, lh) {
    const words = String(text).split(' ');
    let line = '';
    let ly = y;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (c.measureText(test).width > maxW && line) {
        c.fillText(line, x, ly);
        line = word;
        ly += lh;
      } else line = test;
    }
    if (line) c.fillText(line, x, ly);
  }

  const post = (msg) => parent !== window && parent.postMessage(msg, '*');

  addEventListener('message', (e) => {
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'romp:config') load(data.config);
    if (data.type === 'romp:restart') restart();
  });

  requestAnimationFrame(frame);
  post({ type: 'romp:ready' });

  // Standalone (published) games inline their config on the page.
  if (window.ROMP_CONFIG) load(window.ROMP_CONFIG);

  return { load, restart };
}

/**
 * Where the camera should sit on one axis.
 * When the level is bigger than the view, follow and clamp to the edges. When
 * it's smaller, centre it — otherwise a short level pins to the top and the
 * player stares at a band of empty sky under the floor.
 */
export function cameraTarget(focus, viewSize, levelSize) {
  const span = levelSize - viewSize;
  if (span <= 0) return span / 2;
  return Math.max(0, Math.min(span, focus - viewSize / 2));
}

/** Axis-aligned box overlap, used by every engine. */
export const hit = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Background gradient shared by the templates, so themes stay coherent. */
export function skyGradient(ctx, W, H, top, bottom) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, top);
  g.addColorStop(1, mix(top, bottom, 0.9));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}
