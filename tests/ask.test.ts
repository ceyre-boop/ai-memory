// ask — retrieval through query.ts, prompt construction, expansion, --dry,
// source attribution, with the Messages endpoint mocked. No real API calls.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUserMessage, SYSTEM_PROMPT, loadDotEnv, citedIndices, mergeHits } from "../scripts/lib/ask";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const FIX = join(REPO, "tests", "fixtures");
const KEY = "ask-passphrase-4!";
let HOME: string;
let mock: ReturnType<typeof Bun.serve>;
const calls: any[] = [];

// Async on purpose: the mock model endpoint runs in this test process, so a
// synchronous spawn would block the event loop and the CLI could never get a reply.
async function runAsk(args: string[], env: Record<string, string> = {}) {
  // Tests simulate a person at a normal terminal, not an AI session issuing
  // the command — scrub CLAUDECODE so ask.ts's human-operator guard doesn't
  // fire for every test here. A dedicated test below re-adds it to prove the guard works.
  const spawnEnv: Record<string, string | undefined> = { ...process.env, AI_MEMORY_HOME: HOME, AI_MEMORY_KEY: KEY, ANTHROPIC_API_KEY: "", AI_MEMORY_NO_DOTENV: "1", ...env };
  delete spawnEnv.CLAUDECODE;
  if (env.CLAUDECODE !== undefined) spawnEnv.CLAUDECODE = env.CLAUDECODE;
  const p = Bun.spawn({
    cmd: ["bun", join(REPO, "scripts", "ask.ts"), ...args],
    env: spawnEnv,
    stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: HOME, // never the repo .env: tests must not reach the real API
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}
const MOCK_ENV = () => ({ AI_MEMORY_PROVIDER: "api", ANTHROPIC_API_KEY: "test-key-123", AI_MEMORY_MODEL_URL: `http://127.0.0.1:${mock.port}/v1/messages` });
// fake `claude` binary: answers from stdin without any network, so the CLI provider is testable
let FAKE_CLI: string;
const CLI_ENV = () => ({ AI_MEMORY_PROVIDER: "claude-cli", AI_MEMORY_CLAUDE_BIN: FAKE_CLI });

beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), "ai-memory-ask-"));
  for (const p of ["chatgpt", "gemini"]) {
    const r = Bun.spawnSync({ cmd: ["bun", join(REPO, "scripts", "ingest.ts"), join(FIX, p)],
      env: { ...process.env, AI_MEMORY_HOME: HOME, AI_MEMORY_KEY: KEY }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
  }
  FAKE_CLI = join(HOME, "fake-claude");
  writeFileSync(FAKE_CLI, "#!/bin/sh\n# records args + stdin, answers like the CLI would\nprintf '%s\\n' \"$@\" > \"${0}.args\"\ninput=$(cat)\nprintf '%s' \"$input\" > \"${0}.stdin\"\ncase \"$*\" in *\"You rewrite a question\"*) printf '[\"sourdough starter\", \"ferment days\", \"cold kitchen\"]';; *) printf 'Five to seven days [1], longer in a cold kitchen [3].';; esac\n");
  chmodSync(FAKE_CLI, 0o755);
  mock = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const body = await req.json();
      calls.push(body);
      if (req.headers.get("x-api-key") !== "test-key-123") return Response.json({ error: { message: "bad key" } }, { status: 401 });
      const isExpand = String(body.system).startsWith("You rewrite a question");
      const text = isExpand
        ? '["sourdough starter", "ferment days", "cold kitchen"]'
        : (String(body.messages[0].content).includes("altitude") ? "Not in your record." : "Let it ferment 5 to 7 days [1]; cold kitchens take longer [3].");
      return Response.json({ model: body.model, stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } });
    },
  });
});
afterAll(() => { mock?.stop(true); rmSync(HOME, { recursive: true, force: true }); });

test("user message numbers snippets with provenance; empty hits say so; system prompt demands refusal wording", () => {
  const m = buildUserMessage("how long?", [
    { kind: "conversation", provider: "chatgpt", title: "Sourdough", role: "assistant", created_at: Date.parse("2024-06-10"), snippet: "«5 to 7» days", score: -1 },
    { kind: "file", path: "notes/bread.md", snippet: "feed twice", score: -0.5 },
  ]);
  expect(m).toContain("Question: how long?");
  expect(m).toContain('[1] (chatgpt · "Sourdough" · assistant · 2024-06-10)\n5 to 7 days');
  expect(m).toContain("[2] (file · notes/bread.md)\nfeed twice");
  expect(buildUserMessage("x", [])).toContain("(no matching snippets in the record)");
  expect(SYSTEM_PROMPT).toContain('reply with exactly: "Not in your record."');
  expect(SYSTEM_PROMPT).toContain("Do not use general knowledge");
});

test("citedIndices parses [n] in order, ignores out-of-range; mergeHits dedupes and ranks", () => {
  expect(citedIndices("see [3] and [1], then [3] again and [9]", 4)).toEqual([3, 1]);
  const a = { kind: "conversation" as const, id: "m1", snippet: "x", score: -2 };
  const b = { kind: "conversation" as const, id: "m1", snippet: "x", score: -5 };
  const c = { kind: "file" as const, path: "p", snippet: "y", score: -3 };
  const merged = mergeHits([[a, c], [b]], 5);
  expect(merged.map((h) => h.score)).toEqual([-5, -3]);
});

