// Sokoban state: the parts the engine needs at runtime.
//
// Kept separate from the solver so a published game ships the rules but not the
// verifier — the verifier runs here, before anything is written.

export const SOKO = {
  WALL: '#',
  FLOOR: '.',
  PLAYER: 'P',
  BOX: 'B',
  TARGET: 'T',
  BOX_ON_TARGET: '*',
  PLAYER_ON_TARGET: '+',
};

export const SOKO_TILES = Object.values(SOKO);

const key = (x, y) => `${x},${y}`;

/** Pull the dynamic pieces out of the grid, leaving only walls as terrain. */
export function parseSokoban(rows) {
  const h = rows.length;
  const w = Math.max(0, ...rows.map((r) => r.length));
  const walls = new Set();
  const targets = [];
  const boxes = [];
  let player = null;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x] ?? SOKO.WALL;
      switch (ch) {
        case SOKO.WALL: walls.add(key(x, y)); break;
        case SOKO.PLAYER: player = { x, y }; break;
        case SOKO.BOX: boxes.push({ x, y }); break;
        case SOKO.TARGET: targets.push({ x, y }); break;
        case SOKO.BOX_ON_TARGET: boxes.push({ x, y }); targets.push({ x, y }); break;
        case SOKO.PLAYER_ON_TARGET: player = { x, y }; targets.push({ x, y }); break;
        default: break;
      }
    }
  }
  return { w, h, walls, player, boxes, targets };
}

export const isWall = (state, x, y) =>
  x < 0 || y < 0 || x >= state.w || y >= state.h || state.walls.has(key(x, y));

export const cellKey = key;

/** Serialise box positions for comparison. Order-independent. */
export const boxesKey = (boxes) =>
  boxes.map((b) => key(b.x, b.y)).sort().join(';');

export const solved = (state, boxes) => {
  const t = new Set(state.targets.map((p) => key(p.x, p.y)));
  return boxes.every((b) => t.has(key(b.x, b.y)));
};

/**
 * A box wedged into a corner can never be moved again. If it isn't on a target,
 * the level is already lost — the classic sokoban deadlock, and the one that
 * catches most unsolvable generated levels without any search at all.
 */
export function inDeadCorner(state, x, y) {
  if (state.targets.some((t) => t.x === x && t.y === y)) return false;
  const up = isWall(state, x, y - 1);
  const down = isWall(state, x, y + 1);
  const left = isWall(state, x - 1, y);
  const right = isWall(state, x + 1, y);
  return (up || down) && (left || right);
}

/** Cells the player can walk to, treating boxes as walls. */
export function playerRegion(state, from, boxes) {
  const blocked = new Set(boxes.map((b) => key(b.x, b.y)));
  const seen = new Set([key(from.x, from.y)]);
  const queue = [from];
  while (queue.length) {
    const { x, y } = queue.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      const k = key(nx, ny);
      if (seen.has(k) || isWall(state, nx, ny) || blocked.has(k)) continue;
      seen.add(k);
      queue.push({ x: nx, y: ny });
    }
  }
  return seen;
}
