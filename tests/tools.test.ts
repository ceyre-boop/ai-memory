import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, dbPath, KEY, makeHome, run, type ScriptResult } from "./helpers.ts";
import { counts, openStore } from "../scripts/lib/db.ts";

const homes: string[] = [];
const nonce = "quillfrond telemetry";
const conversationId = "claude:tools-fixture";

interface ConversationFixture {
  id: string;
  provider: string;
  title: string;
  messageBodies: string[];
}

interface PathRow {
  path: unknown;
}

afterEach(() => {
  while (homes.length > 0) cleanup(homes.pop() as string);
});

function createHome(): string {
  const home = makeHome();
  homes.push(home);
  return home;
}

function runObserved(home: string, script: string, args: string[] = [], env: Record<string, string> = {}): ScriptResult {
  const result = run(script, args, { AI_MEMORY_HOME: home, ...env });
  expect(result.stdout).not.toContain(KEY);
  expect(result.stderr).not.toContain(KEY);
  return result;
}

function insertConversation(home: string, fixture: ConversationFixture): void {
  const db = openStore({ path: dbPath(home), key: KEY, create: true });
  try {
    db.run(
      `INSERT INTO conversations (
        id, provider, source_id, title, created_at, updated_at, message_count,
        thread_inferred, export_file, export_hash, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fixture.id,
        fixture.provider,
        fixture.id.replace(/^[^:]+:/, ""),
        fixture.title,
        1,
        1,
        fixture.messageBodies.length,
        0,
        "tools-fixture.json",
        `${fixture.id}-hash`,
        1,
      ],
    );
    for (const [sequence, body] of fixture.messageBodies.entries()) {
      db.run(
        `INSERT INTO messages (
          id, conversation_id, seq, role, created_at, body, parent_id, on_main_path, content_types
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `${fixture.id}:message-${sequence}`,
          fixture.id,
          sequence,
          sequence === 0 ? "user" : "assistant",
          sequence + 1,
          body,
          null,
          1,
          '["text"]',
        ],
      );
    }
  } finally {
    db.close();
  }
}

function createConversationFixture(home: string, messageCount = 2): void {
  const bodies = Array.from({ length: messageCount }, (_, index) => `${nonce} message ${index + 1}`);
  insertConversation(home, {
    id: conversationId,
    provider: "claude",
    title: "Quillfrond fixture conversation",
    messageBodies: bodies,
  });
}

function readCounts(home: string): ReturnType<typeof counts> {
  const db = openStore({ path: dbPath(home), key: KEY, readonly: true });
  try {
    return counts(db);
  } finally {
    db.close();
  }
}

