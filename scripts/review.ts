#!/usr/bin/env bun
// Batch standing-pattern review across the topics your record has been busy
// with lately. This is `standing`, run over several topics in one pass.
//
// Governance: Tier 1. It is read-only over the corpus, every flag cites the
// operator's own prior words, and TOPICS COME FROM THE RECORD — the titles of
// recently active conversations, in time order — never from a judgment about
// what matters. It does not rank, prioritize, or call anything urgent.
// It is pull-only: the operator runs it. Nothing in this codebase runs it on a
// schedule or delivers its output unasked. See GOVERNANCE.md Tier 1 and Tier 3.
//
// Usage: bun scripts/review.ts [--days 7] [--topics N] [--k 20] [--dry]
//                              [--json] [--out <path>] [--key-file <path>]
import { openStore, fail, StoreError } from "./lib/db";
import { parseArgs, usage, fmtInt } from "./lib/cli";
import { search, type Hit } from "./query";
import { findStandingPatterns, expandQuestion, mergeHits } from "./lib/ask";

const USAGE = `
usage: bun scripts/review.ts [--days 7] [--topics N] [--k 20] [--dry] [--json] [--out <path>]

  Runs the standing-pattern check across the topics your record has been active on.
  Topics are the titles of recently updated conversations, oldest-active first —
  the record picks them, not the system.

  --days N     how far back counts as "recent" (default 7)
  --topics N   cap on topics reviewed (default 5)
  --k N        snippets compared per topic (default 20)
  --dry        list the topics and retrieval plan; make no model call
  --json       emit structured JSON instead of prose
  --out PATH   also write the report to a file

  Reports "nothing standing" per topic rather than inventing a pattern.
  Pull-only by design: run it yourself. See GOVERNANCE.md.
`;

// CONSTRAINTS.md: sending anything outbound is a human act, same as push, ask,
// contradictions, and standing. review batches standing, so it inherits the
// identical guard — batching a human act does not make it an automatic one.
// Inside an AI coding session (CLAUDECODE set) every real call is refused;
// --dry still works so the assistant can show the plan without sending it.
function requireHumanOperator(dry: boolean): void {
  if (dry) return;
  if (process.env.CLAUDECODE) {
    throw new StoreError(
      "refusing to send your topics to the model from inside an AI coding session (CLAUDECODE is set) — " +
      "sending anything outbound is a human act here. Run this command yourself in a normal terminal. " +
      "--dry still works from here.",
    );
  }
}

interface TopicRow { id: string; title: string | null; last: number; n: number }

/** Recently active conversations, by the record's own timestamps. */
function recentTopics(db: ReturnType<typeof openStore>, days: number, cap: number): TopicRow[] {
  const cutoff = Date.now() - days * 86_400_000;
  return db.query(
    `SELECT c.id AS id, c.title AS title, max(m.created_at) AS last, count(*) AS n
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.created_at IS NOT NULL AND m.created_at >= ?
     GROUP BY c.id
     HAVING title IS NOT NULL AND length(trim(title)) > 0
     ORDER BY last DESC
     LIMIT ?`).all(cutoff, cap) as TopicRow[];
}

async function retrieve(db: any, topic: string, k: number, expand: boolean): Promise<Hit[]> {
  const lists: Hit[][] = [search(db, topic, { limit: k, source: "conv" })];
  if (expand) {
    try {
      for (const v of await expandQuestion(topic)) lists.push(search(db, v, { limit: k, source: "conv" }));
    } catch { /* expansion is best-effort; the plain topic still retrieved */ }
  }
  return mergeHits(lists, k);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), ["dry", "json", "help", "no-expand"],
                     ["days", "topics", "k", "out"]);
  } catch (e) { usage(`${USAGE}\n${(e as Error).message}`, 2); }
  if (args.flags.has("help")) usage(USAGE, 0);

  const days = Number(args.opts.get("days") ?? 7);
  const cap = Number(args.opts.get("topics") ?? 5);
  const k = Number(args.opts.get("k") ?? 20);
  if (![days, cap, k].every((n) => Number.isFinite(n) && n > 0)) {
    usage(`${USAGE}\n--days, --topics and --k must be positive numbers`, 2);
  }

  requireHumanOperator(args.flags.has("dry"));

  const db = openStore({ readonly: true });
  const topics = recentTopics(db, days, cap);
  if (topics.length === 0) {
    console.log(`no conversations active in the last ${days} days — nothing to review`);
    return;
  }

  if (args.flags.has("dry")) {
    console.log(`${topics.length} topic(s) active in the last ${days} days, ${k} snippets each:\n`);
    for (const t of topics) {
      const hits = await retrieve(db, t.title!, k, false);
      console.log(`  ${new Date(t.last).toISOString().slice(0, 10)}  ${t.title}`);
      console.log(`     ${fmtInt(t.n)} messages · ${hits.length} snippets would be compared`);
    }
    console.log(`\nDRY RUN — no model call, nothing written.`);
    return;
  }

  const report: any[] = [];
  for (const t of topics) {
    const title = t.title!;
    const hits = await retrieve(db, title, k, !args.flags.has("no-expand"));
    if (hits.length === 0) { report.push({ topic: title, last: t.last, patterns: [] }); continue; }
    const res = await findStandingPatterns(title, hits);
    report.push({ topic: title, last: t.last, patterns: res.patterns ?? [], model: res.model,
                  snippets_sent: res.snippets_sent });
  }

  const flagged = report.filter((r) => r.patterns.length > 0);
  let out: string;
  if (args.flags.has("json")) {
    out = JSON.stringify({ generated: new Date().toISOString(), days, topics: report }, null, 2);
  } else {
    const lines: string[] = [`standing review · ${new Date().toISOString().slice(0, 16).replace("T", " ")} · last ${days} days\n`];
    for (const r of report) {
      lines.push(`── ${new Date(r.last).toISOString().slice(0, 10)}  ${r.topic}`);
      if (r.patterns.length === 0) { lines.push("   nothing standing\n"); continue; }
      for (const p of r.patterns) {
        // StandingPattern shape (scripts/lib/ask.ts): { name, now, said: { n, hit } }
        lines.push(`   ⚑ ${p.name ?? "(unlabelled)"}`);
        if (p.said?.hit?.snippet) lines.push(`     your words: "${String(p.said.hit.snippet).replace(/[«»]/g, "").replace(/\s+/g, " ").trim().slice(0, 220)}"`);
        if (p.now) lines.push(`     ${p.now}`);
      }
      lines.push("");
    }
    lines.push(`${flagged.length} of ${report.length} topic(s) matched something you already named.`);
    lines.push(`Every flag above is quoted from your own record. Nothing here is the system's standard.`);
    out = lines.join("\n");
  }

  console.log(out);
  const file = args.opts.get("out");
  if (file) { await Bun.write(file, out + "\n"); console.error(`\nwritten to ${file}`); }
}

main().catch(fail);
