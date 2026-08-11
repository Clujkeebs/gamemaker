// Ties a template's declared reachability policy to a specific config.
//
// The search needs to know how far the player can actually jump, and that comes
// from the config's physics — not from a constant. Deriving it in one place
// keeps the preview check, the publish check, and the test suite from
// disagreeing about whether a level is winnable.

import { checkReachable, carveTo } from './reachability.js';
import { TILE } from './tiles.js';

/** Which tiles must be reachable, given what the config says winning means. */
export function requiredTiles(schema, config) {
  const declared = schema.reachability?.need ?? [TILE.GOAL];
  const win = config?.rules?.win;
  const need = new Set();

  if (win === 'collectAll') need.add(TILE.PICKUP);
  else if (win === 'reachGoal') {
    declared.forEach((t) => need.add(t));
    if (config?.rules?.goalNeedsAll) need.add(TILE.PICKUP);
  }
  // 'survive' has no spatial win condition; a spawn that exists is enough.
  return [...need];
}

/** Jump reach in tiles, straight out of the physics the config asked for. */
export function searchOpts(schema, config) {
  if (schema.reachability?.kind !== 'platform') return {};
  const ph = config.physics ?? {};
  const T = config.level?.tileSize ?? 18;
  const g = Math.max(1, ph.gravity ?? 720);
  const jp = ph.jumpPower ?? 262;
  const heightPx = (jp * jp) / (2 * g);
  const hooks = new Set(config.mechanicHooks ?? []);
  // A double jump roughly doubles peak height; round up so the check never
  // reports a level unwinnable that the player can in fact clear.
  const mult = hooks.has('doubleJump') ? 1.9 : 1;
  const maxUp = Math.max(1, Math.floor((heightPx * mult) / T));
  // Airtime scales with hang time, so horizontal reach follows jump height.
  const maxAcross = Math.max(3, Math.min(9, Math.round(maxUp * 1.4) + 1));
  return { maxUp, maxAcross, maxDown: 14 };
}

/** Full check for one config against its template. */
export function checkLevel(schema, config) {
  const rows = config?.level?.grid;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, reasons: ['config has no level grid'], unreachable: [] };
  }
  const ragged = rows.some((r) => r.length !== rows[0].length);
  const result = checkReachable(
    rows,
    schema.reachability?.kind ?? 'flood',
    requiredTiles(schema, config),
    searchOpts(schema, config)
  );
  if (ragged) {
    result.reasons.push('level rows are not all the same length (they get padded with air)');
  }
  return result;
}

/**
 * Make an unwinnable level winnable. Carving is deliberate vandalism of the
 * level's shape, so it only runs after the generator has already had its retry:
 * a level with an ugly tunnel is still a game, and a sealed goal is not.
 */
export function repairLevel(schema, config) {
  const check = checkLevel(schema, config);
  if (check.ok || !check.unreachable?.length) return { config, repaired: false, check };
  const fixed = structuredClone(config);
  fixed.level.grid = carveTo(config.level.grid, check.unreachable);
  return { config: fixed, repaired: true, check: checkLevel(schema, fixed) };
}
