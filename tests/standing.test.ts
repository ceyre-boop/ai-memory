// standing — parsing (pure, no network) plus the CLI end to end with the
// model endpoint mocked. A flag is only ever as good as the snippet it
// cites: these tests prove a snippet with no self-characterization never
// gets flagged, and a citation the model didn't earn (out of range) gets
// dropped rather than trusted.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStandingPatterns, buildStandingMessage, STANDING_SYSTEM_PROMPT } from "../scripts/lib/ask";
import type { Hit } from "../scripts/query";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const KEY = "standing-passphrase-6!";
let HOME: string;
let mock: ReturnType<typeof Bun.serve>;
const calls: any[] = [];

async function runCli(args: string[], env: Record<string, string> = {}) {
  // Tests simulate a person at a normal terminal, not an AI session issuing
  // the command — scrub CLAUDECODE so standing.ts's human-operator guard
  // doesn't fire for every test here. A dedicated test below re-adds it to prove the guard works.
  const spawnEnv: Record<string, string | undefined> = { ...process.env, AI_MEMORY_HOME: HOME, AI_MEMORY_KEY: KEY, ANTHROPIC_API_KEY: "", AI_MEMORY_NO_DOTENV: "1", ...env };
  delete spawnEnv.CLAUDECODE;
  if (env.CLAUDECODE !== undefined) spawnEnv.CLAUDECODE = env.CLAUDECODE;
  const p = Bun.spawn({
    cmd: ["bun", join(REPO, "scripts", "standing.ts"), ...args],
    env: spawnEnv,
    stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: HOME,
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}
const MOCK_ENV = () => ({ AI_MEMORY_PROVIDER: "api", ANTHROPIC_API_KEY: "test-key-123", AI_MEMORY_MODEL_URL: `http://127.0.0.1:${mock.port}/v1/messages` });

function seedStore() {
  HOME = mkdtempSync(join(tmpdir(), "ai-memory-standing-"));
  mkdirSync(join(HOME, "embeddings"), { recursive: true });
}

// Insert one genuine self-characterization ("that was a mistake...") plus one
// plain fact with no self-judgment attached, directly (bypassing ingest —
// this test controls exactly what's in the store).
async function seedPolishingPattern() {
  const { openStore } = await import("../scripts/lib/db");
  const db = openStore({ path: join(HOME, "embeddings", "index.db"), key: KEY, create: true });
  const insConv = db.prepare(`INSERT INTO conversations (id, provider, source_id, title, created_at, message_count, thread_inferred, imported_at) VALUES (?,?,?,?,?,?,?,?)`);
  const insMsg = db.prepare(`INSERT INTO messages (id, conversation_id, seq, role, created_at, body, on_main_path, content_types) VALUES (?,?,?,?,?,?,?,?)`);
  insConv.run("claude:retro", "claude", "retro", "Sprint retro notes", Date.parse("2026-04-10"), 1, 0, Date.now());
  insMsg.run("claude:retro:1", "claude:retro", 0, "user",
    Date.parse("2026-04-10"), "That was a mistake on my part — I keep polishing the demo instead of shipping the feature. Note to self: stop doing that.", 1, '["text"]');
  insConv.run("claude:standup", "claude", "standup", "Standup notes", Date.parse("2026-02-01"), 1, 0, Date.now());
  insMsg.run("claude:standup:1", "claude:standup", 0, "user",
    Date.parse("2026-02-01"), "Today I refactored the auth module and wrote three new tests.", 1, '["text"]');
  db.close();
}

beforeAll(async () => {
  seedStore();
  await seedPolishingPattern();
  mock = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const body = await req.json();
      calls.push(body);
      if (req.headers.get("x-api-key") !== "test-key-123") return Response.json({ error: { message: "bad key" } }, { status: 401 });
      const content = String(body.messages[0].content);
      const findN = (needle: string) => {
        const m = new RegExp(`\\[(\\d+)\\][^\\[]*?${needle}`, "s").exec(content);
        return m ? m[1] : "1";
      };
      let text: string;
      if (content.includes("[bad-format]")) {
        text = "I looked but couldn't form a clean flag here.";
      } else if (content.includes("[force-none]")) {
        text = "NOTHING STANDING.";
      } else if (content.includes("mistake") && content.includes("polishing")) {
        const n = findN("mistake");
        text = `PATTERN: polishing instead of shipping\nSAID: [${n}] called it a mistake, said stop doing it\nNOW: the current topic is the same demo-polishing situation\n---`;
      } else {
        text = "NOTHING STANDING.";
      }
      return Response.json({ model: body.model, stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } });
    },
  });
});
afterAll(() => { mock?.stop(true); rmSync(HOME, { recursive: true, force: true }); });

// ── pure parsing ─────────────────────────────────────────────────────────

const HITS: Hit[] = [
  { kind: "conversation", provider: "claude", title: "Sprint retro notes", role: "user", created_at: Date.parse("2026-04-10"), snippet: "that was a mistake, I keep polishing instead of shipping", score: -1 } as Hit,
  { kind: "conversation", provider: "claude", title: "Standup notes", role: "user", created_at: Date.parse("2026-02-01"), snippet: "refactored the auth module", score: -2 } as Hit,
];

