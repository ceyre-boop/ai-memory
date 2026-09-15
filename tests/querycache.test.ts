// The local --more pagination cache. Every test points AI_MEMORY_QUERY_CACHE
// at a disposable temp file — never the real ~/.config/ai-memory/query-cache.json.
// cachePath() inside the module is resolved lazily per call, not frozen at
// module load, so a single import here safely sees each test's own path.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, seenRefs, recordRefs } from "../scripts/lib/querycache";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-memory-qcache-"));
  process.env.AI_MEMORY_QUERY_CACHE = join(dir, "query-cache.json");
});
afterEach(() => {
  delete process.env.AI_MEMORY_QUERY_CACHE;
  rmSync(dir, { recursive: true, force: true });
});

test("seenRefs is [] before anything is recorded, and the cache file doesn't exist yet", () => {
  const key = cacheKey("ask", "some question");
  expect(seenRefs(key)).toEqual([]);
  expect(existsSync(process.env.AI_MEMORY_QUERY_CACHE!)).toBe(false);
});

test("recordRefs then seenRefs round-trips, and writes the file", () => {
  const key = cacheKey("ask", "some question");
  recordRefs(key, ["a", "b"]);
  expect(existsSync(process.env.AI_MEMORY_QUERY_CACHE!)).toBe(true);
  expect(seenRefs(key)).toEqual(["a", "b"]);
});

test("recordRefs accumulates across calls and dedupes", () => {
  const key = cacheKey("ask", "some question");
  recordRefs(key, ["a", "b"]);
  recordRefs(key, ["b", "c"]);
  expect(seenRefs(key)).toEqual(["a", "b", "c"]);
});

test("recordRefs with an empty array is a no-op — never creates the file", () => {
  const key = cacheKey("ask", "some question");
  recordRefs(key, []);
  expect(existsSync(process.env.AI_MEMORY_QUERY_CACHE!)).toBe(false);
  expect(seenRefs(key)).toEqual([]);
});

test("cacheKey namespaces by tool: the same question text under ask vs contradictions never collides", () => {
  const askKey = cacheKey("ask", "shared topic");
  const contraKey = cacheKey("contradictions", "shared topic");
  expect(askKey).not.toBe(contraKey);
  recordRefs(askKey, ["only-for-ask"]);
  expect(seenRefs(contraKey)).toEqual([]);
  expect(seenRefs(askKey)).toEqual(["only-for-ask"]);
});

test("cacheKey is stable for the same text, case/whitespace-insensitive", () => {
  expect(cacheKey("ask", "Widget Plan")).toBe(cacheKey("ask", "  widget plan  "));
  expect(cacheKey("ask", "widget plan")).not.toBe(cacheKey("ask", "gadget plan"));
});

test("a corrupt cache file is treated as empty, not fatal", async () => {
  await Bun.write(process.env.AI_MEMORY_QUERY_CACHE!, "{ not json");
  const key = cacheKey("ask", "anything");
  expect(seenRefs(key)).toEqual([]);
  // and it recovers cleanly on the next write
  recordRefs(key, ["x"]);
  expect(seenRefs(key)).toEqual(["x"]);
});
