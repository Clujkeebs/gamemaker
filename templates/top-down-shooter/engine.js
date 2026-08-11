// top-down-shooter — waves of things come at you, you shoot them.
//
// ENGINE CODE. Never written or edited by the generator.
// No tilemap: the arena is an open box with procedurally placed cover, so there
// is no such thing as an unreachable objective here.

import { boot, hit } from '../../shared/runtime.js';
import { shade, mix, rng } from '../../shared/draw.js';
import { getSprite, rampFor } from '../../shared/sprites.js';
import { getStyle } from '../../shared/styles.js';
import { drawTile, drawParticles } from '../../shared/render.js';

const HOOKS = ['spread', 'pierce', 'dashRoll', 'shield', 'homing'];

function makeGame(cfg, rt) {
  const th = cfg.theme;
  const style = getStyle(cfg.style);
  const hooks = new Set((cfg.mechanicHooks ?? []).filter((h) => HOOKS.includes(h)));
  const rand = rng((cfg.seed ?? 5) || 5);
  const art = {
    player: getSprite(cfg.entities.player.sprite, rampFor(th.player, th.accent, style), style, cfg.entities.player.size * 2),
    enemy: getSprite(cfg.entities.enemy.sprite, rampFor(th.enemy, th.accent, style), style, cfg.entities.enemy.size * 2),
  };
  const W = rt.W;
  const H = rt.H;
  const M = 10; // arena wall inset

  // Cover blocks, placed once from the seed. Deterministic, and kept clear of
  // the middle so the player never spawns inside one.
  const cover = [];
  for (let i = 0; i < cfg.arena.coverCount; i++) {
    const w = 18 + rand() * 34;
    const h = 18 + rand() * 34;
    const x = M + 14 + rand() * (W - 2 * M - 28 - w);
    const y = M + 14 + rand() * (H - 2 * M - 28 - h);
    if (Math.hypot(x + w / 2 - W / 2, y + h / 2 - H / 2) < 44) continue;
    cover.push({ x, y, w, h });
  }

  const ps = cfg.entities.player.size;
  const player = {
    x: W / 2 - ps / 2, y: H / 2 - ps / 2, w: ps, h: ps,
    vx: 0, vy: 0, aim: 0, facing: 1, hp: cfg.rules.health,
    fireCd: 0, rollT: 0, rollCd: 0, hurtT: 0, shieldT: 0,
  };

  let enemies = [];
  let bullets = [];
  let foeShots = [];
  let particles = [];
  let score = 0;
  let wave = 0;
  let waveT = 1.2;
  let betweenWaves = true;
  let shakeT = 0;

  const overlapsCover = (x, y, w, h) => cover.some((c) => hit({ x, y, w, h }, c));

  function spawnWave() {
    wave += 1;
    const n = Math.round(cfg.waves.baseEnemies + (wave - 1) * cfg.waves.ramp);
    const es = cfg.entities.enemy.size;
    for (let i = 0; i < Math.min(n, 40); i++) {
      // Spawn on the arena edge, away from the player.
      const side = Math.floor(rand() * 4);
      const x = side === 0 ? M : side === 1 ? W - M - es : M + rand() * (W - 2 * M - es);
      const y = side === 2 ? M : side === 3 ? H - M - es : M + rand() * (H - 2 * M - es);
      enemies.push({
        x, y, w: es, h: es, vx: 0, vy: 0,
        hp: cfg.entities.enemy.hp + Math.floor((wave - 1) * cfg.waves.hpRamp),
        fireCd: 1 + rand() * 2, wobble: rand() * 6.28,
      });
    }
    betweenWaves = false;
  }

  function burst(x, y, color, n = 9) {
    for (let i = 0; i < n; i++)
      particles.push({
        x, y, life: 0.3 + rand() * 0.35, color,
        vx: (rand() - 0.5) * 230, vy: (rand() - 0.5) * 230,
      });
  }

  function hurtPlayer(amount) {
    if (player.hurtT > 0 || player.rollT > 0) return;
    if (hooks.has('shield') && player.shieldT > 0) return;
    player.hp -= amount;
    player.hurtT = 0.9;
    shakeT = 0.3;
    burst(player.x + player.w / 2, player.y + player.h / 2, th.player, 12);
    if (player.hp <= 0)
      rt.lose(`Down on wave ${wave}. ${score} points.`);
  }

  function fire(ang) {
    const spread = hooks.has('spread') ? [-0.22, 0, 0.22] : [0];
    for (const off of spread) {
      bullets.push({
        x: player.x + player.w / 2, y: player.y + player.h / 2,
        vx: Math.cos(ang + off) * cfg.combat.bulletSpeed,
        vy: Math.sin(ang + off) * cfg.combat.bulletSpeed,
        w: 4, h: 4, life: 1.4, pierce: hooks.has('pierce') ? 3 : 1,
      });
    }
  }

  return {
    background: th.floor,

    update(dt) {
      const { input } = rt;
      player.hurtT = Math.max(0, player.hurtT - dt);
      player.fireCd = Math.max(0, player.fireCd - dt);
      player.rollT = Math.max(0, player.rollT - dt);
      player.rollCd = Math.max(0, player.rollCd - dt);
      player.shieldT = Math.max(0, player.shieldT - dt);
      shakeT = Math.max(0, shakeT - dt);

      let dx = (input.down('right') ? 1 : 0) - (input.down('left') ? 1 : 0);
      let dy = (input.down('down') ? 1 : 0) - (input.down('up') ? 1 : 0);
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      if (dx) player.facing = Math.sign(dx);

      if (hooks.has('dashRoll') && input.tapped('dash') && player.rollCd <= 0 && (dx || dy)) {
        player.rollT = 0.22;
        player.rollCd = 0.9;
      }
      if (hooks.has('shield') && input.tapped('dash') && !hooks.has('dashRoll') && player.rollCd <= 0) {
        player.shieldT = 1.4;
        player.rollCd = 4;
      }

      const spd = cfg.movement.speed * (player.rollT > 0 ? 2.4 : 1);
      player.vx += (dx * spd - player.vx) * Math.min(1, cfg.movement.accel * dt);
      player.vy += (dy * spd - player.vy) * Math.min(1, cfg.movement.accel * dt);

      const nx = player.x + player.vx * dt;
      const ny = player.y + player.vy * dt;
      if (!overlapsCover(nx, player.y, player.w, player.h)) player.x = nx;
      if (!overlapsCover(player.x, ny, player.w, player.h)) player.y = ny;
      player.x = Math.max(M, Math.min(W - M - player.w, player.x));
      player.y = Math.max(M, Math.min(H - M - player.h, player.y));

      // Aim: mouse when the player has a pointer, movement direction otherwise.
      // Keyboard-only players still get a usable game.
      const pcx = player.x + player.w / 2;
      const pcy = player.y + player.h / 2;
      if (cfg.combat.aim === 'mouse') {
        player.aim = Math.atan2(input.pointer.y - pcy, input.pointer.x - pcx);
      } else if (dx || dy) player.aim = Math.atan2(dy, dx);

      const wantsFire = cfg.combat.aim === 'mouse'
        ? input.pointer.down || input.down('fire')
        : input.down('fire');
      if (wantsFire && player.fireCd <= 0) {
        player.fireCd = 1 / cfg.combat.fireRate;
        fire(player.aim);
      }

      // --- waves -----------------------------------------------------------
      if (betweenWaves) {
        waveT -= dt;
        if (waveT <= 0) spawnWave();
      } else if (enemies.length === 0) {
        if (cfg.rules.win === 'clearWaves' && wave >= cfg.waves.count)
          return rt.win(`All ${cfg.waves.count} waves cleared. ${score} points.`);
        betweenWaves = true;
        waveT = cfg.waves.restBetween;
        score += 50;
      }

      const espd = cfg.entities.enemy.speed;
      for (const e of enemies) {
        const ecx = e.x + e.w / 2;
        const ecy = e.y + e.h / 2;
        const d = Math.hypot(pcx - ecx, pcy - ecy) || 1;
        e.wobble += dt * 3;

        if (cfg.entities.enemy.behavior === 'shooter') {
          // Hold a ring at range and shoot, rather than piling onto the player.
          const want = d < 90 ? -1 : d > 130 ? 1 : 0;
          e.vx = ((pcx - ecx) / d) * espd * want;
          e.vy = ((pcy - ecy) / d) * espd * want;
          e.fireCd -= dt;
          if (e.fireCd <= 0) {
            e.fireCd = cfg.entities.enemy.fireEvery;
            foeShots.push({
              x: ecx, y: ecy, w: 5, h: 5, life: 2.4,
              vx: ((pcx - ecx) / d) * cfg.combat.bulletSpeed * 0.55,
              vy: ((pcy - ecy) / d) * cfg.combat.bulletSpeed * 0.55,
            });
          }
        } else if (cfg.entities.enemy.behavior === 'drift') {
          e.vx = ((pcx - ecx) / d) * espd + Math.cos(e.wobble) * espd * 0.6;
          e.vy = ((pcy - ecy) / d) * espd + Math.sin(e.wobble) * espd * 0.6;
        } else {
          e.vx = ((pcx - ecx) / d) * espd;
          e.vy = ((pcy - ecy) / d) * espd;
        }

        const enx = e.x + e.vx * dt;
        const eny = e.y + e.vy * dt;
        if (!overlapsCover(enx, e.y, e.w, e.h)) e.x = enx;
        if (!overlapsCover(e.x, eny, e.w, e.h)) e.y = eny;
        e.x = Math.max(M, Math.min(W - M - e.w, e.x));
        e.y = Math.max(M, Math.min(H - M - e.h, e.y));

        if (hit(player, e)) hurtPlayer(1);
      }

      for (const b of bullets) {
        if (hooks.has('homing')) {
          let best = null;
          let bd = 90;
          for (const e of enemies) {
            const d = Math.hypot(e.x - b.x, e.y - b.y);
            if (d < bd) { bd = d; best = e; }
          }
          if (best) {
            const a = Math.atan2(best.y - b.y, best.x - b.x);
            const s = Math.hypot(b.vx, b.vy);
            b.vx += (Math.cos(a) * s - b.vx) * Math.min(1, 6 * dt);
            b.vy += (Math.sin(a) * s - b.vy) * Math.min(1, 6 * dt);
          }
        }
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.life -= dt;
        if (b.x < M || b.y < M || b.x > W - M || b.y > H - M || overlapsCover(b.x, b.y, b.w, b.h))
          b.life = 0;
        for (const e of enemies) {
          if (e.hp > 0 && b.life > 0 && hit(b, e)) {
            e.hp -= cfg.combat.damage;
            b.pierce -= 1;
            if (b.pierce <= 0) b.life = 0;
            burst(e.x + e.w / 2, e.y + e.h / 2, th.accent, 4);
            if (e.hp <= 0) {
              score += cfg.rules.killScore;
              burst(e.x + e.w / 2, e.y + e.h / 2, th.enemy, 11);
            }
          }
        }
      }
      bullets = bullets.filter((b) => b.life > 0);
      enemies = enemies.filter((e) => e.hp > 0);

      for (const s of foeShots) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.life -= dt;
        if (s.x < M || s.y < M || s.x > W - M || s.y > H - M || overlapsCover(s.x, s.y, s.w, s.h))
          s.life = 0;
        if (hit(player, s)) {
          s.life = 0;
          hurtPlayer(1);
        }
      }
      foeShots = foeShots.filter((s) => s.life > 0);

      for (const p of particles) {
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.92;
        p.vy *= 0.92;
      }
      particles = particles.filter((p) => p.life > 0);

      if (cfg.rules.win === 'survive' && rt.time >= cfg.rules.surviveSeconds)
        return rt.win(`Survived ${cfg.rules.surviveSeconds}s. ${score} points.`);

      rt.hud({
        score,
        wave: cfg.rules.win === 'clearWaves' ? `${wave}/${cfg.waves.count}` : wave,
        hp: '♥'.repeat(Math.max(0, player.hp)),
        time: cfg.rules.win === 'survive' ? Math.max(0, Math.ceil(cfg.rules.surviveSeconds - rt.time)) : undefined,
      });
    },

    draw(ctx) {
      ctx.save();
      if (shakeT > 0) ctx.translate((rand() - 0.5) * 6, (rand() - 0.5) * 6);

      if (th.floorPattern !== 'none') {
        ctx.strokeStyle = shade(th.floor, 0.08);
        ctx.lineWidth = 1;
        for (let x = M; x < W - M; x += 24) {
          ctx.beginPath();
          ctx.moveTo(x + 0.5, M);
          ctx.lineTo(x + 0.5, H - M);
          ctx.stroke();
        }
        for (let y = M; y < H - M; y += 24) {
          ctx.beginPath();
          ctx.moveTo(M, y + 0.5);
          ctx.lineTo(W - M, y + 0.5);
          ctx.stroke();
        }
      }

      ctx.strokeStyle = th.wall;
      ctx.lineWidth = 3;
      ctx.strokeRect(M - 1.5, M - 1.5, W - 2 * M + 3, H - 2 * M + 3);

      // Cover uses the same tile renderer as every other solid thing, so a
      // style change reaches it too. Each block stands alone: all edges exposed.
      const allOpen = { top: true, bottom: true, left: true, right: true };
      for (const c of cover) drawTile(ctx, style, c.x, c.y, c.w, c.h, th.wall, allOpen);

      for (const e of enemies) {
        art.enemy.draw(ctx, e.x, e.y, e.w, e.h, Math.sign(e.vx) || 1);
      }

      ctx.fillStyle = th.accent;
      for (const b of bullets) ctx.fillRect(b.x - 2, b.y - 2, b.w, b.h);
      ctx.fillStyle = th.enemy;
      for (const s of foeShots) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      drawParticles(ctx, style, particles);

      if (!(player.hurtT > 0 && Math.floor(rt.time * 20) % 2)) {
        const pcx = player.x + player.w / 2;
        const pcy = player.y + player.h / 2;
        ctx.save();
        ctx.translate(pcx, pcy);
        ctx.rotate(player.aim + Math.PI / 2);
        art.player.draw(ctx, -player.w / 2, -player.h / 2, player.w, player.h, 1);
        ctx.restore();
        // Barrel: the only reliable way to tell where you're aiming.
        ctx.strokeStyle = th.accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pcx, pcy);
        ctx.lineTo(pcx + Math.cos(player.aim) * (player.w * 0.85), pcy + Math.sin(player.aim) * (player.w * 0.85));
        ctx.stroke();
        if (player.shieldT > 0) {
          ctx.strokeStyle = mix(th.accent, '#ffffff', 0.4);
          ctx.globalAlpha = 0.7;
          ctx.beginPath();
          ctx.arc(pcx, pcy, player.w * 1.1, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      if (betweenWaves) {
        ctx.textAlign = 'center';
        ctx.fillStyle = mix(th.accent, '#ffffff', 0.2);
        ctx.font = style.overlay.body;
        ctx.fillText(`WAVE ${wave + 1}`, W / 2, H / 2);
        ctx.textAlign = 'left';
      }
      ctx.restore();
    },
  };
}

if (typeof document !== 'undefined') boot(makeGame, { width: 480, height: 270 });
export default makeGame;
