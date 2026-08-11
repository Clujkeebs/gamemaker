// top-down-collector — move in 8 directions, gather things, avoid what's chasing you.
//
// ENGINE CODE. Never written or edited by the generator.
// The other safe default alongside platformer-classic: no gravity means far
// fewer ways for a generated level to be unplayable.

import { boot, hit, cameraTarget } from '../../shared/runtime.js';
import { shade, mix, rng, hashString } from '../../shared/draw.js';
import { TILE, parseGrid, at, isSolid, findAll, findOne } from '../../shared/tiles.js';
import { getSprite, rampFor } from '../../shared/sprites.js';
import { getStyle } from '../../shared/styles.js';
import { drawTile, drawHazard, drawParticles, drawGoal } from '../../shared/render.js';

const HOOKS = ['dash', 'sprint', 'lantern', 'magnet'];

function makeGame(cfg, rt) {
  const T = cfg.level.tileSize;
  const grid = parseGrid(cfg.level.grid);
  const hooks = new Set((cfg.mechanicHooks ?? []).filter((h) => HOOKS.includes(h)));
  const th = cfg.theme;
  const style = getStyle(cfg.style);
  const rand = rng(hashString(JSON.stringify(cfg.level.grid)) ^ (cfg.seed ?? 3));

  const art = {
    player: getSprite(cfg.entities.player.sprite, rampFor(th.player, th.accent, style), style, cfg.entities.player.size * 2),
    enemy: getSprite(cfg.entities.enemy.sprite, rampFor(th.enemy, th.accent, style), style, cfg.entities.enemy.size * 2),
    pickup: getSprite({ pickup: cfg.entities.pickup.icon }, rampFor(th.pickup, th.pickup, style), style, cfg.entities.pickup.size * 2),
  };

  const levelW = grid.w * T;
  const levelH = grid.h * T;
  const spawn = findOne(grid, TILE.SPAWN) ?? { x: 1, y: 1 };
  const goalTile = findOne(grid, TILE.GOAL);

  const ps = cfg.entities.player.size;
  const player = {
    x: spawn.x * T + (T - ps) / 2, y: spawn.y * T + (T - ps) / 2,
    w: ps, h: ps, vx: 0, vy: 0, facing: 1,
    dashT: 0, dashCd: 0, hurtT: 0,
  };

  const pickups = findAll(grid, TILE.PICKUP).map((p) => ({
    x: p.x * T + T / 2, y: p.y * T + T / 2, taken: false, bob: rand() * 6.28,
  }));
  const totalPickups = pickups.length;

  const es = cfg.entities.enemy.size;
  const enemies = findAll(grid, TILE.ENEMY).map((e, i) => {
    const ang = rand() * Math.PI * 2;
    return {
      x: e.x * T + (T - es) / 2, y: e.y * T + (T - es) / 2, w: es, h: es,
      vx: Math.cos(ang), vy: Math.sin(ang), home: { x: e.x * T, y: e.y * T },
      think: 0, id: i,
    };
  });

  let particles = [];
  let score = 0;
  let lives = cfg.rules.lives;
  let collected = 0;
  let timeLeft = cfg.rules.timeLimit > 0 ? cfg.rules.timeLimit : null;
  const cam = { x: 0, y: 0 };
  let shakeT = 0;

  function blocked(x, y, w, h) {
    const x0 = Math.floor(x / T);
    const x1 = Math.floor((x + w - 0.01) / T);
    const y0 = Math.floor(y / T);
    const y1 = Math.floor((y + h - 0.01) / T);
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) if (isSolid(at(grid, tx, ty))) return true;
    return false;
  }

  function slide(ent, dx, dy) {
    if (dx && !blocked(ent.x + dx, ent.y, ent.w, ent.h)) ent.x += dx;
    else if (dx) ent.vx = 0;
    if (dy && !blocked(ent.x, ent.y + dy, ent.w, ent.h)) ent.y += dy;
    else if (dy) ent.vy = 0;
  }

  function burst(x, y, color, n = 8) {
    for (let i = 0; i < n; i++)
      particles.push({
        x, y, life: 0.35 + rand() * 0.3, color,
        vx: (rand() - 0.5) * 170, vy: (rand() - 0.5) * 170,
      });
  }

  function hurt() {
    if (player.hurtT > 0) return;
    lives -= 1;
    player.hurtT = 1.3;
    shakeT = 0.3;
    burst(player.x + player.w / 2, player.y + player.h / 2, th.player, 14);
    if (lives <= 0)
      return rt.lose(`Caught with ${collected}/${totalPickups} ${th.pickupName} in hand.`);
    player.x = spawn.x * T + (T - ps) / 2;
    player.y = spawn.y * T + (T - ps) / 2;
    player.vx = player.vy = 0;
  }

  return {
    background: th.floor,

    update(dt) {
      const { input } = rt;
      const mv = cfg.movement;

      if (timeLeft !== null) {
        timeLeft -= dt;
        if (timeLeft <= 0) return rt.lose("Time's up.");
      }
      player.hurtT = Math.max(0, player.hurtT - dt);
      player.dashCd = Math.max(0, player.dashCd - dt);
      player.dashT = Math.max(0, player.dashT - dt);
      shakeT = Math.max(0, shakeT - dt);

      let dx = (input.down('right') ? 1 : 0) - (input.down('left') ? 1 : 0);
      let dy = (input.down('down') ? 1 : 0) - (input.down('up') ? 1 : 0);
      if (!mv.diagonal && dx && dy) dy = 0;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      if (dx) player.facing = Math.sign(dx);

      if (hooks.has('dash') && input.tapped('dash') && player.dashCd <= 0 && (dx || dy)) {
        player.dashT = 0.14;
        player.dashCd = 0.7;
        burst(player.x + player.w / 2, player.y + player.h / 2, th.accent, 6);
      }

      const sprinting = hooks.has('sprint') && input.down('dash');
      const speed = mv.speed * (player.dashT > 0 ? 3.1 : sprinting ? 1.5 : 1);
      player.vx += (dx * speed - player.vx) * Math.min(1, mv.accel * dt);
      player.vy += (dy * speed - player.vy) * Math.min(1, mv.accel * dt);
      slide(player, player.vx * dt, player.vy * dt);
      player.x = Math.max(0, Math.min(levelW - player.w, player.x));
      player.y = Math.max(0, Math.min(levelH - player.h, player.y));

      const pcx = player.x + player.w / 2;
      const pcy = player.y + player.h / 2;

      if (at(grid, Math.floor(pcx / T), Math.floor(pcy / T)) === TILE.HAZARD) hurt();

      for (const p of pickups) {
        if (p.taken) continue;
        p.bob += dt * 3;
        if (hooks.has('magnet')) {
          const d = Math.hypot(p.x - pcx, p.y - pcy);
          if (d < T * 3.5 && d > 1) {
            p.x += ((pcx - p.x) / d) * 70 * dt;
            p.y += ((pcy - p.y) / d) * 70 * dt;
          }
        }
        if (Math.abs(p.x - pcx) < T * 0.65 && Math.abs(p.y - pcy) < T * 0.65) {
          p.taken = true;
          collected += 1;
          score += cfg.rules.pickupScore;
          burst(p.x, p.y, th.pickup, 7);
          if (cfg.rules.win === 'collectAll' && collected >= totalPickups)
            return rt.win(`Every last one of the ${totalPickups} ${th.pickupName}.`);
        }
      }

      const espeed = cfg.entities.enemy.speed;
      for (const e of enemies) {
        const ecx = e.x + e.w / 2;
        const ecy = e.y + e.h / 2;
        const dist = Math.hypot(pcx - ecx, pcy - ecy);
        e.think -= dt;

        switch (cfg.entities.enemy.behavior) {
          case 'chase':
            if (dist > 1) {
              e.vx = ((pcx - ecx) / dist) * espeed;
              e.vy = ((pcy - ecy) / dist) * espeed;
            }
            break;
          case 'guard': {
            const hx = e.home.x + T / 2 - ecx;
            const hy = e.home.y + T / 2 - ecy;
            if (dist < T * 4.5) {
              e.vx = ((pcx - ecx) / dist) * espeed;
              e.vy = ((pcy - ecy) / dist) * espeed;
            } else if (Math.hypot(hx, hy) > T * 0.4) {
              const hd = Math.hypot(hx, hy);
              e.vx = (hx / hd) * espeed * 0.7;
              e.vy = (hy / hd) * espeed * 0.7;
            } else e.vx = e.vy = 0;
            break;
          }
          case 'wander':
            if (e.think <= 0) {
              const a = rand() * Math.PI * 2;
              e.vx = Math.cos(a) * espeed;
              e.vy = Math.sin(a) * espeed;
              e.think = 0.6 + rand() * 1.2;
            }
            break;
          default: { // patrol: straight lines, bounce off walls
            const nx = e.x + e.vx * dt;
            const ny = e.y + e.vy * dt;
            if (blocked(nx, e.y, e.w, e.h)) e.vx *= -1;
            if (blocked(e.x, ny, e.w, e.h)) e.vy *= -1;
            const m = Math.hypot(e.vx, e.vy) || 1;
            e.vx = (e.vx / m) * espeed;
            e.vy = (e.vy / m) * espeed;
          }
        }
        slide(e, e.vx * dt, e.vy * dt);
        if (hit(player, e)) hurt();
      }

      for (const p of particles) {
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.94;
        p.vy *= 0.94;
      }
      particles = particles.filter((p) => p.life > 0);

      if (cfg.rules.win === 'survive' && rt.time >= cfg.rules.surviveSeconds)
        return rt.win(`Survived ${cfg.rules.surviveSeconds} seconds. ${score} points.`);

      if (goalTile && cfg.rules.win === 'reachGoal') {
        const g = { x: goalTile.x * T, y: goalTile.y * T, w: T, h: T };
        if (hit(player, g) && (!cfg.rules.goalNeedsAll || collected >= totalPickups))
          return rt.win(`Out clean with ${score} points.`);
      }

      cam.x += (cameraTarget(pcx, rt.W, levelW) - cam.x) * Math.min(1, 8 * dt);
      cam.y += (cameraTarget(pcy, rt.H, levelH) - cam.y) * Math.min(1, 8 * dt);

      rt.hud({
        score,
        [th.pickupName]: `${collected}/${totalPickups}`,
        lives: '♥'.repeat(Math.max(0, lives)),
        time: timeLeft !== null ? Math.ceil(timeLeft) : undefined,
      });
    },

    draw(ctx) {
      ctx.save();
      const sx = shakeT > 0 ? (rand() - 0.5) * 6 : 0;
      ctx.translate(-Math.round(cam.x) + sx, -Math.round(cam.y));

      const x0 = Math.max(0, Math.floor(cam.x / T) - 1);
      const x1 = Math.min(grid.w - 1, Math.ceil((cam.x + rt.W) / T));
      const y0 = Math.max(0, Math.floor(cam.y / T) - 1);
      const y1 = Math.min(grid.h - 1, Math.ceil((cam.y + rt.H) / T));

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const ch = grid.cells[y][x];
          const px = x * T;
          const py = y * T;
          if (ch === TILE.SOLID) {
            drawTile(ctx, style, px, py, T, T, th.wall, {
              top: !isSolid(at(grid, x, y - 1)),
              bottom: !isSolid(at(grid, x, y + 1)),
              left: !isSolid(at(grid, x - 1, y)),
              right: !isSolid(at(grid, x + 1, y)),
            });
          } else {
            if (th.floorPattern === 'checker' && (x + y) % 2 === 0) {
              ctx.fillStyle = shade(th.floor, 0.05);
              ctx.fillRect(px, py, T, T);
            } else if (th.floorPattern === 'grid') {
              ctx.strokeStyle = shade(th.floor, 0.08);
              ctx.lineWidth = 1;
              ctx.strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);
            }
            if (ch === TILE.HAZARD) drawHazard(ctx, style, px, py, T, th.hazard, rt.time);
          }
        }
      }

      if (goalTile) drawGoal(ctx, style, goalTile.x * T, goalTile.y * T, T, th.goal, rt.time, 'pad');

      for (const p of pickups) {
        if (p.taken) continue;
        const s = cfg.entities.pickup.size;
        art.pickup.draw(ctx, p.x - s / 2, p.y - s / 2 + Math.sin(p.bob) * 1.5, s, s, 1);
      }

      for (const e of enemies) {
        art.enemy.draw(ctx, e.x, e.y, e.w, e.h, Math.sign(e.vx) || 1);
      }

      drawParticles(ctx, style, particles);

      if (!(player.hurtT > 0 && Math.floor(rt.time * 20) % 2)) {
        art.player.draw(ctx, player.x, player.y, player.w, player.h, player.facing);
      }
      ctx.restore();

      // Lantern is drawn in screen space, after the camera pops — it's a vignette
      // over the whole view, not an object in the world.
      if (hooks.has('lantern')) {
        const cx = player.x + player.w / 2 - cam.x;
        const cy = player.y + player.h / 2 - cam.y;
        // Wide and soft on purpose. A tight, near-opaque vignette hides so much
        // of the maze that the game stops being playable — the hook is meant to
        // set a mood, not to blindfold you.
        const g = ctx.createRadialGradient(cx, cy, T * 2.6, cx, cy, T * 9);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(0.55, `${mix(th.floor, '#000000', 0.45)}aa`);
        g.addColorStop(1, `${mix(th.floor, '#000000', 0.62)}ee`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, rt.W, rt.H);
      }
    },
  };
}

if (typeof document !== 'undefined') boot(makeGame, { width: 480, height: 270 });
export default makeGame;
