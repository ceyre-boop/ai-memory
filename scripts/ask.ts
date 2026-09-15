#!/usr/bin/env bun
// Ask a question of your own record. Retrieves the top-k snippets through
// query.ts `search()` (the single retrieval path), sends question + snippets
// to the configured model, prints the answer and the sources it drew from.
//
// Usage: bun scripts/ask.ts "question" [--k 8] [--dry] [--no-expand]
//        [--source conv|files|all] [--key-file <path>]
//
// CONSTRAINTS.md → "ask": the only outbound call in the repository. --dry
// shows exactly what would be sent and sends nothing (no expansion either).
import { openStore, fail, StoreError } from "./lib/db";
import { parseArgs, usage, fmtInt } from "./lib/cli";
import { search, type Hit, type Source } from "./query";
import { ask, expandQuestion, mergeHits, buildUserMessage, describeHit, citedIndices, modelConfig, SYSTEM_PROMPT, findStandingPatterns } from "./lib/ask";

const USAGE = `
usage: bun scripts/ask.ts "question" [--k 8] [--dry] [--no-expand] [--no-patterns] [--source all|conv|files] [--key-file <path>]

  Answers only from the top-k snippets of your own record; says "Not in your record." otherwise.
  --k N          snippets to send (default 8)
  --dry          print the retrieved snippets and the assembled prompt; call no API (expansion skipped)
  --no-expand    search the question as typed; default asks a small model for 3 keyword variants first
  --no-patterns  skip the standing-pattern check (same snippets, one more call) — on by default
  --source       conv (default: your conversations) | files (collected files) | all

  Provider: the claude CLI on your subscription (default) or AI_MEMORY_PROVIDER=api with ANTHROPIC_API_KEY in .env.

  Asking also checks whether your own record already named this same kind of situation a mistake,
  a rule, or a pattern — cited to your own words, same as standing.ts. You're already asking; this
  doesn't leave the machine on its own between questions. See GOVERNANCE.md.
`;

function when(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "undated";
}

function sourceLine(i: number, h: Hit): string {
  return h.kind === "conversation"
    ? `  [${i}] ${h.provider} · ${h.title ?? "(untitled)"} · ${when(h.created_at)}`
    : `  [${i}] file · ${h.path}`;
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
    args = parseArgs(process.argv.slice(2), ["dry", "no-expand", "no-patterns", "help"], ["k", "source"]);
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
  const DRY = args.flags.has("dry");
  requireHumanOperator(DRY);
  const EXPAND = !args.flags.has("no-expand") && !DRY;

  const cfg = modelConfig();
  if (!DRY && !cfg.configured) {
    throw new StoreError(cfg.provider === "api"
      ? "no model configured — put ANTHROPIC_API_KEY in .env, or unset AI_MEMORY_PROVIDER to use the claude CLI (or --dry)"
      : "claude CLI not found — install Claude Code and sign in, or set AI_MEMORY_PROVIDER=api with ANTHROPIC_API_KEY (or --dry)");
  }

  // 1. retrieval — one search path (query.ts), optionally widened by model-suggested keywords
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
  const t0 = Date.now();
  const hits = mergeHits(terms.map((t) => search(db, t, { limit: k, source }) as Hit[]), k);
  db.close();
  const retrieveMs = Date.now() - t0;

  console.log(`▸ ${question}`);
  console.log(`  ${fmtInt(hits.length)} snippets retrieved in ${retrieveMs} ms${expansionNote ? ` · ${expansionNote}` : ""}`);

  if (!hits.length) {
    console.log("\nno matches in the store — nothing sent to the model");
    return;
  }

  // 2. --dry: show exactly what would be sent, send nothing
  if (DRY) {
    console.log("\n── retrieved snippets ──");
    hits.forEach((h, i) => console.log(`\n[${i + 1}] ${describeHit(h)} · score ${h.score.toFixed(2)}\n${h.snippet}`));
    console.log("\n── system prompt ──\n" + SYSTEM_PROMPT);
    console.log("\n── user message ──\n" + buildUserMessage(question, hits));
    console.log(`\nDRY RUN — nothing sent (would go to ${cfg.model} via ${cfg.label})`);
    return;
  }

  // 3. ask
  const t1 = Date.now();
  let r;
  try {
    r = await ask(question, hits);
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

  // 4. standing-pattern check — same hits already retrieved, no new search.
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
