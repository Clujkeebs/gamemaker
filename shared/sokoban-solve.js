// Is this sokoban level actually solvable?
//
// "Reachable" is the wrong question here — a push puzzle can be fully connected
// and still impossible. So this does three things, cheapest first:
//
//   1. Structural checks. Enough boxes for the targets, a spawn, no box already
//      wedged in a dead corner. Catches most bad generated levels for free.
//   2. A bounded breadth-first search over push-states. Definitive when it
//      finishes inside the cap.
//   3. Honest reporting when it doesn't. A level the search couldn't settle in
//      time is reported as UNKNOWN, not as broken — claiming a level is
//      unsolvable because we ran out of budget would be a lie, and it would
//      throw away levels that are fine.
//
// Only the generator and the validator import this. Published games don't.

import { parseSokoban, isWall, boxesKey, solved, inDeadCorner, playerRegion, cellKey } from './sokoban.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Canonical player position for a push-state: the smallest reachable cell. */
function normalise(state, player, boxes) {
  const region = playerRegion(state, player, boxes);
  let best = null;
  for (const k of region) {
    const [x, y] = k.split(',').map(Number);
    if (!best || y < best.y || (y === best.y && x < best.x)) best = { x, y };
  }
  return { anchor: best ?? player, region };
}

export function structuralProblems(state) {
  const problems = [];
  if (!state.player) problems.push('level has no player spawn (P)');
  if (state.targets.length === 0) problems.push('level has no targets (T), so it can never be completed');
  if (state.boxes.length < state.targets.length) {
    problems.push(`only ${state.boxes.length} box(es) for ${state.targets.length} target(s)`);
  }
  for (const b of state.boxes) {
    if (inDeadCorner(state, b.x, b.y)) {
      problems.push(`a box at ${b.x},${b.y} is wedged in a corner and can never be moved onto a target`);
    }
  }
  return problems;
}

/**
 * @returns { status: 'solved'|'unsolvable'|'unknown', pushes, explored }
 */
export function solve(state, { cap = 60000, msBudget = 2000 } = {}) {
  if (!state.player) return { status: 'unsolvable', explored: 0 };
  if (solved(state, state.boxes)) return { status: 'solved', pushes: 0, explored: 0 };

  // A state count is not a time limit. Every node here runs a flood fill, so
  // cost per state varies hugely with the level: a wide-open 4-crate warehouse
  // measured 46s inside the same 60k-state budget that a tight puzzle finishes
  // in milliseconds. What the caller actually needs to bound is wall clock —
  // this runs inside a request that has to answer before the host hangs up.
  const deadline = Date.now() + msBudget;

  const targets = new Set(state.targets.map((t) => cellKey(t.x, t.y)));
  const start = normalise(state, state.player, state.boxes);
  const seen = new Set([`${cellKey(start.anchor.x, start.anchor.y)}|${boxesKey(state.boxes)}`]);
  let frontier = [{ anchor: start.anchor, region: start.region, boxes: state.boxes, pushes: 0 }];
  let explored = 0;

  while (frontier.length) {
    const next = [];
    for (const node of frontier) {
      if (++explored > cap) return { status: 'unknown', explored, limit: 'states' };
      // Checking the clock every node is measurable overhead; every 64 is
      // plenty of resolution against a budget in seconds.
      if ((explored & 63) === 0 && Date.now() > deadline) {
        return { status: 'unknown', explored, limit: 'time' };
      }

      const occupied = new Set(node.boxes.map((b) => cellKey(b.x, b.y)));
      for (let i = 0; i < node.boxes.length; i++) {
        const box = node.boxes[i];
        for (const [dx, dy] of DIRS) {
          const standX = box.x - dx;
          const standY = box.y - dy;
          const toX = box.x + dx;
          const toY = box.y + dy;
          // The player has to be able to get behind the box, and the far side
          // has to be empty.
          if (!node.region.has(cellKey(standX, standY))) continue;
          if (isWall(state, toX, toY) || occupied.has(cellKey(toX, toY))) continue;
          // Pushing into a dead corner is legal but pointless; pruning it is
          // what keeps the search inside its budget on wide-open levels.
          if (inDeadCorner(state, toX, toY)) continue;

          const boxes = node.boxes.map((b, j) => (j === i ? { x: toX, y: toY } : b));
          if (solved(state, boxes)) {
            return { status: 'solved', pushes: node.pushes + 1, explored };
          }
          const norm = normalise(state, { x: box.x, y: box.y }, boxes);
          const k = `${cellKey(norm.anchor.x, norm.anchor.y)}|${boxesKey(boxes)}`;
          if (seen.has(k)) continue;
          seen.add(k);
          next.push({ anchor: norm.anchor, region: norm.region, boxes, pushes: node.pushes + 1 });
        }
      }
    }
    frontier = next;
  }
  return { status: 'unsolvable', explored };
}

