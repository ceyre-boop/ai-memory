// ghostwrite.ts — assembles SOUL + retrieved snippets into a draft prompt. The
// real model call is a human act (CLAUDECODE-guarded); here we only exercise the
// --dry assembly and the guard, over a temp store built from the fixtures.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const FIX = join(REPO, "tests", "fixtures");
const KEY = "ghostwrite-passphrase-7!";
let HOME: string;
let SOUL: string;

function run(args: string[], extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: ["bun", join(REPO, "scripts", "ghostwrite.ts"), ...args],
    env: { ...process.env, AI_MEMORY_HOME: HOME, AI_MEMORY_KEY: KEY, ...extraEnv },
    stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: REPO,
  });
}

beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), "ai-memory-ghost-"));
  for (const p of ["claude", "chatgpt", "gemini"]) {
    const r = Bun.spawnSync({
      cmd: ["bun", join(REPO, "scripts", "ingest.ts"), join(FIX, p)],
      env: { ...process.env, AI_MEMORY_HOME: HOME, AI_MEMORY_KEY: KEY },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    expect(r.exitCode).toBe(0);
  }
  SOUL = join(HOME, "SOUL.fixture.md");
  writeFileSync(SOUL, "# SOUL\nColin argues with the text and ends on an open question. Signature line: to be is to be chomped on.\n");
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("--dry assembles SOUL + retrieved snippets and sends nothing", () => {
  const r = run(["sourdough", "--dry", "--soul", SOUL]);
  expect(r.exitCode).toBe(0);
  const out = r.stdout.toString();
  expect(out).toContain("DRY RUN");
  expect(out).toContain("nothing sent");
  expect(out).toContain("SOUL framing");          // the system prompt carries the profile
  expect(out).toContain("open question");          // from the SOUL fixture body
  expect(out).toContain("sourdough");              // the topic is in the user message
  expect(out).toContain("[1]");                    // at least one retrieved snippet
  expect(out).toContain("Sourdough");              // the fixture conversation surfaced
});

test("refuses the real model call inside an AI coding session", () => {
  const r = run(["anything", "--soul", SOUL], { CLAUDECODE: "1" });
  expect(r.exitCode).not.toBe(0);
  expect(r.stdout.toString() + r.stderr.toString()).toContain("AI coding session");
});

test("a missing SOUL profile is a clear error, not a silent draft", () => {
  const r = run(["anything", "--dry", "--soul", join(HOME, "nope.md")]);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("no SOUL profile");
});
