// Can the player actually finish this level?
//
// The system prompt asks the model to guarantee reachable win conditions, but a
// language model cannot actually perform that check on a tile grid — it needs a
// search. This runs one before the preview renders, so "the AI made an
// impossible level" is caught by the machine rather than by the user.
//
// Two search kinds, because a platformer and a top-down game disagree about
// what "adjacent" means:
//   flood    — 4-directional walk through passable tiles (top-down, maze, sokoban)
//   platform — jump-aware search over standable tiles (anything with gravity)

import { TILE, at, isSolid, findOne, findAll, parseGrid } from './tiles.js';

const key = (x, y) => `${x},${y}`;

function floodReachable(grid, start) {
  const seen = new Set([key(start.x, start.y)]);
  const queue = [start];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (queue.length) {
    const { x, y } = queue.shift();
    for (const [dx, dy] of dirs) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) continue;
      if (isSolid(at(grid, nx, ny))) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ x: nx, y: ny });
    }
  }
  return seen;
}

/** A tile you can stand in: open, with something solid directly beneath. */
function isStandable(grid, x, y) {
  if (isSolid(at(grid, x, y))) return false;
  const below = at(grid, x, y + 1);
  return isSolid(below) || below === TILE.ONEWAY;
}

/** Is the L-shaped path from a to b clear of solid tiles? Approximate, deliberately. */
function pathClear(grid, ax, ay, bx, by) {
  const stepY = by > ay ? 1 : -1;
  for (let y = ay; y !== by + stepY; y += stepY) if (isSolid(at(grid, ax, y))) return false;
  const stepX = bx > ax ? 1 : -1;
  for (let x = ax; x !== bx + stepX; x += stepX) if (isSolid(at(grid, x, by))) return false;
  return true;
}

/**
 * Jump-aware reachability. Rather than simulate physics, we ask a cheaper
 * question: from each standable tile, which other standable tiles are within a
 * jump arc, with a clear path? That is an approximation, and it is the right
 * one — it reliably catches the failure that actually happens (the goal is
 * sealed behind solid tiles) without pretending to model coyote time.
 */
function platformReachable(grid, start, { maxUp = 3, maxDown = 12, maxAcross = 4 } = {}) {
  // Drop the spawn to the ground; models routinely place P floating in the air.
  let sy = start.y;
  while (sy + 1 < grid.h && !isStandable(grid, start.x, sy)) sy++;

  const seen = new Set([key(start.x, sy)]);
  const queue = [{ x: start.x, y: sy }];

  while (queue.length) {
    const { x, y } = queue.shift();
    for (let dx = -maxAcross; dx <= maxAcross; dx++) {
      for (let dy = -maxUp; dy <= maxDown; dy++) {
        if (dx === 0 && dy === 0) continue;
        // Falling reaches further sideways than jumping does upward.
        if (dy < 0 && Math.abs(dx) + Math.abs(dy) > maxAcross + 1) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) continue;
        if (!isStandable(grid, nx, ny)) continue;
        const k = key(nx, ny);
        if (seen.has(k)) continue;
        if (!pathClear(grid, x, y, nx, ny)) continue;
        seen.add(k);
        queue.push({ x: nx, y: ny });
      }
    }
  }
  return seen;
}

/**
 * @param rows   level grid as rows-of-strings
 * @param kind   'flood' | 'platform'
 * @param need   tile chars that must be reachable for the level to be winnable
 * @returns { ok, reasons[], reachable:Set, unreachable:[{x,y,tile}] }
 */
export function checkReachable(rows, kind = 'flood', need = [TILE.GOAL], opts = {}) {
  const grid = parseGrid(rows);
  const reasons = [];
  const spawn = findOne(grid, TILE.SPAWN);

  if (!spawn) {
    return { ok: false, reasons: ['level has no spawn point (P)'], reachable: new Set(), unreachable: [] };
  }

  const reachable =
    kind === 'platform' ? platformReachable(grid, spawn, opts) : floodReachable(grid, spawn);

  const unreachable = [];
  for (const ch of need) {
    const targets = findAll(grid, ch);
    if (targets.length === 0) {
      reasons.push(`level has no "${ch}" tile, so its win condition can never be met`);
      continue;
    }
    for (const t of targets) {
      // In a platformer the goal usually floats one tile above the floor, so a
      // target counts as reached if the player can stand on it or just below it.
      const hit =
        reachable.has(key(t.x, t.y)) ||
        (kind === 'platform' &&
          (reachable.has(key(t.x, t.y + 1)) || reachable.has(key(t.x, t.y - 1))));
      if (!hit) unreachable.push({ x: t.x, y: t.y, tile: ch });
    }
  }

  if (unreachable.length) {
    const list = unreachable.slice(0, 4).map((u) => `${u.tile}@${u.x},${u.y}`).join(', ');
    reasons.push(
      `${unreachable.length} required tile(s) can't be reached from the spawn: ${list}` +
        (unreachable.length > 4 ? ', …' : '')
    );
  }

  return { ok: reasons.length === 0, reasons, reachable, unreachable };
}

/**
 * Last-resort repair: carve a walkable corridor from spawn to each unreachable
 * required tile. Ugly, but a playable ugly level beats an unplayable pretty one,
 * and it only ever runs after reseeding has already failed.
 */
export function carveTo(rows, targets) {
  const grid = parseGrid(rows);
  const spawn = findOne(grid, TILE.SPAWN);
  if (!spawn) return rows;
  const cells = grid.cells.map((r) => [...r]);

  for (const t of targets) {
    let { x, y } = spawn;
    const stepX = t.x > x ? 1 : -1;
    while (x !== t.x) {
      x += stepX;
      if (cells[y]?.[x] === TILE.SOLID) cells[y][x] = TILE.EMPTY;
    }
    const stepY = t.y > y ? 1 : -1;
    while (y !== t.y) {
      y += stepY;
      if (cells[y]?.[x] === TILE.SOLID) cells[y][x] = TILE.EMPTY;
    }
  }
  return cells.map((r) => r.join(''));
}
