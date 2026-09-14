// Regression tests for the Cato audit findings (2026-09-14).
import { test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChatGPT } from "../scripts/lib/parsers/chatgpt";
import { parseClaude } from "../scripts/lib/parsers/claude";
import { KEY, makeHome, run, cleanup } from "./helpers";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const FIX = join(REPO, "tests", "fixtures");

test("push never carries .env, *.key, wip/ or corpus/ to the target, and --dry leaves no probe", () => {
  const home = makeHome();
  const target = mkdtempSync(join(tmpdir(), "ai-memory-chip-"));
  try {
    expect(run("ingest.ts", [join(FIX, "claude")], { AI_MEMORY_HOME: home }).code).toBe(0);
    writeFileSync(join(home, ".env"), "ANTHROPIC_API_KEY=sk-fake\n");
    writeFileSync(join(home, "store.key"), "not-really\n");
    mkdirSync(join(home, "wip"), { recursive: true }); writeFileSync(join(home, "wip", "ask.ts"), "// parked\n");
    mkdirSync(join(home, "corpus"), { recursive: true }); writeFileSync(join(home, "corpus", "note.md"), "plaintext inbox\n");
    mkdirSync(join(home, "scripts"), { recursive: true }); writeFileSync(join(home, "scripts", "x.ts"), "// script\n");
    writeFileSync(join(home, "scripts", ".env.local"), "NOPE=1\n");

    const dry = run("push.ts", [target, "--dry"], { AI_MEMORY_HOME: home });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("never copied");
    expect(readdirSync(target)).toEqual([]); // no probe, no ai-memory dir

    const push = run("push.ts", [target], { AI_MEMORY_HOME: home });
    expect(push.code).toBe(0);
    const dest = join(target, "ai-memory");
    expect(existsSync(join(dest, "embeddings", "index.db"))).toBe(true);
    expect(existsSync(join(dest, "scripts", "x.ts"))).toBe(true);
    for (const bad of [".env", "store.key", "wip", "corpus", join("scripts", ".env.local")]) {
      expect(existsSync(join(dest, bad))).toBe(false);
    }
    const all = JSON.stringify(readdirSync(dest, { recursive: true }));
    expect(all).not.toContain(".env");
    expect(all).not.toContain(".key");
    expect(push.stdout + push.stderr).not.toContain(KEY);

    // pull refuses a plaintext source and verifies an encrypted one
    const plain = mkdtempSync(join(tmpdir(), "ai-memory-plain-"));
    mkdirSync(join(plain, "ai-memory", "embeddings"), { recursive: true });
    writeFileSync(join(plain, "ai-memory", "embeddings", "index.db"), "SQLite format 3\0" + "x".repeat(100), "latin1");
    const badPull = run("push.ts", [plain, "--pull"], { AI_MEMORY_HOME: home });
    expect(badPull.code).not.toBe(0);
    expect(badPull.stderr).toContain("refusing to pull a plaintext store");
    const goodPull = run("push.ts", [target, "--pull"], { AI_MEMORY_HOME: home });
    expect(goodPull.code).toBe(0);
    expect(goodPull.stdout).toContain("pulled and verified");
    // a pull must never prune the local primary's own secrets or inbox
    expect(existsSync(join(home, ".env"))).toBe(true);
    expect(existsSync(join(home, "store.key"))).toBe(true);
    expect(existsSync(join(home, "corpus", "note.md"))).toBe(true);
    rmSync(plain, { recursive: true, force: true });
  } finally { cleanup(home); rmSync(target, { recursive: true, force: true }); }
});

test("gemini: re-ingest at a different --gap-minutes replaces inferred threads instead of duplicating them", () => {
  const home = makeHome();
  try {
    const count = () => Number(/store now (\d+) conversations · (\d+) messages/.exec(run("ingest.ts", [join(FIX, "gemini")], { AI_MEMORY_HOME: home }).stdout)![1]);
    expect(run("ingest.ts", [join(FIX, "gemini")], { AI_MEMORY_HOME: home }).stdout).toContain("store now 2 conversations · 7 messages");
    const split = run("ingest.ts", [join(FIX, "gemini"), "--gap-minutes", "5"], { AI_MEMORY_HOME: home });
    expect(split.code).toBe(0);
    expect(split.stdout).toContain("replaced 2 previously inferred threads");
    expect(split.stdout).toContain("store now 4 conversations · 7 messages");
    const merged = run("ingest.ts", [join(FIX, "gemini")], { AI_MEMORY_HOME: home });
    expect(merged.stdout).toContain("replaced 4 previously inferred threads");
    expect(merged.stdout).toContain("store now 2 conversations · 7 messages");
    expect(count()).toBe(2);
  } finally { cleanup(home); }
});

