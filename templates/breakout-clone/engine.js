// breakout-clone — paddle, ball, wall of bricks, powerups.
//
// ENGINE CODE. Never written or edited by the generator.
// The brick wall is generated from a pattern name plus rows/cols rather than a
// hand-authored grid, which makes "unwinnable layout" structurally impossible.

import { boot, hit } from '../../shared/runtime.js';
import { shape, shade, mix, rng } from '../../shared/draw.js';

const HOOKS = ['multiball', 'sticky', 'lasers', 'widen'];
const PATTERNS = ['solid', 'checker', 'pyramid', 'gaps', 'arch'];

function makeGame(cfg, rt) {
  const th = cfg.theme;
  const hooks = new Set((cfg.mechanicHooks ?? []).filter((h) => HOOKS.includes(h)));
  const rand = rng((cfg.seed ?? 11) || 11);
  const W = rt.W;
  const H = rt.H;

  const paddle = {
    w: cfg.paddle.width, h: 8,
    x: W / 2 - cfg.paddle.width / 2, y: H - 22,
    baseW: cfg.paddle.width, buffT: 0, laserCd: 0,
  };

  const bricks = [];
  const b = cfg.bricks;
  const marginX = 18;
  const top = 34;
  const bw = (W - marginX * 2 - (b.cols - 1) * 3) / b.cols;
  const bh = 11;

  const inPattern = (r, c) => {
    switch (b.pattern) {
      case 'checker': return (r + c) % 2 === 0;
      case 'pyramid': return c >= r && c < b.cols - r;
      case 'gaps': return c % 3 !== 2;
      case 'arch': return r === 0 || c === 0 || c === b.cols - 1 || r === b.rows - 1;
      default: return true;
    }
  };

  for (let r = 0; r < b.rows; r++) {
    for (let c = 0; c < b.cols; c++) {
      if (!inPattern(r, c)) continue;
      bricks.push({
        x: marginX + c * (bw + 3), y: top + r * (bh + 4),
        w: bw, h: bh,
        hp: Math.max(1, b.hp - Math.floor((r / Math.max(1, b.rows - 1)) * (b.hp - 1))),
        row: r,
      });
    }
  }
  const totalBricks = bricks.length;

  const newBall = (stuck = true) => ({
    x: paddle.x + paddle.w / 2, y: paddle.y - cfg.ball.size,
    r: cfg.ball.size / 2,
    vx: 0, vy: 0, stuck, speed: cfg.ball.speed,
  });

  let balls = [newBall(true)];
  let shots = [];
  let particles = [];
  let drops = [];
  let score = 0;
  let lives = cfg.rules.lives;
  let broken = 0;
  let shakeT = 0;

  function burst(x, y, color, n = 8) {
    for (let i = 0; i < n; i++)
      particles.push({
        x, y, life: 0.25 + rand() * 0.3, color,
        vx: (rand() - 0.5) * 200, vy: (rand() - 0.5) * 200,
      });
  }

  const brickColor = (br) =>
    mix(th.brickTop, th.brickBottom, b.rows > 1 ? br.row / (b.rows - 1) : 0);

  function launch(ball) {
    ball.stuck = false;
    const a = -Math.PI / 2 + (rand() - 0.5) * 0.7;
    ball.vx = Math.cos(a) * ball.speed;
    ball.vy = Math.sin(a) * ball.speed;
  }

  function hitBrick(br, ball) {
    br.hp -= 1;
    score += cfg.rules.brickScore;
    burst(br.x + br.w / 2, br.y + br.h / 2, brickColor(br), 6);
    if (br.hp <= 0) {
      broken += 1;
      const i = bricks.indexOf(br);
      if (i >= 0) bricks.splice(i, 1);
      if (hooks.size && rand() < cfg.rules.powerupChance) {
        const kinds = [...hooks];
        drops.push({
          x: br.x + br.w / 2, y: br.y, vy: 46,
          kind: kinds[Math.floor(rand() * kinds.length)],
        });
      }
    }
    if (ball) ball.speed = Math.min(cfg.ball.maxSpeed, ball.speed + cfg.ball.accel);
  }

  function applyPowerup(kind) {
    switch (kind) {
      case 'multiball': {
        const src = balls[0];
        for (let i = 0; i < 2; i++) {
          const nb = newBall(false);
          nb.x = src.x;
          nb.y = src.y;
          const a = Math.atan2(src.vy, src.vx) + (i ? 0.5 : -0.5);
          nb.speed = src.speed;
          nb.vx = Math.cos(a) * nb.speed;
          nb.vy = Math.sin(a) * nb.speed;
          balls.push(nb);
        }
        break;
      }
      case 'widen':
        paddle.buffT = 12;
        break;
      case 'sticky':
        paddle.sticky = 14;
        break;
      case 'lasers':
        paddle.lasers = 12;
        break;
    }
  }

  return {
    background: th.background,

    update(dt) {
      const { input } = rt;
      shakeT = Math.max(0, shakeT - dt);
      paddle.buffT = Math.max(0, paddle.buffT - dt);
      paddle.sticky = Math.max(0, (paddle.sticky ?? 0) - dt);
      paddle.lasers = Math.max(0, (paddle.lasers ?? 0) - dt);
      paddle.laserCd = Math.max(0, paddle.laserCd - dt);
      paddle.w = paddle.baseW * (paddle.buffT > 0 ? 1.7 : 1);

      // Pointer steers directly; keys nudge. Both always work.
      const dir = (input.down('right') ? 1 : 0) - (input.down('left') ? 1 : 0);
      if (dir) paddle.x += dir * cfg.paddle.speed * dt;
      else if (input.pointer.x) paddle.x += (input.pointer.x - paddle.w / 2 - paddle.x) * Math.min(1, 16 * dt);
      paddle.x = Math.max(4, Math.min(W - 4 - paddle.w, paddle.x));

      if (paddle.lasers > 0 && paddle.laserCd <= 0 && (input.down('fire') || input.pointer.down)) {
        paddle.laserCd = 0.32;
        shots.push({ x: paddle.x + 4, y: paddle.y, vy: -280 });
        shots.push({ x: paddle.x + paddle.w - 6, y: paddle.y, vy: -280 });
      }

      for (const ball of balls) {
        if (ball.stuck) {
          ball.x = paddle.x + paddle.w / 2;
          ball.y = paddle.y - ball.r - 1;
          if (input.tapped('jump') || input.tapped('fire') || input.pointer.fired) launch(ball);
          continue;
        }

        // Substep so a fast ball can't tunnel through a brick row.
        const steps = Math.max(1, Math.ceil((Math.hypot(ball.vx, ball.vy) * dt) / 4));
        for (let s = 0; s < steps; s++) {
          ball.x += (ball.vx * dt) / steps;
          ball.y += (ball.vy * dt) / steps;

          if (ball.x - ball.r < 0) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); }
          if (ball.x + ball.r > W) { ball.x = W - ball.r; ball.vx = -Math.abs(ball.vx); }
          if (ball.y - ball.r < 0) { ball.y = ball.r; ball.vy = Math.abs(ball.vy); }

          const box = { x: ball.x - ball.r, y: ball.y - ball.r, w: ball.r * 2, h: ball.r * 2 };

          if (ball.vy > 0 && hit(box, paddle)) {
            if (paddle.sticky > 0) {
              ball.stuck = true;
            } else {
              // Bounce angle from where it struck the paddle — the one control
              // that makes breakout a game of aim rather than of luck.
              const rel = (ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2);
              const a = -Math.PI / 2 + Math.max(-1, Math.min(1, rel)) * 1.05;
              ball.vx = Math.cos(a) * ball.speed;
              ball.vy = Math.sin(a) * ball.speed;
              ball.y = paddle.y - ball.r - 0.5;
            }
          }

          for (const br of bricks) {
            if (!hit(box, br)) continue;
            const overlapX = Math.min(box.x + box.w - br.x, br.x + br.w - box.x);
            const overlapY = Math.min(box.y + box.h - br.y, br.y + br.h - box.y);
            if (overlapX < overlapY) ball.vx *= -1;
            else ball.vy *= -1;
            hitBrick(br, ball);
            const m = Math.hypot(ball.vx, ball.vy) || 1;
            ball.vx = (ball.vx / m) * ball.speed;
            ball.vy = (ball.vy / m) * ball.speed;
            break;
          }
        }
      }

      const before = balls.length;
      balls = balls.filter((ball) => ball.y - ball.r < H + 12);
      if (balls.length === 0 && before > 0) {
        lives -= 1;
        shakeT = 0.3;
        if (lives <= 0)
          return rt.lose(`Ball lost with ${totalBricks - broken} bricks standing.`);
        balls = [newBall(true)];
        drops = [];
      }

      for (const d of drops) {
        d.y += d.vy * dt;
        if (d.y > paddle.y - 6 && d.y < paddle.y + paddle.h && d.x > paddle.x && d.x < paddle.x + paddle.w) {
          applyPowerup(d.kind);
          score += 25;
          burst(d.x, d.y, th.accent, 8);
          d.y = H + 99;
        }
      }
      drops = drops.filter((d) => d.y < H + 20);

      for (const s of shots) {
        s.y += s.vy * dt;
        for (const br of bricks) {
          if (s.y < br.y + br.h && s.y > br.y && s.x > br.x && s.x < br.x + br.w) {
            hitBrick(br, null);
            s.y = -99;
            break;
          }
        }
      }
      shots = shots.filter((s) => s.y > -10);

      for (const p of particles) {
        p.life -= dt;
        p.vy += 300 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      particles = particles.filter((p) => p.life > 0);

      if (bricks.length === 0)
        return rt.win(`Wall cleared. ${score} points, ${lives} ${lives === 1 ? 'life' : 'lives'} left.`);

      rt.hud({
        score,
        bricks: `${totalBricks - bricks.length}/${totalBricks}`,
        lives: '♥'.repeat(Math.max(0, lives)),
      });
    },

    draw(ctx) {
      ctx.save();
      if (shakeT > 0) ctx.translate((rand() - 0.5) * 5, (rand() - 0.5) * 5);

      for (const br of bricks) {
        const c = brickColor(br);
        ctx.fillStyle = br.hp > 1 ? shade(c, -0.2) : c;
        ctx.fillRect(br.x, br.y, br.w, br.h);
        ctx.fillStyle = shade(c, 0.25);
        ctx.fillRect(br.x, br.y, br.w, 2);
        if (br.hp > 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.28)';
          ctx.fillRect(br.x + br.w / 2 - 4, br.y + br.h / 2 - 1, 8, 2);
        }
      }

      ctx.fillStyle = paddle.sticky > 0 ? th.accent : th.paddle;
      ctx.beginPath();
      ctx.roundRect(paddle.x, paddle.y, paddle.w, paddle.h, 4);
      ctx.fill();
      if (paddle.lasers > 0) {
        ctx.fillStyle = th.accent;
        ctx.fillRect(paddle.x + 2, paddle.y - 3, 3, 3);
        ctx.fillRect(paddle.x + paddle.w - 5, paddle.y - 3, 3, 3);
      }

      ctx.fillStyle = th.accent;
      for (const s of shots) ctx.fillRect(s.x, s.y, 2, 7);

      for (const d of drops) {
        shape(ctx, 'diamond', d.x - 5, d.y - 5, 10, 10, th.accent);
      }

      ctx.fillStyle = th.ball;
      for (const ball of balls) {
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const p of particles) {
        ctx.globalAlpha = Math.max(0, p.life * 3);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;

      if (balls.some((b2) => b2.stuck)) {
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '500 11px system-ui, sans-serif';
        ctx.fillText('space or click to launch', W / 2, H - 8);
        ctx.textAlign = 'left';
      }
      ctx.restore();
    },
  };
}

if (typeof document !== 'undefined') boot(makeGame, { width: 480, height: 270 });
export default makeGame;
export { PATTERNS };
