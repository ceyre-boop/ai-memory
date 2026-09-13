#!/usr/bin/env bun
// Ingest corpus/ into a portable SQLite index. Zero external deps.
import { Database } from "bun:sqlite";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CORPUS = join(ROOT, "corpus");
const DB_PATH = join(ROOT, "embeddings", "index.db");
const EXTS = new Set([".md", ".txt", ".json", ".ts", ".js", ".py"]);
const CHUNK = 1200;
const OVERLAP = 150;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (EXTS.has(extname(e.name))) yield p;
  }
}

function chunk(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK - OVERLAP) {
    const slice = text.slice(i, i + CHUNK).trim();
    if (slice) out.push(slice);
    if (i + CHUNK >= text.length) break;
  }
  return out;
}

const db = new Database(DB_PATH, { create: true });
db.run(`CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY, path TEXT, mtime INTEGER, chunks INTEGER)`);
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  path, body, tokenize='porter unicode61')`);

const insDoc = db.prepare("INSERT INTO docs (path, mtime, chunks) VALUES (?, ?, ?)");
const insChunk = db.prepare("INSERT INTO chunks (path, body) VALUES (?, ?)");
const clearDoc = db.prepare("DELETE FROM chunks WHERE path = ?");
const clearMeta = db.prepare("DELETE FROM docs WHERE path = ?");

let docs = 0, total = 0;
for await (const file of walk(CORPUS)) {
  const rel = relative(CORPUS, file);
  const { mtimeMs } = await stat(file);
  clearDoc.run(rel); clearMeta.run(rel);
  const parts = chunk(await readFile(file, "utf8"));
  db.transaction(() => { for (const p of parts) insChunk.run(rel, p); })();
  insDoc.run(rel, Math.floor(mtimeMs), parts.length);
  docs++; total += parts.length;
  console.log(`  ${rel} → ${parts.length} chunks`);
}

const manifest = join(ROOT, "manifest.json");
const m = JSON.parse(await readFile(manifest, "utf8"));
m.stats = { documents: docs, chunks: total, last_indexed: new Date().toISOString() };
await Bun.write(manifest, JSON.stringify(m, null, 2));

console.log(`\nindexed ${docs} documents → ${total} chunks → ${relative(ROOT, DB_PATH)}`);
