// Shared store access. Every script opens the store through openStore() so that
// SQLCipher, key handling, and the schema live in exactly one place.
// See CONSTRAINTS.md — this file enforces: passphrase never logged, store always encrypted.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT =
  process.env.AI_MEMORY_HOME ??
  new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
export const DB_PATH = join(ROOT, "embeddings", "index.db");
export const MANIFEST_PATH = join(ROOT, "manifest.json");

export const INSTALL_HINT =
  "install SQLCipher: macOS `brew install sqlcipher` · Debian/Ubuntu `apt install libsqlcipher0` · " +
  "or set AI_MEMORY_SQLCIPHER=/path/to/libsqlcipher.{dylib,so}";

export class StoreError extends Error {
  constructor(message: string, public code = 1) {
    super(message);
  }
}

// ── cipher library ─────────────────────────────────────────────────────────

const CIPHER_CANDIDATES = [
  process.env.AI_MEMORY_SQLCIPHER,
  "/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.0.dylib",
  "/usr/local/opt/sqlcipher/lib/libsqlcipher.0.dylib",
  "/usr/lib/x86_64-linux-gnu/libsqlcipher.so.0",
  "/usr/lib/aarch64-linux-gnu/libsqlcipher.so.0",
  "/usr/local/lib/libsqlcipher.so.0",
  "/usr/lib/libsqlcipher.so.0",
].filter((p): p is string => !!p);

let cipherPath: string | null = null;

/** Point bun:sqlite at libsqlcipher. Must run before any Database is opened. */
export function loadCipher(): string {
  if (cipherPath) return cipherPath;
  const found = CIPHER_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new StoreError(`libsqlcipher not found. ${INSTALL_HINT}`);
  Database.setCustomSQLite(found);
  cipherPath = found;
  return found;
}

// ── passphrase ─────────────────────────────────────────────────────────────

/**
 * Resolve the passphrase: --key-file <path>, then AI_MEMORY_KEY, then an
 * interactive no-echo prompt. Never logged. Exit code 2 when unavailable.
 */
export function getKey(argv: string[] = process.argv): string {
  const i = argv.indexOf("--key-file");
  if (i > -1) {
    const file = argv[i + 1];
    if (!file) throw new StoreError("--key-file needs a path", 2);
    try {
      return readFileSync(file, "utf8").replace(/[\r\n]+$/, "");
    } catch {
      throw new StoreError(`cannot read key file ${file}`, 2);
    }
  }
  if (process.env.AI_MEMORY_KEY) return process.env.AI_MEMORY_KEY;
  if (process.stdin.isTTY) {
    const r = Bun.spawnSync({
      cmd: [
        "sh",
        "-c",
        'printf "ai-memory passphrase: " >&2; stty -echo; IFS= read -r k; stty echo; printf "\\n" >&2; printf "%s" "$k"',
      ],
      stdin: "inherit",
      stderr: "inherit",
      stdout: "pipe",
    });
    const k = r.stdout.toString();
    if (k) return k;
  }
  throw new StoreError(
    "no passphrase: set AI_MEMORY_KEY, pass --key-file <path>, or run interactively",
    2,
  );
}

export function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ── file inspection (no key needed) ────────────────────────────────────────

const PLAINTEXT_HEADER = "SQLite format 3\0";

/** true = plaintext SQLite, false = not plaintext (encrypted or other), null = missing. */
export function isPlaintextSqlite(path: string): boolean | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return n === 16 && buf.toString("latin1") === PLAINTEXT_HEADER;
  } finally {
    closeSync(fd);
  }
}

// ── cipher parameters sidecar ──────────────────────────────────────────────
// SQLCipher's KDF settings are open-time inputs, not stored in the file. A
// plaintext sidecar records them so a future SQLCipher default change can
// never turn the corpus into "file is not a database". No secrets live here.

export interface CipherMeta {
  format: 1;
  cipher: "sqlcipher";
  cipher_compatibility: 4;
  kdf_iter: number;
  cipher_page_size: number;
  created: string;
}

export const DEFAULT_META: Omit<CipherMeta, "created"> = {
  format: 1,
  cipher: "sqlcipher",
  cipher_compatibility: 4,
  kdf_iter: 256000,
  cipher_page_size: 4096,
};

export function metaPath(dbPath: string): string {
  return dbPath + ".meta.json";
}

export function readMeta(dbPath: string): CipherMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(dbPath), "utf8"));
  } catch {
    return null;
  }
}

export function writeMeta(dbPath: string): CipherMeta {
  const m: CipherMeta = { ...DEFAULT_META, created: new Date().toISOString() };
  writeFileSync(metaPath(dbPath), JSON.stringify(m, null, 2) + "\n");
  return m;
}

/**
 * Key an already-constructed Database and prove the cipher is real.
 * Order matters: key, then compatibility/KDF pragmas, then the first read.
 */
export function applyKey(db: Database, key: string, meta: CipherMeta | null) {
  db.run(`PRAGMA key = ${sqlQuote(key)}`);
  if (meta) {
    db.run(`PRAGMA cipher_compatibility = ${Number(meta.cipher_compatibility) || 4}`);
    if (meta.kdf_iter !== DEFAULT_META.kdf_iter) db.run(`PRAGMA kdf_iter = ${Number(meta.kdf_iter)}`);
    if (meta.cipher_page_size !== DEFAULT_META.cipher_page_size)
      db.run(`PRAGMA cipher_page_size = ${Number(meta.cipher_page_size)}`);
  }
  const v = db.query("PRAGMA cipher_version").get() as { cipher_version?: string } | null;
  if (!v?.cipher_version) {
    db.close();
    throw new StoreError(`SQLCipher did not load (no cipher_version) — refusing to touch the store. ${INSTALL_HINT}`);
  }
  try {
    db.query("SELECT count(*) FROM sqlite_master").get();
  } catch {
    db.close();
    throw new StoreError("wrong passphrase or not an ai-memory store");
  }
}

