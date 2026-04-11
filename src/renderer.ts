/**
 * DDA Raycasting renderer with Unicode box-drawing characters.
 *
 * Wall surfaces: █▓▒░ (shade density by distance — closer = denser)
 * Wall edges: │ (vertical corridor boundary)
 * Floor: ░ with dim color
 * Ceiling: black space
 * Wall-side indicator: ║ for E/W walls (side-lit), │ for N/S
 *
 * All characters colored with ANSI truecolor for smooth depth shading.
 */

import type { DungeonMap, PlayerPos } from "./dungeon.js";

export let VIEWPORT_W = 80;
export let VIEWPORT_H = 24;

export function setViewportSize(w: number, h: number): void {
  VIEWPORT_W = w;
  VIEWPORT_H = h;
}

const FOV = Math.PI / 3;  // 60°
const MAX_DIST = 16;
const RESET = "\x1b[0m";

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}


// --- Brightness by distance ---
function wallBright(dist: number, side: number): number {
  const base = clamp(260 - dist * 28);
  return side === 1 ? Math.round(base * 0.72) : base;
}

// --- DDA Raycasting ---

interface RayHit {
  dist: number;
  side: number;  // 0 = N/S face, 1 = E/W face
  wallX: number; // 0-1 where on the wall surface the ray hit
}

function castRay(
  grid: number[][], size: number,
  px: number, py: number,
  rayDirX: number, rayDirY: number,
): RayHit {
  const mapX = Math.floor(px), mapY = Math.floor(py);
  const deltaDistX = Math.abs(rayDirX) < 1e-10 ? 1e10 : Math.abs(1 / rayDirX);
  const deltaDistY = Math.abs(rayDirY) < 1e-10 ? 1e10 : Math.abs(1 / rayDirY);

  let stepX: number, stepY: number;
  let sideDistX: number, sideDistY: number;

  if (rayDirX < 0) { stepX = -1; sideDistX = (px - mapX) * deltaDistX; }
  else { stepX = 1; sideDistX = (mapX + 1 - px) * deltaDistX; }
  if (rayDirY < 0) { stepY = -1; sideDistY = (py - mapY) * deltaDistY; }
  else { stepY = 1; sideDistY = (mapY + 1 - py) * deltaDistY; }

  let hitX = mapX, hitY = mapY;
  let side = 0;

  for (let step = 0; step < 64; step++) {
    if (sideDistX < sideDistY) {
      sideDistX += deltaDistX; hitX += stepX; side = 0;
    } else {
      sideDistY += deltaDistY; hitY += stepY; side = 1;
    }
    if (hitX < 0 || hitY < 0 || hitX >= size || hitY >= size)
      return { dist: MAX_DIST, side, wallX: 0 };
    if (grid[hitY][hitX] === 1) {
      const dist = Math.max(side === 0 ? sideDistX - deltaDistX : sideDistY - deltaDistY, 0.01);
      let wallX = side === 0 ? py + dist * rayDirY : px + dist * rayDirX;
      wallX -= Math.floor(wallX);
      return { dist, side, wallX };
    }
  }
  return { dist: MAX_DIST, side: 0, wallX: 0 };
}

// --- Stone wall texture (8x8 tiling, running bond pattern) ---
// Returns brightness multiplier 0.0–1.0 at texture coordinate (u, v)
// u = horizontal (wallX), v = vertical (0 top of wall, 1 bottom)

const TEX_W = 8;
const TEX_H = 8;
const MORTAR = 0.55;  // mortar brightness (darker)
const STONE_MIN = 0.85;
const STONE_MAX = 1.0;

