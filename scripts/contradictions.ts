#!/usr/bin/env bun
// Find contradictions in your own record. Retrieves the top-k snippets on a
// topic through query.ts `searchPage()` (the single retrieval path), asks the
// configured model where two of them assert the same specific thing
// incompatibly, and prints only the ones it cites against real snippets it
// was actually given — never a date or title the model made up.
//
// Usage: bun scripts/contradictions.ts "topic" [--k 20] [--dry] [--no-expand]
//        [--more] [--oldest|--newest] [--since <date>] [--until <date>]
//        [--chunk <id>] [--source conv|files|all] [--key-file <path>]
//
// CONSTRAINTS.md → "ask": this shares that one outbound file and that one
// rule. --dry shows exactly what would be sent and sends nothing.
import { openStore, fail, StoreError } from "./lib/db";
import { parseArgs, usage, fmtInt, parseDateArg } from "./lib/cli";
import { searchPage, fetchByRef, type Hit, type Source, type Order } from "./query";
import {
  findContradictions, expandQuestion, mergeHitPages, buildContradictionMessage,
  describeHit, modelConfig, CONTRADICTION_SYSTEM_PROMPT, type HitPage,
} from "./lib/ask";
import { cacheKey, seenRefs, recordRefs } from "./lib/querycache";

const USAGE = `
usage: bun scripts/contradictions.ts "topic" [--k 20] [--dry] [--no-expand]
                                     [--more] [--oldest|--newest] [--since <date>] [--until <date>]
                                     [--chunk <id>] [--source all|conv|files] [--key-file <path>]

  Finds places your own record asserts the same specific thing two incompatible ways.
  Reports only what the model cites against snippets it was actually given — nothing invented.
  --k N        snippets to compare (default 20 — contradictions need spread across time, not just top hits)
  --dry        print the retrieved snippets and the assembled prompt; call no API (expansion skipped)
  --no-expand  search the topic as typed; default asks a small model for 3 keyword variants first
  --more       next batch on this same topic, excluding snippets already shown for it
  --oldest     order by date, oldest first, instead of relevance
  --newest     order by date, newest first, instead of relevance
  --since DATE only snippets on or after this date (any Date.parse()-able string)
  --until DATE only snippets on or before this date
  --chunk ID   fetch one exact snippet by its ref (printed after every side) — skips search entirely
  --source     conv (default: your conversations) | files (collected files) | all

  Provider: the claude CLI on your subscription (default) or AI_MEMORY_PROVIDER=api with ANTHROPIC_API_KEY in .env.

  When a batch is cut off by --k, this prints a note pointing at --more; the model never says a
  count of what was missed, and "NO CONTRADICTIONS FOUND" is always about this batch, not the record.
`;

function when(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "undated";
}

function sideLine(label: string, side: { n: number; hit: Hit }): string {
  const h = side.hit;
  const where = h.kind === "conversation" ? `${h.provider} · ${h.title ?? "(untitled)"} · ${when(h.created_at)} · ${h.ref}` : `file · ${h.path} · ${h.ref}`;
  return `  ${label} [${side.n}] ${where}\n      "${h.snippet.replace(/[«»]/g, "").replace(/\s+/g, " ").trim()}"`;
}

