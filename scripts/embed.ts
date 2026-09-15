#!/usr/bin/env bun
// Builds local vector embeddings for the store. Resumable: re-running only
// embeds what is missing. See CONSTRAINTS.md item 6 — local-only, or it fails.
// Usage: bun scripts/embed.ts [--kind file|message|all] [--dry] [--limit N]
//                             [--batch N] [--concurrency N] [--key-file path]
import { openStore, counts, fail, StoreError } from "./lib/db.ts";
import { parseArgs, usage, fmtInt } from "./lib/cli.ts";
import {
  VECTOR_TABLE_DDL, embedTexts, probeEmbedder, quantize, embedModel,
} from "./lib/embed.ts";

const USAGE =
  "usage: bun scripts/embed.ts [--kind file|message|all] [--dry] [--limit N]\n" +
  "                            [--batch N] [--concurrency N] [--key-file path]\n\n" +
  "  Embeds with a model running on this machine (Ollama, loopback only).\n" +
  "  Resumable: only rows without a vector are embedded.\n" +
  "  --dry   report what would be embedded; writes nothing, makes no model call.";

// Bodies longer than this are truncated before embedding; the full text stays
// searchable by keyword. nomic-embed-text handles 8k tokens, ~32k chars.
const MAX_CHARS = 6000;

const SOURCES = {
  file: {
    total: "SELECT count(*) c FROM chunks",
    missing: `SELECT c.rowid AS ref_id, c.body AS body FROM chunks c
              LEFT JOIN vectors v ON v.kind = 'file' AND v.ref_id = c.rowid
              WHERE v.ref_id IS NULL LIMIT ?`,
    remaining: `SELECT count(*) c FROM chunks c
                LEFT JOIN vectors v ON v.kind = 'file' AND v.ref_id = c.rowid
                WHERE v.ref_id IS NULL`,
  },
  message: {
    total: "SELECT count(*) c FROM messages",
    missing: `SELECT m.rid AS ref_id, m.body AS body FROM messages m
              LEFT JOIN vectors v ON v.kind = 'message' AND v.ref_id = m.rid
              WHERE v.ref_id IS NULL AND length(trim(m.body)) > 0 LIMIT ?`,
    remaining: `SELECT count(*) c FROM messages m
                LEFT JOIN vectors v ON v.kind = 'message' AND v.ref_id = m.rid
                WHERE v.ref_id IS NULL AND length(trim(m.body)) > 0`,
  },
} as const;
type Kind = keyof typeof SOURCES;

function bar(done: number, total: number, width = 28): string {
  const pct = total ? done / total : 1;
  const on = Math.round(pct * width);
  return `[${"#".repeat(on)}${"-".repeat(width - on)}] ${(pct * 100).toFixed(1)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2),
    ["dry", "help"],
    ["kind", "limit", "batch", "concurrency"]);
  if (args.flags.has("help")) usage(USAGE, 0);

  const kindArg = args.opts.get("kind") ?? "all";
  if (!["file", "message", "all"].includes(kindArg)) usage(`unknown --kind ${kindArg}\n${USAGE}`);
  const kinds: Kind[] = kindArg === "all" ? ["message", "file"] : [kindArg as Kind];

  const limit = args.opts.has("limit") ? Number(args.opts.get("limit")) : Infinity;
  const batch = Number(args.opts.get("batch") ?? 64);
  const concurrency = Number(args.opts.get("concurrency") ?? 6);
  if (!Number.isFinite(batch) || batch < 1) usage("--batch must be a positive integer");

  const dry = args.flags.has("dry");
  const db = openStore({ readonly: dry });
  if (!dry) db.run(VECTOR_TABLE_DDL);

  // --dry must not touch the network, so the table may not exist yet.
  const haveVectors = db.prepare(
    "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='vectors'").get() as { c: number };

  console.log(`store: ${fmtInt(counts(db).chunks)} chunks · ${fmtInt(counts(db).messages)} messages`);

  if (dry) {
    for (const k of kinds) {
      const total = (db.prepare(SOURCES[k].total).get() as { c: number }).c;
      const remaining = haveVectors.c
        ? (db.prepare(SOURCES[k].remaining).get() as { c: number }).c
        : total;
      const bytes = remaining * 768;
      console.log(`  ${k.padEnd(8)} ${fmtInt(remaining)} of ${fmtInt(total)} need vectors ` +
                  `· ~${(bytes / 1048576).toFixed(0)} MB int8`);
    }
    console.log(`\nmodel ${embedModel()} (loopback). DRY RUN — no model call, nothing written.`);
    return;
  }

  const probe = await probeEmbedder();
  console.log(`model: ${probe.model} · ${probe.dim} dims · loopback only\n`);

  const insert = db.prepare(
    "INSERT OR REPLACE INTO vectors (kind, ref_id, dim, vec, model) VALUES (?, ?, ?, ?, ?)");

  let grandTotal = 0;
  const t0 = Date.now();

  for (const kind of kinds) {
    const remaining = (db.prepare(SOURCES[kind].remaining).get() as { c: number }).c;
    const target = Math.min(remaining, limit - grandTotal);
    if (target <= 0) { console.log(`${kind}: nothing to do`); continue; }
    console.log(`${kind}: ${fmtInt(target)} to embed`);

    let done = 0;
    while (done < target) {
      const take = Math.min(batch, target - done);
      const rows = db.prepare(SOURCES[kind].missing).all(take) as { ref_id: number; body: string }[];
      if (rows.length === 0) break;

      const texts = rows.map(r => (r.body ?? "").slice(0, MAX_CHARS));
      let vecs: number[][];
      try {
        vecs = await embedTexts(texts, { concurrency });
      } catch (e) {
        console.error(`\n${(e as Error).message}`);
        console.error(`progress kept: ${fmtInt(grandTotal + done)} vectors written. Re-run to resume.`);
        throw e;
      }

      db.transaction(() => {
        for (let i = 0; i < rows.length; i++) {
          insert.run(kind, rows[i].ref_id, vecs[i].length, quantize(vecs[i]), probe.model);
        }
      })();

      done += rows.length;
      const elapsed = (Date.now() - t0) / 1000;
      const rate = (grandTotal + done) / elapsed;
      const left = (target - done) / (rate || 1);
      process.stdout.write(
        `\r  ${bar(done, target)} ${fmtInt(done)}/${fmtInt(target)} · ` +
        `${rate.toFixed(0)}/s · ETA ${(left / 60).toFixed(1)}m   `);
    }
    process.stdout.write("\n");
    grandTotal += done;
    if (grandTotal >= limit) break;
  }

  const stored = (db.prepare("SELECT count(*) c FROM vectors").get() as { c: number }).c;
  const mb = (db.prepare("SELECT sum(length(vec)) s FROM vectors").get() as { s: number }).s ?? 0;
  console.log(`\n✓ ${fmtInt(grandTotal)} embedded this run · ${fmtInt(stored)} vectors in store ` +
              `· ${(mb / 1048576).toFixed(0)} MB`);
  console.log(`  elapsed ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

main().catch(fail);
