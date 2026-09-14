// Ingester tests — one fixture per provider, run through the real CLI against
// a temp store. Never touches embeddings/index.db in the repo.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FIX = join(REPO, "tests", "fixtures");
const KEY = "fixture-passphrase-Zq7!";
let HOME: string;

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync({
    cmd: ["bun", join(REPO, "scripts", script), ...args],
    env: { ...process.env, AI_MEMORY_HOME: HOME, AI_MEMORY_KEY: KEY, ...env },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

async function store() {
  const { openStore } = await import("../scripts/lib/db");
  return openStore({ path: join(HOME, "embeddings", "index.db"), key: KEY, readonly: true });
}
async function rows(sql: string, ...params: unknown[]) {
  const db = await store();
  try { return db.query(sql).all(...(params as any[])) as any[]; } finally { db.close(); }
}
async function one(sql: string, ...params: unknown[]) {
  return (await rows(sql, ...params))[0];
}

beforeAll(() => { HOME = mkdtempSync(join(tmpdir(), "ai-memory-ingest-")); });
afterAll(() => { rmSync(HOME, { recursive: true, force: true }); });

// ── general ────────────────────────────────────────────────────────────────

test("no args → usage, non-zero", () => {
  const r = run("ingest.ts", []);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("usage");
});

test("--dry needs no key, reports counts, writes nothing", () => {
  const r = run("ingest.ts", [join(FIX, "claude"), "--dry"], { AI_MEMORY_KEY: "" });
  expect(r.code).toBe(0);
  expect(r.out).toContain("2 conversations");
  expect(r.out).toContain("DRY RUN");
  expect(r.out).toContain("skipped users.json (account identity — never stored)");
  expect(existsSync(join(HOME, "embeddings", "index.db"))).toBe(false);
});

test("unrecognised JSON exits 1 naming the providers", () => {
  const p = join(HOME, "junk.json");
  writeFileSync(p, JSON.stringify([{ hello: "world" }]));
  const r = run("ingest.ts", [p]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("chatgpt, claude, gemini");
});

test("HTML-only Takeout exits 1 asking for JSON", () => {
  const d = join(HOME, "takeout-html", "Takeout", "My Activity", "Gemini Apps");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "MyActivity.html"), "<html></html>");
  const r = run("ingest.ts", [join(HOME, "takeout-html")]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("re-export as JSON");
});

// ── Claude ─────────────────────────────────────────────────────────────────

test("claude: directory ingest lands 2 conversations, 6 messages, roles mapped", async () => {
  const r = run("ingest.ts", [join(FIX, "claude")]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("provider: claude");
  const c = await one("SELECT count(*) c FROM conversations WHERE provider='claude'");
  expect(c.c).toBe(2);
  const m = await one("SELECT count(*) c FROM messages WHERE conversation_id LIKE 'claude:%'");
  expect(m.c).toBe(6);
  const roles = await rows("SELECT role, count(*) c FROM messages WHERE conversation_id LIKE 'claude:%' GROUP BY role ORDER BY role");
  expect(roles).toEqual([{ role: "assistant", c: 3 }, { role: "user", c: 3 }]);
});

test("claude: timestamps are unix ms, title/source_id preserved, seq follows array order", async () => {
  const conv = await one("SELECT * FROM conversations WHERE id='claude:0192aaaa-0000-7000-8000-000000000001'");
  expect(conv.title).toBe("Trip planning for Lisbon");
  expect(conv.source_id).toBe("0192aaaa-0000-7000-8000-000000000001");
  expect(conv.created_at).toBe(Date.parse("2026-05-02T09:15:00.000Z"));
  expect(conv.updated_at).toBe(Date.parse("2026-05-02T09:22:10.000Z"));
  expect(conv.thread_inferred).toBe(0);
  expect(conv.message_count).toBe(4);
  const ms = await rows("SELECT seq, role, created_at, parent_id FROM messages WHERE conversation_id=? ORDER BY seq", conv.id);
  expect(ms.map((x) => x.seq)).toEqual([0, 1, 2, 3]);
  expect(ms[0].created_at).toBe(Date.parse("2026-05-02T09:15:01.000Z"));
  expect(ms[1].parent_id).toBe("m-0001");
});

test("claude: thinking excluded by default, tool parts marked, attachment text kept, files listed", async () => {
  const a = await one("SELECT body, content_types FROM messages WHERE id='claude:0192aaaa-0000-7000-8000-000000000001:m-0002'");
  expect(a.body).not.toContain("pastel de nata line");
  expect(a.body).toContain("Miradouro");
  expect(JSON.parse(a.content_types)).toEqual(["thinking", "text"]);
  const t = await one("SELECT body FROM messages WHERE id='claude:0192aaaa-0000-7000-8000-000000000001:m-0004'");
  expect(t.body).toContain("[tool_use: web_search]");
  expect(t.body).toContain("[tool_result]");
  expect(t.body).toContain("Tram 28E runs from Martim Moniz");
  const att = await one("SELECT body FROM messages WHERE id='claude:0192aaaa-0000-7000-8000-000000000001:m-0001'");
  expect(att.body).toContain("[attachment: confirmation.txt]");
  expect(att.body).toContain("Hotel near Alfama");
  const f = await one("SELECT body FROM messages WHERE id='claude:0192aaaa-0000-7000-8000-000000000001:m-0003'");
  expect(f.body).toContain("[file: lisbon-map.png]");
  const legacy = await one("SELECT body, content_types FROM messages WHERE id='claude:0192aaaa-0000-7000-8000-000000000002:m-1001'");
  expect(legacy.body).toContain("REPL");
  expect(JSON.parse(legacy.content_types)).toEqual(["text"]);
  expect(legacy.body.length).toBeGreaterThan(10);
});

test("claude: --include-thinking keeps thinking text", async () => {
  const r = run("ingest.ts", [join(FIX, "claude"), "--include-thinking"]);
  expect(r.code).toBe(0);
  const a = await one("SELECT body FROM messages WHERE id='claude:0192aaaa-0000-7000-8000-000000000001:m-0002'");
  expect(a.body).toContain("pastel de nata line");
  run("ingest.ts", [join(FIX, "claude")]); // restore default
});

test("account identity is never stored", async () => {
  const hits = await rows("SELECT count(*) c FROM messages WHERE body LIKE '%fixture-account@example.com%'");
  expect(hits[0].c).toBe(0);
  const conv = await rows("SELECT count(*) c FROM conversations WHERE title LIKE '%fixture-account%'");
  expect(conv[0].c).toBe(0);
});

// ── ChatGPT ────────────────────────────────────────────────────────────────

test("chatgpt: tree walk keeps branches, marks main path, converts seconds to ms", async () => {
  const r = run("ingest.ts", [join(FIX, "chatgpt")]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("provider: chatgpt");
  expect(r.out).toContain("skipped user.json");
  const c = await one("SELECT count(*) c FROM conversations WHERE provider='chatgpt'");
  expect(c.c).toBe(2);
  const conv = await one("SELECT * FROM conversations WHERE id='chatgpt:c0ffee00-0000-4000-8000-000000000001'");
  expect(conv.title).toBe("Sourdough starter timing");
  expect(conv.created_at).toBe(1718000000123);
  expect(conv.updated_at).toBe(1718003600500);
  const ms = await rows("SELECT id, seq, role, on_main_path, parent_id, created_at FROM messages WHERE conversation_id=? ORDER BY seq", conv.id);
  expect(ms.length).toBe(6); // root system node with empty parts skipped
  expect(ms.map((m) => m.id.split(":").pop())).toEqual(["u1", "a1", "u2", "a2", "u2b", "a2b"]);
  expect(ms.map((m) => m.on_main_path)).toEqual([1, 1, 0, 0, 1, 1]);
  expect(ms[2].parent_id).toBe("a1");
  expect(ms[0].created_at).toBe(1718000000500);
  expect(ms.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
});

test("chatgpt: code fenced, image part marked, tool role kept, null create_time → NULL", async () => {
  const ms = await rows("SELECT id, role, body, created_at, content_types FROM messages WHERE conversation_id='chatgpt:c0ffee00-0000-4000-8000-000000000002' ORDER BY seq");
  expect(ms.length).toBe(3);
  expect(ms[0].body).toContain("[image: file-service://file-fixture-image-001]");
  expect(ms[0].body).toContain("ISO 8601");
  expect(ms[1].body.startsWith("```python\n")).toBe(true);
  expect(ms[1].created_at).toBeNull();
  expect(JSON.parse(ms[1].content_types)).toEqual(["code"]);
  expect(ms[2].role).toBe("tool");
});

// ── Gemini ─────────────────────────────────────────────────────────────────

test("gemini: locates MyActivity.json, infers 2 threads, strips HTML, sorts ascending", async () => {
  const r = run("ingest.ts", [join(FIX, "gemini")]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("provider: gemini");
  expect(r.out).toContain("2 threads inferred");
  const convs = await rows("SELECT * FROM conversations WHERE provider='gemini' ORDER BY created_at");
  expect(convs.length).toBe(2);
  expect(convs.every((c) => c.thread_inferred === 1)).toBe(true);
  expect(convs[0].title).toBe("What is the boiling point of water at altitude?");
  expect(convs[0].created_at).toBe(Date.parse("2026-03-14T10:00:00.000Z"));
  expect(convs[0].updated_at).toBe(Date.parse("2026-03-14T10:05:30.000Z"));
  expect(convs[0].message_count).toBe(4);
  const ms = await rows("SELECT role, body, created_at FROM messages WHERE conversation_id=? ORDER BY seq", convs[0].id);
  expect(ms.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(ms[1].body).toContain("- Sea level: 100°C");
  expect(ms[1].body).not.toContain("<");
  expect(ms[3].body).toContain("95°C");
  expect(ms[0].created_at).toBe(ms[1].created_at);
  // second thread: haiku + follow-up without a response
  const ms2 = await rows("SELECT role, body FROM messages WHERE conversation_id=? ORDER BY seq", convs[1].id);
  expect(ms2.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(ms2[1].body).toContain("Maple leaves let go—");
});

test("gemini: --gap-minutes 5 splits the follow-up into its own thread; ids deterministic", async () => {
  const before = (await rows("SELECT id FROM conversations WHERE provider='gemini' ORDER BY id")).map((r) => r.id);
  run("ingest.ts", [join(FIX, "gemini")]);
  const again = (await rows("SELECT id FROM conversations WHERE provider='gemini' ORDER BY id")).map((r) => r.id);
  expect(again).toEqual(before);
  const r = run("ingest.ts", [join(FIX, "gemini"), "--gap-minutes", "5"]);
  expect(r.code).toBe(0);
  // 10:00→10:05:30 is 5.5 min and 14:00→14:12 is 12 min: both split → 4 threads.
  // The two "first entry" threads keep the same deterministic ids as before.
  const c = await one("SELECT count(*) c FROM conversations WHERE provider='gemini'");
  expect(c.c).toBe(4);
  const ids = (await rows("SELECT id FROM conversations WHERE provider='gemini' ORDER BY id")).map((r) => r.id);
  expect(before.every((id) => ids.includes(id))).toBe(true);
});

// ── idempotency / upsert / zip / search ────────────────────────────────────

test("re-ingest is idempotent; modified export upserts", async () => {
  run("ingest.ts", [join(FIX, "claude")]);
  const a = await one("SELECT (SELECT count(*) FROM conversations) c, (SELECT count(*) FROM messages) m");
  run("ingest.ts", [join(FIX, "claude")]);
  const b = await one("SELECT (SELECT count(*) FROM conversations) c, (SELECT count(*) FROM messages) m");
  expect(b).toEqual(a);
  // modify one conversation's title and drop a message → same id, replaced
  const mod = join(HOME, "claude-mod");
  mkdirSync(mod, { recursive: true });
  const data = JSON.parse(readFileSync(join(FIX, "claude", "conversations.json"), "utf8"));
  data[1].name = "Debug a bun test (edited)";
  data[1].chat_messages.pop();
  writeFileSync(join(mod, "conversations.json"), JSON.stringify(data));
  const r = run("ingest.ts", [mod]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("2 replaced");
  const conv = await one("SELECT title, message_count FROM conversations WHERE id='claude:0192aaaa-0000-7000-8000-000000000002'");
  expect(conv.title).toBe("Debug a bun test (edited)");
  expect(conv.message_count).toBe(1);
  const c = await one("SELECT count(*) c FROM messages WHERE conversation_id='claude:0192aaaa-0000-7000-8000-000000000002'");
  expect(c.c).toBe(1);
  run("ingest.ts", [join(FIX, "claude")]); // restore
});

test("zip archive is read via unzip -p (no temp extraction)", async () => {
  const zip = join(HOME, "claude-export.zip");
  const z = Bun.spawnSync({ cmd: ["zip", "-qr", zip, "."], cwd: join(FIX, "claude") });
  expect(z.exitCode).toBe(0);
  const r = run("ingest.ts", [zip, "--dry"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("claude-export.zip → conversations.json");
  expect(r.out).toContain("skipped users.json");
  const src = readFileSync(join(REPO, "scripts", "ingest.ts"), "utf8");
  expect(src).not.toMatch(/mkdtemp|tmpdir\(|unzip -d|unzip", "-d/);
});

test("bare file path works and export_file/export_hash recorded", async () => {
  const r = run("ingest.ts", [join(FIX, "chatgpt", "conversations.json")]);
  expect(r.code).toBe(0);
  const c = await one("SELECT export_file, export_hash FROM conversations WHERE provider='chatgpt' LIMIT 1");
  expect(c.export_file).toBe("conversations.json");
  expect(c.export_hash).toMatch(/^[0-9a-f]+$/);
});

test("--provider override rejects unknown provider", () => {
  const r = run("ingest.ts", [join(FIX, "claude"), "--provider", "bard"]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("supported: chatgpt, claude, gemini");
});

test("fixture phrases are searchable through messages_fts", async () => {
  for (const term of ["Miradouro", "sourdough", "Denver"]) {
    const hits = await rows("SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?", term);
    expect(hits[0].c).toBeGreaterThan(0);
  }
});

test("no output ever contains the passphrase", () => {
  const r = run("ingest.ts", [join(FIX, "gemini")]);
  expect(r.out + r.err).not.toContain(KEY);
});

test("no network code in scripts/", () => {
  const files = Bun.spawnSync({ cmd: ["sh", "-c", `grep -rlE 'fetch\\(|openai\\.com|anthropic\\.com|google\\.com|https?://' ${join(REPO, "scripts")} || true`] });
  expect(files.stdout.toString().trim()).toBe("");
});
