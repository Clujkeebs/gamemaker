// platformer-classic — gravity, jumping, pickups, hazards, a goal flag.
//
// ENGINE CODE. Never written or edited by the generator; it only ever supplies
// a config. Every number it can set is bounded in schema.json, and every
// optional behaviour is a hook listed there. If a game idea needs something
// this file can't do, that's a template switch, not an edit to this file.

import { boot, hit, skyGradient, cameraTarget } from '../../shared/runtime.js';
import { shape, eyes, shade, mix, rng, hashString } from '../../shared/draw.js';
import { TILE, parseGrid, at, isSolid, findAll, findOne } from '../../shared/tiles.js';

const HOOKS = ['doubleJump', 'dash', 'wallJump', 'stomp', 'shoot', 'gravityFlip'];

function makeGame(cfg, rt) {
  const T = cfg.level.tileSize;
  const grid = parseGrid(cfg.level.grid);
  const hooks = new Set((cfg.mechanicHooks ?? []).filter((h) => HOOKS.includes(h)));
  const th = cfg.theme;
  const rand = rng(hashString(JSON.stringify(cfg.level.grid)) ^ (cfg.seed ?? 7));

  const levelW = grid.w * T;
  const levelH = grid.h * T;
  const spawn = findOne(grid, TILE.SPAWN) ?? { x: 1, y: 1 };
  const goalTile = findOne(grid, TILE.GOAL);

  const ps = cfg.entities.player.size;
  const player = {
    x: spawn.x * T + (T - ps) / 2, y: spawn.y * T + (T - ps),
    w: ps, h: ps, vx: 0, vy: 0,
    onGround: false, facing: 1, jumps: 0, flip: 1,
    dashT: 0, dashCd: 0, fireCd: 0, hurtT: 0, wallDir: 0,
  };

  let pickups = findAll(grid, TILE.PICKUP).map((p) => ({
    x: p.x * T + T / 2, y: p.y * T + T / 2, taken: false, bob: rand() * 6.28,
  }));
  const totalPickups = pickups.length;

  const es = cfg.entities.enemy.size;
  let enemies = findAll(grid, TILE.ENEMY).map((e) => ({
    x: e.x * T + (T - es) / 2, y: e.y * T + (T - es),
    w: es, h: es, vx: cfg.entities.enemy.speed * (rand() < 0.5 ? -1 : 1), vy: 0,
    alive: true, hopT: rand() * 1.5,
  }));

  let bullets = [];
  let particles = [];
  let score = 0;
  let lives = cfg.rules.lives;
  let collected = 0;
  let timeLeft = cfg.rules.timeLimit > 0 ? cfg.rules.timeLimit : null;
  let cam = { x: 0, y: 0 };
  let shakeT = 0;

  const solidAt = (tx, ty) => isSolid(at(grid, tx, ty));

  // One-way platforms are solid only when falling onto them from above.
  function blocked(x, y, w, h, vy) {
    const x0 = Math.floor(x / T);
    const x1 = Math.floor((x + w - 0.01) / T);
    const y0 = Math.floor(y / T);
    const y1 = Math.floor((y + h - 0.01) / T);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const ch = at(grid, tx, ty);
        if (isSolid(ch)) return true;
        if (ch === TILE.ONEWAY && vy > 0 && y + h - vy * 0.02 <= ty * T + 2) return true;
      }
    }
    return false;
  }

  function moveAxis(ent, dx, dy) {
    if (dx) {
      const nx = ent.x + dx;
      if (blocked(nx, ent.y, ent.w, ent.h, 0)) {
        ent.x = dx > 0 ? Math.ceil((ent.x + ent.w) / T) * T - ent.w - 0.01
                       : Math.floor(ent.x / T) * T + T + 0.01;
        ent.wallDir = dx > 0 ? 1 : -1;
        ent.vx = 0;
        return true;
      }
      ent.x = nx;
    }
    if (dy) {
      const ny = ent.y + dy;
      if (blocked(ent.x, ny, ent.w, ent.h, dy)) {
        ent.y = dy > 0 ? Math.ceil((ent.y + ent.h) / T) * T - ent.h - 0.01
                       : Math.floor(ent.y / T) * T + T + 0.01;
        ent.vy = 0;
        return true;
      }
      ent.y = ny;
    }
    return false;
  }

  function burst(x, y, color, n = 8) {
    for (let i = 0; i < n; i++) {
      particles.push({
        x, y, life: 0.4 + rand() * 0.3, color,
        vx: (rand() - 0.5) * 190, vy: (rand() - 0.7) * 190,
      });
    }
  }

  function hurt() {
    if (player.hurtT > 0) return;
    lives -= 1;
    player.hurtT = 1.2;
    shakeT = 0.28;
    burst(player.x + player.w / 2, player.y + player.h / 2, th.player, 14);
    if (lives <= 0) return rt.lose(`Out of lives on ${collected}/${totalPickups} ${cfg.theme.pickupName}.`);
    player.x = spawn.x * T + (T - ps) / 2;
    player.y = spawn.y * T + (T - ps);
    player.vx = player.vy = 0;
    player.flip = 1;
  }

  const won = () => {
    rt.win(cfg.rules.win === 'collectAll'
      ? `All ${totalPickups} ${cfg.theme.pickupName} collected.`
      : `You made it. ${score} points.`);
  };

  return {
    background: th.skyBottom,

    update(dt) {
      const { input } = rt;
      const ph = cfg.physics;

      if (timeLeft !== null) {
        timeLeft -= dt;
        if (timeLeft <= 0) return rt.lose("Time's up.");
      }
      player.hurtT = Math.max(0, player.hurtT - dt);
      player.dashCd = Math.max(0, player.dashCd - dt);
      player.fireCd = Math.max(0, player.fireCd - dt);
      shakeT = Math.max(0, shakeT - dt);

      // --- input -> intent -------------------------------------------------
      const dir = (input.down('right') ? 1 : 0) - (input.down('left') ? 1 : 0);
      if (dir) player.facing = dir;

      if (hooks.has('gravityFlip') && input.tapped('down') && player.onGround) {
        player.flip *= -1;
        player.vy = -ph.jumpPower * 0.35 * player.flip;
        player.onGround = false;
      }

      if (hooks.has('dash') && input.tapped('dash') && player.dashCd <= 0) {
        player.dashT = 0.16;
        player.dashCd = 0.6;
        burst(player.x + player.w / 2, player.y + player.h / 2, th.accent, 6);
      }

      if (hooks.has('shoot') && input.tapped('fire') && player.fireCd <= 0) {
        player.fireCd = 0.28;
        bullets.push({
          x: player.x + player.w / 2, y: player.y + player.h / 2,
          vx: 300 * player.facing, w: 5, h: 3, life: 1.1,
        });
      }

      const maxJumps = hooks.has('doubleJump') ? 2 : 1;
      if (input.tapped('jump')) {
        if (player.onGround || player.jumps < maxJumps) {
          player.vy = -ph.jumpPower * player.flip;
          player.jumps += 1;
          player.onGround = false;
        } else if (hooks.has('wallJump') && player.wallDir) {
          player.vy = -ph.jumpPower * 0.95 * player.flip;
          player.vx = -player.wallDir * ph.moveSpeed * 1.1;
          player.jumps = 1;
        }
      }
      // Variable jump height: releasing early cuts the arc. Cheap, and it's most
      // of what makes a platformer feel responsive rather than floaty.
      if (!input.down('jump') && player.vy * player.flip < 0) player.vy *= 0.86;

      // --- physics ---------------------------------------------------------
      const target = dir * ph.moveSpeed * (player.dashT > 0 ? 2.6 : 1);
      const accel = player.onGround ? ph.friction : ph.friction * 0.55;
      player.vx += (target - player.vx) * Math.min(1, accel * dt);
      player.dashT = Math.max(0, player.dashT - dt);

      if (player.dashT > 0) player.vy *= 0.55;
      player.vy += ph.gravity * player.flip * dt;
      player.vy = Math.max(-620, Math.min(620, player.vy));

      player.wallDir = 0;
      moveAxis(player, player.vx * dt, 0);
      const landed = moveAxis(player, 0, player.vy * dt);
      player.onGround = landed && ((player.flip > 0 && player.vy >= 0) || (player.flip < 0 && player.vy <= 0));
      if (player.onGround) player.jumps = 0;

      if (player.y > levelH + 80 || player.y < -140) hurt();
      player.x = Math.max(0, Math.min(levelW - player.w, player.x));

      // --- world -----------------------------------------------------------
      const ptx = Math.floor((player.x + player.w / 2) / T);
      const pty = Math.floor((player.y + player.h / 2) / T);
      if (at(grid, ptx, pty) === TILE.HAZARD) hurt();

      for (const p of pickups) {
        if (p.taken) continue;
        p.bob += dt * 3;
        if (Math.abs(p.x - (player.x + player.w / 2)) < T * 0.7 &&
            Math.abs(p.y - (player.y + player.h / 2)) < T * 0.7) {
          p.taken = true;
          collected += 1;
          score += cfg.rules.pickupScore;
          burst(p.x, p.y, th.pickup, 7);
          if (cfg.rules.win === 'collectAll' && collected >= totalPickups) return won();
        }
      }

      const speed = cfg.entities.enemy.speed;
      for (const e of enemies) {
        if (!e.alive) continue;
        const beh = cfg.entities.enemy.behavior;
        if (beh === 'chase' && Math.abs(e.x - player.x) < T * 7) {
          e.vx = Math.sign(player.x - e.x) * speed;
        } else if (beh === 'hop') {
          e.hopT -= dt;
          if (e.hopT <= 0 && e.vy === 0) {
            e.vy = -ph.jumpPower * 0.7;
            e.hopT = 1.4;
          }
        }
        e.vy += ph.gravity * dt;
        if (moveAxis(e, e.vx * dt, 0)) e.vx *= -1;
        // Patrollers turn at ledges instead of walking off into the void.
        if (beh !== 'chase') {
          const ahead = Math.floor((e.x + (e.vx > 0 ? e.w + 2 : -2)) / T);
          const below = Math.floor((e.y + e.h + 2) / T);
          if (!solidAt(ahead, below) && at(grid, ahead, below) !== TILE.ONEWAY) e.vx *= -1;
        }
        moveAxis(e, 0, e.vy * dt);

        if (hit(player, e)) {
          const stomping = hooks.has('stomp') && player.vy * player.flip > 0 &&
            player.y + player.h - player.vy * dt <= e.y + e.h * 0.55;
          if (stomping) {
            e.alive = false;
            score += cfg.rules.pickupScore * 2;
            player.vy = -ph.jumpPower * 0.62 * player.flip;
            burst(e.x + e.w / 2, e.y + e.h / 2, th.enemy, 9);
          } else hurt();
        }
      }

      for (const b of bullets) {
        b.x += b.vx * dt;
        b.life -= dt;
        if (blocked(b.x, b.y, b.w, b.h, 0)) b.life = 0;
        for (const e of enemies) {
          if (e.alive && hit({ x: b.x, y: b.y, w: b.w, h: b.h }, e)) {
            e.alive = false;
            b.life = 0;
            score += cfg.rules.pickupScore * 2;
            burst(e.x + e.w / 2, e.y + e.h / 2, th.enemy, 9);
          }
        }
      }
      bullets = bullets.filter((b) => b.life > 0);

      for (const p of particles) {
        p.life -= dt;
        p.vy += 400 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      particles = particles.filter((p) => p.life > 0);

      if (cfg.rules.win === 'survive' && rt.time >= cfg.rules.surviveSeconds) return won();

      if (goalTile && cfg.rules.win === 'reachGoal') {
        const g = { x: goalTile.x * T, y: goalTile.y * T, w: T, h: T };
        if (hit(player, g) && (collected >= totalPickups || !cfg.rules.goalNeedsAll)) return won();
      }

      // --- camera ----------------------------------------------------------
      const tx = cameraTarget(player.x + player.w / 2, rt.W, levelW);
      const ty = cameraTarget(player.y + player.h / 2, rt.H, levelH);
      cam.x += (tx - cam.x) * Math.min(1, 9 * dt);
      cam.y += (ty - cam.y) * Math.min(1, 9 * dt);

      rt.hud({
        score,
        [cfg.theme.pickupName]: `${collected}/${totalPickups}`,
        lives: '♥'.repeat(Math.max(0, lives)),
        time: timeLeft !== null ? Math.ceil(timeLeft) : undefined,
      });
    },

    draw(ctx) {
      skyGradient(ctx, rt.W, rt.H, th.skyTop, th.skyBottom);
      drawBackdrop(ctx, th, cam, rt, rand);

      ctx.save();
      const sx = shakeT > 0 ? (rand() - 0.5) * 6 : 0;
      ctx.translate(-Math.round(cam.x) + sx, -Math.round(cam.y));

      // Only draw the tiles on screen. Big levels stay smooth on a phone.
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
            ctx.fillStyle = th.ground;
            ctx.fillRect(px, py, T, T);
            if (!isSolid(at(grid, x, y - 1))) {
              ctx.fillStyle = shade(th.ground, 0.22);
              ctx.fillRect(px, py, T, Math.max(2, T * 0.2));
            }
            ctx.fillStyle = shade(th.ground, -0.18);
            ctx.fillRect(px, py + T - 1, T, 1);
          } else if (ch === TILE.ONEWAY) {
            ctx.fillStyle = shade(th.ground, 0.3);
            ctx.fillRect(px, py, T, Math.max(3, T * 0.28));
          } else if (ch === TILE.HAZARD) {
            ctx.fillStyle = th.hazard;
            for (let i = 0; i < 3; i++) {
              const sxp = px + (T / 3) * i;
              ctx.beginPath();
              ctx.moveTo(sxp, py + T);
              ctx.lineTo(sxp + T / 6, py + T * 0.25);
              ctx.lineTo(sxp + T / 3, py + T);
              ctx.closePath();
              ctx.fill();
            }
          }
        }
      }

      if (goalTile) {
        const gx = goalTile.x * T;
        const gy = goalTile.y * T;
        const wave = Math.sin(rt.time * 4) * 2;
        ctx.fillStyle = shade(th.goal, -0.3);
        ctx.fillRect(gx + T * 0.16, gy, 2, T);
        ctx.fillStyle = th.goal;
        ctx.beginPath();
        ctx.moveTo(gx + T * 0.22, gy + 2);
        ctx.lineTo(gx + T * 0.9 + wave, gy + T * 0.26);
        ctx.lineTo(gx + T * 0.22, gy + T * 0.5);
        ctx.closePath();
        ctx.fill();
      }

      for (const p of pickups) {
        if (p.taken) continue;
        const s = cfg.entities.pickup.size;
        const by = p.y + Math.sin(p.bob) * 2;
        ctx.globalAlpha = 0.9;
        shape(ctx, cfg.entities.pickup.shape, p.x - s / 2, by - s / 2, s, s, th.pickup);
        ctx.globalAlpha = 1;
      }

      for (const e of enemies) {
        if (!e.alive) continue;
        shape(ctx, cfg.entities.enemy.shape, e.x, e.y, e.w, e.h, th.enemy);
        if (cfg.entities.enemy.eyes) eyes(ctx, e.x, e.y, e.w, e.h, Math.sign(e.vx) || 1);
      }

      ctx.fillStyle = th.accent;
      for (const b of bullets) ctx.fillRect(b.x, b.y, b.w, b.h);

      for (const p of particles) {
        ctx.globalAlpha = Math.max(0, p.life * 2);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;

      // Flicker while invulnerable so the hit actually reads.
      if (!(player.hurtT > 0 && Math.floor(rt.time * 20) % 2)) {
        ctx.save();
        if (player.flip < 0) {
          ctx.translate(0, player.y * 2 + player.h);
          ctx.scale(1, -1);
        }
        if (player.dashT > 0) {
          ctx.globalAlpha = 0.35;
          shape(ctx, cfg.entities.player.shape, player.x - player.vx * 0.03, player.y,
                player.w, player.h, th.accent);
          ctx.globalAlpha = 1;
        }
        shape(ctx, cfg.entities.player.shape, player.x, player.y, player.w, player.h, th.player);
        if (cfg.entities.player.eyes) eyes(ctx, player.x, player.y, player.w, player.h, player.facing);
        ctx.restore();
      }
      ctx.restore();
    },
  };
}

