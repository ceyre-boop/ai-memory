// review — batches standing.ts across recently-active topics. Regression
// coverage for a real bug found while wiring the scheduled job: the report
// formatter referenced field names (p.pattern/p.summary/p.quote/p.where)
// that don't exist on StandingPattern ({name, now, said: {n, hit}}), so
// every flagged pattern printed "(unlabelled)" with no quote at all.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const KEY = "review-passphrase-8!";
let HOME: string;
let mock: ReturnType<typeof Bun.serve>;

async function runCli(args: string[], env: Record<string, string> = {}) {
  const spawnEnv: Record<string, string | undefined> = {
    ...process.env, AI_MEMORY_HOME: HOME, AI_MEMORY_KEY: KEY, ANTHROPIC_API_KEY: "",
    AI_MEMORY_NO_DOTENV: "1", AI_MEMORY_QUERY_CACHE: join(HOME, "query-cache.json"), ...env,
  };
  delete spawnEnv.CLAUDECODE;
  if (env.CLAUDECODE !== undefined) spawnEnv.CLAUDECODE = env.CLAUDECODE;
  const p = Bun.spawn({ cmd: ["bun", join(REPO, "scripts", "review.ts"), ...args], env: spawnEnv, stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: HOME });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}
const MOCK_ENV = () => ({ AI_MEMORY_PROVIDER: "api", ANTHROPIC_API_KEY: "test-key-123", AI_MEMORY_MODEL_URL: `http://127.0.0.1:${mock.port}/v1/messages` });

beforeAll(async () => {
  HOME = mkdtempSync(join(tmpdir(), "ai-memory-review-"));
  mkdirSync(join(HOME, "embeddings"), { recursive: true });
  const { openStore } = await import("../scripts/lib/db");
  const db = openStore({ path: join(HOME, "embeddings", "index.db"), key: KEY, create: true });
  const insConv = db.prepare(`INSERT INTO conversations (id, provider, source_id, title, created_at, message_count, thread_inferred, imported_at) VALUES (?,?,?,?,?,?,?,?)`);
  const insMsg = db.prepare(`INSERT INTO messages (id, conversation_id, seq, role, created_at, body, on_main_path, content_types) VALUES (?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  insConv.run("claude:scope", "claude", "scope", "Project scope rule", now, 1, 0, now);
  insMsg.run("claude:scope:1", "claude:scope", 0, "user", now, "Note to self: never let paid tooling cross paths with a personal project.", 1, '["text"]');

  mock = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const body = await req.json();
      if (req.headers.get("x-api-key") !== "test-key-123") return Response.json({ error: { message: "bad key" } }, { status: 401 });
      const isStanding = String(body.system).startsWith("You compare a current topic");
      const text = isStanding
        ? 'PATTERN: paid tooling crossing into personal work\nSAID: [1] never let paid tooling cross paths with a personal project\nNOW: same crossover concern\n---'
        : "[]"; // expansion path, unused here (--no-expand)
      return Response.json({ model: body.model, stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 8, output_tokens: 4 } });
    },
  });
});
afterAll(() => { mock?.stop(true); rmSync(HOME, { recursive: true, force: true }); });

test("--dry lists recent topics and the retrieval plan, calls nothing", async () => {
  const r = await runCli(["--dry", "--days", "30"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("Project scope rule");
  expect(r.out).toContain("DRY RUN — no model call, nothing written.");
});

test("a real flagged pattern prints its actual name and quoted words, not '(unlabelled)'", async () => {
  const r = await runCli(["--days", "30", "--no-expand"], MOCK_ENV());
  expect(r.code).toBe(0);
  expect(r.out).toContain("⚑ paid tooling crossing into personal work");
  expect(r.out).not.toContain("(unlabelled)");
  expect(r.out).toContain('your words: "Note to self: never let paid tooling cross paths with a personal project."');
  expect(r.out).toContain("same crossover concern");
});

test("--out writes the same report to a file", async () => {
  const outPath = join(HOME, "report.md");
  const r = await runCli(["--days", "30", "--no-expand", "--out", outPath], MOCK_ENV());
  expect(r.code).toBe(0);
  const written = await Bun.file(outPath).text();
  expect(written).toContain("⚑ paid tooling crossing into personal work");
});

test("refuses to run for real from inside an AI coding session; --dry still works", async () => {
  const dry = await runCli(["--dry", "--days", "30"], { ...MOCK_ENV(), CLAUDECODE: "1" });
  expect(dry.code).toBe(0);
  const real = await runCli(["--days", "30"], { ...MOCK_ENV(), CLAUDECODE: "1" });
  expect(real.code).not.toBe(0);
  expect(real.err).toContain("refusing to send your topics to the model from inside an AI coding session");
});
