// Style packs.
//
// A style is not a colour scheme — it's an art direction, and it has to reach
// everything or it isn't one. Each pack below drives sprite rasterizing,
// terrain tiles, backdrops, particles, HUD chrome, the win/lose overlay, AND
// the CSS of the published landing page. One token in the config, one look
// across every artifact.
//
// Colour stays separate: the palette comes from the game's theme, the style
// says how that palette is rendered. That split is what lets "a haunted
// library" and "a candy factory" share a style and still look like themselves.

import { mix, shade } from './draw.js';

export const STYLES = {
  pixel: {
    id: 'pixel',
    label: 'Chunky pixel',
    blurb: 'Hard 1px outlines, flat three-tone shading, everything snapped to the grid.',
    sprite: { outline: 1, outlineDarken: 0.62, darken: 0.3, lighten: 0.3, topLight: 0.5, smooth: false, glow: false },
    tile: { mode: 'bevel', radius: 0, edge: 0.22, inset: 0, outline: 0.35 },
    hazard: 'spikes',
    particle: { shape: 'square', size: 3, gravity: 380 },
    backdropAlpha: 0.42,
    hud: {
      font: '700 11px ui-monospace, Menlo, Consolas, monospace',
      radius: 2, padX: 7, padY: 5, bg: 'rgba(0,0,0,0.55)', fg: '#ffffff', gap: 6,
    },
    overlay: {
      title: '800 26px ui-monospace, Menlo, Consolas, monospace',
      body: '600 12px ui-monospace, Menlo, Consolas, monospace',
      scrim: 0.78, letterSpacing: 2,
    },
    page: {
      fontStack: 'ui-monospace, Menlo, Consolas, monospace',
      headingWeight: 800, letterSpacing: '-0.01em', textTransform: 'none',
      radius: '4px', cardRadius: '4px', buttonRadius: '4px',
      border: '2px solid var(--accent)', cardBorder: '2px solid rgba(255,255,255,0.12)',
      shadow: '6px 6px 0 rgba(0,0,0,0.55)', buttonShadow: '4px 4px 0 rgba(0,0,0,0.6)',
      headingCase: 'uppercase',
    },
  },

  neon: {
    id: 'neon',
    label: 'Neon glow',
    blurb: 'Dark ground, bright edges, everything humming like a sign at 2am.',
    sprite: { outline: 1, outlineDarken: 0.8, darken: 0.42, lighten: 0.42, topLight: 0.7, smooth: false, glow: true },
    tile: { mode: 'glow', radius: 2, edge: 0.5, inset: 1, outline: 0.6 },
    hazard: 'bars',
    particle: { shape: 'spark', size: 2.5, gravity: 120 },
    backdropAlpha: 0.3,
    hud: {
      font: '700 11px "Segoe UI", system-ui, sans-serif',
      radius: 999, padX: 10, padY: 5, bg: 'rgba(10,6,22,0.72)', fg: '#ffffff', gap: 7, track: 0.6,
    },
    overlay: {
      title: '800 28px "Segoe UI", system-ui, sans-serif',
      body: '500 13px "Segoe UI", system-ui, sans-serif',
      scrim: 0.82, letterSpacing: 6, glow: true,
    },
    page: {
      fontStack: '"Segoe UI", system-ui, -apple-system, sans-serif',
      headingWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
      radius: '16px', cardRadius: '14px', buttonRadius: '999px',
      border: '1px solid color-mix(in srgb, var(--accent) 55%, transparent)',
      cardBorder: '1px solid rgba(255,255,255,0.09)',
      shadow: '0 0 42px color-mix(in srgb, var(--accent) 28%, transparent)',
      buttonShadow: '0 0 26px color-mix(in srgb, var(--accent) 65%, transparent)',
      headingCase: 'uppercase',
    },
  },

  storybook: {
    id: 'storybook',
    label: 'Storybook',
    blurb: 'Thick soft outlines and warm paper, like something torn out of a picture book.',
    sprite: { outline: 2, outlineDarken: 0.72, darken: 0.22, lighten: 0.26, topLight: 0.35, smooth: false, glow: false },
    tile: { mode: 'soft', radius: 5, edge: 0.26, inset: 1, outline: 0.55 },
    hazard: 'thorns',
    particle: { shape: 'dot', size: 3.5, gravity: 300 },
    backdropAlpha: 0.5,
    hud: {
      font: '700 12px Iowan Old Style, Georgia, serif',
      radius: 9, padX: 9, padY: 5, bg: 'rgba(38,26,18,0.62)', fg: '#fff6e8', gap: 7,
    },
    overlay: {
      title: '800 30px Iowan Old Style, Georgia, serif',
      body: '500 14px Iowan Old Style, Georgia, serif',
      scrim: 0.72, letterSpacing: 0,
    },
    page: {
      fontStack: 'Iowan Old Style, Georgia, "Times New Roman", serif',
      headingWeight: 700, letterSpacing: '-0.02em', textTransform: 'none',
      radius: '18px', cardRadius: '16px', buttonRadius: '999px',
      border: '3px solid rgba(0,0,0,0.35)', cardBorder: '2px solid rgba(0,0,0,0.22)',
      shadow: '0 14px 34px rgba(0,0,0,0.35)', buttonShadow: '0 6px 0 rgba(0,0,0,0.32)',
      headingCase: 'none',
    },
  },

  clay: {
    id: 'clay',
    label: 'Soft clay',
    blurb: 'No outlines, round corners, everything lit from above like a toy on a shelf.',
    sprite: { outline: 0, darken: 0.24, lighten: 0.32, topLight: 0.8, smooth: true, glow: false },
    tile: { mode: 'round', radius: 7, edge: 0.32, inset: 1.5, outline: 0 },
    hazard: 'blobs',
    particle: { shape: 'dot', size: 4, gravity: 260 },
    backdropAlpha: 0.55,
    hud: {
      font: '700 12px ui-rounded, "SF Pro Rounded", "Segoe UI Variable", system-ui, sans-serif',
      radius: 999, padX: 10, padY: 6, bg: 'rgba(255,255,255,0.14)', fg: '#ffffff', gap: 7,
    },
    overlay: {
      title: '800 30px ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
      body: '500 13px ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
      scrim: 0.7, letterSpacing: 0,
    },
    page: {
      fontStack: 'ui-rounded, "SF Pro Rounded", "Segoe UI Variable", system-ui, sans-serif',
      headingWeight: 800, letterSpacing: '-0.03em', textTransform: 'none',
      radius: '26px', cardRadius: '22px', buttonRadius: '999px',
      border: 'none', cardBorder: '1px solid rgba(255,255,255,0.08)',
      shadow: '0 20px 44px rgba(0,0,0,0.4)', buttonShadow: '0 8px 20px rgba(0,0,0,0.35)',
      headingCase: 'none',
    },
  },
};

export const STYLE_NAMES = Object.keys(STYLES);
export const getStyle = (id) => STYLES[id] ?? STYLES.pixel;

/**
 * Derive the landing page's look from the game's style and palette.
 *
 * This is the join that makes the promise true: the page is not styled
 * independently and then hopefully matched, it is *computed* from the same
 * style token and the same colours the game is using.
 */
export function pageThemeFrom(style, palette) {
  const ground = palette.ground ?? palette.wall ?? palette.brickTop ?? '#3b4560';
  const back = palette.skyBottom ?? palette.floor ?? palette.background ?? '#0b0d13';
  const accent = palette.accent ?? '#ffd166';

  return {
    background: back,
    // Surfaces sit just off the game's own background, tinted toward its
    // terrain — so the cards feel like they're cut from the same world.
    surface: mix(back, ground, style.id === 'clay' ? 0.3 : 0.19),
    text: style.id === 'storybook' ? '#fdf3e3' : '#eef1f7',
    muted: mix(shade(back, 0.55), ground, 0.35),
    accent,
    font: style.id,
  };
}
