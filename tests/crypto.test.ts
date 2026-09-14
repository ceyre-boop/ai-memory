import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, dbPath, KEY, makeHome, run } from "./helpers.ts";
import { isPlaintextSqlite, loadCipher, openStore } from "../scripts/lib/db.ts";

const homes: string[] = [];
const NEW_KEY = "forge-rekey-passphrase-a184";

afterEach(() => {
  while (homes.length > 0) cleanup(homes.pop() as string);
});

function createHome(): string {
  const home = makeHome();
  homes.push(home);
  return home;
}

function createPlaintextFixture(home: string): { files: number; chunks: number } {
  const path = dbPath(home);
  loadCipher();
  const db = new Database(path, { create: true });
  try {
    db.run(`CREATE TABLE files (
      hash TEXT PRIMARY KEY, path TEXT, name TEXT, ext TEXT,
      bytes INTEGER, mtime INTEGER, kind TEXT, indexed INTEGER DEFAULT 0)`);
    db.run("CREATE VIRTUAL TABLE chunks USING fts5(path, body, tokenize='porter unicode61')");
    db.run("INSERT INTO files VALUES ('one', 'notes/a.md', 'a.md', '.md', 10, 1, 'text', 1)");
    db.run("INSERT INTO files VALUES ('two', 'notes/b.md', 'b.md', '.md', 20, 2, 'text', 1)");
    db.run("INSERT INTO chunks(path, body) VALUES ('notes/a.md', 'first legacy chunk')");
    db.run("INSERT INTO chunks(path, body) VALUES ('notes/b.md', 'second legacy chunk')");
    db.run("INSERT INTO chunks(path, body) VALUES ('notes/b.md', 'third legacy chunk')");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  expect(readFileSync(path).subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
  return { files: 2, chunks: 3 };
}

function call(home: string, script: string, args: string[] = [], env: Record<string, string> = {}) {
  const result = run(script, args, { AI_MEMORY_HOME: home, ...env });
  expect(result.stdout + result.stderr).not.toContain(KEY);
  return result;
}

function migrate(home: string): void {
  const result = call(home, "encrypt.ts", ["migrate"]);
  expect(result.code).toBe(0);
}

describe("encryption at rest", () => {
  test("migrate --dry leaves a plaintext store byte-identical", () => {
    const home = createHome();
    createPlaintextFixture(home);
    const path = dbPath(home);
    const bytes = readFileSync(path);
    const mtime = statSync(path).mtimeMs;

    const result = call(home, "encrypt.ts", ["migrate", "--dry"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("destination:");
    expect(existsSync(path + ".enc")).toBeFalse();
    expect(existsSync(path + ".meta.json")).toBeFalse();
    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(isPlaintextSqlite(path)).toBeTrue();
  });

  test("migrate encrypts, verifies, and removes plaintext sidecars", () => {
    const home = createHome();
    const expected = createPlaintextFixture(home);
    const path = dbPath(home);
    migrate(home);

    expect(readFileSync(path).subarray(0, 16).toString("latin1")).not.toBe("SQLite format 3\0");
    const raw = new Database(path);
    try {
      expect(() => raw.query("SELECT count(*) FROM sqlite_master").get()).toThrow("file is not a database");
    } finally {
      raw.close();
    }
    const encrypted = openStore({ path, key: KEY });
    try {
      expect(encrypted.query("SELECT count(*) AS c FROM files").get()).toEqual({ c: expected.files });
      expect(encrypted.query("SELECT count(*) AS c FROM chunks").get()).toEqual({ c: expected.chunks });
    } finally {
      encrypted.close();
    }
    expect(existsSync(path + "-wal")).toBeFalse();
    expect(existsSync(path + "-shm")).toBeFalse();
    expect(existsSync(path + ".meta.json")).toBeTrue();
  });

  test("migrate rejects an already encrypted store", () => {
    const home = createHome();
    createPlaintextFixture(home);
    migrate(home);
    const result = call(home, "encrypt.ts", ["migrate"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("already encrypted");
  });

  test("rekey rejects the old passphrase and preserves counts with the new one", () => {
    const home = createHome();
    const expected = createPlaintextFixture(home);
    const path = dbPath(home);
    migrate(home);
    const result = call(home, "encrypt.ts", ["rekey"], { AI_MEMORY_NEW_KEY: NEW_KEY });
    expect(result.code).toBe(0);
    expect(() => openStore({ path, key: KEY })).toThrow("wrong passphrase or not an ai-memory store");
    const rekeyed = openStore({ path, key: NEW_KEY });
    try {
      expect(rekeyed.query("SELECT count(*) AS c FROM files").get()).toEqual({ c: expected.files });
      expect(rekeyed.query("SELECT count(*) AS c FROM chunks").get()).toEqual({ c: expected.chunks });
    } finally {
      rekeyed.close();
    }
    expect(existsSync(path + ".rekey")).toBeFalse();
    expect(existsSync(path + ".rekey.meta.json")).toBeFalse();
  });

  test("WAL pages do not expose message text", () => {
    const home = createHome();
    createPlaintextFixture(home);
    const path = dbPath(home);
    migrate(home);
    const nonce = "zqxjfliverwortnonce";
    const db = openStore({ path, key: KEY });
    try {
      db.run("INSERT INTO chunks(path, body) VALUES (?, ?)", ["nonce.md", nonce]);
      const wal = path + "-wal";
      expect(existsSync(wal)).toBeTrue();
      expect(readFileSync(wal).length).toBeGreaterThan(0);
      expect(readFileSync(wal).includes(Buffer.from(nonce))).toBeFalse();
    } finally {
      db.close();
    }
  });

  test("status reports encrypted counts and remains successful while locked", () => {
    const home = createHome();
    createPlaintextFixture(home);
    migrate(home);
    const status = call(home, "status.ts");
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("encrypted: true");
    expect(status.stdout).toContain("files: 2");
    expect(status.stdout).toContain("chunks: 3");

    const locked = call(home, "status.ts", [], { AI_MEMORY_KEY: "wrong-key" });
    expect(locked.code).toBe(0);
    expect(locked.stdout).toContain("files: locked");
    expect(locked.stdout).toContain("locked:");
  });

  test("command usage and header-only check do not require a passphrase", () => {
    const home = createHome();
    createPlaintextFixture(home);
    expect(call(home, "encrypt.ts").code).not.toBe(0);
    expect(call(home, "encrypt.ts", ["--help"]).code).not.toBe(0);
    const check = call(home, "encrypt.ts", ["check"], { AI_MEMORY_KEY: "" });
    expect(check.code).toBe(0);
    expect(check.stdout).toContain("encrypted: false");
  });
});