describe("query", () => {
  test("returns the provider, title, and message role for a matching conversation", () => {
    const home = createHome();
    createConversationFixture(home);

    const result = runObserved(home, "query.ts", [nonce]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("claude");
    expect(result.stdout).toContain("Quillfrond fixture conversation");
    expect(result.stdout).toContain("user");
  });

  test("prints no matches for a missing term", () => {
    const home = createHome();
    createConversationFixture(home);

    const result = runObserved(home, "query.ts", ["zzqqxxnomatchhere"]);

    expect(result.code).toBe(0);
    expect(result.stdout.split("\n").some((line) => line.trim() === "no matches")).toBeTrue();
  });

  test("accepts punctuation and quotes without a SQL error", () => {
    const home = createHome();
    createConversationFixture(home);

    for (const question of ["a:b*", 'a "quoted phrase']) {
      const result = runObserved(home, "query.ts", [question]);
      expect(result.code).toBe(0);
      expect(result.stderr.toLowerCase()).not.toContain("sql");
    }
  });

  test("limits the rendered result blocks", () => {
    const home = createHome();
    createConversationFixture(home);

    const result = runObserved(home, "query.ts", [nonce, "--limit", "1"]);

    expect(result.code).toBe(0);
    expect(result.stdout.match(/^── /gm) ?? []).toHaveLength(1);
  });

  test("accepts file and conversation source filters", () => {
    const home = createHome();
    createConversationFixture(home);

    for (const source of ["files", "conv"]) {
      const result = runObserved(home, "query.ts", [nonce, "--source", source]);
      expect(result.code).toBe(0);
    }
  });
});

describe("forget", () => {
  test("dry run reports the target and preserves store counts", () => {
    const home = createHome();
    createConversationFixture(home);
    const before = readCounts(home);

    const result = runObserved(home, "forget.ts", [conversationId, "--dry"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(conversationId);
    expect(result.stdout).toContain("claude");
    expect(result.stdout).toContain("Quillfrond fixture conversation");
    expect(result.stdout).toContain("2 messages");
    expect(readCounts(home)).toEqual(before);
  });

  test("deletes the conversation, messages, and their FTS hits", () => {
    const home = createHome();
    createConversationFixture(home);

    const deleted = runObserved(home, "forget.ts", [conversationId]);
    const queried = runObserved(home, "query.ts", [nonce]);

    expect(deleted.code).toBe(0);
    expect(readCounts(home)).toEqual({ files: 0, chunks: 0, conversations: 0, messages: 0 });
    expect(queried.code).toBe(0);
    expect(queried.stdout.split("\n").some((line) => line.trim() === "no matches")).toBeTrue();
  });

  test("deletes every conversation from a selected provider", () => {
    const home = createHome();
    createConversationFixture(home);
    insertConversation(home, {
      id: "claude:second-tools-fixture",
      provider: "claude",
      title: "Second Quillfrond fixture",
      messageBodies: ["second claude conversation"],
    });

    const result = runObserved(home, "forget.ts", ["--provider", "claude"]);

    expect(result.code).toBe(0);
    expect(readCounts(home)).toEqual({ files: 0, chunks: 0, conversations: 0, messages: 0 });
  });

  test("requires a selector", () => {
    const home = createHome();

    const result = runObserved(home, "forget.ts");

    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain("usage:");
  });

  test("fails for an unknown conversation id", () => {
    const home = createHome();
    createConversationFixture(home);

    const result = runObserved(home, "forget.ts", ["claude:unknown"]);

    expect(result.code).toBe(1);
  });
});

describe("collect", () => {
  test("dry run needs no passphrase and does not create a store", () => {
    const home = createHome();
    const source = join(home, "source");
    mkdirSync(source);
    writeFileSync(join(source, "note.md"), "Dry collection fixture prose.");

    const result = runObserved(home, "collect.ts", [source, "--dry"], { AI_MEMORY_KEY: "" });

    expect(result.code).toBe(0);
    expect(existsSync(dbPath(home))).toBeFalse();
  });

  test("collects prose into searchable chunks", () => {
    const home = createHome();
    const source = join(home, "source");
    mkdirSync(source);
    writeFileSync(join(source, "note.md"), "This is real prose for collection into the encrypted store.");

    const result = runObserved(home, "collect.ts", [source]);

    expect(result.code).toBe(0);
    expect(readCounts(home).chunks).toBeGreaterThan(0);
  });

  test("does not collect chunks from its own store directory", () => {
    const home = createHome();
    createConversationFixture(home);
    writeFileSync(join(home, "note.md"), "A real document beside the encrypted store.");

    const result = runObserved(home, "collect.ts", [home]);

    expect(result.code).toBe(0);
    const db = openStore({ path: dbPath(home), key: KEY, readonly: true });
    try {
      const rows = db.query("SELECT path FROM chunks WHERE path LIKE ?").all("%index.db%") as PathRow[];
      for (const row of rows) expect(typeof row.path).toBe("string");
      expect(rows).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("command usage", () => {
  test("rejects missing required arguments without leaking the passphrase", () => {
    const home = createHome();

    for (const script of ["encrypt.ts", "forget.ts", "push.ts", "query.ts", "collect.ts"]) {
      expect(runObserved(home, script).code).not.toBe(0);
    }
    expect(runObserved(home, "status.ts", ["--help"]).code).not.toBe(0);
  });
});