test("claude: an empty content[] does not discard a populated text field", () => {
  const r = parseClaude([{ uuid: "u1", name: "t", chat_messages: [
    { uuid: "m1", sender: "human", text: "kept from text field", content: [], created_at: "2026-01-01T00:00:00Z" },
    { uuid: "m2", sender: "assistant", text: "", content: [{ type: "token_budget" }], created_at: "2026-01-01T00:00:01Z" },
  ] }]);
  expect(r.conversations[0].messages.map((m) => m.body)).toEqual(["kept from text field"]);
  expect(r.emptySkipped).toBe(1);
});

test("chatgpt: nodes unreachable through children[] are kept as branches and noted; missing current_node is noted", () => {
  const r = parseChatGPT([{ id: "c1", title: "t", current_node: null, mapping: {
    root: { id: "root", parent: null, children: ["a"], message: null },
    a: { id: "a", parent: "root", children: [], message: { id: "a", author: { role: "user" }, create_time: 1, content: { content_type: "text", parts: ["linked"] } } },
    orphan: { id: "orphan", parent: "a", children: [], message: { id: "orphan", author: { role: "assistant" }, create_time: 2, content: { content_type: "text", parts: ["unlinked reply"] } } },
  } }]);
  const msgs = r.conversations[0].messages;
  expect(msgs.map((m) => m.body)).toEqual(["linked", "unlinked reply"]);
  expect(msgs[1].onMainPath).toBe(false);
  expect(r.notes.some((n) => n.includes("not linked from any parent"))).toBe(true);
  expect(r.notes.some((n) => n.includes("current_node missing"))).toBe(true);
});

test("counts(strict) fails loudly on a missing table; lenient reads 0", async () => {
  const { openStore, counts } = await import("../scripts/lib/db");
  const home = makeHome();
  try {
    const db = openStore({ path: join(home, "embeddings", "index.db"), key: KEY, create: true });
    db.run("DROP TABLE messages");
    expect(counts(db).messages).toBe(0);
    expect(() => counts(db, true)).toThrow(/count failed/);
    db.close();
  } finally { cleanup(home); }
});

test("a store home with a space in its path works (removable media like '/Volumes/NO NAME')", () => {
  const home = join(mkdtempSync(join(tmpdir(), "ai-memory space ")), "my store");
  mkdirSync(join(home, "embeddings"), { recursive: true });
  try {
    const r = run("ingest.ts", [join(FIX, "claude")], { AI_MEMORY_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("store now 2 conversations");
    const q = run("query.ts", ["Lisbon", "--limit", "1"], { AI_MEMORY_HOME: home });
    expect(q.code).toBe(0);
    expect(q.stdout).toContain("Trip planning for Lisbon");
  } finally { rmSync(join(home, ".."), { recursive: true, force: true }); }
});

test("child processes never inherit the passphrase (push spawns rsync/du/df with a scrubbed env)", () => {
  const src = readFileSync(join(REPO, "scripts", "push.ts"), "utf8");
  expect(src).toContain("env: scrubbedEnv()");
  const ingest = readFileSync(join(REPO, "scripts", "ingest.ts"), "utf8");
  expect(ingest).toMatch(/Bun\.spawn\(\["unzip", "-p"[^\n]*env \}\)/);
});

test("push refuses to write to media from inside an AI session (CLAUDECODE set); --dry still works", () => {
  const home = makeHome();
  const target = mkdtempSync(join(tmpdir(), "ai-memory-chip-guard-"));
  try {
    expect(run("ingest.ts", [join(FIX, "claude")], { AI_MEMORY_HOME: home }).code).toBe(0);

    // simulate running from inside an AI coding session
    const dry = run("push.ts", [target, "--dry"], { AI_MEMORY_HOME: home, CLAUDECODE: "1" });
    expect(dry.code).toBe(0);
    expect(readdirSync(target)).toEqual([]);

    const real = run("push.ts", [target], { AI_MEMORY_HOME: home, CLAUDECODE: "1" });
    expect(real.code).not.toBe(0);
    expect(real.stderr).toContain("refusing to write to removable media from inside an AI coding session");
    expect(readdirSync(target)).toEqual([]);

    // the same command, run as if from a normal terminal, is allowed
    const human = run("push.ts", [target], { AI_MEMORY_HOME: home });
    expect(human.code).toBe(0);
    expect(existsSync(join(target, "ai-memory", "embeddings", "index.db"))).toBe(true);

    // --pull is a write to the local primary and is refused the same way
    const pullGuard = run("push.ts", [target, "--pull"], { AI_MEMORY_HOME: home, CLAUDECODE: "1" });
    expect(pullGuard.code).not.toBe(0);
    expect(pullGuard.stderr).toContain("refusing to write to removable media from inside an AI coding session");
  } finally { cleanup(home); rmSync(target, { recursive: true, force: true }); }
});