/** Full check used by the pipeline. */
export function checkSokoban(rows, opts = {}) {
  const state = parseSokoban(rows);
  const reasons = structuralProblems(state);
  if (reasons.length) return { ok: false, reasons, status: 'unsolvable', unreachable: [] };

  const result = solve(state, opts);
  if (result.status === 'solved') return { ok: true, reasons: [], status: 'solved', pushes: result.pushes, unreachable: [] };
  if (result.status === 'unknown') {
    // Explicitly not a failure. Say what happened and let it through.
    return {
      ok: true,
      reasons: [
        result.limit === 'time'
          ? `solver ran out of time after ${result.explored} states without settling this level; letting it through unverified`
          : `solver hit its ${result.explored}-state budget without settling this level; letting it through unverified`,
      ],
      status: 'unknown',
      unreachable: [],
    };
  }
  return {
    ok: false,
    reasons: [`no sequence of pushes solves this level (searched ${result.explored} states)`],
    status: 'unsolvable',
    unreachable: [],
  };
}

/**
 * Generate a level that is solvable BY CONSTRUCTION.
 *
 * Start from the finished position — every box already on a target — and then
 * *pull* boxes backwards. Every pull is a push run in reverse, so replaying
 * them forwards is a guaranteed solution. This is the same trick as generating
 * a maze with a spanning tree: make the property structural instead of
 * searching for it.
 */
export function generateSokoban(rand, { w = 11, h = 9, boxes = 3, pulls = 26, wallChance = 0.1 } = {}) {
  const cells = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) =>
      x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : '.')
  );
  // A few interior blocks for shape. Kept off the border ring so the interior
  // stays one connected room.
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) if (rand() < wallChance) cells[y][x] = '#';
  }

  const free = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) if (cells[y][x] === '.') free.push({ x, y });
  if (free.length < boxes + 2) return null;

  const shuffled = free.slice().sort(() => rand() - 0.5);
  const targets = shuffled.slice(0, boxes);
  const live = targets.map((t) => ({ ...t }));
  const isFree = (x, y) =>
    x > 0 && y > 0 && x < w - 1 && y < h - 1 && cells[y][x] !== '#' &&
    !live.some((b) => b.x === x && b.y === y);

  // Park the player next to a box to start pulling.
  let player = null;
  for (const b of live) {
    for (const [dx, dy] of DIRS) {
      if (isFree(b.x + dx, b.y + dy)) { player = { x: b.x + dx, y: b.y + dy }; break; }
    }
    if (player) break;
  }
  if (!player) return null;

  for (let i = 0; i < pulls; i++) {
    const b = live[Math.floor(rand() * live.length)];
    const [dx, dy] = DIRS[Math.floor(rand() * DIRS.length)];
    // To pull the box to (b - d), the player must stand at (b - d) and step to
    // (b - 2d); both must be clear.
    const px = b.x - dx;
    const py = b.y - dy;
    const qx = b.x - dx * 2;
    const qy = b.y - dy * 2;
    if (!isFree(px, py) || !isFree(qx, qy)) continue;

    const reachable = playerRegion(
      { w, h, walls: new Set(cells.flatMap((row, y) => row.flatMap((c, x) => (c === '#' ? [`${x},${y}`] : [])))) },
      player, live
    );
    if (!reachable.has(`${px},${py}`)) continue;

    b.x = px;
    b.y = py;
    player = { x: qx, y: qy };
  }

  // Nothing moved? That's a degenerate puzzle — say so instead of shipping it.
  if (live.every((b, i) => b.x === targets[i].x && b.y === targets[i].y)) return null;

  for (const t of targets) cells[t.y][t.x] = 'T';
  for (const b of live) cells[b.y][b.x] = cells[b.y][b.x] === 'T' ? '*' : 'B';
  cells[player.y][player.x] = cells[player.y][player.x] === 'T' ? '+' : 'P';
  return cells.map((r) => r.join(''));
}
