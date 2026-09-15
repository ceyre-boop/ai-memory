#!/usr/bin/env bun
// Collects file text into the encrypted searchable memory store.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readdir, stat, readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { ROOT, StoreError, fail, openStore } from "./lib/db.ts";
import { parseArgs, usage } from "./lib/cli.ts";

const USAGE = "usage: bun scripts/collect.ts <dir...> [--max-mb N] [--dry] [--key-file path]";
const TEXT = new Set([".md", ".txt", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml",
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp",
  ".sh", ".zsh", ".sql", ".html", ".css", ".xml", ".toml", ".ini", ".cfg", ".log", ".env.example"]);
const SKIP_DIR = new Set(["node_modules", ".git", ".next", "dist", "build", "target",
  "venv", ".venv", "__pycache__", ".cache", "Library", "Caches", ".Trash", "vendor",
  ".terraform", "Pods", ".gradle", "DerivedData", ".bun", ".npm", ".pnpm-store"]);
const CHUNK = 1200;
const OVERLAP = 150;

interface Stats {
  scanned: number;
  indexed: number;
  cataloged: number;
  dupes: number;
  skipped: number;
  chunks: number;
  bytes: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function parsePositiveNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// CONSTRAINTS.md: sweeping files into the store is a human act, same as
// push. Inside an AI coding session (CLAUDECODE set), every write is
// refused; --dry still works so the assistant can show what it *would*
// collect, never do it.
function requireHumanOperator(dry: boolean): void {
  if (dry) return;
  if (process.env.CLAUDECODE) {
    throw new StoreError(
      "refusing to write to the store from inside an AI coding session (CLAUDECODE is set) — " +
      "sweeping files into your record is a human act here. Run this command yourself in a " +
      "normal terminal. --dry still works from here.",
    );
  }
}

function chunk(text: string): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += CHUNK - OVERLAP) {
    const part = text.slice(index, index + CHUNK).trim();
    if (part) parts.push(part);
    if (index + CHUNK >= text.length) break;
  }
  return parts;
}

async function readableSources(sources: string[]): Promise<string[]> {
  const readable: string[] = [];
  for (const source of sources) {
    try {
      const sourceStat = await stat(source);
      if (!sourceStat.isDirectory()) throw new StoreError(`source is not a directory: ${source}`);
      readable.push(source);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      if (!existsSync(source)) throw new StoreError(`source directory does not exist: ${source}`);
      console.warn(`warning: cannot read source directory ${source}: ${errorMessage(error)}`);
    }
  }
  return readable;
}

async function* walk(directory: string, storeDirectory: string): AsyncGenerator<string> {
  if (resolve(directory) === storeDirectory) return;

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    console.warn(`warning: cannot read directory ${directory}: ${errorMessage(error)}`);
    return;
  }
  if (entries.some((entry) => entry.name === "index.db.meta.json" && entry.isFile())) return;

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue; // Hidden entries are intentionally excluded.
    if (entry.isSymbolicLink()) continue; // Symlinks are intentionally excluded to avoid leaving the source tree.
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) yield* walk(path, storeDirectory);
      continue;
    }
    if (entry.isFile()) {
      yield path;
      continue;
    }
    // Non-file directory entries are intentionally excluded from collection.
  }
}

function printSummary(stats: Stats, dry: boolean, startedAt: number): void {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const duplicates = dry ? "n/a (dry run — store not opened)" : `${stats.dupes}  (skipped)`;
  console.log(`\n
${dry ? "DRY RUN — nothing written" : "PIPELINE COMPLETE"}
  scanned    ${stats.scanned}
  indexed    ${stats.indexed}  (full text searchable)
  cataloged  ${stats.cataloged}  (binary: name/path/hash only)
  duplicates ${duplicates}
  too large  ${stats.skipped}
  chunks     ${stats.chunks}
  payload    ${(stats.bytes / 1048576).toFixed(1)} MB
  elapsed    ${seconds}s`);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2), ["dry", "help"], ["max-mb"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    usage(`${USAGE}\n${message}`);
  }
  if (parsed.flags.has("help") || parsed.positional.length === 0) usage(USAGE);

  const maxMegabytesOption = parsed.opts.get("max-mb");
  const maxMegabytes = maxMegabytesOption === undefined ? 5 : parsePositiveNumber(maxMegabytesOption);
  if (maxMegabytes === null) usage(`${USAGE}\n--max-mb must be a positive number`);

  const dry = parsed.flags.has("dry");
  requireHumanOperator(dry);
  const sources = await readableSources(parsed.positional);
  const stats: Stats = { scanned: 0, indexed: 0, cataloged: 0, dupes: 0, skipped: 0, chunks: 0, bytes: 0 };
  const startedAt = Date.now();
  const storeDirectory = resolve(join(ROOT, "embeddings"));
  let db: Database | null = null;

  try {
    if (!dry) db = openStore({ create: true });
    const seen = db?.query("SELECT 1 FROM files WHERE hash = ?");
    const insertFile = db?.query(`INSERT OR IGNORE INTO files
      (hash,path,name,ext,bytes,mtime,kind,indexed) VALUES (?,?,?,?,?,?,?,?)`);
    const insertChunk = db?.query("INSERT INTO chunks (path, body) VALUES (?, ?)");

    for (const source of sources) {
      console.log(`\n▸ scanning ${source}`);
      for await (const file of walk(source, storeDirectory)) {
        stats.scanned++;
        let fileStat: Awaited<ReturnType<typeof stat>>;
        try {
          fileStat = await stat(file);
        } catch (error) {
          stats.skipped++;
          console.warn(`warning: cannot stat ${file}: ${errorMessage(error)}`);
          continue;
        }

        const extension = extname(file).toLowerCase();
        const isText = TEXT.has(extension);
        if (isText && fileStat.size > maxMegabytes * 1024 * 1024) {
          stats.skipped++;
          continue;
        }

        let buffer: Buffer;
        try {
          buffer = await readFile(file);
        } catch (error) {
          stats.skipped++;
          console.warn(`warning: cannot read ${file}: ${errorMessage(error)}`);
          continue;
        }
        const hash = Bun.hash(buffer).toString(16);

        if (!dry && seen?.get(hash)) {
          stats.dupes++;
          continue;
        }
        if (dry) {
          if (isText) stats.indexed++;
          else stats.cataloged++;
          continue;
        }
        if (!insertFile || !insertChunk || !db) throw new StoreError("store statements were not initialized");

        const kind = isText ? "text" : "binary";
        insertFile.run(hash, file, basename(file), extension, fileStat.size, Math.floor(fileStat.mtimeMs), kind, isText ? 1 : 0);
        stats.bytes += fileStat.size;
        if (isText) {
          const parts = chunk(buffer.toString("utf8"));
          db.transaction(() => {
            for (const part of parts) insertChunk.run(file, part);
          })();
          stats.chunks += parts.length;
          stats.indexed++;
        } else {
          stats.cataloged++;
        }

        if (stats.scanned % 500 === 0) {
          process.stdout.write(`\r  ${stats.scanned} scanned · ${stats.indexed} indexed · ${stats.chunks} chunks`);
        }
      }
    }
    printSummary(stats, dry, startedAt);
  } finally {
    if (db) db.close();
  }
}

try {
  await main();
} catch (error) {
  fail(error);
}
