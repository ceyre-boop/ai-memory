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
    expect(real.stderr).toContain("refusing to touch removable media from inside an AI coding session");
    expect(readdirSync(target)).toEqual([]);

    // the same command, run as if from a normal terminal, is allowed
    const human = run("push.ts", [target], { AI_MEMORY_HOME: home });
    expect(human.code).toBe(0);
    expect(existsSync(join(target, "ai-memory", "embeddings", "index.db"))).toBe(true);

    // --pull is a write to the local primary and is refused the same way
    const pullGuard = run("push.ts", [target, "--pull"], { AI_MEMORY_HOME: home, CLAUDECODE: "1" });
    expect(pullGuard.code).not.toBe(0);
    expect(pullGuard.stderr).toContain("refusing to touch removable media from inside an AI coding session");
  } finally { cleanup(home); rmSync(target, { recursive: true, force: true }); }
});

test("push --eject: CLAUDECODE guard refuses a real eject, allows --dry; --pull+--eject is rejected", () => {
  const home = makeHome();
  const target = mkdtempSync(join(tmpdir(), "ai-memory-eject-guard-"));
  try {
    const both = run("push.ts", [target, "--pull", "--eject"], { AI_MEMORY_HOME: home });
    expect(both.code).not.toBe(0);
    expect(both.stderr + both.stdout).toContain("mutually exclusive");

    const dry = run("push.ts", [target, "--eject", "--dry"], { AI_MEMORY_HOME: home, CLAUDECODE: "1" });
    expect(dry.code).toBe(0);
    expect(existsSync(target)).toBe(true); // untouched

    const real = run("push.ts", [target, "--eject"], { AI_MEMORY_HOME: home, CLAUDECODE: "1" });
    expect(real.code).not.toBe(0);
    expect(real.stderr).toContain("refusing to touch removable media from inside an AI coding session");
    expect(existsSync(target)).toBe(true); // never reached diskutil
  } finally { cleanup(home); rmSync(target, { recursive: true, force: true }); }
});

test("push --eject --dry reports correctly whether the active store lives on the target, and calls diskutil for neither case", () => {
  const target = mkdtempSync(join(tmpdir(), "ai-memory-eject-dry-"));
  try {
    // Case 1: the active store IS on the target.
    const onTargetHome = join(target, "ai-memory");
    mkdirSync(join(onTargetHome, "embeddings"), { recursive: true });
    expect(run("ingest.ts", [join(FIX, "claude")], { AI_MEMORY_HOME: onTargetHome }).code).toBe(0);
    const dryOn = run("push.ts", [target, "--eject", "--dry"], { AI_MEMORY_HOME: onTargetHome });
    expect(dryOn.code).toBe(0);
    expect(dryOn.stdout).toContain("active store IS on this volume");
    expect(dryOn.stdout).toContain("DRY RUN — nothing checkpointed, nothing ejected");
    expect(existsSync(join(onTargetHome, "embeddings", "index.db"))).toBe(true); // untouched

    // Case 2: the active store is NOT on the target.
    const elsewhere = makeHome();
    try {
      const dryOff = run("push.ts", [target, "--eject", "--dry"], { AI_MEMORY_HOME: elsewhere });
      expect(dryOff.code).toBe(0);
      expect(dryOff.stdout).toContain("active store is NOT on this volume");
    } finally { cleanup(elsewhere); }
  } finally { rmSync(target, { recursive: true, force: true }); }
});

// Fake `diskutil`: real diskutil can't eject a plain temp directory, so this
// stands in for it — "ejecting" here means the target directory disappears,
// the same observable effect targetIsMountedDirectory() checks for on a
// real volume. Proves push.ts drives the real diskutil binary by name via
// PATH, not a hardcoded path, and that the post-eject poll actually waits
// for the target to be gone before declaring success.
function fakeDiskutilBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai-memory-fake-diskutil-"));
  const bin = join(dir, "diskutil");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "eject" ]; then rm -rf "$2"; echo "Disk $2 ejected"; exit 0; fi\nexit 1\n`);
  require("node:fs").chmodSync(bin, 0o755);
  return dir;
}

test("push --eject (real): checkpoints and verifies the on-target store before ejecting, refuses to eject a plaintext store's guarantee, and confirms the target is gone", () => {
  const fakeBinDir = fakeDiskutilBin();
  const pathWithFake = `${fakeBinDir}:${process.env.PATH}`;

  // encrypted store on the target
  const target1 = mkdtempSync(join(tmpdir(), "ai-memory-eject-real-"));
  const home1 = join(target1, "ai-memory");
  mkdirSync(join(home1, "embeddings"), { recursive: true });
  try {
    expect(run("ingest.ts", [join(FIX, "claude")], { AI_MEMORY_HOME: home1 }).code).toBe(0);
    const r = run("push.ts", [target1, "--eject"], { AI_MEMORY_HOME: home1, PATH: pathWithFake });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ WAL checkpointed — index.db is self-contained");
    expect(r.stdout).toContain("✓ reopened clean:");
    expect(r.stdout).toContain("✓ safe to eject: nothing pending, store reopens clean");
    expect(r.stdout).toContain(`✓ ${target1} ejected — safe to remove`);
    expect(existsSync(target1)).toBe(false); // the fake diskutil actually removed it, and push.ts confirmed that
  } finally { rmSync(target1, { recursive: true, force: true }); }

  // plaintext store on the target: still ejects, but with the plaintext note instead of a checkpoint
  const target2 = mkdtempSync(join(tmpdir(), "ai-memory-eject-plain-"));
  const home2 = join(target2, "ai-memory");
  mkdirSync(join(home2, "embeddings"), { recursive: true });
  writeFileSync(join(home2, "embeddings", "index.db"), "SQLite format 3\0" + "x".repeat(100), "latin1");
  try {
    const r2 = run("push.ts", [target2, "--eject"], { AI_MEMORY_HOME: home2, PATH: pathWithFake });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain("the store on this volume is plaintext SQLite");
    expect(r2.stdout).not.toContain("WAL checkpointed");
    expect(existsSync(target2)).toBe(false);
  } finally { rmSync(target2, { recursive: true, force: true }); }

  // target unrelated to the active store: ejects with the no-store-specific-check note
  const target3 = mkdtempSync(join(tmpdir(), "ai-memory-eject-unrelated-"));
  const home3 = makeHome();
  try {
    const r3 = run("push.ts", [target3, "--eject"], { AI_MEMORY_HOME: home3, PATH: pathWithFake });
    expect(r3.code).toBe(0);
    expect(r3.stdout).toContain("active store is not on");
    expect(existsSync(target3)).toBe(false);
  } finally { cleanup(home3); rmSync(target3, { recursive: true, force: true }); }

  rmSync(fakeBinDir, { recursive: true, force: true });
});

test("push --eject (real): refuses and stays mounted when the fake diskutil reports failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-memory-fake-diskutil-fail-"));
  const bin = join(dir, "diskutil");
  writeFileSync(bin, `#!/bin/sh\necho "Resource busy" >&2\nexit 1\n`);
  require("node:fs").chmodSync(bin, 0o755);
  const target = mkdtempSync(join(tmpdir(), "ai-memory-eject-busy-"));
  const home = makeHome();
  try {
    const r = run("push.ts", [target, "--eject"], { AI_MEMORY_HOME: home, PATH: `${dir}:${process.env.PATH}` });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Resource busy");
    expect(existsSync(target)).toBe(true); // still there — eject never claimed success it didn't earn
  } finally { cleanup(home); rmSync(target, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});
