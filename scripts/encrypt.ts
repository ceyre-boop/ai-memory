#!/usr/bin/env bun
// Migrates, rekeys, or inspects the ai-memory encrypted store.
import { Database } from "bun:sqlite";
import {
  DB_PATH,
  type Counts,
  StoreError,
  counts,
  fail,
  getKey,
  isPlaintextSqlite,
  loadCipher,
  metaPath,
  openStore,
  readMeta,
  sqlQuote,
  writeMeta,
} from "./lib/db.ts";
import { type ParsedArgs, parseArgs, usage } from "./lib/cli.ts";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";

const USAGE = "usage: bun scripts/encrypt.ts <migrate|rekey|check> [--dry] [--key-file path] [--new-key-file path]";

interface MigrationCounts {
  files: number;
  chunks: number;
  docs: number;
}

function describeCounts(value: MigrationCounts): string {
  return `files=${value.files} chunks=${value.chunks} docs=${value.docs}`;
}

function removeFileIfPresent(path: string): void {
  rmSync(path, { force: true });
}

function removeDatabaseSidecars(path: string): void {
  removeFileIfPresent(path + "-wal");
  removeFileIfPresent(path + "-shm");
}

function removeCandidate(path: string): void {
  removeFileIfPresent(path);
  removeFileIfPresent(metaPath(path));
  removeDatabaseSidecars(path);
}

function legacyTableCount(db: Database, table: "files" | "chunks" | "docs"): number {
  try {
    const row = db.query(`SELECT count(*) AS c FROM ${table}`).get() as { c?: unknown } | null;
    if (typeof row?.c !== "number") throw new StoreError(`could not read ${table} count from ${DB_PATH}`);
    return row.c;
  } catch (error) {
    if (error instanceof StoreError) throw error;
    if (error instanceof Error && /no such table/i.test(error.message)) return 0;
    throw error;
  }
}

function migrationCounts(db: Database): MigrationCounts {
  return {
    files: legacyTableCount(db, "files"),
    chunks: legacyTableCount(db, "chunks"),
    docs: legacyTableCount(db, "docs"),
  };
}

function normalKeyWasSupplied(argv: string[]): boolean {
  return argv.includes("--key-file") || argv.some((arg) => arg.startsWith("--key-file=")) || !!process.env.AI_MEMORY_KEY;
}

function migrationKey(argv: string[]): string {
  const first = getKey(argv);
  if (normalKeyWasSupplied(argv)) return first;
  const second = getKey(argv);
  if (first !== second) throw new StoreError("passphrases did not match", 2);
  return first;
}

