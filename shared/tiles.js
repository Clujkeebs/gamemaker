// One tile alphabet, shared by every template that uses a grid level.
// Keeping it universal means reachability, rendering, and validation all speak
// the same language regardless of archetype.

export const TILE = {
  EMPTY: '.',
  SOLID: '#',
  SPAWN: 'P',
  GOAL: 'G',
  HAZARD: 'x',
  PICKUP: 'o',
  ENEMY: 'e',
  ONEWAY: '-', // platform you can jump up through, stand on from above
};

export const PASSABLE = new Set([
  TILE.EMPTY, TILE.SPAWN, TILE.GOAL, TILE.HAZARD, TILE.PICKUP, TILE.ENEMY,
]);

export const SOLID = new Set([TILE.SOLID]);

export const isSolid = (ch) => SOLID.has(ch);
export const isPassable = (ch) => PASSABLE.has(ch) || ch === TILE.ONEWAY;

/** Parse rows-of-strings into a padded rectangular char grid. */
export function parseGrid(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { w: 0, h: 0, cells: [] };
  const w = Math.max(...rows.map((r) => String(r).length));
  const cells = rows.map((r) => {
    const s = String(r);
    return Array.from({ length: w }, (_, i) => s[i] ?? TILE.EMPTY);
  });
  return { w, h: cells.length, cells };
}

export function findAll(grid, ch) {
  const out = [];
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) if (grid.cells[y][x] === ch) out.push({ x, y });
  }
  return out;
}

export const findOne = (grid, ch) => findAll(grid, ch)[0] ?? null;
export const at = (grid, x, y) =>
  x < 0 || y < 0 || x >= grid.w || y >= grid.h ? TILE.SOLID : grid.cells[y][x];
