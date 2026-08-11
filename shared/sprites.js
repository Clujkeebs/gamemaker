// Procedural sprites that actually look like something.
//
// The naive way to generate sprites is random symmetric noise. It produces
// mush. Instead this composes HAND-AUTHORED body plans with hand-authored
// feature overlays: a cat is a quadruped body + pointed ears + a tail, and it
// reads as a cat because someone drew the silhouette, not because a PRNG got
// lucky. The generator only picks which parts to combine and what colors to
// use — the same "configure, don't invent" rule the whole product runs on.
//
// Mask characters:
//   .  transparent      B  body (base tone)     D  dark tone
//   L  light tone       A  accent color         E  eye white      P  pupil
//
// Front-facing plans are authored as an 8-wide RIGHT half and mirrored, which
// makes symmetry exact and halves the authoring. Side-facing plans are authored
// full width and flipped at draw time to face the other way.

export const RES = 16;

const mirror = (half) => half.map((row) => [...row].reverse().join('') + row);

// ── body plans ──────────────────────────────────────────────────────────────

const HALF = {
  // Chibi humanoid: big head, small body. Reads at 16px where a realistic
  // figure just reads as a smudge.
  biped: [
    '........',
    'BBB.....',
    'BBBB....',
    'BBBB....',
    'BEEB....',
    'BEPB....',
    'BBBB....',
    'BBB.....',
    'BBB.....',
    'BBBA....',
    'BBBA....',
    'BLLB....',
    'BLLB....',
    'BBB.....',
    '.DD.....',
    '.DD.....',
  ],
  blob: [
    '........',
    '........',
    'BB......',
    'BBBB....',
    'BBBBB...',
    'BEEBB...',
    'BEPBB...',
    'BBBBB...',
    'BBBBBB..',
    'BLLBBB..',
    'BLLBBB..',
    'BBBBBB..',
    'BBBBBB..',
    'BBBBB...',
    'DDDDD...',
    '........',
  ],
  orb: [
    '........',
    '........',
    '..BB....',
    '.BBBB...',
    'BBBBB...',
    'BEEBB...',
    'BEPBB...',
    'BBBBBB..',
    'BLLBBB..',
    'BLLBBB..',
    'BBBBBB..',
    'BBBBB...',
    '.BBBB...',
    '..BB....',
    '........',
    '........',
  ],
  // A rocket, not a lozenge: narrow nose, a window you can find, fins that
  // flare at the base. Silhouette does all the work at 15px.
  ship: [
    '........',
    'B.......',
    'B.......',
    'BB......',
    'BLB.....',
    'BLB.....',
    'BBB.....',
    'BBB.....',
    'BBB.....',
    'BBBA....',
    'BBBAA...',
    'BBBAAA..',
    'BBB.....',
    'DAD.....',
    '.A......',
    '........',
  ],
  ghost: [
    '........',
    '........',
    'BBB.....',
    'BBBBB...',
    'BBBBB...',
    'BEEBB...',
    'BEPBB...',
    'BBBBBB..',
    'BBBBBB..',
    'BBBBBB..',
    'BBBBBB..',
    'BBBBBB..',
    'BBBBBB..',
    'BB.BB...',
    'B..BB...',
    '........',
  ],
  bug: [
    '........',
    '........',
    '..BB....',
    '.BBBB...',
    'BEEBB...',
    'BEPBB...',
    'BBBBB...',
    'BBBBA...',
    'BBBBBA..',
    'BLLBBA..',
    'BLLBB...',
    'BBBBB...',
    'BBBB....',
    'A.A.....',
    'A.A.....',
    '........',
  ],
  // A cut gem / crystal, for pickups that want to be big.
  crystal: [
    '........',
    '..A.....',
    '.LAB....',
    'LLAB....',
    'LABB....',
    'ABBB....',
    'ABBB....',
    'ABBB....',
    'ABBB....',
    'ABBD....',
    'ABDD....',
    '.BDD....',
    '.BD.....',
    '..D.....',
    '........',
    '........',
  ],
};

