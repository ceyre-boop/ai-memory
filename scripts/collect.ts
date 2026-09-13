#!/usr/bin/env bun
// Bulk ingest pipeline. Sweeps source dirs, dedupes, extracts text, indexes.
// Usage: bun scripts/collect.ts ~/dir1 ~/dir2 [--max-mb 5] [--dry]
import { Database } from "bun:sqlite";
import { readdir, stat, readFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DB_PATH = join(ROOT, "embeddings", "index.db");

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const maxIdx = args.indexOf("--max-mb");
const MAX_BYTES = (maxIdx > -1 ? Number(args[maxIdx + 1]) : 5) * 1024 * 1024;
const SOURCES = args.filter((a, i) =>
  !a.startsWith("--") && args[i - 1] !== "--max-mb");

if (!SOURCES.length) {
  console.error('usage: bun scripts/collect.ts <dir...> [--max-mb 5] [--dry]');
  process.exit(1);
}

const TEXT = new Set([".md",".txt",".json",".jsonl",".csv",".tsv",".yaml",".yml",
  ".ts",".tsx",".js",".jsx",".py",".rb",".go",".rs",".java",".c",".h",".cpp",
  ".sh",".zsh",".sql",".html",".css",".xml",".toml",".ini",".cfg",".log",".env.example"]);

const SKIP_DIR = new Set(["node_modules",".git",".next","dist","build","target",
  "venv",".venv","__pycache__",".cache","Library","Caches",".Trash","vendor",
  ".terraform","Pods",".gradle","DerivedData",".bun",".npm",".pnpm-store"]);

const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run(`CREATE TABLE IF NOT EXISTS files (
  hash TEXT PRIMARY KEY, path TEXT, name TEXT, ext TEXT,
  bytes INTEGER, mtime INTEGER, kind TEXT, indexed INTEGER DEFAULT 0)`);
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  path, body, tokenize='porter unicode61')`);
db.run("CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)");

const seen = db.prepare("SELECT 1 FROM files WHERE hash = ?");
const insFile = db.prepare(`INSERT OR IGNORE INTO files
  (hash,path,name,ext,bytes,mtime,kind,indexed) VALUES (?,?,?,?,?,?,?,?)`);
const insChunk = db.prepare("INSERT INTO chunks (path, body) VALUES (?, ?)");

const CHUNK = 1200, OVERLAP = 150;
function chunk(t: string) {
  const out: string[] = [];
  for (let i = 0; i < t.length; i += CHUNK - OVERLAP) {
    const s = t.slice(i, i + CHUNK).trim();
    if (s) out.push(s);
    if (i + CHUNK >= t.length) break;
  }
  return out;
}

const stats = { scanned:0, indexed:0, cataloged:0, dupes:0, skipped:0, chunks:0, bytes:0 };
const t0 = Date.now();

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".env.example") continue;
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) yield* walk(p); }
    else if (e.isFile()) yield p;
  }
}

for (const src of SOURCES) {
  console.log(`\n▸ scanning ${src}`);
  for await (const file of walk(src)) {
    stats.scanned++;
    let st; try { st = await stat(file); } catch { continue; }
    const ext = extname(file).toLowerCase();
    const isText = TEXT.has(ext);

    if (isText && st.size > MAX_BYTES) { stats.skipped++; continue; }

    let buf: Buffer;
    try { buf = await readFile(file); } catch { stats.skipped++; continue; }
    const hash = Bun.hash(buf).toString(16);

    if (seen.get(hash)) { stats.dupes++; continue; }
    if (DRY) { isText ? stats.indexed++ : stats.cataloged++; continue; }

    const kind = isText ? "text" : "binary";
    insFile.run(hash, file, basename(file), ext, st.size,
                Math.floor(st.mtimeMs), kind, isText ? 1 : 0);
    stats.bytes += st.size;

    if (isText) {
      const parts = chunk(buf.toString("utf8"));
      db.transaction(() => { for (const p of parts) insChunk.run(file, p); })();
      stats.chunks += parts.length;
      stats.indexed++;
    } else stats.cataloged++;

    if (stats.scanned % 500 === 0)
      process.stdout.write(`\r  ${stats.scanned} scanned · ${stats.indexed} indexed · ${stats.chunks} chunks`);
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n
${DRY ? "DRY RUN — nothing written" : "PIPELINE COMPLETE"}
  scanned    ${stats.scanned}
  indexed    ${stats.indexed}  (full text searchable)
  cataloged  ${stats.cataloged}  (binary: name/path/hash only)
  duplicates ${stats.dupes}  (skipped)
  too large  ${stats.skipped}
  chunks     ${stats.chunks}
  payload    ${(stats.bytes / 1048576).toFixed(1)} MB
  elapsed    ${secs}s`);
