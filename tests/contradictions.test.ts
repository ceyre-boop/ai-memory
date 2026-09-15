// contradictions — parsing (pure, no network) plus the CLI end to end with
// the model endpoint mocked. Every printed date/title comes from the real
// retrieved snippet, never from the model's own text — these tests prove
// that a citation the model didn't earn (out of range, self-referencing)
// gets dropped rather than trusted.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContradictions, buildContradictionMessage, CONTRADICTION_SYSTEM_PROMPT } from "../scripts/lib/ask";
import type { Hit } from "../scripts/query";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const KEY = "contra-passphrase-7!";
let HOME: string;
let mock: ReturnType<typeof Bun.serve>;
const calls: any[] = [];

async function runCli(args: string[], env: Record<string, string> = {}) {
  // Tests simulate a person at a normal terminal, not an AI session issuing
  // the command — scrub CLAUDECODE so contradictions.ts's human-operator
  // guard doesn't fire for every test here. A dedicated test below re-adds it to prove the guard works.
  // AI_MEMORY_QUERY_CACHE isolated too — contradictions.ts's --more writes
  // into it by default, and the real path is ~/.config/ai-memory/query-cache.json.
  const spawnEnv: Record<string, string | undefined> = { ...process.env, AI_MEMORY_HOME: HOME, AI_MEMORY_KEY: KEY, ANTHROPIC_API_KEY: "", AI_MEMORY_NO_DOTENV: "1", AI_MEMORY_QUERY_CACHE: join(HOME, "query-cache.json"), ...env };
  delete spawnEnv.CLAUDECODE;
  if (env.CLAUDECODE !== undefined) spawnEnv.CLAUDECODE = env.CLAUDECODE;
  const p = Bun.spawn({
    cmd: ["bun", join(REPO, "scripts", "contradictions.ts"), ...args],
    env: spawnEnv,
    stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: HOME,
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}
const MOCK_ENV = () => ({ AI_MEMORY_PROVIDER: "api", ANTHROPIC_API_KEY: "test-key-123", AI_MEMORY_MODEL_URL: `http://127.0.0.1:${mock.port}/v1/messages` });

function seedStore() {
  HOME = mkdtempSync(join(tmpdir(), "ai-memory-contra-"));
  mkdirSync(join(HOME, "embeddings"), { recursive: true });
}

// Insert two known, genuinely conflicting statements directly (bypassing
// ingest — this test controls exactly what's in the store) and hand back
// a reply-builder that finds their snippet numbers in the actual outbound
// prompt, regardless of which order search() ranks them in.
async function seedBudgetConflict() {
  const { openStore } = await import("../scripts/lib/db");
  // Explicit path + key — never rely on AI_MEMORY_HOME/AI_MEMORY_KEY env
  // resolution here, which could otherwise fall through to the real
  // ~/.config/ai-memory/key and the real local store.
  const db = openStore({ path: join(HOME, "embeddings", "index.db"), key: KEY, create: true });
  const insConv = db.prepare(`INSERT INTO conversations (id, provider, source_id, title, created_at, message_count, thread_inferred, imported_at) VALUES (?,?,?,?,?,?,?,?)`);
  const insMsg = db.prepare(`INSERT INTO messages (id, conversation_id, seq, role, created_at, body, on_main_path, content_types) VALUES (?,?,?,?,?,?,?,?)`);
  insConv.run("claude:budget", "claude", "budget", "House budget", Date.parse("2026-01-10"), 1, 0, Date.now());
  insMsg.run("claude:budget:1", "claude:budget", 0, "user", Date.parse("2026-01-10"), "My hard cap for the house is $250k, not going a dollar over that.", 1, '["text"]');
  insConv.run("claude:offer", "claude", "offer", "Offer accepted", Date.parse("2026-03-01"), 1, 0, Date.now());
  insMsg.run("claude:offer:1", "claude:offer", 0, "user", Date.parse("2026-03-01"), "Just put an offer in on the house at $310k, fingers crossed.", 1, '["text"]');
  // Five dated "gadget" messages — controlled data for --more/--since/--until/--oldest/--newest/--chunk.
  insConv.run("claude:gadgets", "claude", "gadgets", "Gadget planning", Date.parse("2026-01-01"), 5, 0, Date.now());
  for (let i = 1; i <= 5; i++) {
    insMsg.run(`claude:gadgets:${i}`, "claude:gadgets", i, "user", Date.parse(`2026-01-0${i}`), `Gadget note number ${i}`, 1, '["text"]');
  }
  db.close();
}

beforeAll(async () => {
  seedStore();
  await seedBudgetConflict();
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
        text = "I looked but couldn't form a clean comparison here.";
      } else if (content.includes("[force-none]")) {
        text = "NO CONTRADICTIONS FOUND.";
      } else if (content.includes("$250k") && content.includes("$310k")) {
        const a = findN("250k"), b = findN("310k");
        text = `CONTRADICTION: stated budget ceiling for the house\nA: [${a}] hard cap at $250k\nB: [${b}] offer went in at $310k\nWHY: the offer exceeds the stated ceiling with no reason given\n---`;
      } else {
        text = "NO CONTRADICTIONS FOUND.";
      }
      return Response.json({ model: body.model, stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 12, output_tokens: 6 } });
    },
  });
});
afterAll(() => { mock?.stop(true); rmSync(HOME, { recursive: true, force: true }); });

