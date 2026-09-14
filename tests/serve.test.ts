// serve.ts — read-only JSON API over a temp store populated from the fixtures.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FIX = join(REPO, "tests", "fixtures");
const KEY = "serve-passphrase-9!";
let HOME: string;
let proc: ReturnType<typeof Bun.spawn>;
let base: string;

function run(script: string, args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", join(REPO, "scripts", script), ...args],
    env: { ...process.env, AI_MEMORY_HOME: HOME, AI_MEMORY_KEY: KEY },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
}

beforeAll(async () => {
  HOME = mkdtempSync(join(tmpdir(), "ai-memory-serve-"));
  for (const p of ["claude", "chatgpt", "gemini"]) expect(run("ingest.ts", [join(FIX, p)]).exitCode).toBe(0);
  const port = 3900 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn({
    cmd: ["bun", join(REPO, "scripts", "serve.ts"), "--port", String(port)],
    env: { ...process.env, AI_MEMORY_HOME: HOME, AI_MEMORY_KEY: KEY },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
    cwd: REPO,
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + "/api/telemetry")).ok) break; } catch {}
    await Bun.sleep(100);
  }
});
afterAll(() => { proc?.kill(); rmSync(HOME, { recursive: true, force: true }); });

test("telemetry reports the encrypted store and real counts", async () => {
  const d = await (await fetch(base + "/api/telemetry")).json();
  expect(d.status).toBe("ONLINE");
  expect(d.encrypted).toBe(true);
  expect(d.counts.conversations).toBe(6);
  expect(d.counts.messages).toBeGreaterThan(10);
  expect(JSON.stringify(d)).not.toContain(KEY);
});

test("nodes are conversations with provider clusters, newest first", async () => {
  const d = await (await fetch(base + "/api/nodes?limit=32")).json();
  expect(d.nodes.length).toBe(6);
  expect(new Set(d.nodes.map((n: any) => n.cluster))).toEqual(new Set(["ChatGPT", "Claude", "Gemini"]));
  const times = d.nodes.map((n: any) => n.updated_at ?? n.created_at);
  expect([...times].sort((a, b) => b - a)).toEqual(times);
  const gem = d.nodes.find((n: any) => n.provider === "gemini");
  expect(gem.thread_inferred).toBe(true);
  expect(typeof gem.first).toBe("string");
});

test("nodes?q filters to matching conversations", async () => {
  const d = await (await fetch(base + "/api/nodes?q=sourdough")).json();
  expect(d.nodes.length).toBe(1);
  expect(d.nodes[0].title).toBe("Sourdough starter timing");
});

test("conversation detail returns ordered messages with roles and branch flags", async () => {
  const id = "chatgpt:c0ffee00-0000-4000-8000-000000000001";
  const d = await (await fetch(base + "/api/conversation/" + encodeURIComponent(id))).json();
  expect(d.title).toBe("Sourdough starter timing");
  expect(d.messages.map((m: any) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(d.messages.map((m: any) => m.on_main_path)).toEqual([1, 1, 0, 0, 1, 1]);
  expect(d.messages[0].role).toBe("user");
  const nf = await fetch(base + "/api/conversation/nope");
  expect(nf.status).toBe(404);
});

test("search returns ranked hits with snippets and survives FTS operators", async () => {
  const d = await (await fetch(base + "/api/search?q=Denver%20altitude")).json();
  expect(d.results.length).toBeGreaterThan(0);
  expect(d.results[0].kind).toBe("conversation");
  expect(d.results[0].snippet).toContain("«");
  const weird = await fetch(base + '/api/search?q=' + encodeURIComponent('"a:b*'));
  expect(weird.status).toBe(200);
  const none = await (await fetch(base + "/api/search?q=zzqxjv")).json();
  expect(none.results).toEqual([]);
});

test("static ui is served; other paths 404; writes refused", async () => {
  const html = await fetch(base + "/");
  expect(html.status).toBe(200);
  expect(await html.text()).toContain("app.js");
  expect((await fetch(base + "/app.js")).headers.get("content-type")).toContain("javascript");
  expect((await fetch(base + "/../scripts/lib/db.ts")).status).toBe(404);
  expect((await fetch(base + "/api/nope")).status).toBe(404);
  expect((await fetch(base + "/api/search", { method: "POST" })).status).toBe(405);
});

test("no CORS wildcard on responses", async () => {
  const r = await fetch(base + "/api/telemetry");
  expect(r.headers.get("access-control-allow-origin")).toBeNull();
});