test("buildStandingMessage numbers snippets with provenance; empty hits say so", () => {
  const m = buildStandingMessage("polishing the demo", HITS);
  expect(m).toContain("Topic: polishing the demo");
  expect(m).toContain('[1] (claude · "Sprint retro notes" · user · 2026-04-10)\nthat was a mistake, I keep polishing instead of shipping');
  expect(m).toContain('[2] (claude · "Standup notes" · user · 2026-02-01)\nrefactored the auth module');
  expect(buildStandingMessage("x", [])).toContain("(no matching snippets in the record)");
  expect(STANDING_SYSTEM_PROMPT).toContain("NOTHING STANDING.");
  expect(STANDING_SYSTEM_PROMPT).toContain("standard must come from the snippet, never from you");
});

test("parseStandingPatterns accepts a well-formed block and attaches real hit metadata", () => {
  const reply = "PATTERN: polishing instead of shipping\nSAID: [1] called it a mistake\nNOW: same situation again\n---";
  const r = parseStandingPatterns(reply, HITS);
  expect(r.noneFound).toBe(false);
  expect(r.unparsed).toBe(false);
  expect(r.patterns.length).toBe(1);
  const p = r.patterns[0];
  expect(p.name).toBe("polishing instead of shipping");
  expect(p.said.n).toBe(1);
  expect(p.said.hit.title).toBe("Sprint retro notes"); // from HITS, not from the model's text
  expect(p.now).toBe("same situation again");
});

test("parseStandingPatterns handles multiple blocks and the exact NOTHING STANDING literal", () => {
  const reply = "PATTERN: a\nSAID: [1] x\nNOW: y1\n---\nPATTERN: b\nSAID: [2] p\nNOW: y2\n---";
  expect(parseStandingPatterns(reply, HITS).patterns.length).toBe(2);
  expect(parseStandingPatterns("NOTHING STANDING.", HITS)).toEqual({ patterns: [], noneFound: true, unparsed: false });
  expect(parseStandingPatterns("nothing standing.", HITS).noneFound).toBe(true); // case-insensitive
});

test("parseStandingPatterns drops out-of-range citations rather than trust them", () => {
  expect(parseStandingPatterns("PATTERN: x\nSAID: [9] b\nNOW: w\n---", HITS).patterns).toEqual([]);
  const r = parseStandingPatterns("some prose that isn't the format at all", HITS);
  expect(r.patterns).toEqual([]);
  expect(r.noneFound).toBe(false);
  expect(r.unparsed).toBe(true);
});

// ── CLI end to end ───────────────────────────────────────────────────────

test("no args → usage; no hits → nothing sent to the model", async () => {
  expect((await runCli([])).code).not.toBe(0);
  const r = await runCli(["zzqxjvnope", "--no-expand"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("no matches in the store");
});

test("--dry retrieves through query.ts, prints snippets + prompt, calls nothing", async () => {
  const before = calls.length;
  const r = await runCli(["polishing instead of shipping", "--dry", "--no-expand", "--k", "5"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("── retrieved snippets ──");
  expect(r.out).toContain("── system prompt ──");
  expect(r.out).toContain("NOTHING STANDING.");
  expect(r.out).toContain("DRY RUN — nothing sent");
  expect(calls.length).toBe(before);
});

test("finds the real pattern and reports it with real dates/titles, not model-stated ones", async () => {
  const r = await runCli(["polishing instead of shipping a mistake", "--no-expand", "--k", "5"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("⚑ PATTERN 1 — polishing instead of shipping");
  expect(r.out).toMatch(/Said \[\d+\] claude · Sprint retro notes · 2026-04-10/);
  expect(r.out).toContain('"That was a mistake on my part'); // real snippet text, not the model's paraphrase
  expect(r.out).toContain("Now: the current topic is the same demo-polishing situation");
  expect(r.out).toMatch(/1 pattern\(s\)/);
});

test("'nothing standing' and unparsable replies are both reported honestly, never invented", async () => {
  const none = await runCli(["[force-none] polishing mistake unrelated topic", "--no-expand", "--k", "5"], MOCK_ENV());
  expect(none.code).toBe(0);
  expect(none.out).toContain("Nothing in your record names this a pattern.");

  const bad = await runCli(["[bad-format] polishing", "--no-expand", "--k", "5"], MOCK_ENV());
  expect(bad.code).toBe(0);
  expect(bad.out).toContain("didn't match the expected pattern format");
  expect(bad.out).toContain("I looked but couldn't form a clean flag here.");
});

test("standing refuses to call the model from inside an AI session (CLAUDECODE set); --dry still works", async () => {
  const dry = await runCli(["polishing", "--dry", "--no-expand"], { ...MOCK_ENV(), CLAUDECODE: "1" });
  expect(dry.code).toBe(0);

  const real = await runCli(["polishing", "--no-expand"], { ...MOCK_ENV(), CLAUDECODE: "1" });
  expect(real.code).not.toBe(0);
  expect(real.err).toContain("refusing to send your topic to the model from inside an AI coding session");
});

test("no output ever contains the passphrase or the API key", async () => {
  const r = await runCli(["polishing instead of shipping a mistake", "--no-expand"], MOCK_ENV());
  expect(r.out + r.err).not.toContain(KEY);
  expect(r.out + r.err).not.toContain("test-key-123");
});