function promptForNewKey(): string {
  const result = Bun.spawnSync({
    cmd: [
      "sh",
      "-c",
      'printf "new ai-memory passphrase: " >&2; stty -echo; IFS= read -r k; stty echo; printf "\\n" >&2; printf "%s" "$k"',
    ],
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  if (typeof result.exitCode !== "number" || result.exitCode !== 0 || !(result.stdout instanceof Uint8Array)) {
    throw new StoreError("could not read the new passphrase", 2);
  }
  return new TextDecoder().decode(result.stdout);
}

function newKeySource(file: string | undefined): { key: string; source: string } {
  if (process.env.AI_MEMORY_NEW_KEY !== undefined) {
    return { key: process.env.AI_MEMORY_NEW_KEY, source: "AI_MEMORY_NEW_KEY" };
  }
  if (file) {
    try {
      return { key: readFileSync(file, "utf8").replace(/[\r\n]+$/, ""), source: "--new-key-file" };
    } catch {
      throw new StoreError(`cannot read new key file ${file}`, 2);
    }
  }
  if (!process.stdin.isTTY) {
    throw new StoreError(
      "no new passphrase: set AI_MEMORY_NEW_KEY, pass --new-key-file <path>, or run interactively",
      2,
    );
  }
  const first = promptForNewKey();
  const second = promptForNewKey();
  if (first !== second) throw new StoreError("passphrases did not match", 2);
  return { key: first, source: "interactive prompt" };
}

function printMeta(): void {
  const meta = readMeta(DB_PATH);
  if (!meta) return;
  console.log(
    `meta: cipher=${meta.cipher} compatibility=${meta.cipher_compatibility} kdf_iter=${meta.kdf_iter} page size=${meta.cipher_page_size} created=${meta.created}`,
  );
}

function check(): void {
  const plaintext = isPlaintextSqlite(DB_PATH);
  console.log(`encrypted: ${plaintext === false}`);
  if (plaintext === null) console.log(`(no store at ${DB_PATH})`);
  printMeta();
}

function migrate(argv: string[], dry: boolean): void {
  const plaintext = isPlaintextSqlite(DB_PATH);
  if (plaintext === null) throw new StoreError(`no store at ${DB_PATH}`);
  if (!plaintext) throw new StoreError("already encrypted");

  const key = migrationKey(argv);
  loadCipher();
  const plain = new Database(DB_PATH, dry ? { readonly: true } : undefined);
  let source: MigrationCounts;
  try {
    if (!dry) plain.run("PRAGMA wal_checkpoint(TRUNCATE)");
    source = migrationCounts(plain);
    if (dry) {
      console.log(`source: ${DB_PATH} (${statSync(DB_PATH).size} bytes)`);
      console.log(`destination: ${DB_PATH}.enc`);
      console.log(`counts: ${describeCounts(source)}`);
      console.log("would delete plaintext database and its -wal/-shm sidecars after verification");
      return;
    }

    const encPath = DB_PATH + ".enc";
    removeCandidate(encPath);
    console.log(`▸ exporting ${DB_PATH} to ${encPath}; large stores can take several minutes`);
    let attached = false;
    try {
      plain.run(`ATTACH DATABASE ${sqlQuote(encPath)} AS enc KEY ${sqlQuote(key)}`);
      attached = true;
      plain.query("SELECT sqlcipher_export('enc')").get();
      console.log("✓ SQLCipher export complete; verifying row counts");
    } finally {
      if (attached) plain.run("DETACH DATABASE enc");
    }
    plain.close();

    try {
      writeMeta(encPath);
      const encrypted = openStore({ path: encPath, key });
      let destination: MigrationCounts;
      try {
        destination = migrationCounts(encrypted);
        encrypted.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        encrypted.close();
      }
      if (source.files !== destination.files || source.chunks !== destination.chunks || source.docs !== destination.docs) {
        console.error(`source counts: ${describeCounts(source)}`);
        console.error(`destination counts: ${describeCounts(destination)}`);
        removeCandidate(encPath);
        throw new StoreError("migration verification counts did not match");
      }
      renameSync(encPath, DB_PATH);
      renameSync(metaPath(encPath), metaPath(DB_PATH));
      removeDatabaseSidecars(DB_PATH);
      removeDatabaseSidecars(encPath);
      console.log(`counts: ${describeCounts(destination)}`);
      console.log("✓ encrypted");
    } catch (error) {
      removeCandidate(encPath);
      throw error;
    }
  } finally {
    plain.close();
  }
}

function rekey(argv: string[], dry: boolean, newKeyFile: string | undefined): void {
  const plaintext = isPlaintextSqlite(DB_PATH);
  if (plaintext === null) throw new StoreError(`no store at ${DB_PATH}`);
  if (plaintext) throw new StoreError("store is plaintext; run `bun scripts/encrypt.ts migrate` first");

  const oldKey = getKey(argv);
  const next = newKeySource(newKeyFile);
  if (!next.key) throw new StoreError("new passphrase must not be empty", 2);
  if (next.key === oldKey) throw new StoreError("new passphrase is the same as the old one", 2);

  const rekeyPath = DB_PATH + ".rekey";
  if (dry) {
    console.log(`source: ${DB_PATH} (${statSync(DB_PATH).size} bytes)`);
    console.log(`destination: ${rekeyPath}`);
    console.log(`new passphrase source: ${next.source}`);
    console.log("would verify the new passphrase before replacing the store");
    return;
  }

  const original = openStore({ key: oldKey });
  try {
    original.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    original.close();
  }
  removeCandidate(rekeyPath);
  copyFileSync(DB_PATH, rekeyPath);
  if (existsSync(metaPath(DB_PATH))) copyFileSync(metaPath(DB_PATH), metaPath(rekeyPath));

  try {
    const replacement = openStore({ path: rekeyPath, key: oldKey });
    try {
      replacement.run(`PRAGMA rekey = ${sqlQuote(next.key)}`);
    } finally {
      replacement.close();
    }
    const verified = openStore({ path: rekeyPath, key: next.key });
    let verifiedCounts: Counts;
    try {
      verifiedCounts = counts(verified);
      verified.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      verified.close();
    }
    renameSync(rekeyPath, DB_PATH);
    writeMeta(DB_PATH);
    removeFileIfPresent(metaPath(rekeyPath));
    removeDatabaseSidecars(rekeyPath);
    console.log("✓ passphrase changed");
    console.log(
      `counts: files=${verifiedCounts.files} chunks=${verifiedCounts.chunks} conversations=${verifiedCounts.conversations} messages=${verifiedCounts.messages}`,
    );
  } catch (error) {
    removeCandidate(rekeyPath);
    throw new StoreError(`rekey verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function main(): void {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2), ["dry", "help"], ["new-key-file"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    throw new StoreError(`${USAGE}\n${message}`);
  }
  if (parsed.flags.has("help") || parsed.positional.length !== 1) usage(USAGE);
  const command = parsed.positional[0];
  if (command === "check") {
    if (parsed.flags.has("dry") || parsed.opts.size > 0) usage(USAGE);
    check();
    return;
  }
  if (command === "migrate") {
    if (parsed.opts.has("new-key-file")) usage(USAGE);
    migrate(process.argv.slice(2), parsed.flags.has("dry"));
    return;
  }
  if (command === "rekey") {
    rekey(process.argv.slice(2), parsed.flags.has("dry"), parsed.opts.get("new-key-file"));
    return;
  }
  usage(USAGE);
}

try {
  main();
} catch (error) {
  fail(error);
}
