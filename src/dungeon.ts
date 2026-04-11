/**
 * Dungeon generation — single winding path, no branches.
 *
 * Uses backtracking DFS to produce one long snake-like corridor
 * with max 3 straight tiles before a forced turn.
 * When the player reaches the dead end, a new floor generates.
 */

export interface DungeonMap {
  grid: number[][]; // 1 = wall, 0 = open
  rooms: Array<{ cx: number; cy: number; w: number; h: number }>;
  size: number;
  deadEnds: Array<{ x: number; y: number }>;
}

export interface PlayerPos {
  x: number;
  y: number;
  facing: number;
}

export const CARDINAL = {
  NORTH: 0,
  EAST: Math.PI / 2,
  SOUTH: Math.PI,
  WEST: (3 * Math.PI) / 2,
} as const;

const MAX_VIEW_DEPTH = 8;
const MAX_STRAIGHT = 2; // max consecutive same-direction moves (3 tiles visible)

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const DIRS: Array<[number, number]> = [[0, -1], [0, 1], [-1, 0], [1, 0]];

/**
 * Generate a single winding path using backtracking DFS.
 * No branches — one continuous corridor that snakes through the grid.
 * Backtracks when stuck to find longer paths.
 */
export function generateDungeon(size = 32, seed?: number): DungeonMap {
  const rng = seed !== undefined ? mulberry32(seed) : Math.random;

  const grid: number[][] = Array.from({ length: size }, () => Array(size).fill(1));
  const cellsW = Math.floor((size - 1) / 2);
  const cellsH = Math.floor((size - 1) / 2);
  const visited: boolean[][] = Array.from({ length: cellsH }, () => Array(cellsW).fill(false));

  // DFS state
  interface Step { cx: number; cy: number; dx: number; dy: number; sc: number; }
  const path: Step[] = [];
  let bestLen = 0;
  let bestGrid: number[][] | null = null;
  let bestEnd: [number, number] = [0, 0];

  const startX = Math.floor(rng() * cellsW);
  const startY = Math.floor(rng() * cellsH);

  visited[startY][startX] = true;
  grid[startY * 2 + 1][startX * 2 + 1] = 0;

  function getNeighbors(cx: number, cy: number, dx: number, dy: number, sc: number) {
    const opts: Array<[number, number, number, number]> = [];
    for (const [ddx, ddy] of DIRS) {
      const nx = cx + ddx, ny = cy + ddy;
      if (nx < 0 || nx >= cellsW || ny < 0 || ny >= cellsH || visited[ny][nx]) continue;
      if (sc >= MAX_STRAIGHT && ddx === dx && ddy === dy) continue;
      opts.push([nx, ny, ddx, ddy]);
    }
    return shuffle(opts, rng);
  }

  // Iterative DFS with backtracking
  interface Frame { neighbors: Array<[number, number, number, number]>; }
  const stack: Frame[] = [{ neighbors: getNeighbors(startX, startY, 1, 0, 0) }];
  let cx = startX, cy = startY, lastDx = 1, lastDy = 0, sc = 0;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    if (frame.neighbors.length === 0) {
      // Backtrack
      stack.pop();
      if (path.length > 0) {
        const prev = path.pop()!;
        // Uncarve
        visited[prev.cy][prev.cx] = false;
        grid[prev.cy * 2 + 1][prev.cx * 2 + 1] = 1;
        // Uncarve wall between parent and this cell
        const parent = path.length > 0 ? path[path.length - 1] : { cx: startX, cy: startY, dx: 1, dy: 0, sc: 0 };
        grid[parent.cy * 2 + 1 + prev.dy][parent.cx * 2 + 1 + prev.dx] = 1;

        // Restore state
        cx = parent.cx; cy = parent.cy;
        lastDx = parent.dx; lastDy = parent.dy; sc = parent.sc;
      }
      continue;
    }

    const [nx, ny, ddx, ddy] = frame.neighbors.pop()!;
    if (visited[ny][nx]) continue;

    const newSc = (ddx === lastDx && ddy === lastDy) ? sc + 1 : 1;

    // Carve
    visited[ny][nx] = true;
    grid[ny * 2 + 1][nx * 2 + 1] = 0;
    grid[cy * 2 + 1 + ddy][cx * 2 + 1 + ddx] = 0;

    path.push({ cx: nx, cy: ny, dx: ddx, dy: ddy, sc: newSc });

    // Save best path found so far
    if (path.length > bestLen) {
      bestLen = path.length;
      bestEnd = [nx, ny];
      // Snapshot grid only occasionally to avoid overhead
      if (path.length % 20 === 0 || path.length >= cellsW * cellsH * 0.5) {
        bestGrid = grid.map(row => [...row]);
      }
    }

    // Good enough — stop
    if (path.length >= cellsW * cellsH * 0.5) break;

    cx = nx; cy = ny; lastDx = ddx; lastDy = ddy; sc = newSc;
    stack.push({ neighbors: getNeighbors(nx, ny, ddx, ddy, newSc) });
  }

  // Use best grid if current is shorter
  if (bestGrid && path.length < bestLen) {
    for (let y = 0; y < size; y++) grid[y] = bestGrid[y];
  }

  const deadEnds: DungeonMap["deadEnds"] = [
    { x: bestEnd[0] * 2 + 1, y: bestEnd[1] * 2 + 1 },
  ];

  return { grid, rooms: [], size, deadEnds };
}