const FULL = {
  // Side-facing. Flipped at draw time, so these all face RIGHT.
  quadruped: [
    '................',
    '................',
    '................',
    '.........BBBB...',
    '........BBEPBB..',
    '........BBBBBBB.',
    '.........BBBBB..',
    '...BBBBBBBBBB...',
    '..BBBBBBBBBBB...',
    '..BLLLLLLLLB....',
    '..BBBBBBBBB.....',
    '..D.D...D.D.....',
    '..D.D...D.D.....',
    '..DD.....DD.....',
    '................',
    '................',
  ],
  bird: [
    '................',
    '................',
    '..........BBB...',
    '.........BBBBB..',
    '.........BEPBBAA',
    '.........BBBBB..',
    '.....BBBBBBBB...',
    '...BBBBBBBBBB...',
    '..BBBLLLLBBB....',
    '..BBLLLLLBB.....',
    '...BBBBBBB......',
    '.....D.D........',
    '.....D.D........',
    '....DD.DD.......',
    '................',
    '................',
  ],
  fish: [
    '................',
    '................',
    '................',
    '................',
    '.....BBBBBB.....',
    '..A.BBBBBBBB....',
    '.AAABBBBBBEPB...',
    '.AAABBBBBBBBB...',
    '..A.BBBLLBBB....',
    '.....BBBBBB.....',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  car: [
    '................',
    '................',
    '................',
    '................',
    '.....BBBBB......',
    '....BLLLLLB.....',
    '...BBBBBBBBB....',
    '..BBBBBBBBBBB...',
    '..BBBBBBBBBBB...',
    '..DDD.....DDD...',
    '...D.......D....',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
};

export const BUILDS = { ...Object.fromEntries(Object.entries(HALF).map(([k, v]) => [k, mirror(v)])), ...FULL };
export const SIDE_FACING = new Set(Object.keys(FULL));
export const BUILD_NAMES = Object.keys(BUILDS);

// ── feature overlays ────────────────────────────────────────────────────────
// Drawn over the body. Sparse masks; '.' leaves whatever is underneath.

export const OVERLAYS = {
  earsPointed: [
    '....B......B....',
    '...BBB....BBB...',
    '...BDB....BDB...',
  ],
  earsRound: [
    '................',
    '...BB......BB...',
    '..BBBB....BBBB..',
  ],
  horns: [
    '...A........A...',
    '...AA......AA...',
    '....A......A....',
  ],
  antenna: [
    '......AAAA......',
    '.......AA.......',
    '.......AA.......',
  ],
  crown: [
    '....A..AA..A....',
    '....AAAAAAAA....',
    '................',
  ],
  visor: [
    '................',
    '................',
    '................',
    '................',
    '....AAAAAAAA....',
    '....ALLLLLLA....',
  ],
  scarf: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '....AAAAAAAA....',
    '.....AA.........',
  ],
  wings: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '.A............A.',
    'AAA..........AAA',
    'AAAA........AAAA',
    '.AAA........AAA.',
    '..A..........A..',
  ],
  cape: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '..AAA......AAA..',
    '..AAA......AAA..',
    '..AAA......AAA..',
    '...AAA....AAA...',
    '....AA....AA....',
  ],
  tail: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '.AA.............',
    'AA..............',
    'A...............',
  ],
  none: [],
};

// Side-facing bodies put the head on the right and the tail on the left, so the
// front-facing overlays land in the wrong place entirely — ears end up floating
// over the creature's back. These are the same features, re-authored for that
// anatomy, and composeMask picks between them automatically.
export const SIDE_OVERLAYS = {
  earsPointed: [
    '.........B...B..',
    '........BB..BB..',
  ],
  earsRound: [
    '................',
    '........BB..BB..',
    '........BB..BB..',
  ],
  horns: [
    '........A....A..',
    '........AA..AA..',
  ],
  antenna: [
    '..........AA....',
    '..........A.....',
    '..........A.....',
  ],
  crown: [
    '........A.A.A...',
    '........AAAAA...',
  ],
  visor: [
    '................',
    '................',
    '................',
    '................',
    '........AAAAAA..',
  ],
  scarf: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '.......AAAA.....',
    '.......AAA......',
  ],
  wings: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '.....AAAA.......',
    '....AAAAAA......',
    '.....AAAA.......',
  ],
  cape: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '..AAAA..........',
    '..AAAA..........',
    '..AAA...........',
  ],
  // A raised tail at the back, which is most of what makes a quadruped read as
  // a specific animal rather than a generic four-legged lump.
  tail: [
    '................',
    '................',
    '................',
    '................',
    '.AA.............',
    '.AA.............',
    '.AA.............',
    '.AA.............',
  ],
  none: [],
};