function drawBackdrop(ctx, th, cam, rt, rand) {
  const par = -cam.x * 0.35;
  ctx.save();
  // Held well back from the play layer. At full strength the trees and
  // buildings read as level geometry, which is worse than having no backdrop.
  ctx.globalAlpha = 0.42;
  ctx.fillStyle = mix(th.skyTop, th.ground, 0.35);
  switch (th.backdrop) {
    case 'hills':
      for (let i = -1; i < 6; i++) {
        const x = ((i * 150 + par) % 900) - 150;
        ctx.beginPath();
        ctx.arc(x, rt.H * 0.95, 96, Math.PI, 0);
        ctx.fill();
      }
      break;
    case 'city':
      for (let i = -1; i < 12; i++) {
        const x = ((i * 74 + par) % 1000) - 100;
        const h = 40 + ((i * 37) % 70);
        ctx.fillRect(x, rt.H - h, 52, h);
      }
      break;
    case 'stars':
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      for (let i = 0; i < 46; i++) {
        const x = (((i * 97) % 480) + par * 0.25 + 480) % 480;
        ctx.fillRect(x, (i * 53) % (rt.H * 0.7), 1.6, 1.6);
      }
      break;
    case 'forest':
      for (let i = -1; i < 9; i++) {
        const x = ((i * 96 + par) % 900) - 120;
        ctx.beginPath();
        ctx.moveTo(x, rt.H);
        ctx.lineTo(x + 34, rt.H - 118);
        ctx.lineTo(x + 68, rt.H);
        ctx.closePath();
        ctx.fill();
      }
      break;
    default:
      break;
  }
  ctx.restore();
}

// Self-booting in a browser, importable as a plain function in tests.
if (typeof document !== 'undefined') boot(makeGame, { width: 480, height: 270 });
export default makeGame;
