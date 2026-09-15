#!/usr/bin/env bun
// Ask a question of your own record. Retrieves the top-k snippets through
// query.ts `searchPage()` (the single retrieval path), sends question +
// snippets to the configured model, prints the answer and the sources it
// drew from.
//
// Usage: bun scripts/ask.ts "question" [--k 8] [--dry] [--no-expand]
//        [--no-patterns] [--more] [--oldest|--newest] [--since <date>]
//        [--until <date>] [--chunk <id>] [--source conv|files|all] [--key-file <path>]
//
// CONSTRAINTS.md → "ask": the only outbound call in the repository. --dry
// shows exactly what would be sent and sends nothing (no expansion either).
import { openStore, fail, StoreError } from "./lib/db";
import { parseArgs, usage, fmtInt, parseDateArg } from "./lib/cli";
import { searchPage, fetchByRef, type Hit, type Source, type Order } from "./query";
import {
  ask, expandQuestion, mergeHitPages, buildUserMessage, describeHit, citedIndices,
  modelConfig, SYSTEM_PROMPT, findStandingPatterns, type HitPage,
} from "./lib/ask";
import { cacheKey, seenRefs, recordRefs } from "./lib/querycache";

const USAGE = `
usage: bun scripts/ask.ts "question" [--k 8] [--dry] [--no-expand] [--no-patterns]
                          [--more] [--oldest|--newest] [--since <date>] [--until <date>]
                          [--chunk <id>] [--source all|conv|files] [--key-file <path>]

  Answers only from the top-k snippets of your own record; says "Not in your record." otherwise.
  --k N          snippets to send (default 8)
  --dry          print the retrieved snippets and the assembled prompt; call no API (expansion skipped)
  --no-expand    search the question as typed; default asks a small model for 3 keyword variants first
  --no-patterns  skip the standing-pattern check (same snippets, one more call) — on by default
  --more         next batch on this same question, excluding snippets already shown for it
  --oldest       order by date, oldest first, instead of relevance
  --newest       order by date, newest first, instead of relevance
  --since DATE   only snippets on or after this date (any Date.parse()-able string)
  --until DATE   only snippets on or before this date
  --chunk ID     fetch one exact snippet by its ref (printed after every source) — skips search entirely
  --source       conv (default: your conversations) | files (collected files) | all

  Provider: the claude CLI on your subscription (default) or AI_MEMORY_PROVIDER=api with ANTHROPIC_API_KEY in .env.

  Asking also checks whether your own record already named this same kind of situation a mistake,
  a rule, or a pattern — cited to your own words, same as standing.ts. You're already asking; this
  doesn't leave the machine on its own between questions. See GOVERNANCE.md.

  When a batch is cut off by --k, the answer may say so and point at --more — never a count of what
  was missed. See CONSTRAINTS.md.
`;

function when(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "undated";
}

function sourceLine(i: number, h: Hit): string {
  return h.kind === "conversation"
    ? `  [${i}] ${h.provider} · ${h.title ?? "(untitled)"} · ${when(h.created_at)} · ${h.ref}`
    : `  [${i}] file · ${h.path} · ${h.ref}`;
}