export const OVERLAY_NAMES = Object.keys(OVERLAYS);

// ── pickups ─────────────────────────────────────────────────────────────────
// Smaller, bolder shapes: a pickup has to read at 9px on a busy background.

// Authored full-width rather than mirrored: these are small, bold shapes where
// an off-centre highlight is most of what sells the form, and mirroring makes
// that impossible (it also hollows out anything not filled at the centre).
export const PICKUPS = {
  coin: [
    '................', '................', '................',
    '.....AAAAA......',
    '....ALLAAAA.....',
    '...ALLAAAAAA....',
    '...ALAAAAAAA....',
    '...AAAAAAAAA....',
    '...AAAAAAAAA....',
    '....AAAAAAA.....',
    '.....AAAAA......',
    '................', '................', '................', '................', '................',
  ],
  gem: [
    '................', '................', '................',
    '.....AAAA.......',
    '....ALLAAA......',
    '...ALLAAAAA.....',
    '...ALAAAAAA.....',
    '....AAAAAAA.....',
    '.....AAAAA......',
    '......AAA.......',
    '.......A........',
    '................', '................', '................', '................', '................',
  ],
  star: [
    '................', '................',
    '.......AA.......',
    '......AAAA......',
    '..AAAAAAAAAAAA..',
    '...ALLAAAAAAA...',
    '....AAAAAAAA....',
    '...AAAAAAAAAA...',
    '..AAAA....AAAA..',
    '..AAA......AAA..',
    '..AA........AA..',
    '................', '................', '................', '................', '................',
  ],
  heart: [
    '................', '................', '................',
    '...AAAA..AAAA...',
    '..ALLAAAAAAAAA..',
    '..AAAAAAAAAAAA..',
    '..AAAAAAAAAAAA..',
    '...AAAAAAAAAA...',
    '....AAAAAAAA....',
    '.....AAAAAA.....',
    '......AAAA......',
    '.......AA.......',
    '................', '................', '................', '................',
  ],
  key: [
    '................', '................', '................',
    '.....AAAA.......',
    '....AA..AA......',
    '....AA..AA......',
    '.....AAAA.......',
    '......AA........',
    '......AA........',
    '......AAA.......',
    '......AA........',
    '......AAA.......',
    '......AA........',
    '................', '................', '................',
  ],
  orb: [
    '................', '................', '................',
    '.....BBBBB......',
    '....BLLBBBB.....',
    '...BLLBBBBBB....',
    '...BLBBBBBBB....',
    '...BBBBBBBBB....',
    '...BBBBBBBBB....',
    '....BBBBBBB.....',
    '.....BBBBB......',
    '................', '................', '................', '................', '................',
  ],
  fruit: [
    '................', '................',
    '.......D........',
    '.......DAA......',
    '.....BBBBB......',
    '....BLLBBBB.....',
    '...BLLBBBBBB....',
    '...BLBBBBBBB....',
    '...BBBBBBBBB....',
    '....BBBBBBB.....',
    '.....BB.BB......',
    '................', '................', '................', '................', '................',
  ],
  bolt: [
    '................', '................',
    '........AA......',
    '.......AAA......',
    '......AAA.......',
    '.....AAAA.......',
    '....AAAAAAA.....',
    '.......AAA......',
    '......AAA.......',
    '.....AA.........',
    '....AA..........',
    '................', '................', '................', '................', '................',
  ],
  shell: [
    '................', '................', '................',
    '.....BBBB.......',
    '....BLBBBB......',
    '...BLBDDBBB.....',
    '...BLBDDBBB.....',
    '...BBBDDBBB.....',
    '....BBBBBB......',
    '.....BBBB.......',
    '................', '................', '................', '................', '................', '................',
  ],
  skull: [
    '................', '................', '................',
    '.....LLLLL......',
    '....LLLLLLL.....',
    '....LDDLLDDL....',
    '....LDDLLDDL....',
    '....LLLLLLL.....',
    '.....LLDLL......',
    '.....L.L.L......',
    '................', '................', '................', '................', '................', '................',
  ],
};

