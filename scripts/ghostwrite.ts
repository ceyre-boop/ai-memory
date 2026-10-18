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
import { openStore, fail } from "./lib/db";
import { parseArgs, usage, fmtInt } from "./lib/cli";
import { search, heading } from "./query";
import { complete } from "./lib/ask";
import { SYSTEM_HEAD, buildSystem, buildUser, requireHumanOperator } from "./lib/ghostwrite";

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
