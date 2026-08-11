// Procedural sprite drawing.
//
// Generated games never reference image files — a broken <img> is the most
// visible way for generated output to look broken, and there's no asset
// pipeline that can guarantee one exists. Everything here is Canvas primitives,
// so every sprite the model can ask for is one that definitely renders.

export const SHAPES = [
  'rect', 'round', 'circle', 'triangle', 'diamond', 'star',
  'hexagon', 'cross', 'blob', 'ship', 'ghost',
];

function poly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

/** Draw `shape` filling the box (x,y,w,h) in `color`. */
export function shape(ctx, kind, x, y, w, h, color) {
  ctx.fillStyle = color;
  const cx = x + w / 2;
  const cy = y + h / 2;
  switch (kind) {
    case 'circle':
      ctx.beginPath();
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'round': {
      const r = Math.min(w, h) * 0.28;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
      break;
    }
    case 'triangle':
      poly(ctx, [[cx, y], [x + w, y + h], [x, y + h]]);
      break;
    case 'diamond':
      poly(ctx, [[cx, y], [x + w, cy], [cx, y + h], [x, cy]]);
      break;
    case 'hexagon':
      poly(ctx, [
        [x + w * 0.25, y], [x + w * 0.75, y], [x + w, cy],
        [x + w * 0.75, y + h], [x + w * 0.25, y + h], [x, cy],
      ]);
      break;
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const r = i % 2 ? 0.22 : 0.5;
        pts.push([cx + Math.cos(a) * w * r, cy + Math.sin(a) * h * r]);
      }
      poly(ctx, pts);
      break;
    }
    case 'cross': {
      const t = Math.min(w, h) * 0.34;
      ctx.fillRect(cx - t / 2, y, t, h);
      ctx.fillRect(x, cy - t / 2, w, t);
      break;
    }
    case 'blob':
      ctx.beginPath();
      ctx.ellipse(cx, cy - h * 0.05, w * 0.5, h * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(x + w * 0.12, cy, w * 0.76, h * 0.5);
      break;
    case 'ship':
      poly(ctx, [
        [cx, y], [x + w, y + h * 0.8], [cx, y + h * 0.62], [x, y + h * 0.8],
      ]);
      break;
    case 'ghost': {
      ctx.beginPath();
      ctx.arc(cx, y + h * 0.42, w * 0.5, Math.PI, 0);
      ctx.lineTo(x + w, y + h);
      for (let i = 3; i >= 0; i--) {
        ctx.lineTo(x + (w / 4) * i + w / 8, y + h - (i % 2 ? h * 0.16 : 0));
        ctx.lineTo(x + (w / 4) * i, y + h);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    default:
      ctx.fillRect(x, y, w, h);
  }
}

/** Two eyes. The cheapest possible way to make a rectangle read as a creature. */
export function eyes(ctx, x, y, w, h, facing = 1, dark = '#12141c') {
  const r = Math.max(1.4, Math.min(w, h) * 0.11);
  const ey = y + h * 0.34;
  const off = w * 0.16 * facing;
  ctx.fillStyle = '#ffffff';
  for (const dx of [-w * 0.17, w * 0.17]) {
    ctx.beginPath();
    ctx.arc(x + w / 2 + dx + off * 0.2, ey, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = dark;
  for (const dx of [-w * 0.17, w * 0.17]) {
    ctx.beginPath();
    ctx.arc(x + w / 2 + dx + off * 0.45, ey, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Mix two hex colors. Used for automatic shading so palettes stay coherent. */
export function mix(a, b, t) {
  const p = (c) => {
    const s = c.replace('#', '');
    const f = s.length === 3 ? s.split('').map((x) => x + x).join('') : s;
    return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
  };
  const [r1, g1, b1] = p(a);
  const [r2, g2, b2] = p(b);
  const c = (u, v) => Math.round(u + (v - u) * t).toString(16).padStart(2, '0');
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

export const shade = (c, amt) => mix(c, amt < 0 ? '#000000' : '#ffffff', Math.abs(amt));

/** Deterministic RNG, so a given config always produces the same level. */
export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
