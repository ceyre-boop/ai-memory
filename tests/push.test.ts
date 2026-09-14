import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, dbPath, KEY, makeHome, run, type ScriptResult } from "./helpers.ts";
import { counts, loadCipher, openStore } from "../scripts/lib/db.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
  while (temporaryPaths.length > 0) cleanup(temporaryPaths.pop() as string);
});

function createHome(): string {
  const home = makeHome();
  temporaryPaths.push(home);
  return home;
}

function createTarget(): string {
  const target = mkdtempSync(join(tmpdir(), "ai-memory-push-target-"));
  temporaryPaths.push(target);
  return target;
}

function writeManifest(home: string): void {
  writeFileSync(join(home, "manifest.json"), '{"name":"portable-ai-memory","version":"0.1.0"}\n');
}

function createEncryptedFixture(home: string): void {
  const db = openStore({ path: dbPath(home), key: KEY, create: true });
  try {
    db.run(
      `INSERT INTO conversations (
        id, provider, source_id, title, created_at, updated_at, message_count,
        thread_inferred, export_file, export_hash, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "chatgpt:fixture-conversation",
        "chatgpt",
        "fixture-conversation",
        "Push fixture",
        1,
        1,
        1,
        0,
        "fixture.json",
        "fixture-hash",
        1,
      ],
    );
    db.run(
      `INSERT INTO messages (
        id, conversation_id, seq, role, created_at, body, parent_id, on_main_path, content_types
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "chatgpt:fixture-message",
        "chatgpt:fixture-conversation",
        0,
        "user",
        1,
        "distinctive push fixture phrase",
        null,
        1,
        '["text"]',
      ],
    );
    db.run(
      "INSERT INTO files (hash, path, name, ext, bytes, mtime, kind, indexed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["fixture-file", "notes/fixture.md", "fixture.md", ".md", 1, 1, "text", 1],
    );
    db.run("INSERT INTO chunks (path, body) VALUES (?, ?)", ["notes/fixture.md", "distinctive chunk phrase"]);
  } finally {
    db.close();
  }
  writeManifest(home);
}

function runPush(home: string, args: string[]): ScriptResult {
  const result = run("push.ts", args, { AI_MEMORY_HOME: home });
  expect(result.stdout).not.toContain(KEY);
  expect(result.stderr).not.toContain(KEY);
  return result;
}

function databaseSidecars(directory: string): string[] {
  const sidecars: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      sidecars.push(...databaseSidecars(path));
    } else if (entry.name.endsWith(".db-wal") || entry.name.endsWith(".db-shm")) {
      sidecars.push(path);
    }
  }
  return sidecars;
}

describe("portable encrypted pushes", () => {
  test("pushes an encrypted store, excludes local files, and records the push", () => {
    const home = createHome();
    const target = createTarget();
    createEncryptedFixture(home);

    const result = runPush(home, [target]);
    const destination = join(target, "ai-memory");
    const manifestPath = join(home, "manifest.json");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("✓ verified on target: 1 chunks · 1 files · 1 conversations · 1 messages");
    expect(existsSync(join(destination, "embeddings", "index.db"))).toBeTrue();
    expect(existsSync(join(destination, "corpus"))).toBeFalse();
    expect(existsSync(join(destination, ".git"))).toBeFalse();
    expect(existsSync(join(destination, "node_modules"))).toBeFalse();
    expect(databaseSidecars(target)).toEqual([]);

    const rawManifest = Bun.file(manifestPath);
    return rawManifest.text().then((raw) => {
      const manifest = JSON.parse(raw) as {
        pushes?: Array<{ target: string; at: string; counts: { messages: number } }>;
      };
      expect(manifest.pushes).toHaveLength(1);
      expect(manifest.pushes?.[0]?.target).toBe(destination);
      expect(Date.parse(manifest.pushes?.[0]?.at ?? "")).not.toBeNaN();
      expect(manifest.pushes?.[0]?.counts.messages).toBe(1);
      expect(raw).not.toContain(KEY);
    });
  });

  test("refuses a plaintext store before writing to the target", () => {
    const home = createHome();
    const target = createTarget();
    const path = dbPath(home);
    loadCipher();
    const db = new Database(path, { create: true });
    try {
      db.run("CREATE TABLE files (hash TEXT PRIMARY KEY)");
    } finally {
      db.close();
    }
    writeManifest(home);

    const result = runPush(home, [target]);

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("refusing to push a plaintext store");
    expect(readdirSync(target)).toEqual([]);
  });

  test("--dry leaves the mounted target empty", () => {
    const home = createHome();
    const target = createTarget();
    createEncryptedFixture(home);

    const result = runPush(home, [target, "--dry"]);

    expect(result.code).toBe(0);
    expect(readdirSync(target)).toEqual([]);
  });

  test("pull restores an encrypted store with matching message counts", () => {
    const home = createHome();
    const target = createTarget();
    createEncryptedFixture(home);
    expect(runPush(home, [target]).code).toBe(0);

    const restoredHome = createHome();
    copyFileSync(join(home, "manifest.json"), join(restoredHome, "manifest.json"));
    const result = runPush(restoredHome, [target, "--pull"]);

    expect(result.code).toBe(0);
    expect(existsSync(dbPath(restoredHome))).toBeTrue();
    const restored = openStore({ path: dbPath(restoredHome), key: KEY, readonly: true });
    try {
      expect(counts(restored).messages).toBe(1);
    } finally {
      restored.close();
    }
  });

  test("prints usage when no target is provided", () => {
    const home = createHome();
    createTarget();

    const result = runPush(home, []);

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("usage:");
  });

  test("rejects a target path that is not mounted", () => {
    const home = createHome();
    const target = createTarget();
    const missingTarget = join(target, "not-mounted");

    const result = runPush(home, [missingTarget]);

    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("not mounted");
  });
});
