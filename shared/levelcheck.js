// Ties a template's declared reachability policy to a specific config.
//
// The search needs to know how far the player can actually jump, and that comes
// from the config's physics — not from a constant. Deriving it in one place
// keeps the preview check, the publish check, and the test suite from
// disagreeing about whether a level is winnable.

import { checkReachable, carveTo } from './reachability.js';
import { checkSokoban, generateSokoban } from './sokoban-solve.js';
import { TILE } from './tiles.js';
import { rng, hashString } from './draw.js';

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

  // A push puzzle needs a search, not a walk: it can be fully connected and
  // still impossible, and a walk would happily pass it.
  if (schema.reachability?.kind === 'sokoban') {
    const result = checkSokoban(rows);
    if (ragged) result.reasons.push('level rows are not all the same length (they get padded with air)');
    return result;
  }
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
  if (check.ok) return { config, repaired: false, check };

  // An unsolvable push puzzle can't be carved open — there is no corridor to
  // cut. Replace it with one that is solvable by construction, and say so.
  if (schema.reachability?.kind === 'sokoban') {
    const rows = config.level.grid;
    const rand = rng(hashString(JSON.stringify(rows)) || 1);
    // Each attempt re-runs the solver, so eight of them can stack into minutes
    // on exactly the levels that were slow to reject in the first place. Bound
    // the whole loop, not just each try.
    const deadline = Date.now() + 4000;
    for (let attempt = 0; attempt < 8 && Date.now() < deadline; attempt++) {
      const generated = generateSokoban(rand, {
        w: Math.min(14, Math.max(7, rows[0]?.length ?? 10)),
        h: Math.min(11, Math.max(5, rows.length)),
        boxes: Math.max(1, Math.min(4, (rows.join('').match(/[B*]/g) ?? ['B']).length)),
      });
      if (!generated) continue;
      const fixed = structuredClone(config);
      fixed.level.grid = generated;
      const after = checkLevel(schema, fixed);
      if (after.ok) return { config: fixed, repaired: true, check: after };
    }
    return { config, repaired: false, check };
  }

  if (!check.unreachable?.length) return { config, repaired: false, check };
  const fixed = structuredClone(config);
  fixed.level.grid = carveTo(config.level.grid, check.unreachable);
  return { config: fixed, repaired: true, check: checkLevel(schema, fixed) };
}
