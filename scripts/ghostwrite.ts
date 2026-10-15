#!/usr/bin/env bun
// ghostwrite — draft in the operator's own mind and voice, from the operator's
// own material: SOUL.md (how they think, argue, and write) plus the snippets
// `search` retrieves from the store (what they've actually said). The draft goes
// out through the one outbound call, reused from lib/ask.ts — no new network code.
//
// Usage: bun scripts/ghostwrite.ts "topic or prompt" [--k 8] [--soul <path>] [--dry]
//
// CONSTRAINTS.md item 10: it drafts, it never delivers. --dry prints exactly what
// would be sent and sends nothing; the real call is a human act (refused under
// CLAUDECODE), same as ask/contradictions/standing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, fail, StoreError } from "./lib/db";
import { parseArgs, usage, fmtInt } from "./lib/cli";
import { search, heading, type Hit } from "./query";
import { complete } from "./lib/ask";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const USAGE = `
usage: bun scripts/ghostwrite.ts "topic or prompt" [--k 8] [--soul <path>] [--dry]

  Drafts the topic as the operator, from SOUL.md (how they think and write) plus the
  top-k snippets retrieved from the store (what they've said). Needs the passphrase
  (AI_MEMORY_KEY, --key-file, or prompt) to read the store.

  --k N         how many snippets to retrieve and ground on (default 8)
  --soul PATH   the profile to write from (default SOUL.md at the repo root)
  --dry         print the snippets and the assembled prompt; call no model
`;

const SYSTEM_HEAD = `You are drafting as one specific person, using a distilled model of how they think, argue, and write. The profile below (SOUL) is built only from that person's own writing. Reason from their priors, make their moves, and write in their voice — short declaratives that turn, dash asides, their register. Ground claims in the numbered snippets from their own record wherever one applies, and cite the snippet number. Never put a belief in their mouth that the profile and snippets do not support; where their record is silent on a stance, write the open question they would ask rather than inventing a position. Produce a draft for them to review — do not address, greet, or sign as anyone.`;

function requireHumanOperator(dry: boolean): void {
  if (dry) return;
  if (process.env.CLAUDECODE) {
    throw new StoreError(
      "refusing to draft through the model from inside an AI coding session (CLAUDECODE is set) — " +
      "sending anything outbound is a human act here. Run this command yourself in a normal terminal. " +
      "--dry still works from here.",
    );
  }
}

function buildSystem(soul: string): string {
  return `${SYSTEM_HEAD}\n\n── SOUL — how this person thinks, argues, and writes ──\n${soul}`;
}

function buildUser(topic: string, hits: Hit[]): string {
  const snippets = hits.length
    ? hits.map((h, i) => `[${i + 1}] ${heading(h)}\n${h.snippet}`).join("\n\n")
    : "(no matching snippets in the record — write from SOUL, and where their stance is unknown, surface the open question rather than inventing one)";
  return `Topic / prompt:\n${topic}\n\n── their own prior words (numbered snippets from the record) ──\n${snippets}\n\n── task ──\nDraft this as them. Use their priors and argumentative moves; keep their voice. Cite snippet numbers where a claim leans on one. End the way they end — on the reframed question, not a tidy bow.`;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), ["dry", "help"], ["k", "soul"]);
  } catch (e) {
    usage(`${(e as Error).message}\n${USAGE}`);
  }
  if (args.flags.has("help") || !args.positional.length) usage(USAGE);
  const topic = args.positional.join(" ");
  const k = Math.min(Math.max(Number(args.opts.get("k") ?? 8) || 8, 1), 50);
  const DRY = args.flags.has("dry");
  const soulPath = args.opts.get("soul") ?? join(REPO, "SOUL.md");

  requireHumanOperator(DRY);
  if (!existsSync(soulPath))
    usage(`no SOUL profile at ${soulPath} — pass --soul <path>, or build SOUL.md from your corpus first.`);
  const soul = readFileSync(soulPath, "utf8");

  try {
    const db = openStore({ readonly: true });
    const hits = search(db, topic, { limit: k });
    const system = buildSystem(soul);
    const user = buildUser(topic, hits);

    if (DRY) {
      console.log("── retrieved snippets ──");
      hits.forEach((h, i) => console.log(`\n[${i + 1}] ${heading(h)} · score ${h.score.toFixed(2)}\n${h.snippet}`));
      console.log(`\n── system (SOUL framing, ${fmtInt(soul.length)} chars) ──\n${SYSTEM_HEAD}\n[+ SOUL.md]`);
      console.log("\n── user message ──\n" + user);
      console.log(`\nDRY RUN — nothing sent. ${fmtInt(hits.length)} snippets + SOUL would go to the model.`);
      db.close();
      return;
    }

    const draft = await complete(system, user, 2048);
    db.close();
    console.log("\n" + draft + "\n");
    console.error(`(draft from SOUL + ${fmtInt(hits.length)} of your own snippets — review before any use; nothing was sent or signed anywhere)`);
  } catch (e) {
    fail(e);
  }
}

if (import.meta.main) main().catch(fail);