// --- Starting position ---

export function startingPosition(dungeon: DungeonMap): PlayerPos {
  const { grid, size } = dungeon;
  const dirs = [
    { dx: 1, dy: 0, facing: CARDINAL.NORTH },
    { dx: -1, dy: 0, facing: CARDINAL.SOUTH },
    { dx: 0, dy: 1, facing: CARDINAL.EAST },
    { dx: 0, dy: -1, facing: CARDINAL.WEST },
  ];
  const open = (gx: number, gy: number) =>
    gx >= 0 && gy >= 0 && gx < size && gy < size && grid[gy][gx] === 0;
  const wall = (gx: number, gy: number) => !open(gx, gy);

  let best: PlayerPos | null = null;
  let bestDepth = 0;

  for (let gy = 1; gy < size - 1; gy++) {
    for (let gx = 1; gx < size - 1; gx++) {
      if (grid[gy][gx] !== 0) continue;
      for (const { dx, dy, facing } of dirs) {
        const px = dy, py = dx;
        if (!wall(gx + px, gy + py) || !wall(gx - px, gy - py)) continue;
        let depth = 0;
        for (let d = 1; d <= MAX_VIEW_DEPTH; d++) {
          if (!open(gx + dx * d, gy + dy * d)) break;
          depth = d;
        }
        if (depth > bestDepth) { bestDepth = depth; best = { x: gx + 0.5, y: gy + 0.5, facing }; }
      }
    }
  }

  if (best && bestDepth >= 1) return best;

  for (let y = 1; y < size - 1; y++)
    for (let x = 1; x < size - 1; x++)
      if (grid[y][x] === 0) return { x: x + 0.5, y: y + 0.5, facing: CARDINAL.NORTH };
  return { x: 1.5, y: 1.5, facing: CARDINAL.NORTH };
}

// --- Utilities ---

export function isAtDeadEnd(dungeon: DungeonMap, pos: PlayerPos): boolean {
  const gx = Math.floor(pos.x), gy = Math.floor(pos.y);
  return dungeon.deadEnds.some(de => de.x === gx && de.y === gy);
}

function isOpenD(dungeon: DungeonMap, gx: number, gy: number): boolean {
  return gx >= 0 && gy >= 0 && gx < dungeon.size && gy < dungeon.size && dungeon.grid[gy][gx] === 0;
}

function dirVec(facing: number): { dx: number; dy: number } {
  return { dx: Math.round(Math.cos(facing)), dy: Math.round(Math.sin(facing)) };
}

export function createStepRng(seed: number): () => number {
  return mulberry32(seed ^ 0xdeadbeef);
}

export function stepForward(
  dungeon: DungeonMap, pos: PlayerPos, rng?: () => number,
): { moved: boolean; pos: PlayerPos } {
  const gx = Math.floor(pos.x), gy = Math.floor(pos.y);
  const { dx, dy } = dirVec(pos.facing);
  const nx = gx + dx, ny = gy + dy;

  if (isOpenD(dungeon, nx, ny))
    return { moved: true, pos: { x: nx + 0.5, y: ny + 0.5, facing: pos.facing } };

  const allDirs = [CARDINAL.NORTH, CARDINAL.EAST, CARDINAL.SOUTH, CARDINAL.WEST];
  const reverse = (pos.facing + Math.PI) % (2 * Math.PI);
  const candidates: number[] = [], reverseCandidates: number[] = [];

  for (const d of allDirs) {
    const v = dirVec(d);
    if (isOpenD(dungeon, gx + v.dx, gy + v.dy)) {
      if (Math.abs(d - reverse) < 0.01) reverseCandidates.push(d);
      else candidates.push(d);
    }
  }

  const pool = candidates.length > 0 ? candidates : reverseCandidates;
  if (pool.length === 0) return { moved: false, pos };

  const pick = rng ? pool[Math.floor(rng() * pool.length)] : pool[0];
  const v = dirVec(pick);
  return { moved: true, pos: { x: gx + v.dx + 0.5, y: gy + v.dy + 0.5, facing: pick } };
}

export function turnPlayer(pos: PlayerPos, direction: "left" | "right"): PlayerPos {
  const delta = direction === "right" ? Math.PI / 2 : -Math.PI / 2;
  let newFacing = (pos.facing + delta) % (2 * Math.PI);
  if (newFacing < 0) newFacing += 2 * Math.PI;
  const cardinals = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  let closest = cardinals[0], minDiff = Infinity;
  for (const c of cardinals) { const diff = Math.abs(newFacing - c); if (diff < minDiff) { minDiff = diff; closest = c; } }
  return { ...pos, facing: closest };
}