// Pre-compute texture: stone blocks with mortar lines
const stoneTex: number[][] = (() => {
  const tex: number[][] = [];
  const blockH = 3; // rows per stone course
  const blockW = 4; // cols per stone block

  for (let y = 0; y < TEX_H; y++) {
    tex[y] = [];
    const course = Math.floor(y / blockH);
    const inRow = y % blockH;
    const isMortarRow = inRow === 0; // horizontal mortar at top of each course
    const offset = (course % 2) * Math.floor(blockW / 2); // running bond offset

    for (let x = 0; x < TEX_W; x++) {
      const bx = (x + offset) % blockW;
      const isMortarCol = bx === 0; // vertical mortar at block edges

      if (isMortarRow || isMortarCol) {
        tex[y][x] = MORTAR;
      } else {
        // Slight variation within each stone block
        const blockId = course * 7 + Math.floor((x + offset) / blockW) * 3;
        const vary = ((blockId * 13 + 7) % 11) / 11; // pseudo-random per block
        tex[y][x] = STONE_MIN + vary * (STONE_MAX - STONE_MIN);
      }
    }
  }
  return tex;
})();

function sampleStoneTexture(u: number, v: number): number {
  const tx = Math.floor((u * TEX_W * 3) % TEX_W); // tile 3x horizontally per wall unit
  const ty = Math.floor((v * TEX_H * 3) % TEX_H); // tile 3x vertically
  return stoneTex[Math.abs(ty) % TEX_H][Math.abs(tx) % TEX_W];
}

// --- Main renderer ---

export function renderViewport(dungeon: DungeonMap, pos: PlayerPos): string[] {
  const { grid, size } = dungeon;
  const w = VIEWPORT_W;
  const h = VIEWPORT_H;

  // RGB per cell — everything rendered as background-colored spaces (no gaps)
  const buf: number[][] = Array.from({ length: h }, () => Array(w).fill(0));

  for (let col = 0; col < w; col++) {
    const cameraX = 2 * col / w - 1;
    const perpX = Math.cos(pos.facing + Math.PI / 2);
    const perpY = Math.sin(pos.facing + Math.PI / 2);
    const rayDirX = Math.cos(pos.facing) + perpX * cameraX * Math.tan(FOV / 2);
    const rayDirY = Math.sin(pos.facing) + perpY * cameraX * Math.tan(FOV / 2);

    const hit = castRay(grid, size, pos.x, pos.y, rayDirX, rayDirY);

    const lineHeight = Math.round(h / hit.dist);
    let drawStart = Math.round(-lineHeight / 2 + h / 2);
    let drawEnd = Math.round(lineHeight / 2 + h / 2);
    if (drawStart < 0) drawStart = 0;
    if (drawEnd >= h) drawEnd = h - 1;

    const v = wallBright(hit.dist, hit.side);

    // Wall with sparse dark bumps (multiple hash layers for irregular scatter)
    for (let row = drawStart; row <= drawEnd; row++) {
      const wx = Math.floor(hit.wallX * 10000);
      const h1 = ((col * 1327 ^ row * 9949 ^ wx * 6151) * 2654435761) >>> 0;
      const h2 = ((row * 3571 ^ col * 7919 ^ wx * 4253) * 2246822519) >>> 0;
      const pick = (h1 ^ h2) >>> 0;
      if (pick % 127 < 4) {
        buf[row][col] = clamp(v - (pick % 23) - 4);
      } else {
        buf[row][col] = v;
      }
    }

    // Floor (dim gradient toward camera)
    for (let row = drawEnd + 1; row < h; row++) {
      const t = (row - h / 2) / (h / 2);
      buf[row][col] = clamp(t * 20);
    }

    // Ceiling (very dark gradient)
    for (let row = 0; row < drawStart; row++) {
      const t = 1 - row / (h / 2);
      buf[row][col] = clamp(4 - t * 3);
    }
  }

  // Convert to ANSI — all background-colored spaces, zero gaps
  const lines: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = "";
    let prevR = -1;
    for (let x = 0; x < w; x++) {
      const v = buf[y][x];
      if (v !== prevR) {
        line += `\x1b[48;2;${v};${v};${v}m`;
        prevR = v;
      }
      line += " ";
    }
    line += RESET;
    lines.push(line);
  }
  return lines;
}

// --- HUD ---

export interface HudData {
  hp: number; maxHp: number; mp: number;
  xp: number; xpNext: number; level: number; title: string;
  gold: number; floor: string; weapon: string; items: string[];
}