// CONSTRAINTS.md: sending anything outbound is a human act, same as push
// and collect. Inside an AI coding session (CLAUDECODE set), every real
// call is refused; --dry still works so the assistant can show what it
// *would* send, never send it.
function requireHumanOperator(dry: boolean): void {
  if (dry) return;
  if (process.env.CLAUDECODE) {
    throw new StoreError(
      "refusing to send your question to the model from inside an AI coding session (CLAUDECODE is set) — " +
      "sending anything outbound is a human act here. Run this command yourself in a normal terminal. " +
      "--dry still works from here.",
    );
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2),
      ["dry", "no-expand", "no-patterns", "more", "oldest", "newest", "help"],
      ["k", "source", "since", "until", "chunk"]);
  } catch (e) {
    usage(`${(e as Error).message}\n${USAGE}`);
  }
  if (args.flags.has("help") || args.positional.length !== 1 || !args.positional[0].trim()) usage(USAGE);
  const question = args.positional[0].trim();
  const k = Number(args.opts.get("k") ?? 8);
  if (!(Number.isInteger(k) && k > 0 && k <= 50)) usage("--k must be an integer from 1 to 50");
  // Default to the conversations table: that is the record the question is
  // about. Swept files (--source files|all) are noisier and bury it.
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
    // --chunk bypasses search entirely: a snippet cited earlier is the same
    // object re-fetched, not re-approximated by a fresh search.
    const db = openStore({ readonly: true });
    const hit = fetchByRef(db, chunkId);
    db.close();
    if (!hit) throw new StoreError(`no snippet found for --chunk ${chunkId}`);
    hits = [hit];
    retrieveNote = `fetched directly by ref, no search`;
  } else {
    const db = openStore({ readonly: true });
    let terms = [question];
    let expansionNote = DRY ? "expansion skipped under --dry" : "";
    if (EXPAND) {
      try {
        const variants = await expandQuestion(question);
        if (variants.length) { terms = [question, ...variants]; expansionNote = `expanded with: ${variants.map((v) => `"${v}"`).join(", ")}`; }
        else expansionNote = "expansion returned nothing usable; searched the question as typed";
      } catch (e) {
        expansionNote = `expansion failed (${(e as Error).message}); searched the question as typed`;
      }
    }
    const cKey = cacheKey("ask", question);
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

  console.log(`▸ ${question}`);
  console.log(`  ${fmtInt(hits.length)} snippets retrieved in ${retrieveMs} ms${retrieveNote ? ` · ${retrieveNote}` : ""}${truncated ? " · more available — run --more" : ""}`);

  if (!hits.length) {
    console.log("\nno matches in the store — nothing sent to the model");
    return;
  }

  // --dry: show exactly what would be sent, send nothing
  if (DRY) {
    console.log("\n── retrieved snippets ──");
    hits.forEach((h, i) => console.log(`\n[${i + 1}] ${describeHit(h)} · score ${h.score.toFixed(2)}\n${h.snippet}`));
    console.log("\n── system prompt ──\n" + SYSTEM_PROMPT);
    console.log("\n── user message ──\n" + buildUserMessage(question, hits, truncated));
    console.log(`\nDRY RUN — nothing sent (would go to ${cfg.model} via ${cfg.label})`);
    return;
  }

  // ask
  const t1 = Date.now();
  let r;
  try {
    r = await ask(question, hits, truncated);
  } catch (e) {
    throw new StoreError(`${(e as Error).message}\n  ${fmtInt(hits.length)} snippets were retrieved; nothing was answered. Re-run with --dry to see them.`);
  }
  const askMs = Date.now() - t1;
  console.log("\n" + r.answer + "\n");
  const cited = citedIndices(r.answer, hits.length);
  if (cited.length) {
    console.log("Sources:");
    for (const i of cited) console.log(sourceLine(i, hits[i - 1]));
  } else {
    console.log("Sources: none cited — snippets sent (uncited):");
    hits.forEach((h, i) => console.log(sourceLine(i + 1, h)));
  }
  console.log(`\n— ${r.model} via ${cfg.label} · ${fmtInt(r.snippets_sent)} snippets sent · ${askMs} ms` +
    (r.usage ? ` · ${fmtInt(r.usage.input_tokens ?? 0)} in / ${fmtInt(r.usage.output_tokens ?? 0)} out tokens` : ""));

  // standing-pattern check — same hits already retrieved, no new search.
  // Same integrity rule as the answer above: cites the user's own words or
  // says nothing. Skippable with --no-patterns; never a separate approval
  // step, since asking the question already was one. See GOVERNANCE.md.
  if (!args.flags.has("no-patterns")) {
    try {
      const p = await findStandingPatterns(question, hits);
      if (!p.noneFound && !p.unparsed && p.patterns.length) {
        console.log("\n⚑ Also standing in your record:");
        for (const pat of p.patterns) {
          const h = pat.said.hit;
          const where = h.kind === "conversation" ? `${h.provider} · ${h.title ?? "(untitled)"} · ${when(h.created_at)}` : `file · ${h.path}`;
          console.log(`  ${pat.name} — [${pat.said.n}] ${where}`);
          console.log(`    "${h.snippet.replace(/[«»]/g, "").replace(/\s+/g, " ").trim()}"`);
        }
      }
    } catch {
      // Non-fatal: the answer above already stands on its own; a failed
      // pattern check is never worth surfacing as an error for this.
    }
  }
}

main().catch(fail);
