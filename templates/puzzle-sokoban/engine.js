// puzzle-sokoban — push every crate onto a marker.
//
// ENGINE CODE. Never written or edited by the generator.
// The one template where "is this level winnable" needs a search rather than a
// walk: a push puzzle can be fully connected and still impossible. That check
// lives in shared/sokoban-solve.js and runs before anything renders.
//
// Note for anyone adding a hook here: nothing may change how a push resolves.
// The solver assumes one-tile pushes, so a "boxes slide until they hit
// something" hook would silently invalidate every solvability guarantee.

import { boot, cameraTarget } from '../../shared/runtime.js';
import { shade, mix, rng } from '../../shared/draw.js';
import { getSprite, rampFor } from '../../shared/sprites.js';
import { getStyle } from '../../shared/styles.js';
import { drawTile, drawParticles } from '../../shared/render.js';
import { parseSokoban, isWall, inDeadCorner } from '../../shared/sokoban.js';

const HOOKS = ['undo', 'deadlockWarning', 'sprint'];
const DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

function makeGame(cfg, rt) {
  const th = cfg.theme;
  const style = getStyle(cfg.style);
  const hooks = new Set((cfg.mechanicHooks ?? []).filter((h) => HOOKS.includes(h)));
  const rand = rng((cfg.seed ?? 17) || 17);
  const T = cfg.level.tileSize;
  const level = parseSokoban(cfg.level.grid);

  const levelW = level.w * T;
  const levelH = level.h * T;
  const ps = cfg.entities.player.size;

  const start = level.player ?? { x: 1, y: 1 };
  let player = { x: start.x, y: start.y };
  let boxes = level.boxes.map((b) => ({ ...b }));
  const targets = level.targets.map((t) => ({ ...t }));

  const art = {
    player: getSprite(cfg.entities.player.sprite, rampFor(th.player, th.accent, style), style, ps * 2),
  };

  // Smoothed render position, so grid movement doesn't look like teleporting.
  const view = { x: player.x, y: player.y };
  const boxView = boxes.map((b) => ({ x: b.x, y: b.y }));

  const history = [];
  let moves = 0;
  let pushes = 0;
  let stepCd = 0;
  let particles = [];
  const cam = { x: 0, y: 0 };

  const onTarget = (x, y) => targets.some((t) => t.x === x && t.y === y);
  const boxAt = (x, y) => boxes.findIndex((b) => b.x === x && b.y === y);
  const placed = () => boxes.filter((b) => onTarget(b.x, b.y)).length;

  function burst(x, y, color, n = 8) {
    for (let i = 0; i < n; i++)
      particles.push({
        x: x * T + T / 2, y: y * T + T / 2, life: 0.3 + rand() * 0.25, color,
        vx: (rand() - 0.5) * 130, vy: (rand() - 0.5) * 130,
      });
  }

  function step(dx, dy) {
    const nx = player.x + dx;
    const ny = player.y + dy;
    if (isWall(level, nx, ny)) return false;

    const bi = boxAt(nx, ny);
    if (bi >= 0) {
      const bx = nx + dx;
      const by = ny + dy;
      if (isWall(level, bx, by) || boxAt(bx, by) >= 0) return false;
      history.push({ player: { ...player }, box: { index: bi, x: boxes[bi].x, y: boxes[bi].y } });
      boxes[bi] = { x: bx, y: by };
      pushes += 1;
      if (onTarget(bx, by)) burst(bx, by, th.accent, 7);
    } else {
      history.push({ player: { ...player }, box: null });
    }
    player = { x: nx, y: ny };
    moves += 1;
    if (history.length > 400) history.shift();
    return true;
  }

  function undo() {
    const last = history.pop();
    if (!last) return;
    player = { ...last.player };
    if (last.box) {
      boxes[last.box.index] = { x: last.box.x, y: last.box.y };
      pushes = Math.max(0, pushes - 1);
    }
    moves = Math.max(0, moves - 1);
  }

  return {
    background: th.floor,

    update(dt) {
      const { input } = rt;
      stepCd = Math.max(0, stepCd - dt);

      if (hooks.has('undo') && input.tapped('fire')) undo();

      // Tap to step; hold to repeat. Repeat rate is deliberately slow — a push
      // puzzle punishes a move you didn't mean to make.
      const rate = hooks.has('sprint') && input.down('dash') ? cfg.rules.repeatDelay * 0.45 : cfg.rules.repeatDelay;
      for (const [action, [dx, dy]] of Object.entries(DIRS)) {
        if (input.tapped(action)) {
          step(dx, dy);
          stepCd = rate * 1.6;
          break;
        }
        if (input.down(action) && stepCd <= 0) {
          step(dx, dy);
          stepCd = rate;
          break;
        }
      }

      const lerp = Math.min(1, cfg.rules.animSpeed * dt);
      view.x += (player.x - view.x) * lerp;
      view.y += (player.y - view.y) * lerp;
      boxes.forEach((b, i) => {
        boxView[i].x += (b.x - boxView[i].x) * lerp;
        boxView[i].y += (b.y - boxView[i].y) * lerp;
      });

      for (const p of particles) {
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      particles = particles.filter((p) => p.life > 0);

      const done = placed();
      if (done === targets.length && targets.length > 0) {
        return rt.win(`Solved in ${moves} moves, ${pushes} pushes.`);
      }
      if (cfg.rules.moveLimit > 0 && moves >= cfg.rules.moveLimit) {
        return rt.lose(`Out of moves with ${done}/${targets.length} placed.`);
      }

      cam.x += (cameraTarget((view.x + 0.5) * T, rt.W, levelW) - cam.x) * Math.min(1, 8 * dt);
      cam.y += (cameraTarget((view.y + 0.5) * T, rt.H, levelH) - cam.y) * Math.min(1, 8 * dt);

      rt.hud({
        [th.boxName]: `${done}/${targets.length}`,
        moves,
        pushes,
        left: cfg.rules.moveLimit > 0 ? cfg.rules.moveLimit - moves : undefined,
      });
    },

    draw(ctx) {
      ctx.save();
      ctx.translate(-Math.round(cam.x), -Math.round(cam.y));

      for (let y = 0; y < level.h; y++) {
        for (let x = 0; x < level.w; x++) {
          const px = x * T;
          const py = y * T;
          if (isWall(level, x, y)) {
            drawTile(ctx, style, px, py, T, T, th.wall, {
              top: !isWall(level, x, y - 1),
              bottom: !isWall(level, x, y + 1),
              left: !isWall(level, x - 1, y),
              right: !isWall(level, x + 1, y),
            });
          } else if (th.floorPattern === 'checker' && (x + y) % 2 === 0) {
            ctx.fillStyle = shade(th.floor, 0.05);
            ctx.fillRect(px, py, T, T);
          }
        }
      }

      // Targets: a ring, drawn under everything so a placed crate covers it.
      for (const t of targets) {
        const cx = t.x * T + T / 2;
        const cy = t.y * T + T / 2;
        ctx.save();
        if (style.tile.mode === 'glow') {
          ctx.shadowColor = th.target;
          ctx.shadowBlur = 8;
        }
        ctx.strokeStyle = th.target;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, T * 0.24, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      boxes.forEach((b, i) => {
        const done = onTarget(b.x, b.y);
        const px = boxView[i].x * T;
        const py = boxView[i].y * T;
        const pad = T * 0.08;
        // A crate is a solid object, so it uses the terrain renderer — that's
        // what keeps it in the same visual language as the walls.
        drawTile(ctx, style, px + pad, py + pad, T - pad * 2, T - pad * 2,
                 done ? mix(th.box, th.accent, 0.55) : th.box,
                 { top: true, bottom: true, left: true, right: true });
        ctx.fillStyle = done ? th.accent : shade(th.box, -0.28);
        ctx.fillRect(px + T * 0.38, py + T * 0.38, T * 0.24, T * 0.24);

        if (hooks.has('deadlockWarning') && !done && inDeadCorner(level, b.x, b.y)) {
          // This crate can never move again. Say so, rather than letting the
          // player keep pushing at a puzzle that is already lost.
          ctx.strokeStyle = th.stuck;
          ctx.lineWidth = 2;
          ctx.strokeRect(px + 1, py + 1, T - 2, T - 2);
        }
      });

      drawParticles(ctx, style, particles);
      art.player.draw(ctx, view.x * T + (T - ps) / 2, view.y * T + (T - ps) / 2, ps, ps, 1);
      ctx.restore();
    },
  };
}

if (typeof document !== 'undefined') boot(makeGame, { width: 480, height: 270 });
export default makeGame;