// CONSTRAINTS.md: sending anything outbound is a human act, same as push
// and collect. Inside an AI coding session (CLAUDECODE set), every real
// call is refused; --dry still works so the assistant can show what it
// *would* send, never send it.
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
    args = parseArgs(process.argv.slice(2),
      ["dry", "no-expand", "more", "oldest", "newest", "help"],
      ["k", "source", "since", "until", "chunk"]);
  } catch (e) {
    usage(`${(e as Error).message}\n${USAGE}`);
  }
  if (args.flags.has("help") || args.positional.length !== 1 || !args.positional[0].trim()) usage(USAGE);
  const topic = args.positional[0].trim();
  const k = Number(args.opts.get("k") ?? 20);
  if (!(Number.isInteger(k) && k > 0 && k <= 50)) usage("--k must be an integer from 1 to 50");
  const source = (args.opts.get("source") ?? "conv") as Source;
  if (!["all", "conv", "files"].includes(source)) usage("--source must be all, conv, or files");
  if (args.flags.has("oldest") && args.flags.has("newest")) usage("--oldest and --newest are mutually exclusive");
  const order: Order = args.flags.has("oldest") ? "oldest" : args.flags.has("newest") ? "newest" : "relevance";
  let since: number | undefined, until: number | undefined;
  if (args.opts.has("since")) {
    const ms = parseDateArg(args.opts.get("since")!);
    if (ms === null) usage("--since needs a date (e.g. 2026-01-01)");
    since = ms;
  }
  if (args.opts.has("until")) {
    const ms = parseDateArg(args.opts.get("until")!);
    if (ms === null) usage("--until needs a date (e.g. 2026-01-01)");
    until = ms;
  }
  const DRY = args.flags.has("dry");
  requireHumanOperator(DRY);
  const EXPAND = !args.flags.has("no-expand") && !DRY;
  const MORE = args.flags.has("more");
  const chunkId = args.opts.get("chunk");

  const cfg = modelConfig();
  if (!DRY && !cfg.configured) {
    throw new StoreError(cfg.provider === "api"
      ? "no model configured — put ANTHROPIC_API_KEY in .env, or unset AI_MEMORY_PROVIDER to use the claude CLI (or --dry)"
      : "claude CLI not found — install Claude Code and sign in, or set AI_MEMORY_PROVIDER=api with ANTHROPIC_API_KEY (or --dry)");
  }

  let hits: Hit[];
  let truncated = false;
  let retrieveNote: string;
  const t0 = Date.now();

  if (chunkId) {
    const db = openStore({ readonly: true });
    const hit = fetchByRef(db, chunkId);
    db.close();
    if (!hit) throw new StoreError(`no snippet found for --chunk ${chunkId}`);
    hits = [hit];
    retrieveNote = "fetched directly by ref, no search";
  } else {
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
    const cKey = cacheKey("contradictions", topic);
    const exclude = MORE ? seenRefs(cKey) : [];
    const pages: HitPage[] = terms.map((t) => searchPage(db, t, { limit: k, source, since, until, order, exclude }));
    db.close();
    const merged = mergeHitPages(pages, k);
    hits = merged.hits;
    truncated = merged.truncated;
    if (!DRY && hits.length) recordRefs(cKey, hits.map((h) => h.ref).filter((r): r is string => !!r));
    retrieveNote = expansionNote + (MORE ? ` · --more: excluded ${fmtInt(exclude.length)} already-shown snippet(s)` : "")
      + (order !== "relevance" ? ` · ordered ${order}` : "") + (since ? ` · since ${when(since)}` : "") + (until ? ` · until ${when(until)}` : "");
  }
  const retrieveMs = Date.now() - t0;

  console.log(`▸ ${topic}`);
  console.log(`  ${fmtInt(hits.length)} snippets retrieved in ${retrieveMs} ms${retrieveNote ? ` · ${retrieveNote}` : ""}${truncated ? " · more available — run --more" : ""}`);

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
    console.log(`\nNo contradictions found on this topic in the retrieved record${truncated ? " (this batch)" : ""}.`);
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
  // Deterministic, not model-generated: CONTRADICTION_SYSTEM_PROMPT's output
  // format is a strict literal ("NO CONTRADICTIONS FOUND." or exact blocks) —
  // asking the model to also mention --more risks breaking that parser. The
  // note below is CLI-side truth instead, same boolean, no count either way.
  if (truncated) console.log(`\nThis batch was cut off by --k; more snippets exist on this topic — run --more.`);

  console.log(`\n— ${r.model} via ${cfg.label} · ${fmtInt(r.snippets_sent)} snippets compared · ${fmtInt(r.contradictions.length)} contradiction(s) · ${ms} ms` +
    (r.usage ? ` · ${fmtInt(r.usage.input_tokens ?? 0)} in / ${fmtInt(r.usage.output_tokens ?? 0)} out tokens` : ""));
}

main().catch(fail);