function colorBar(
  current: number, max: number, width: number,
  filledR: number, filledG: number, filledB: number,
): string {
  const filled = Math.round((current / max) * width);
  const empty = width - filled;
  let bar = "";
  if (filled > 0) bar += `\x1b[48;2;${filledR};${filledG};${filledB}m` + " ".repeat(filled);
  if (empty > 0) bar += `\x1b[48;2;60;60;60m` + " ".repeat(empty);
  bar += RESET;
  return bar;
}

export function renderHud(data: HudData): string[] {
  const hpBar = colorBar(data.hp, data.maxHp, 8, 50, 200, 50);
  const mpBar = colorBar(data.mp, 100, 8, 150, 50, 200);
  const xpBar = colorBar(data.xp, data.xpNext, 8, 220, 200, 50);

  const line1 =
    `  HP ${hpBar} \x1b[38;2;180;180;180m${data.hp}/${data.maxHp}${RESET}` +
    `   MP ${mpBar} \x1b[38;2;180;180;180m${data.mp}%${RESET}` +
    `   XP ${xpBar} \x1b[38;2;180;180;180m${data.xp}/${data.xpNext}${RESET}` +
    `   \x1b[38;2;200;200;100mGold: ${data.gold}${RESET}`;

  const line2 =
    `  \x1b[38;2;120;200;120mLVL ${data.level} ${data.title}${RESET}` +
    `  \x1b[38;2;100;100;100m|${RESET}  ` +
    `\x1b[38;2;180;180;180mFloor: ${data.floor}${RESET}` +
    `  \x1b[38;2;100;100;100m|${RESET}  ` +
    `\x1b[38;2;180;140;100m[${data.weapon}]${RESET}` +
    data.items.map((i) => `  \x1b[38;2;140;140;180m[${i}]${RESET}`).join("");

  return [line1, line2];
}

export function renderNarrator(text: string, turn: number): string[] {
  const header = `\x1b[38;2;100;100;100mNARRATOR${RESET}  \x1b[38;2;60;60;60m(turn ${turn})${RESET}`;
  const body = `\x1b[38;2;180;180;160m${text}${RESET}`;
  return [header, body];
}

export function renderFrame(
  viewportLines: string[], hudLines: string[], narratorLines: string[],
): string {
  const lines: string[] = [];
  for (const row of viewportLines) lines.push(row);
  lines.push(`\x1b[48;2;40;40;40m` + " ".repeat(VIEWPORT_W) + RESET);
  for (const h of hudLines) lines.push(h);
  lines.push(`\x1b[48;2;30;30;30m` + " ".repeat(VIEWPORT_W) + RESET);
  for (const n of narratorLines) lines.push("  " + n);
  return lines.join("\n");
}

export function renderMinimap(dungeon: DungeonMap, pos: PlayerPos, radius = 7): string[] {
  const lines: string[] = [];
  const px = Math.floor(pos.x), py = Math.floor(pos.y);
  // Cardinals: NORTH=0 is +x (right on map), EAST=π/2 is +y (down), etc.
  const facingLabel =
    pos.facing < 0.1 ? "→"
      : pos.facing < Math.PI / 2 + 0.1 ? "↓"
        : pos.facing < Math.PI + 0.1 ? "←" : "↑";

  for (let dy = -radius; dy <= radius; dy++) {
    let line = "";
    for (let dx = -radius; dx <= radius; dx++) {
      const mx = px + dx, my = py + dy;
      if (mx === px && my === py) {
        line += `\x1b[38;2;0;255;0m${facingLabel}${RESET}`;
      } else if (mx < 0 || my < 0 || mx >= dungeon.size || my >= dungeon.size) {
        line += " ";
      } else if (dungeon.grid[my][mx] === 1) {
        line += `\x1b[38;2;60;60;60m█${RESET}`;
      } else {
        line += `\x1b[38;2;30;30;30m·${RESET}`;
      }
    }
    lines.push(line);
  }
  return lines;
}
