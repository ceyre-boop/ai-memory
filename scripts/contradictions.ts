#!/usr/bin/env bun
// Find contradictions in your own record. Retrieves the top-k snippets on a
// topic through query.ts `search()` (the single retrieval path), asks the
// configured model where two of them assert the same specific thing
// incompatibly, and prints only the ones it cites against real snippets it
// was actually given — never a date or title the model made up.
//
// Usage: bun scripts/contradictions.ts "topic" [--k 20] [--dry] [--no-expand]
//        [--source conv|files|all] [--key-file <path>]
//
// CONSTRAINTS.md → "ask": this shares that one outbound file and that one
// rule. --dry shows exactly what would be sent and sends nothing.
import { openStore, fail, StoreError } from "./lib/db";
import { parseArgs, usage, fmtInt } from "./lib/cli";
import { search, type Hit, type Source } from "./query";
import {
  findContradictions, expandQuestion, mergeHits, buildContradictionMessage,
  describeHit, modelConfig, CONTRADICTION_SYSTEM_PROMPT,
} from "./lib/ask";

const USAGE = `
usage: bun scripts/contradictions.ts "topic" [--k 20] [--dry] [--no-expand] [--source all|conv|files] [--key-file <path>]

  Finds places your own record asserts the same specific thing two incompatible ways.
  Reports only what the model cites against snippets it was actually given — nothing invented.
  --k N        snippets to compare (default 20 — contradictions need spread across time, not just top hits)
  --dry        print the retrieved snippets and the assembled prompt; call no API (expansion skipped)
  --no-expand  search the topic as typed; default asks a small model for 3 keyword variants first
  --source     conv (default: your conversations) | files (collected files) | all

  Provider: the claude CLI on your subscription (default) or AI_MEMORY_PROVIDER=api with ANTHROPIC_API_KEY in .env.
`;

function when(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "undated";
}

function sideLine(label: string, side: { n: number; hit: Hit }): string {
  const h = side.hit;
  const where = h.kind === "conversation" ? `${h.provider} · ${h.title ?? "(untitled)"} · ${when(h.created_at)}` : `file · ${h.path}`;
  return `  ${label} [${side.n}] ${where}\n      "${h.snippet.replace(/[«»]/g, "").replace(/\s+/g, " ").trim()}"`;
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

  if (hits.length < 2) {
    console.log("\nfewer than 2 snippets in the store on this topic — nothing to compare, nothing sent to the model");
    return;
  }

  if (DRY) {
    console.log("\n── retrieved snippets ──");
    hits.forEach((h, i) => console.log(`\n[${i + 1}] ${describeHit(h)} · score ${h.score.toFixed(2)}\n${h.snippet}`));
    console.log("\n── system prompt ──\n" + CONTRADICTION_SYSTEM_PROMPT);
    console.log("\n── user message ──\n" + buildContradictionMessage(topic, hits));
    console.log(`\nDRY RUN — nothing sent (would go to ${cfg.model} via ${cfg.label})`);
    return;
  }

  const t1 = Date.now();
  let r;
  try {
    r = await findContradictions(topic, hits);
  } catch (e) {
    throw new StoreError(`${(e as Error).message}\n  ${fmtInt(hits.length)} snippets were retrieved; nothing was compared. Re-run with --dry to see them.`);
  }
  const ms = Date.now() - t1;

  if (r.noneFound) {
    console.log(`\nNo contradictions found on this topic in the retrieved record.`);
  } else if (r.unparsed) {
    console.log(`\nThe model's reply didn't match the expected contradiction format — showing it as-is, treat with caution:\n`);
    console.log(r.raw);
  } else {
    r.contradictions.forEach((c, i) => {
      console.log(`\n⚠ CONTRADICTION ${i + 1} — ${c.subject}`);
      console.log(sideLine("A:", c.a));
      console.log(sideLine("B:", c.b));
      console.log(`  Why: ${c.why}`);
    });
  }

  console.log(`\n— ${r.model} via ${cfg.label} · ${fmtInt(r.snippets_sent)} snippets compared · ${fmtInt(r.contradictions.length)} contradiction(s) · ${ms} ms` +
    (r.usage ? ` · ${fmtInt(r.usage.input_tokens ?? 0)} in / ${fmtInt(r.usage.output_tokens ?? 0)} out tokens` : ""));
}

main().catch(fail);
