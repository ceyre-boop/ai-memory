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
  // AI_MEMORY_QUERY_CACHE isolated too — ask.ts's --more writes into it by
  // default, and the real path is ~/.config/ai-memory/query-cache.json.
  const spawnEnv: Record<string, string | undefined> = { ...process.env, AI_MEMORY_HOME: HOME, AI_MEMORY_KEY: KEY, ANTHROPIC_API_KEY: "", AI_MEMORY_NO_DOTENV: "1", AI_MEMORY_QUERY_CACHE: join(HOME, "query-cache.json"), ...env };
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

beforeAll(async () => {
  HOME = mkdtempSync(join(tmpdir(), "ai-memory-ask-"));
  for (const p of ["chatgpt", "gemini"]) {
    const r = Bun.spawnSync({ cmd: ["bun", join(REPO, "scripts", "ingest.ts"), join(FIX, p)],
      env: { ...process.env, AI_MEMORY_HOME: HOME, AI_MEMORY_KEY: KEY }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
  }
  // Five dated "gadget" messages, direct-inserted — controlled data for
  // --more/--since/--until/--oldest/--newest/--chunk, independent of the
  // ingested fixtures' own keyword content and message counts.
  {
    const { openStore } = await import("../scripts/lib/db");
    const db = openStore({ path: join(HOME, "embeddings", "index.db"), key: KEY });
    const insConv = db.prepare(`INSERT INTO conversations (id, provider, source_id, title, created_at, message_count, thread_inferred, imported_at) VALUES (?,?,?,?,?,?,?,?)`);
    const insMsg = db.prepare(`INSERT INTO messages (id, conversation_id, seq, role, created_at, body, on_main_path, content_types) VALUES (?,?,?,?,?,?,?,?)`);
    insConv.run("claude:gadgets", "claude", "gadgets", "Gadget planning", Date.parse("2026-01-01"), 5, 0, Date.now());
    for (let i = 1; i <= 5; i++) {
      insMsg.run(`claude:gadgets:${i}`, "claude:gadgets", i, "user", Date.parse(`2026-01-0${i}`), `Gadget note number ${i}`, 1, '["text"]');
    }
    db.close();
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
      const isStanding = String(body.system).startsWith("You compare a current topic");
      const content = String(body.messages[0].content);
      let text: string;
      if (isExpand) text = '["sourdough starter", "ferment days", "cold kitchen"]';
      else if (isStanding) {
        if (content.includes("[break-standing]")) return Response.json({ error: { message: "simulated outage" } }, { status: 500 });
        text = content.includes("[force-pattern]")
          ? 'PATTERN: forgetting the starter\nSAID: [1] noted forgetting to feed the starter as a recurring mistake\nNOW: same starter-care situation\n---'
          : "NOTHING STANDING.";
      }
      else if (content.includes("altitude")) text = "Not in your record.";
      else if (content.includes("gadget")) text = content.includes("(this batch was cut off") ? "There are more, sir — [1] covers this batch." : "Gadget note [1].";
      else text = "Let it ferment 5 to 7 days [1]; cold kitchens take longer [3].";
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
  expect(m).toContain('[1] (chatgpt · "Sourdough" · assistant · 2024-06-10 · ?)\n5 to 7 days');
  expect(m).toContain("[2] (file · notes/bread.md · ?)\nfeed twice");
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
  const r = await runAsk(["sourdough", "--no-patterns"], { AI_MEMORY_PROVIDER: "api" });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("no model configured");
  const c = await runAsk(["sourdough", "--no-patterns"], { AI_MEMORY_PROVIDER: "claude-cli", AI_MEMORY_CLAUDE_BIN: join(HOME, "nope") });
  expect(c.code).not.toBe(0);
  expect(c.err).toContain("claude CLI not found");
});

test("default provider is the claude CLI: no tools, no settings, stdin prompt, cited answer", async () => {
  const r = await runAsk(["how long should sourdough ferment", "--k", "4", "--no-patterns"], CLI_ENV());
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
  const r = await runAsk(["how long should sourdough ferment", "--k", "4", "--no-patterns"], MOCK_ENV());
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
  const r = await runAsk(["altitude boiling", "--no-expand", "--no-patterns"], MOCK_ENV());
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

test("standing-pattern check runs by default, on the same hits, as a second call", async () => {
  const before = calls.length;
  const r = await runAsk(["how long should sourdough ferment", "--no-expand"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(calls.length - before).toBe(2); // one answer call + one standing-pattern call, no expansion
  const answer = calls[before], pattern = calls[before + 1];
  expect(answer.system).toBe(SYSTEM_PROMPT);
  expect(String(pattern.system)).toContain("You compare a current topic");
  expect(pattern.messages[0].content).toContain("Topic: how long should sourdough ferment");
  // nothing found in this case (no [force-pattern] marker) — no block printed
  expect(r.out).not.toContain("Also standing in your record");
});

test("--no-patterns skips the second call entirely", async () => {
  const before = calls.length;
  const r = await runAsk(["how long should sourdough ferment", "--no-expand", "--no-patterns"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(calls.length - before).toBe(1);
  expect(r.out).not.toContain("Also standing in your record");
});

test("a real standing pattern prints cited, with real hit metadata — not the model's own text", async () => {
  const r = await runAsk(["[force-pattern] how long should sourdough ferment", "--no-expand"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("⚑ Also standing in your record:");
  expect(r.out).toContain("forgetting the starter — [1] chatgpt · Sourdough starter timing · 2024-06-10");
  expect(r.out).toContain('"How long should I let a sourdough starter ferment before the first bake?"'); // real snippet text, not the model's paraphrase
});

test("a failed standing-pattern call never breaks the main answer", async () => {
  const r = await runAsk(["[break-standing] how long should sourdough ferment", "--no-expand"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("Let it ferment 5 to 7 days [1]"); // main answer unaffected
  expect(r.out).not.toContain("Also standing in your record"); // pattern check failed silently, not fatally
});

// ── steerable retrieval: --more, --oldest/--newest, --since/--until, --chunk ──

test("--dry shows the retrieved set and truncation state for --k below the real count", async () => {
  const r = await runAsk(["gadget", "--dry", "--no-expand", "--k", "2", "--source", "conv"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("2 snippets retrieved");
  expect(r.out).toContain("more available — run --more");
  expect(r.out).toContain("── retrieved snippets ──");
  expect(r.out).toContain("── user message ──");
  expect(r.out).toContain("(this batch was cut off by --k; more matches exist — --more retrieves the next batch)");
});

test("--dry shows no truncation note when --k covers everything", async () => {
  const r = await runAsk(["gadget", "--dry", "--no-expand", "--k", "10", "--source", "conv"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("5 snippets retrieved");
  expect(r.out).not.toContain("more available");
  expect(r.out).not.toContain("this batch was cut off");
});

test("--more excludes what --k already returned and pulls a genuinely disjoint next batch", async () => {
  const before = calls.length;
  const first = await runAsk(["gadget", "--no-expand", "--no-patterns", "--k", "2", "--source", "conv"], MOCK_ENV());
  expect(first.code).toBe(0);
  const firstRefs = [...first.out.matchAll(/claude:gadgets:\d/g)].map((m) => m[0]);
  expect(firstRefs.length).toBeGreaterThan(0);

  const more = await runAsk(["gadget", "--no-expand", "--no-patterns", "--k", "2", "--source", "conv", "--more"], MOCK_ENV());
  expect(more.code).toBe(0);
  expect(more.out).toContain("--more: excluded 2 already-shown snippet(s)");
  const moreRefs = [...more.out.matchAll(/claude:gadgets:\d/g)].map((m) => m[0]);
  expect(moreRefs.length).toBeGreaterThan(0);
  expect(moreRefs.some((r) => firstRefs.includes(r))).toBe(false); // no overlap
  expect(calls.length - before).toBe(2); // two answer calls, --no-patterns skips the extra one
});

test("--oldest and --newest reorder by date and are mutually exclusive", async () => {
  const oldest = await runAsk(["gadget", "--dry", "--no-expand", "--k", "5", "--source", "conv", "--oldest"], MOCK_ENV());
  expect(oldest.out.indexOf("Gadget note number 1")).toBeLessThan(oldest.out.indexOf("Gadget note number 5"));

  const newest = await runAsk(["gadget", "--dry", "--no-expand", "--k", "5", "--source", "conv", "--newest"], MOCK_ENV());
  expect(newest.out.indexOf("Gadget note number 5")).toBeLessThan(newest.out.indexOf("Gadget note number 1"));

  const both = await runAsk(["gadget", "--dry", "--oldest", "--newest"], MOCK_ENV());
  expect(both.code).not.toBe(0);
  expect(both.err).toContain("mutually exclusive");
});

test("--since/--until bound the date window, composed together", async () => {
  const r = await runAsk(["gadget", "--dry", "--no-expand", "--k", "10", "--source", "conv", "--since", "2026-01-02", "--until", "2026-01-04"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("3 snippets retrieved");
  expect(r.out).toContain("Gadget note number 2");
  expect(r.out).toContain("Gadget note number 3");
  expect(r.out).toContain("Gadget note number 4");
  expect(r.out).not.toContain("Gadget note number 1");
  expect(r.out).not.toContain("Gadget note number 5");
});

test("a garbage --since value is a usage error, not a silent no-op", async () => {
  const r = await runAsk(["gadget", "--dry", "--since", "not-a-date"], MOCK_ENV());
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("--since needs a date");
});

test("--chunk fetches one exact snippet directly, skipping search entirely", async () => {
  const dry = await runAsk(["anything", "--dry", "--chunk", "claude:gadgets:3"], MOCK_ENV());
  expect(dry.code).toBe(0);
  expect(dry.out).toContain("fetched directly by ref, no search");
  expect(dry.out).toContain("1 snippets retrieved");
  expect(dry.out).toContain("Gadget note number 3");
  expect(dry.out).not.toContain("more available"); // a single directly-fetched snippet is never "truncated"
});

test("--chunk with an unknown ref is a clear error, not an empty answer", async () => {
  const r = await runAsk(["anything", "--dry", "--chunk", "claude:gadgets:does-not-exist"], MOCK_ENV());
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("no snippet found for --chunk");
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