export const PICKUP_NAMES = Object.keys(PICKUPS);

// ── composition ─────────────────────────────────────────────────────────────

const EYE_STYLES = {
  dot: { white: false },
  big: { white: true },
  angry: { white: true, brow: true },
  visor: { hide: true },
  none: { hide: true },
};

/**
 * Compose a sprite spec into a 16x16 character grid.
 * Pure and DOM-free, so the test suite can assert shape without a canvas.
 */
export function composeMask(spec = {}) {
  const build = BUILDS[spec.build] ?? BUILDS.biped;
  const cells = build.map((row) => [...row]);

  const apply = (overlay) => {
    if (!overlay) return;
    overlay.forEach((row, y) => {
      if (y >= RES) return;
      [...row].forEach((ch, x) => {
        if (ch !== '.' && x < RES) cells[y][x] = ch;
      });
    });
  };

  // Ears and horns go on before markings so a stripe can run over an ear.
  const set = SIDE_FACING.has(spec.build) ? SIDE_OVERLAYS : OVERLAYS;
  for (const name of spec.features ?? []) apply(set[name] ?? OVERLAYS[name]);

  const eyes = EYE_STYLES[spec.eyes ?? 'big'] ?? EYE_STYLES.big;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const ch = cells[y][x];
      if (ch !== 'E' && ch !== 'P') continue;
      if (eyes.hide) cells[y][x] = 'B';
      else if (ch === 'E' && !eyes.white) cells[y][x] = 'P';
    }
  }
  if (eyes.brow) {
    // One dark row above the eyes turns a friendly face into a cross one.
    for (let y = 1; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        if ((cells[y][x] === 'E' || cells[y][x] === 'P') && cells[y - 1][x] === 'B') {
          cells[y - 1][x] = 'D';
        }
      }
    }
  }

  applyPattern(cells, spec.pattern ?? 'none', SIDE_FACING.has(spec.build));
  return cells.map((row) => row.join(''));
}

/**
 * Markings, painted only onto plain body pixels so they never eat a face.
 * Direction follows the body: stripes run across the spine, which means
 * vertical bands on a side-facing animal and horizontal ones head-on. Getting
 * this backwards is what turns a tiger into a creature wearing a belt.
 */
function applyPattern(cells, pattern, side = false) {
  if (pattern === 'none') return;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      if (cells[y][x] !== 'B') continue;
      const mid = Math.abs(x - (RES - 1) / 2);
      switch (pattern) {
        case 'stripes':
          if (side ? x % 3 === 0 && y > 6 : y % 3 === 1 && y > 6) cells[y][x] = 'D';
          break;
        case 'spots':
          if ((x * 7 + y * 13) % 11 === 0 && y > 5) cells[y][x] = 'D';
          break;
        case 'belly':
          if (side ? y > 8 : mid < 2.2 && y > 7) cells[y][x] = 'L';
          break;
        case 'plated':
          if (side ? x % 2 === 0 && y > 6 : y % 2 === 0 && mid > 1.5) cells[y][x] = 'D';
          break;
      }
    }
  }
}

// ── rasterizing ─────────────────────────────────────────────────────────────

import { mix, shade } from './draw.js';

/** Four-tone ramp derived from one base color, so palettes stay coherent. */
export function rampFor(base, accent, style) {
  const s = style?.sprite ?? {};
  return {
    B: base,
    D: shade(base, -(s.darken ?? 0.3)),
    L: shade(base, s.lighten ?? 0.3),
    A: accent,
    E: s.eyeWhite ?? '#ffffff',
    P: s.pupil ?? '#14161f',
    O: s.outlineColor ?? shade(base, -(s.outlineDarken ?? 0.62)),
  };
}

