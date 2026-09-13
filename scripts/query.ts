#!/usr/bin/env bun
// Query the portable memory index. Usage: bun scripts/query.ts "your question" [limit]
import { Database } from "bun:sqlite";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const q = process.argv[2];
const limit = Number(process.argv[3] ?? 5);
if (!q) { console.error('usage: bun scripts/query.ts "question" [limit]'); process.exit(1); }

const db = new Database(join(ROOT, "embeddings", "index.db"), { readonly: true });
const rows = db.prepare(
  `SELECT path, snippet(chunks, 1, '«', '»', '…', 24) AS snip, bm25(chunks) AS score
   FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT ?`
).all(q.split(/\s+/).join(" OR "), limit) as any[];

if (!rows.length) { console.log("no matches"); process.exit(0); }
for (const r of rows) console.log(`\n── ${r.path}  (${r.score.toFixed(2)})\n${r.snip}`);
