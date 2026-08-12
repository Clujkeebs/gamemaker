// endless-runner — the world comes at you; jump or duck.
//
// ENGINE CODE. Never written or edited by the generator.
// No authored level at all: obstacles are spawned from a seeded stream with a
// documented minimum gap, so "unclearable level" is prevented by construction
// rather than by a check. That makes this the safest template in the library.

import { boot, hit, skyGradient } from '../../shared/runtime.js';
import { shade, mix, rng } from '../../shared/draw.js';
import { getSprite, rampFor } from '../../shared/sprites.js';
import { getStyle } from '../../shared/styles.js';
import { drawTile, drawHazard, drawParticles } from '../../shared/render.js';

const HOOKS = ['doubleJump', 'duck', 'dash', 'magnet', 'shield'];

function makeGame(cfg, rt) {
  const th = cfg.theme;
  const style = getStyle(cfg.style);
  const hooks = new Set((cfg.mechanicHooks ?? []).filter((h) => HOOKS.includes(h)));
  const rand = rng((cfg.seed ?? 13) || 13);
  const W = rt.W;
  const H = rt.H;

  // The action has to sit in the frame, not along the bottom edge. Jump apex is
  // roughly jumpPower²/(2·gravity) above this line, so leaving ~70px of ground
  // below puts the whole arc inside the middle of the screen.
  const GROUND = H - 70;
  const ps = cfg.entities.player.size;
  const art = {
    player: getSprite(cfg.entities.player.sprite, rampFor(th.player, th.accent, style), style, ps * 2),
    obstacle: getSprite(cfg.entities.obstacle.sprite, rampFor(th.obstacle, th.accent, style), style, 32),
    pickup: getSprite({ pickup: cfg.entities.pickup.icon }, rampFor(th.pickup, th.pickup, style), style, 20),
  };

  const player = {
    x: 62, y: GROUND - ps, w: ps, h: ps,
    vy: 0, onGround: true, jumps: 0,
    duckT: 0, dashT: 0, dashCd: 0, hurtT: 0, shieldT: 0,
  };

  let obstacles = [];
  let pickups = [];
  let particles = [];
  let spawnIn = 0.9;
  let distance = 0;
  let score = 0;
  let lives = cfg.rules.lives;
  let shakeT = 0;
  let scroll = 0;

  // Speed ramps with distance, capped. The cap is what keeps a long run
  // playable instead of turning into a slideshow of unavoidable walls.
  const speedNow = () =>
    Math.min(cfg.run.maxSpeed, cfg.run.speed + distance * cfg.run.ramp);

  function burst(x, y, color, n = 8) {
    for (let i = 0; i < n; i++)
      particles.push({
        x, y, life: 0.3 + rand() * 0.3, color,
        vx: -speedNow() * 0.4 + (rand() - 0.5) * 150, vy: (rand() - 0.6) * 170,
      });
  }

  function spawn() {
    const kind = rand();
    const ducking = hooks.has('duck');
    // Only spawn overhead bars when the player can actually duck under them.
    if (ducking && kind < 0.3) {
      obstacles.push({ x: W + 20, y: GROUND - ps * 2.1, w: 26, h: 14, type: 'high' });
    } else if (kind < 0.62) {
      const h = 16 + rand() * 16;
      obstacles.push({ x: W + 20, y: GROUND - h, w: 16 + rand() * 10, h, type: 'ground' });
    } else {
      const h = 14 + rand() * 10;
      obstacles.push({ x: W + 20, y: GROUND - h, w: 14, h, type: 'hazard' });
    }
    if (rand() < cfg.run.pickupChance) {
      pickups.push({
        x: W + 20 + rand() * 40,
        y: GROUND - (30 + rand() * 46),
        taken: false, bob: rand() * 6.28,
      });
    }
    // Gap in seconds, converted to distance by current speed: the faster it
    // gets, the further apart things spawn, so reaction time stays constant.
    spawnIn = cfg.run.gapSeconds * (0.75 + rand() * 0.6);
  }

  function hurt() {
    if (player.hurtT > 0 || player.dashT > 0) return;
    if (hooks.has('shield') && player.shieldT > 0) {
      player.shieldT = 0;
      burst(player.x + player.w, player.y + player.h / 2, th.accent, 12);
      return;
    }
    lives -= 1;
    player.hurtT = 1.1;
    shakeT = 0.3;
    burst(player.x + player.w / 2, player.y + player.h / 2, th.player, 14);
    if (lives <= 0) rt.lose(`Ran ${Math.floor(distance)}m. ${score} points.`);
  }

  return {
    background: th.skyBottom,

    update(dt) {
      const { input } = rt;
      const speed = speedNow();
      distance += (speed * dt) / 10;
      scroll += speed * dt;

      player.hurtT = Math.max(0, player.hurtT - dt);
      player.dashCd = Math.max(0, player.dashCd - dt);
      player.dashT = Math.max(0, player.dashT - dt);
      player.shieldT = Math.max(0, player.shieldT - dt);
      shakeT = Math.max(0, shakeT - dt);

      // --- input -----------------------------------------------------------
      const maxJumps = hooks.has('doubleJump') ? 2 : 1;
      if (input.tapped('jump') && (player.onGround || player.jumps < maxJumps)) {
        player.vy = -cfg.run.jumpPower;
        player.jumps += 1;
        player.onGround = false;
        player.duckT = 0;
      }
      if (!input.down('jump') && player.vy < 0) player.vy *= 0.86;

      if (hooks.has('duck')) {
        player.duckT = input.down('down') && player.onGround ? 1 : 0;
      }
      if (hooks.has('dash') && input.tapped('dash') && player.dashCd <= 0) {
        player.dashT = 0.28;
        player.dashCd = 2.2;
        burst(player.x, player.y + player.h / 2, th.accent, 8);
      }

      player.vy += cfg.run.gravity * dt;
      player.y += player.vy * dt;
      if (player.y + player.h >= GROUND) {
        player.y = GROUND - player.h;
        player.vy = 0;
        player.onGround = true;
        player.jumps = 0;
      }

      // Ducking shrinks the hitbox rather than moving the sprite, which is what
      // makes sliding under a bar feel fair.
      player.h = player.duckT ? ps * 0.55 : ps;
      if (player.onGround) player.y = GROUND - player.h;
      player.w = ps;

      // --- world -----------------------------------------------------------
      spawnIn -= dt;
      if (spawnIn <= 0) spawn();

      for (const o of obstacles) {
        o.x -= speed * dt;
        if (hit(player, o)) {
          if (player.dashT > 0 && o.type !== 'high') {
            o.dead = true;
            score += cfg.rules.smashScore;
            burst(o.x, o.y + o.h / 2, th.obstacle, 10);
          } else hurt();
        }
      }
      obstacles = obstacles.filter((o) => o.x > -60 && !o.dead);

      const pcx = player.x + player.w / 2;
      const pcy = player.y + player.h / 2;
      for (const p of pickups) {
        p.x -= speed * dt;
        p.bob += dt * 3;
        if (hooks.has('magnet')) {
          const d = Math.hypot(p.x - pcx, p.y - pcy);
          if (d < 66 && d > 1) {
            p.x += ((pcx - p.x) / d) * 130 * dt;
            p.y += ((pcy - p.y) / d) * 130 * dt;
          }
        }
        if (!p.taken && Math.abs(p.x - pcx) < 12 && Math.abs(p.y - pcy) < 14) {
          p.taken = true;
          score += cfg.rules.pickupScore;
          burst(p.x, p.y, th.pickup, 7);
        }
      }
      pickups = pickups.filter((p) => p.x > -30 && !p.taken);

      for (const p of particles) {
        p.life -= dt;
        p.vy += style.particle.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      particles = particles.filter((p) => p.life > 0);

      if (cfg.rules.win === 'distance' && distance >= cfg.rules.targetDistance) {
        return rt.win(`${cfg.rules.targetDistance}m. ${score} points.`);
      }

      rt.hud({
        score,
        m: Math.floor(distance),
        lives: '♥'.repeat(Math.max(0, lives)),
        goal: cfg.rules.win === 'distance' ? `${cfg.rules.targetDistance}m` : undefined,
      });
    },

    draw(ctx) {
      skyGradient(ctx, W, H, th.skyTop, th.skyBottom);

      // Parallax bands. Cheap, and without them there is no sense of speed at all.
      ctx.save();
      ctx.globalAlpha = style.backdropAlpha;
      ctx.fillStyle = mix(th.skyTop, th.ground, 0.4);
      for (let i = 0; i < 7; i++) {
        const x = ((i * 140 - scroll * 0.25) % (W + 280)) - 140;
        ctx.beginPath();
        ctx.arc(x, GROUND + 12, 74, Math.PI, 0);
        ctx.fill();
      }
      ctx.restore();

      ctx.save();
      if (shakeT > 0) ctx.translate((rand() - 0.5) * 6, (rand() - 0.5) * 6);

      // Ground as a run of tiles, scrolling, so it uses the style's terrain look.
      const T = 18;
      const off = scroll % T;
      // Sides marked open so each tile keeps its edge: without those seams the
      // ground is a flat slab and the scroll becomes invisible, which is fatal
      // in a game whose whole feeling is speed.
      for (let x = -T; x < W + T; x += T) {
        drawTile(ctx, style, Math.round(x - off), GROUND, T, H - GROUND, th.ground, {
          top: true, bottom: false, left: true, right: true,
        });
      }

      for (const o of obstacles) {
        if (o.type === 'hazard') {
          drawHazard(ctx, style, o.x, o.y + o.h - 16, Math.max(o.w, 16), th.hazard, rt.time);
        } else {
          art.obstacle.draw(ctx, o.x, o.y, o.w, o.h, -1);
        }
      }

      for (const p of pickups) {
        const s = cfg.entities.pickup.size;
        art.pickup.draw(ctx, p.x - s / 2, p.y - s / 2 + Math.sin(p.bob) * 2, s, s, 1);
      }

      drawParticles(ctx, style, particles);

      if (!(player.hurtT > 0 && Math.floor(rt.time * 20) % 2)) {
        if (player.dashT > 0) {
          ctx.globalAlpha = 0.3;
          art.player.draw(ctx, player.x - 12, player.y, player.w, player.h, 1);
          ctx.globalAlpha = 1;
        }
        art.player.draw(ctx, player.x, player.y, player.w, player.h, 1);
        if (hooks.has('shield') && player.shieldT > 0) {
          ctx.strokeStyle = mix(th.accent, '#ffffff', 0.35);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(player.x + player.w / 2, player.y + player.h / 2, player.w * 0.95, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    },
  };
}

if (typeof document !== 'undefined') boot(makeGame, { width: 480, height: 270 });
export default makeGame;