const cache = new Map();
const keyOf = (spec, ramp, style, px) =>
  `${spec.build}|${(spec.features ?? []).join(',')}|${spec.eyes}|${spec.pattern}|${spec.pickup ?? ''}|` +
  `${Object.values(ramp).join(',')}|${style?.id}|${px}`;

const hasDom = () => typeof document !== 'undefined' && typeof document.createElement === 'function';

/**
 * A drawable sprite. In Node (tests) the canvas is null and draw() is a no-op,
 * so engines can call it unconditionally without branching on the environment.
 */
export function getSprite(spec, ramp, style, px = 32) {
  const key = keyOf(spec, ramp, style, px);
  const hit = cache.get(key);
  if (hit) return hit;

  const rows = spec.pickup ? PICKUPS[spec.pickup] ?? PICKUPS.coin : composeMask(spec);
  const sprite = { rows, canvas: null, px, sideFacing: SIDE_FACING.has(spec.build) };

  if (hasDom()) {
    sprite.canvas = rasterize(rows, ramp, style, px);
    if (cache.size > 240) cache.clear(); // bounded; a game uses a handful
  }

  sprite.draw = (ctx, x, y, w, h, facing = 1) => {
    if (!sprite.canvas) return;
    ctx.save();
    // Snap to whole pixels: half-pixel placement is what makes pixel art shimmer.
    const dx = Math.round(x);
    const dy = Math.round(y);
    ctx.imageSmoothingEnabled = style?.sprite?.smooth ?? false;
    if (facing < 0) {
      ctx.translate(dx + w, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(sprite.canvas, 0, 0, w, h);
    } else {
      ctx.drawImage(sprite.canvas, dx, dy, w, h);
    }
    ctx.restore();
  };

  cache.set(key, sprite);
  return sprite;
}

function rasterize(rows, ramp, style, px) {
  const s = style?.sprite ?? {};
  const scale = Math.max(2, Math.round(px / RES));
  const pad = (s.outline ?? 1) + (s.glow ? 2 : 0);
  const size = (RES + pad * 2) * scale;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const at = (x, y) => (x < 0 || y < 0 || x >= RES || y >= RES ? '.' : rows[y][x]);
  const px2 = (x, y, color) => {
    ctx.fillStyle = color;
    ctx.fillRect((x + pad) * scale, (y + pad) * scale, scale, scale);
  };

  // Outline first: any empty cell touching a filled one, dilated by the style's
  // outline width. Drawn under the body so it never eats detail.
  const width = s.outline ?? 1;
  if (width > 0) {
    for (let y = -width; y < RES + width; y++) {
      for (let x = -width; x < RES + width; x++) {
        if (at(x, y) !== '.') continue;
        let touching = false;
        for (let dy = -width; dy <= width && !touching; dy++) {
          for (let dx = -width; dx <= width && !touching; dx++) {
            if (at(x + dx, y + dy) !== '.') touching = true;
          }
        }
        if (touching) px2(x, y, ramp.O);
      }
    }
  }

  if (s.glow) {
    ctx.save();
    ctx.shadowColor = ramp.A;
    ctx.shadowBlur = scale * 2.4;
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) if (at(x, y) === 'A') px2(x, y, ramp.A);
    }
    ctx.restore();
  }

  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const ch = at(x, y);
      if (ch === '.') continue;
      px2(x, y, ramp[ch] ?? ramp.B);
    }
  }

  // Top-left key light: lift the top edge of every solid column.
  if (s.topLight) {
    for (let x = 0; x < RES; x++) {
      for (let y = 0; y < RES; y++) {
        const ch = at(x, y);
        if (ch === '.' || ch === 'E' || ch === 'P') continue;
        if (at(x, y - 1) === '.') {
          ctx.globalAlpha = s.topLight;
          px2(x, y, mix(ramp[ch] ?? ramp.B, '#ffffff', 0.55));
          ctx.globalAlpha = 1;
        }
        break;
      }
    }
  }

  return canvas;
}

/** Reset between style switches in tests; harmless in production. */
export const clearSpriteCache = () => cache.clear();
