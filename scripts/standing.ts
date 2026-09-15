#!/usr/bin/env bun
// Standing patterns — pull-based, never pushed. Retrieves the top-k snippets
// on a topic through query.ts `search()` (the single retrieval path), asks
// the configured model where your own record already named this same kind
// of situation a mistake, a rule, or a pattern to stop — and prints only
// what it cites against real snippets it was actually given, never a
// standard the model invented on its own.
//
// Usage: bun scripts/standing.ts "topic" [--k 20] [--dry] [--no-expand]
//        [--source conv|files|all] [--key-file <path>]
//
// This is Tier 1 (recall), not Tier 3 (the system deciding what matters):
// every flag cites the user's own prior words. See GOVERNANCE.md.
// CONSTRAINTS.md: shares the ask exception — same file, same provider, same
// rule. --dry shows exactly what would be sent and sends nothing. You run
// this; it never runs at you — nothing in this codebase calls it on your
// behalf or on a schedule.
import { openStore, fail, StoreError } from "./lib/db";
import { parseArgs, usage, fmtInt } from "./lib/cli";
import { search, type Hit, type Source } from "./query";
import {
  findStandingPatterns, expandQuestion, mergeHits, buildStandingMessage,
  describeHit, modelConfig, STANDING_SYSTEM_PROMPT,
} from "./lib/ask";

const USAGE = `
usage: bun scripts/standing.ts "topic" [--k 20] [--dry] [--no-expand] [--source all|conv|files] [--key-file <path>]

  Finds where your own record already named this same kind of situation a mistake, a rule, or a pattern.
  Reports only what the model cites against snippets it was actually given — nothing invented.
  --k N        snippets to compare (default 20 — patterns need spread across time, not just top hits)
  --dry        print the retrieved snippets and the assembled prompt; call no API (expansion skipped)
  --no-expand  search the topic as typed; default asks a small model for 3 keyword variants first
  --source     conv (default: your conversations) | files (collected files) | all

  Provider: the claude CLI on your subscription (default) or AI_MEMORY_PROVIDER=api with ANTHROPIC_API_KEY.
`;

function when(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "undated";
}

function saidLine(side: { n: number; hit: Hit }): string {
  const h = side.hit;
  const where = h.kind === "conversation" ? `${h.provider} · ${h.title ?? "(untitled)"} · ${when(h.created_at)}` : `file · ${h.path}`;
  return `  Said [${side.n}] ${where}\n      "${h.snippet.replace(/[«»]/g, "").replace(/\s+/g, " ").trim()}"`;
}

// CONSTRAINTS.md: sending anything outbound is a human act, same as push,
// collect, ask, and contradictions. Inside an AI coding session (CLAUDECODE
// set), every real call is refused; --dry still works so the assistant can
// show what it *would* send, never send it.
function requireHumanOperator(dry: boolean): void {
  if (dry) return;
  if (process.env.CLAUDECODE) {
    throw new StoreError(
      "refusing to send your topic to the model from inside an AI coding session (CLAUDECODE is set) — " +
      "sending anything outbound is a human act here. Run this command yourself in a normal terminal. " +
      "--dry still works from here.",
    );
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), ["dry", "no-expand", "help"], ["k", "source"]);
  } catch (e) {
    usage(`${(e as Error).message}\n${USAGE}`);
  }
  if (args.flags.has("help") || args.positional.length !== 1 || !args.positional[0].trim()) usage(USAGE);
  const topic = args.positional[0].trim();
  const k = Number(args.opts.get("k") ?? 20);
  if (!(Number.isInteger(k) && k > 0 && k <= 50)) usage("--k must be an integer from 1 to 50");
  const source = (args.opts.get("source") ?? "conv") as Source;
  if (!["all", "conv", "files"].includes(source)) usage("--source must be all, conv, or files");
  const DRY = args.flags.has("dry");
  requireHumanOperator(DRY);
  const EXPAND = !args.flags.has("no-expand") && !DRY;

  const cfg = modelConfig();
  if (!DRY && !cfg.configured) {
    throw new StoreError(cfg.provider === "api"
      ? "no model configured — put ANTHROPIC_API_KEY in .env, or unset AI_MEMORY_PROVIDER to use the claude CLI (or --dry)"
      : "claude CLI not found — install Claude Code and sign in, or set AI_MEMORY_PROVIDER=api with ANTHROPIC_API_KEY (or --dry)");
  }

  const db = openStore({ readonly: true });
  let terms = [topic];
  let expansionNote = DRY ? "expansion skipped under --dry" : "";
  if (EXPAND) {
    try {
      const variants = await expandQuestion(topic);
      if (variants.length) { terms = [topic, ...variants]; expansionNote = `expanded with: ${variants.map((v) => `"${v}"`).join(", ")}`; }
      else expansionNote = "expansion returned nothing usable; searched the topic as typed";
    } catch (e) {
      expansionNote = `expansion failed (${(e as Error).message}); searched the topic as typed`;
    }
  }
  const t0 = Date.now();
  const hits = mergeHits(terms.map((t) => search(db, t, { limit: k, source }) as Hit[]), k);
  db.close();
  const retrieveMs = Date.now() - t0;

  console.log(`▸ ${topic}`);
  console.log(`  ${fmtInt(hits.length)} snippets retrieved in ${retrieveMs} ms${expansionNote ? ` · ${expansionNote}` : ""}`);

  if (!hits.length) {
    console.log("\nno matches in the store on this topic — nothing sent to the model");
    return;
  }

  if (DRY) {
    console.log("\n── retrieved snippets ──");
    hits.forEach((h, i) => console.log(`\n[${i + 1}] ${describeHit(h)} · score ${h.score.toFixed(2)}\n${h.snippet}`));
    console.log("\n── system prompt ──\n" + STANDING_SYSTEM_PROMPT);
    console.log("\n── user message ──\n" + buildStandingMessage(topic, hits));
    console.log(`\nDRY RUN — nothing sent (would go to ${cfg.model} via ${cfg.label})`);
    return;
  }

  const t1 = Date.now();
  let r;
  try {
    r = await findStandingPatterns(topic, hits);
  } catch (e) {
    throw new StoreError(`${(e as Error).message}\n  ${fmtInt(hits.length)} snippets were retrieved; nothing was compared. Re-run with --dry to see them.`);
  }
  const ms = Date.now() - t1;

  if (r.noneFound) {
    console.log(`\nNothing in your record names this a pattern.`);
  } else if (r.unparsed) {
    console.log(`\nThe model's reply didn't match the expected pattern format — showing it as-is, treat with caution:\n`);
    console.log(r.raw);
  } else {
    r.patterns.forEach((p, i) => {
      console.log(`\n⚑ PATTERN ${i + 1} — ${p.name}`);
      console.log(saidLine(p.said));
      console.log(`  Now: ${p.now}`);
    });
  }

  console.log(`\n— ${r.model} via ${cfg.label} · ${fmtInt(r.snippets_sent)} snippets compared · ${fmtInt(r.patterns.length)} pattern(s) · ${ms} ms` +
    (r.usage ? ` · ${fmtInt(r.usage.input_tokens ?? 0)} in / ${fmtInt(r.usage.output_tokens ?? 0)} out tokens` : ""));
}

main().catch(fail);
