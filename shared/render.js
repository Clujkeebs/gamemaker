// Style-aware drawing shared by every engine.
//
// Terrain, hazards, particles, and HUD chrome all have to change with the
// style, or a "neon" game ends up being neon sprites sitting on chunky pixel
// blocks. Putting them here means each engine stays small and no engine can
// quietly opt out of the art direction.

import { shade, mix } from './draw.js';

/**
 * One terrain block.
 *
 * Takes its neighbours, because a tile drawn without them is a tile that
 * doesn't know it's part of a floor: round every corner and a run of ground
 * becomes a row of separate balls. Only exposed corners get rounded, and only
 * exposed edges get an outline, so a mass of tiles reads as one solid thing
 * with a styled silhouette.
 *
 * `open` = { top, left, right, bottom } — true where there is NO neighbour.
 */
export function drawTile(ctx, style, x, y, w, h, color, open = {}) {
  const t = style.tile;
  const r = Math.min(t.radius, Math.min(w, h) / 2);
  const corners = [
    open.top && open.left ? r : 0,
    open.top && open.right ? r : 0,
    open.bottom && open.right ? r : 0,
    open.bottom && open.left ? r : 0,
  ];
  const path = () => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, corners);
  };

  // Paint over the edges that touch a neighbour, so the outline drawn around
  // the whole tile only survives on the silhouette.
  const maskSeams = (lw, paint) => {
    ctx.fillStyle = paint;
    if (!open.top) ctx.fillRect(x, y - lw, w, lw * 2);
    if (!open.bottom) ctx.fillRect(x, y + h - lw, w, lw * 2);
    if (!open.left) ctx.fillRect(x - lw, y, lw * 2, h);
    if (!open.right) ctx.fillRect(x + w - lw, y, lw * 2, h);
  };

  switch (t.mode) {
    case 'glow': {
      ctx.fillStyle = shade(color, -0.45);
      path();
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.shadowColor = color;
      ctx.shadowBlur = 7;
      path();
      ctx.stroke();
      ctx.restore();
      maskSeams(1.4, shade(color, -0.45));
      break;
    }
    case 'soft': {
      ctx.fillStyle = color;
      path();
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = shade(color, -t.outline);
      ctx.lineWidth = 2;
      path();
      ctx.stroke();
      ctx.restore();
      maskSeams(2, color);
      // Highlight goes on last: masking the seams afterwards would punch holes
      // in it and leave a row of ticks along the top of every platform.
      if (open.top) {
        ctx.fillStyle = shade(color, t.edge);
        ctx.fillRect(x + (open.left ? r : 0), y + 1, w - (open.left ? r : 0) - (open.right ? r : 0), Math.max(2, h * 0.2));
      }
      break;
    }
    case 'round': {
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, mix(color, '#ffffff', t.edge));
      g.addColorStop(0.6, color);
      g.addColorStop(1, shade(color, -t.edge * 0.6));
      ctx.fillStyle = g;
      path();
      ctx.fill();
      break;
    }
    default: { // 'bevel'
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
      if (open.top) {
        ctx.fillStyle = shade(color, t.edge);
        ctx.fillRect(x, y, w, Math.max(2, h * 0.2));
      }
      ctx.fillStyle = shade(color, -t.outline);
      if (open.bottom) ctx.fillRect(x, y + h - 1, w, 1);
      if (open.right) ctx.fillRect(x + w - 1, y, 1, h);
      break;
    }
  }
}

/** A hazard tile. Shape is the style's, colour is the theme's. */
export function drawHazard(ctx, style, x, y, T, color, time = 0) {
  switch (style.hazard) {
    case 'bars': {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.lineWidth = 2;
      const wob = Math.sin(time * 5 + x) * 1.5;
      for (let i = 0; i < 3; i++) {
        const bx = x + T * (0.22 + i * 0.28);
        ctx.beginPath();
        ctx.moveTo(bx, y + T);
        ctx.lineTo(bx, y + T * 0.25 + wob);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'thorns': {
      ctx.fillStyle = shade(color, -0.45);
      for (let i = 0; i < 3; i++) {
        const bx = x + (T / 3) * i;
        ctx.beginPath();
        ctx.moveTo(bx, y + T);
        ctx.quadraticCurveTo(bx + T / 6, y + T * 0.15, bx + T / 3, y + T);
        ctx.fill();
      }
      ctx.fillStyle = color;
      for (let i = 0; i < 3; i++) {
        const bx = x + (T / 3) * i + 1;
        ctx.beginPath();
        ctx.moveTo(bx, y + T);
        ctx.quadraticCurveTo(bx + T / 7, y + T * 0.3, bx + T / 3 - 2, y + T);
        ctx.fill();
      }
      break;
    }
    case 'blobs': {
      ctx.fillStyle = color;
      for (let i = 0; i < 3; i++) {
        const bx = x + T * (0.2 + i * 0.3);
        const r = T * (0.13 + (i % 2) * 0.05);
        ctx.beginPath();
        ctx.arc(bx, y + T - r - 1, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    default: { // 'spikes'
      ctx.fillStyle = color;
      for (let i = 0; i < 3; i++) {
        const sx = x + (T / 3) * i;
        ctx.beginPath();
        ctx.moveTo(sx, y + T);
        ctx.lineTo(sx + T / 6, y + T * 0.25);
        ctx.lineTo(sx + T / 3, y + T);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
  }
}

export function drawParticles(ctx, style, particles) {
  const p0 = style.particle;
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2.4));
    ctx.fillStyle = p.color;
    switch (p0.shape) {
      case 'dot':
        ctx.beginPath();
        ctx.arc(p.x, p.y, p0.size / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'spark': {
        ctx.save();
        ctx.strokeStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 6;
        ctx.lineWidth = p0.size * 0.7;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
        ctx.stroke();
        ctx.restore();
        break;
      }
      default:
        ctx.fillRect(p.x - p0.size / 2, p.y - p0.size / 2, p0.size, p0.size);
    }
  }
  ctx.globalAlpha = 1;
}

/** The goal marker: a flag for side-view games, a pad for top-down ones. */
export function drawGoal(ctx, style, x, y, T, color, time, kind = 'flag') {
  if (kind === 'pad') {
    const pulse = 0.55 + Math.sin(time * 3) * 0.25;
    ctx.save();
    if (style.tile.mode === 'glow') {
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
    }
    ctx.globalAlpha = pulse;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x + 1, y + 1, T - 2, T - 2, style.tile.radius);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = shade(color, 0.45);
    ctx.beginPath();
    ctx.roundRect(x + T * 0.3, y + T * 0.3, T * 0.4, T * 0.4, style.tile.radius * 0.5);
    ctx.fill();
    ctx.restore();
    return;
  }

  const wave = Math.sin(time * 4) * 2;
  ctx.fillStyle = shade(color, -0.4);
  ctx.fillRect(x + T * 0.16, y, Math.max(2, T * 0.11), T);
  ctx.save();
  if (style.tile.mode === 'glow') {
    ctx.shadowColor = color;
    ctx.shadowBlur = 9;
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + T * 0.24, y + 2);
  ctx.lineTo(x + T * 0.92 + wave, y + T * 0.26);
  ctx.lineTo(x + T * 0.24, y + T * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