// ── pure parsing ─────────────────────────────────────────────────────────

const HITS: Hit[] = [
  { kind: "conversation", provider: "claude", title: "House budget", role: "user", created_at: Date.parse("2026-01-10"), snippet: "hard cap at 250k", score: -1 } as Hit,
  { kind: "conversation", provider: "claude", title: "Offer accepted", role: "user", created_at: Date.parse("2026-03-01"), snippet: "offer went in at 310k", score: -2 } as Hit,
];

test("buildContradictionMessage numbers snippets with provenance; empty hits say so", () => {
  const m = buildContradictionMessage("house budget", HITS);
  expect(m).toContain("Topic: house budget");
  expect(m).toContain('[1] (claude · "House budget" · user · 2026-01-10 · ?)\nhard cap at 250k');
  expect(m).toContain('[2] (claude · "Offer accepted" · user · 2026-03-01 · ?)\noffer went in at 310k');
  expect(buildContradictionMessage("x", [])).toContain("(no matching snippets in the record)");
  expect(CONTRADICTION_SYSTEM_PROMPT).toContain("NO CONTRADICTIONS FOUND.");
  expect(CONTRADICTION_SYSTEM_PROMPT).toContain("say nothing");
});

test("parseContradictions accepts a well-formed block and attaches real hit metadata", () => {
  const reply = "CONTRADICTION: stated budget ceiling\nA: [1] hard cap at $250k\nB: [2] offer went in at $310k\nWHY: exceeds the stated cap\n---";
  const r = parseContradictions(reply, HITS);
  expect(r.noneFound).toBe(false);
  expect(r.unparsed).toBe(false);
  expect(r.contradictions.length).toBe(1);
  const c = r.contradictions[0];
  expect(c.subject).toBe("stated budget ceiling");
  expect(c.a.n).toBe(1);
  expect(c.a.hit.title).toBe("House budget"); // from HITS, not from the model's text
  expect(c.b.n).toBe(2);
  expect(c.b.hit.created_at).toBe(Date.parse("2026-03-01"));
});

test("parseContradictions handles multiple blocks and the exact NO CONTRADICTIONS literal", () => {
  const reply = "CONTRADICTION: a\nA: [1] x\nB: [2] y\nWHY: w1\n---\nCONTRADICTION: b\nA: [2] p\nB: [1] q\nWHY: w2\n---";
  expect(parseContradictions(reply, HITS).contradictions.length).toBe(2);
  expect(parseContradictions("NO CONTRADICTIONS FOUND.", HITS)).toEqual({ contradictions: [], noneFound: true, unparsed: false });
  expect(parseContradictions("no contradictions found.", HITS).noneFound).toBe(true); // case-insensitive
});

test("parseContradictions drops out-of-range and self-referencing citations rather than trust them", () => {
  expect(parseContradictions("CONTRADICTION: x\nA: [1] a\nB: [9] b\nWHY: w\n---", HITS).contradictions).toEqual([]);
  expect(parseContradictions("CONTRADICTION: x\nA: [1] a\nB: [1] b\nWHY: w\n---", HITS).contradictions).toEqual([]);
  const r = parseContradictions("some prose that isn't the format at all", HITS);
  expect(r.contradictions).toEqual([]);
  expect(r.noneFound).toBe(false);
  expect(r.unparsed).toBe(true);
});

// ── CLI end to end ───────────────────────────────────────────────────────