// ── schema ─────────────────────────────────────────────────────────────────

export function ensureSchema(db: Database) {
  // legacy tables from collect.ts / the original corpus ingester — kept as-is
  db.run(`CREATE TABLE IF NOT EXISTS files (
    hash TEXT PRIMARY KEY, path TEXT, name TEXT, ext TEXT,
    bytes INTEGER, mtime INTEGER, kind TEXT, indexed INTEGER DEFAULT 0)`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
    path, body, tokenize='porter unicode61')`);
  db.run("CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)");
  db.run(`CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY, path TEXT, mtime INTEGER, chunks INTEGER)`);

  // conversations from provider exports
  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,            -- provider:source_id
    provider TEXT NOT NULL,         -- chatgpt | claude | gemini
    source_id TEXT,                 -- provider's own id, or a derived hash (gemini)
    title TEXT,
    created_at INTEGER,             -- unix ms
    updated_at INTEGER,             -- unix ms
    message_count INTEGER NOT NULL DEFAULT 0,
    thread_inferred INTEGER NOT NULL DEFAULT 0,  -- 1 when boundaries were reconstructed
    export_file TEXT,               -- basename of the archive the user supplied
    export_hash TEXT,               -- content hash of the parsed file
    imported_at INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    rid INTEGER PRIMARY KEY,        -- stable rowid for the external-content FTS
    id TEXT NOT NULL UNIQUE,        -- provider:message_id
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,           -- order within the thread
    role TEXT NOT NULL,             -- user | assistant | system | tool
    created_at INTEGER,             -- unix ms, NULL when the export had none
    body TEXT NOT NULL,
    parent_id TEXT,                 -- provider parent message id when known
    on_main_path INTEGER NOT NULL DEFAULT 1,  -- 0 for edited/regenerated branches
    content_types TEXT,             -- JSON array of part types seen, e.g. ["thinking","text"]
    UNIQUE(conversation_id, seq))`);
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq)");
  db.run("CREATE INDEX IF NOT EXISTS idx_conversations_provider ON conversations(provider)");
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    body, content='messages', content_rowid='rid', tokenize='porter unicode61')`);
  db.run(`CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body) VALUES (new.rid, new.body); END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rid, old.body); END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rid, old.body);
    INSERT INTO messages_fts(rowid, body) VALUES (new.rid, new.body); END`);
}

// ── open ───────────────────────────────────────────────────────────────────

export interface OpenOptions {
  path?: string;
  key?: string;
  argv?: string[];
  readonly?: boolean;
  create?: boolean;
}

/**
 * Open the encrypted store. Loads SQLCipher, applies the key, verifies it,
 * and (unless readonly) ensures the schema. Throws StoreError with a plain
 * message on every failure; never echoes the key.
 */
export function openStore(opts: OpenOptions = {}): Database {
  loadCipher();
  const path = opts.path ?? DB_PATH;
  const exists = existsSync(path);
  if (!exists && !opts.create) {
    throw new StoreError(`no store at ${path} — run ingest or collect first`);
  }
  if (exists && isPlaintextSqlite(path)) {
    throw new StoreError(
      `store at ${path} is plaintext SQLite — run \`bun scripts/encrypt.ts migrate\` first`,
    );
  }
  if (!exists) mkdirSync(join(path, ".."), { recursive: true });

  const key = opts.key ?? getKey(opts.argv);
  const db = new Database(path, opts.readonly ? { readonly: true } : { create: true });
  applyKey(db, key, readMeta(path));
  if (!exists) writeMeta(path);
  if (!opts.readonly) {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    // cascade / REPLACE deletes must still fire the messages_fts delete trigger
    db.run("PRAGMA recursive_triggers = ON");
    ensureSchema(db);
  }
  return db;
}

// ── counts / manifest ──────────────────────────────────────────────────────

export interface Counts {
  files: number;
  chunks: number;
  conversations: number;
  messages: number;
}

/**
 * Row counts. Lenient by default (a missing table reads as 0, for stores that
 * predate a table). Pass strict=true wherever a count is used as proof — a
 * missing or unreadable table must then fail loudly, never bless a zero.
 */
export function counts(db: Database, strict = false): Counts {
  const one = (sql: string) => {
    try {
      return (db.query(sql).get() as { c: number }).c;
    } catch (e) {
      if (strict) throw new StoreError(`count failed (${sql.replace(/SELECT count\(\*\) c FROM /, "")}): ${(e as Error).message}`);
      return 0;
    }
  };
  return {
    files: one("SELECT count(*) c FROM files"),
    chunks: one("SELECT count(*) c FROM chunks"),
    conversations: one("SELECT count(*) c FROM conversations"),
    messages: one("SELECT count(*) c FROM messages"),
  };
}

export interface Manifest {
  name: string;
  version: string;
  created?: string;
  description?: string;
  layout?: Record<string, string>;
  stats?: Record<string, unknown>;
  pushes?: { target: string; at: string; counts: Counts }[];
}

export function readManifest(path = MANIFEST_PATH): Manifest {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { name: "portable-ai-memory", version: "0.1.0" };
  }
}

export async function writeManifest(m: Manifest, path = MANIFEST_PATH) {
  await Bun.write(path, JSON.stringify(m, null, 2) + "\n");
}

/** Print a StoreError plainly and exit with its code; rethrow anything else. */
export function fail(e: unknown): never {
  if (e instanceof StoreError) {
    console.error(`✗ ${e.message}`);
    process.exit(e.code);
  }
  throw e;
}
