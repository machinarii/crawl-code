#!/usr/bin/env node
/**
 * Crawl Code overlay for Ollama — uses REST API directly.
 *
 * No PTY, no CLI wrapping. Calls Ollama's /api/chat endpoint,
 * streams the response, strips thinking blocks, and renders
 * the dungeon header above the conversation.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import * as readline from "node:readline";
import {
  generateDungeon, startingPosition, stepForward,
  createStepRng, isAtDeadEnd,
} from "./dungeon.js";
import type { DungeonMap, PlayerPos } from "./dungeon.js";
import {
  renderViewport, renderHud, renderNarrator,
  setViewportSize,
} from "./renderer.js";
import type { HudData } from "./renderer.js";
import { randomMonster, renderMonsterOverlay, renderMonsterStatus } from "./monsters.js";
import type { Monster } from "./monsters.js";

// -------------------------------------------------------------------
// Game state
// -------------------------------------------------------------------

interface GS {
  dungeon: DungeonMap; pos: PlayerPos; rng: () => number;
  floor: number; turn: number; hp: number; maxHp: number;
  xp: number; level: number; gold: number; weapon: string;
  narrator: string; history: string[];
  monster: Monster | null; monsterHp: number; seed: number;
}

const WEAPONS = [
  "Elven Wand of Tokenization", "Dragon Claw of Attention",
  "Hellstaff of Hallucination", "Phoenix Rod of Fine-Tuning",
  "Staff of Reinforcement Learning", "Wand of Emergent Behavior",
];

// XP required to reach next level
const XP_THRESHOLDS = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
const xpNeeded = (level: number) => XP_THRESHOLDS[Math.min(level - 1, XP_THRESHOLDS.length - 1)];
// XP earned per exchange scales with level
const xpGain = (level: number) => 10 + Math.floor(Math.random() * 10) + level * 3;
const title = (l: number) => l >= 15 ? "Archmage" : l >= 10 ? "High Sorcerer" : l >= 5 ? "Sorcerer Adept" : "Sorcerer";

function narrate(gs: GS, t: string) { gs.narrator = t; gs.history.push(t); while (gs.history.length > 5) gs.history.shift(); }

function newGS(seed: number): GS {
  const d = generateDungeon(32, seed);
  const history = [
    "The guild masters spoke of a labyrinth beneath the old compiler ruins.",
    "Armed with nothing but a Boring Wand, you descend the spiral stair.",
    "The iron gate seals behind you. Torchlight catches ancient runes.",
    "Somewhere below, the Source Code of the Ancients awaits.",
    "You grip your wand and step into the darkness. The dungeon breathes.",
  ];
  return { dungeon: d, pos: startingPosition(d), rng: createStepRng(seed),
    floor: 1, turn: 0, hp: 100, maxHp: 100, xp: 0, level: 1, gold: 0,
    weapon: "Boring Wand", narrator: history[history.length - 1],
    history, monster: null, monsterHp: 0, seed };
}

function advance(gs: GS) {
  gs.turn++;
  if (gs.monster) {
    const dmg = 8 + Math.floor(Math.random() * 12);
    gs.monsterHp -= dmg;
    if (gs.monsterHp <= 0) {
      gs.xp += gs.monster.xp; gs.gold += 5 + Math.floor(Math.random() * 15);
      if (Math.random() < 0.3) { const w = WEAPONS.filter(x => x !== gs.weapon)[Math.floor(Math.random() * (WEAPONS.length - 1))]; gs.weapon = w; narrate(gs, `${gs.monster.name} was destroyed! You find a ${w}.`); }
      else narrate(gs, `${gs.monster.name} was destroyed! +${gs.monster.xp} XP`);
      gs.monster = null; gs.monsterHp = 0;
    } else { const pd = 3 + Math.floor(Math.random() * 8); gs.hp = Math.max(1, gs.hp - pd); narrate(gs, `You swing at ${gs.monster.name} for ${dmg}. It strikes back for ${pd}.`); }
    return;
  }
  const r = stepForward(gs.dungeon, gs.pos, gs.rng);
  if (r.moved) gs.pos = r.pos;
  if (!r.moved && isAtDeadEnd(gs.dungeon, gs.pos)) { gs.floor++; gs.seed += gs.floor * 7919; gs.dungeon = generateDungeon(32, gs.seed); gs.pos = startingPosition(gs.dungeon); gs.rng = createStepRng(gs.seed); narrate(gs, `You step through a crumbling archway. Floor B${gs.floor} — a new passage opens.`); return; }
  if (gs.level < 10) {
    gs.xp += xpGain(gs.level);
    if (gs.level < 10 && gs.xp >= xpNeeded(gs.level)) { gs.level++; gs.maxHp += 10; gs.hp = Math.min(gs.hp + 20, gs.maxHp); narrate(gs, `You step forward and feel power surge. Level ${gs.level} ${title(gs.level)}!`); return; }
  }
  if (Math.random() < 0.25) { gs.monster = randomMonster(); gs.monsterHp = gs.monster.hp; narrate(gs, `You step forward. A ${gs.monster.name} lurches from the shadows!`); return; }
  const a = [
    "You step forward. The corridor stretches onward.",
    "You take a step. Your footsteps echo against cold stone.",
    "You press ahead. A faint draft brushes your face.",
    "You move forward. Dripping water echoes far away.",
    "You round a corner. The passage turns sharply.",
    "You step into darkness. Dust swirls at your feet.",
    "You advance one pace. The dungeon does not protest.",
    "You push through cobwebs and step forward.",
    "You stride ahead. The torchlight flickers on the walls.",
    "You take another step deeper into the labyrinth.",
  ];
  narrate(gs, a[Math.floor(Math.random() * a.length)]);
}

// -------------------------------------------------------------------
// Ollama API
// -------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "system-prompt.md"), "utf-8");
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

interface ChatMessage { role: "system" | "user" | "assistant"; content: string; }

function ollamaChat(
  model: string,
  messages: ChatMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
): void {
  const url = new URL("/api/chat", OLLAMA_HOST);
  const body = JSON.stringify({ model, messages, stream: true,
    options: { num_predict: 300 },  // keep replies short so they don't bury the chat
  });

  const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
    let buf = "";
    let inThink = false;

    res.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || ""; // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.done) { onDone(); return; }
          let content: string = json.message?.content || "";

          // Strip <think>...</think> inline
          while (content.includes("<think>")) {
            const start = content.indexOf("<think>");
            const end = content.indexOf("</think>");
            if (end >= 0) {
              content = content.slice(0, start) + content.slice(end + 8);
            } else {
              // Opening tag but no close yet — mark as inside thinking
              content = content.slice(0, start);
              inThink = true;
            }
          }
          if (inThink) {
            if (content.includes("</think>")) {
              content = content.slice(content.indexOf("</think>") + 8);
              inThink = false;
            } else {
              continue; // still thinking, skip
            }
          }

          if (content.length > 0) onToken(content);
        } catch {}
      }
    });

    res.on("end", () => onDone());
  });

  req.on("error", (e) => {
    onToken(`\n[Ollama error: ${e.message}]\n`);
    onDone();
  });

  req.write(body);
  req.end();
}

// -------------------------------------------------------------------
// Drawing
// -------------------------------------------------------------------

function drawHeader(gs: GS, cols: number, vpH: number, headerH: number) {
  const RST = "\x1b[0m";
  const DIM = "\x1b[38;2;90;90;90m";
  const W = "\x1b[38;2;220;220;220m";
  const GRN = "\x1b[38;2;80;200;80m";
  const RED = "\x1b[38;2;220;60;60m";
  const GLD = "\x1b[38;2;220;200;80m";
  const CYN = "\x1b[38;2;100;200;220m";

  function pad(s: string, w: number) { const v = s.replace(/\x1b\[[0-9;]*m/g, ""); return v.length >= w ? s : s + " ".repeat(w - v.length); }
  function bar(c: number, m: number, w: number, r: number, g: number, b: number) { const f = Math.round((c / m) * w); return `\x1b[48;2;${r};${g};${b}m${" ".repeat(f)}\x1b[48;2;40;40;40m${" ".repeat(w - f)}${RST}`; }

  process.stdout.write("\x1b7\x1b[?25l\x1b[1;1H");

  const vp = renderViewport(gs.dungeon, gs.pos);
  for (const l of vp) process.stdout.write(l + "\x1b[K\n");

  if (gs.monster) {
    const ov = renderMonsterOverlay(gs.monster, cols, vpH);
    for (const o of ov) if (o.row >= 0 && o.row < vpH) process.stdout.write(`\x1b[${o.row + 1};${o.col + 1}H${o.text}`);
    process.stdout.write(`\x1b[${vpH + 1};1H`);
  }

  process.stdout.write(`\x1b[48;2;40;40;40m${" ".repeat(cols)}\x1b[K${RST}\n`);

  const hw = Math.floor(cols / 2);
  const L = [
    ` ${W}Player: ${GRN}${title(gs.level)}, Lvl ${gs.level}${RST}  ${DIM}Floor B${gs.floor}${RST}`,
    ` HP ${bar(gs.hp, gs.maxHp, 10, 50, 200, 50)} ${W}${gs.hp}/${gs.maxHp}${RST}`,
    ` MP ${bar(100, 100, 10, 150, 50, 200)} ${W}100%${RST}`,
    (() => {
      const prevThresh = gs.level <= 1 ? 0 : xpNeeded(gs.level - 1);
      const nextThresh = xpNeeded(gs.level);
      const current = gs.xp - prevThresh;
      const needed = nextThresh - prevThresh;
      return ` XP ${bar(current, needed, 10, 220, 200, 50)} ${DIM}${gs.xp}/${nextThresh}${RST}`;
    })(),
    ` ${CYN}Equipped: [${gs.weapon}]${RST}`,
    ` ${GLD}Crypto: ${gs.gold}${RST}`,
  ];
  const R: string[] = [];
  if (gs.monster) {
    const fc = Object.values(gs.monster.palette)[0];
    R.push(`${W}NPC: \x1b[38;2;${fc[0]};${fc[1]};${fc[2]}m${gs.monster.name}${RST}`);
    R.push(`HP ${bar(gs.monsterHp, gs.monster.hp, 10, 50, 200, 50)} ${W}${gs.monsterHp}/${gs.monster.hp}${RST}`);
    R.push(`${RED}⚔ Combat!${RST}`); R.push(""); R.push(""); R.push("");
  } else { R.push(`${DIM}No enemies nearby${RST}`); R.push(""); R.push(""); R.push(""); R.push(""); R.push(""); }
  for (let i = 0; i < Math.max(L.length, R.length); i++) process.stdout.write(pad(L[i] || "", hw) + (R[i] || "") + `\x1b[K\n`);

  process.stdout.write(`\x1b[48;2;30;30;30m${" ".repeat(cols)}\x1b[K${RST}\n`);
  process.stdout.write("\x1b8\x1b[?25h");
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

async function main() {
  const model = process.argv[2] || "llama3.2";
  const TC = process.stdout.columns || 80;
  const TR = process.stdout.rows || 40;
  const cols = Math.min(TC, 80);
  const vpH = Math.max(10, Math.floor(TR * 0.38));
  const headerH = vpH + 9; // viewport + separator(1) + info(6) + separator(1) + separator(1)

  setViewportSize(cols, vpH);
  const gs = newGS(Math.floor(Math.random() * 100000));

  // Chat history for context
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  // Chat buffer — stores all chat content for re-rendering on resize
  const chatBuffer: string[] = [];

  function chatWrite(text: string) {
    // Split into lines and buffer
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i === 0 && chatBuffer.length > 0) {
        // Append to last line (partial line continuation)
        chatBuffer[chatBuffer.length - 1] += lines[0];
      } else {
        chatBuffer.push(lines[i]);
      }
    }
    // Also write to stdout
    process.stdout.write(text);
  }

  function redrawChat() {
    const nr = process.stdout.rows || 40;
    const chatRows = nr - headerH;
    // Show last N lines that fit
    const startIdx = Math.max(0, chatBuffer.length - chatRows + 1);
    process.stdout.write(`\x1b[${headerH + 1};1H\x1b[J`);
    for (let i = startIdx; i < chatBuffer.length; i++) {
      process.stdout.write(chatBuffer[i] + "\n");
    }
  }

  // Setup scroll region
  process.stdout.write("\x1b[2J\x1b[H");
  drawHeader(gs, cols, vpH, headerH);
  process.stdout.write(`\x1b[${headerH + 1};${TR}r`);
  process.stdout.write(`\x1b[${headerH + 1};1H`);

  // Print opening events
  const EVT = "\x1b[38;2;160;140;100m";
  const RST0 = "\x1b[0m";
  for (const evt of gs.history) {
    chatWrite(`${EVT}  ⟫ ${evt}${RST0}\n`);
  }
  chatWrite(`\n\x1b[38;2;80;200;80m  The Oracle awaits thy query, Chosen One...\x1b[0m\n\n`);

  let busy = false;

  const PROMPT_STR = `\x1b[38;2;100;200;100m>>> \x1b[0m`;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: PROMPT_STR });

  rl.prompt();

  rl.on("line", (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) { rl.prompt(); return; }
    if (trimmed.toLowerCase() === "quit" || trimmed.toLowerCase() === "exit") {
      process.stdout.write("\x1b[r\x1b[0m\n");
      process.exit(0);
    }
    if (busy) return;
    busy = true;

    messages.push({ role: "user", content: trimmed });

    process.stdout.write("\n");
    let fullResponse = "";
    let firstToken = true;

    // Spinner while waiting for first token
    const spinChars = ["◜", "◠", "◝", "◞", "◡", "◟"];
    const spinMessages = [
      "The orb begins to glow...",
      "Ancient runes shimmer on the walls...",
      "The Oracle stirs from slumber...",
      "A whisper echoes through the stone...",
      "The crystal pulses with light...",
      "Dust swirls as magic gathers...",
    ];
    const spinMsg = spinMessages[Math.floor(Math.random() * spinMessages.length)];
    let spinIdx = 0;
    const spinner = setInterval(() => {
      const ch = spinChars[spinIdx % spinChars.length];
      process.stdout.write(`\r\x1b[38;2;180;150;255m  ${ch} ${spinMsg}\x1b[0m\x1b[K`);
      spinIdx++;
    }, 120);

    ollamaChat(model, messages, (token) => {
      if (firstToken) {
        clearInterval(spinner);
        process.stdout.write(`\r\x1b[K`);
        firstToken = false;
      }
      chatWrite(token);
      fullResponse += token;
    }, () => {
      if (firstToken) { clearInterval(spinner); process.stdout.write(`\r\x1b[K`); }
      chatWrite("\n");
      messages.push({ role: "assistant", content: fullResponse });
      while (messages.length > 21) messages.splice(1, 2);

      // Sequenced update:
      // 1. Reply just finished (above)
      // 2. Pause, then show transitional event narration
      setTimeout(() => {
        advance(gs);

        // 3. Show the event text in the chat area
        const DIM2 = "\x1b[38;2;160;140;100m";
        const RST2 = "\x1b[0m";
        chatWrite(`${DIM2}  ⟫ ${gs.narrator}${RST2}\n\n`);

        // 4. Pause, then update visual (dungeon viewport + HUD)
        setTimeout(() => {
          drawHeader(gs, cols, vpH, headerH);

          busy = false;
          rl.prompt();
        }, 600);
      }, 800);
    });
  });

  rl.on("close", () => {
    process.stdout.write("\x1b[r\x1b[0m\n");
    process.exit(0);
  });

  // Handle resize — redraw header and chat from buffer
  process.stdout.on("resize", () => {
    const nr = process.stdout.rows || 40;
    process.stdout.write("\x1b[r"); // reset scroll region temporarily
    drawHeader(gs, cols, vpH, headerH);
    process.stdout.write(`\x1b[${headerH + 1};${nr}r`);
    redrawChat();
  });
}

main();