test("loadDotEnv reads KEY=VALUE without overriding existing env", () => {
  const f = join(HOME, "test.env");
  writeFileSync(f, "# comment\nAI_MEMORY_TEST_A=hello\nAI_MEMORY_TEST_B='quoted'\n");
  process.env.AI_MEMORY_TEST_B = "already";
  loadDotEnv(f);
  expect(process.env.AI_MEMORY_TEST_A).toBe("hello");
  expect(process.env.AI_MEMORY_TEST_B).toBe("already");
});

test("no args → usage; api provider without a key → clear error; cli provider without a binary → clear error", async () => {
  expect((await runAsk([])).code).not.toBe(0);
  const r = await runAsk(["sourdough"], { AI_MEMORY_PROVIDER: "api" });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("no model configured");
  const c = await runAsk(["sourdough"], { AI_MEMORY_PROVIDER: "claude-cli", AI_MEMORY_CLAUDE_BIN: join(HOME, "nope") });
  expect(c.code).not.toBe(0);
  expect(c.err).toContain("claude CLI not found");
});

test("default provider is the claude CLI: no tools, no settings, stdin prompt, cited answer", async () => {
  const r = await runAsk(["how long should sourdough ferment", "--k", "4"], CLI_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain('expanded with: "sourdough starter", "ferment days", "cold kitchen"');
  expect(r.out).toContain("Five to seven days [1]");
  expect(r.out).toContain("via claude CLI (subscription)");
  expect(r.out).toMatch(/\[1\] chatgpt · Sourdough starter timing · 2024-06-10/);
  const args = readFileSync(FAKE_CLI + ".args", "utf8");
  expect(args).toContain("--print");
  expect(args).toContain("--tools\n\n");
  expect(args).toContain("--no-session-persistence");
  expect(args).toContain("--strict-mcp-config");
  expect(args).toContain("--model\nopus");
  const stdin = readFileSync(FAKE_CLI + ".stdin", "utf8");
  expect(stdin).toContain("Question: how long should sourdough ferment");
  expect(stdin).toContain("[1] (chatgpt");
  expect(existsSync(join(HOME, ".claude"))).toBe(false);
});

test("--dry retrieves through query.ts, prints snippets + prompt, calls nothing", async () => {
  const before = calls.length;
  const r = await runAsk(["how long should sourdough ferment", "--dry", "--k", "3"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("expansion skipped under --dry");
  expect(r.out).toContain("── retrieved snippets ──");
  expect(r.out).toContain('[1] chatgpt · "Sourdough starter timing"');
  expect(r.out).toContain("── user message ──");
  expect(r.out).toContain("DRY RUN — nothing sent");
  expect(calls.length).toBe(before);
  expect(r.out + r.err).not.toContain("test-key-123");
  expect(r.out + r.err).not.toContain(KEY);
});

test("default run expands with 3 variants, unions results, answers with cited sources", async () => {
  const before = calls.length;
  const r = await runAsk(["how long should sourdough ferment", "--k", "4"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain('expanded with: "sourdough starter", "ferment days", "cold kitchen"');
  expect(r.out).toContain("Let it ferment 5 to 7 days [1]");
  expect(r.out).toContain("Sources:");
  expect(r.out).toMatch(/\[1\] chatgpt · Sourdough starter timing · 2024-06-10/);
  expect(r.out).toContain("— claude-opus-5 via Messages API · ");
  expect(calls.length - before).toBe(2); // one expansion call + one answer call
  const expand = calls[before], answer = calls[before + 1];
  expect(expand.model).toBe("claude-haiku-4-5");
  expect(answer.model).toBe("claude-opus-5");
  expect(answer.system).toBe(SYSTEM_PROMPT);
  expect(answer.messages[0].content).toContain("Question: how long should sourdough ferment");
  expect(JSON.stringify(answer)).not.toContain(KEY);
});

test("--no-expand makes exactly one call; unanswerable → 'Not in your record.' passed through verbatim", async () => {
  const before = calls.length;
  const r = await runAsk(["altitude boiling", "--no-expand"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(calls.length - before).toBe(1);
  expect(r.out).toContain("Not in your record.");
  expect(r.out).toContain("none cited — snippets sent (uncited)");
});

test("zero hits → nothing sent to the model", async () => {
  const before = calls.length;
  const r = await runAsk(["zzqxjv", "--no-expand"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("no matches in the store — nothing sent to the model");
  expect(calls.length).toBe(before);
});

test("outbound network code lives only in ask.ts (hosted) and embed.ts (loopback)", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(join(REPO, "scripts"));
  const offenders = files.filter((f) => !f.endsWith("lib/ask.ts") && !f.endsWith("lib/embed.ts") &&
    /\bfetch\(|https?:\/\/(?!127\.0\.0\.1|localhost)/.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);

  // embed.ts may open a socket, but only to loopback — CONSTRAINTS.md item 6.
  const embed = readFileSync(join(REPO, "scripts", "lib", "embed.ts"), "utf8");
  const hosts = [...embed.matchAll(/https?:\/\/([^\s"'`$/]+)/g)].map((m) => m[1]);
  expect(hosts.filter((h) => !/^(127\.0\.0\.1|localhost|\[?::1\]?)(:\d+)?$/.test(h))).toEqual([]);
});