test("no args → usage; fewer than 2 hits → nothing sent to the model", async () => {
  expect((await runCli([])).code).not.toBe(0);
  const r = await runCli(["zzqxjvnope", "--no-expand"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("fewer than 2 snippets");
});

test("--dry retrieves through query.ts, prints snippets + prompt, calls nothing", async () => {
  const before = calls.length;
  const r = await runCli(["house budget offer", "--dry", "--no-expand", "--k", "5"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("── retrieved snippets ──");
  expect(r.out).toContain("── system prompt ──");
  expect(r.out).toContain("NO CONTRADICTIONS FOUND.");
  expect(r.out).toContain("DRY RUN — nothing sent");
  expect(calls.length).toBe(before);
});

test("finds the real contradiction and reports it with real dates/titles, not model-stated ones", async () => {
  const r = await runCli(["house budget offer 250k 310k", "--no-expand", "--k", "5"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("⚠ CONTRADICTION 1 — stated budget ceiling for the house");
  expect(r.out).toMatch(/A: \[\d+\] claude · House budget · 2026-01-10/);
  expect(r.out).toMatch(/B: \[\d+\] claude · Offer accepted · 2026-03-01/);
  expect(r.out).toContain('My hard cap for the house is $250k, not going a dollar over that.'); // real snippet text, not the model's paraphrase
  expect(r.out).toContain("Why: the offer exceeds the stated ceiling with no reason given");
  expect(r.out).toMatch(/1 contradiction\(s\)/);
});

test("'no contradictions' and unparsable replies are both reported honestly, never invented", async () => {
  const none = await runCli(["[force-none] unrelated topic house budget", "--no-expand", "--k", "5"], MOCK_ENV());
  expect(none.code).toBe(0);
  expect(none.out).toContain("No contradictions found on this topic in the retrieved record.");

  const bad = await runCli(["[bad-format] house budget offer", "--no-expand", "--k", "5"], MOCK_ENV());
  expect(bad.code).toBe(0);
  expect(bad.out).toContain("didn't match the expected contradiction format");
  expect(bad.out).toContain("I looked but couldn't form a clean comparison here.");
});

// ── steerable retrieval: --more, --oldest/--newest, --since/--until, --chunk ──

test("--dry shows truncation state; the note is CLI-side, never inside the model's structured reply", async () => {
  const cut = await runCli(["gadget", "--dry", "--no-expand", "--k", "2", "--source", "conv"], MOCK_ENV());
  expect(cut.code).toBe(0);
  expect(cut.out).toContain("2 snippets retrieved");
  expect(cut.out).toContain("more available — run --more");

  const full = await runCli(["gadget", "--dry", "--no-expand", "--k", "10", "--source", "conv"], MOCK_ENV());
  expect(full.code).toBe(0);
  expect(full.out).toContain("5 snippets retrieved");
  expect(full.out).not.toContain("more available");
});

test("truncated batch prints a deterministic CLI note after a real (mocked) reply, not baked into NO CONTRADICTIONS FOUND", async () => {
  const r = await runCli(["gadget", "--no-expand", "--k", "2", "--source", "conv"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("No contradictions found on this topic in the retrieved record (this batch).");
  expect(r.out).toContain("This batch was cut off by --k; more snippets exist on this topic — run --more.");
});

test("--more excludes what --k already returned and pulls a genuinely disjoint next batch", async () => {
  // --dry (not a real contradiction) so the retrieved refs are visible in
  // output regardless of what the model would have said about them.
  const first = await runCli(["gadget", "--dry", "--no-expand", "--k", "2", "--source", "conv"], MOCK_ENV());
  const firstRefs = [...first.out.matchAll(/claude:gadgets:\d/g)].map((m) => m[0]);
  expect(firstRefs.length).toBeGreaterThan(0);

  // Real (non-dry) call first to actually populate the cache — --dry never writes to it.
  await runCli(["gadget", "--no-expand", "--k", "2", "--source", "conv"], MOCK_ENV());
  const more = await runCli(["gadget", "--dry", "--no-expand", "--k", "2", "--source", "conv", "--more"], MOCK_ENV());
  expect(more.out).toContain("--more: excluded 2 already-shown snippet(s)");
  const moreRefs = [...more.out.matchAll(/claude:gadgets:\d/g)].map((m) => m[0]);
  expect(moreRefs.length).toBeGreaterThan(0);
  expect(moreRefs.some((r) => firstRefs.includes(r))).toBe(false);
});

test("--oldest and --newest reorder by date and are mutually exclusive", async () => {
  const oldest = await runCli(["gadget", "--dry", "--no-expand", "--k", "5", "--source", "conv", "--oldest"], MOCK_ENV());
  expect(oldest.out.indexOf("Gadget note number 1")).toBeLessThan(oldest.out.indexOf("Gadget note number 5"));
  const both = await runCli(["gadget", "--dry", "--oldest", "--newest"], MOCK_ENV());
  expect(both.code).not.toBe(0);
  expect(both.err).toContain("mutually exclusive");
});

test("--since/--until bound the date window", async () => {
  const r = await runCli(["gadget", "--dry", "--no-expand", "--k", "10", "--source", "conv", "--since", "2026-01-02", "--until", "2026-01-04"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("3 snippets retrieved");
  expect(r.out).not.toContain("Gadget note number 1");
  expect(r.out).not.toContain("Gadget note number 5");
});

test("--chunk fetches one exact snippet directly; fewer than 2 means nothing sent to the model", async () => {
  const r = await runCli(["anything", "--chunk", "claude:gadgets:3"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("fetched directly by ref, no search");
  expect(r.out).toContain("fewer than 2 snippets");
});

test("--chunk with an unknown ref is a clear error", async () => {
  const r = await runCli(["anything", "--dry", "--chunk", "claude:gadgets:does-not-exist"], MOCK_ENV());
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("no snippet found for --chunk");
});

test("no output ever contains the passphrase or the API key", async () => {
  const r = await runCli(["house budget offer 250k 310k", "--no-expand"], MOCK_ENV());
  expect(r.out + r.err).not.toContain(KEY);
  expect(r.out + r.err).not.toContain("test-key-123");
});
