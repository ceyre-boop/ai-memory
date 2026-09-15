// searchPage / fetchByRef — the steerable-retrieval primitives ask.ts and
// contradictions.ts build on. Seeds a small, fully controlled store (known
// dates, known count) so truncation, exclude, since/until, and ordering are
// each provable rather than inferred from real data.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { searchPage, fetchByRef } from "../scripts/query";

const KEY = "query-test-passphrase-3!";
let HOME: string;
let db: Database;

const DAY = (n: number) => Date.parse(`2026-01-${String(n).padStart(2, "0")}`);

beforeAll(async () => {
  HOME = mkdtempSync(join(tmpdir(), "ai-memory-query-"));
  mkdirSync(join(HOME, "embeddings"), { recursive: true });
  const { openStore } = await import("../scripts/lib/db");
  db = openStore({ path: join(HOME, "embeddings", "index.db"), key: KEY, create: true });

  const insConv = db.prepare(`INSERT INTO conversations (id, provider, source_id, title, created_at, message_count, thread_inferred, imported_at) VALUES (?,?,?,?,?,?,?,?)`);
  const insMsg = db.prepare(`INSERT INTO messages (id, conversation_id, seq, role, created_at, body, on_main_path, content_types) VALUES (?,?,?,?,?,?,?,?)`);
  insConv.run("claude:widgets", "claude", "widgets", "Widget planning", DAY(1), 5, 0, Date.now());
  // Five messages, one per day, all matching "widget" — a fully known set to
  // page and bound against.
  for (let i = 1; i <= 5; i++) {
    insMsg.run(`claude:widgets:${i}`, "claude:widgets", i, "user", DAY(i), `Widget note number ${i} for the day-${i} batch`, 1, '["text"]');
  }

  // Two file chunks matching "gadget", for source=files and fetchByRef("c:...").
  db.run(`INSERT INTO files (hash, path, name, ext, bytes, mtime, kind, indexed) VALUES (?,?,?,?,?,?,?,?)`,
    ["h1", "/notes/gadget-a.md", "gadget-a.md", ".md", 100, DAY(2), "text", 1]);
  db.run(`INSERT INTO files (hash, path, name, ext, bytes, mtime, kind, indexed) VALUES (?,?,?,?,?,?,?,?)`,
    ["h2", "/notes/gadget-b.md", "gadget-b.md", ".md", 100, DAY(4), "text", 1]);
  db.run(`INSERT INTO chunks (path, body) VALUES (?, ?)`, ["/notes/gadget-a.md", "Gadget spec draft one"]);
  db.run(`INSERT INTO chunks (path, body) VALUES (?, ?)`, ["/notes/gadget-b.md", "Gadget spec draft two"]);
});
afterAll(() => { db?.close(); rmSync(HOME, { recursive: true, force: true }); });

test("truncated is true when more matches exist beyond k, false when the batch covers everything", () => {
  const page1 = searchPage(db, "widget", { limit: 3, source: "conv" });
  expect(page1.hits.length).toBe(3);
  expect(page1.truncated).toBe(true);

  const page2 = searchPage(db, "widget", { limit: 10, source: "conv" });
  expect(page2.hits.length).toBe(5);
  expect(page2.truncated).toBe(false);
});

test("every hit carries a stable ref, distinct per snippet", () => {
  const page = searchPage(db, "widget", { limit: 5, source: "conv" });
  const refs = page.hits.map((h) => h.ref);
  expect(new Set(refs).size).toBe(5);
  expect(refs.every((r) => typeof r === "string" && r.length > 0)).toBe(true);
});

test("--more semantics: exclude already-seen refs returns a disjoint next batch, eventually exhausting", () => {
  const page1 = searchPage(db, "widget", { limit: 2, source: "conv" });
  expect(page1.hits.length).toBe(2);
  expect(page1.truncated).toBe(true);

  const page2 = searchPage(db, "widget", { limit: 2, source: "conv", exclude: page1.hits.map((h) => h.ref) });
  expect(page2.hits.length).toBe(2);
  expect(page2.truncated).toBe(true); // one more (#5) still exists
  const overlap = page2.hits.filter((h) => page1.hits.some((p) => p.ref === h.ref));
  expect(overlap).toEqual([]);

  const page3 = searchPage(db, "widget", { limit: 2, source: "conv", exclude: [...page1.hits, ...page2.hits].map((h) => h.ref) });
  expect(page3.hits.length).toBe(1); // the last one
  expect(page3.truncated).toBe(false); // nothing left beyond it
});

test("--since / --until bound the window; both together narrow further", () => {
  const since = searchPage(db, "widget", { limit: 10, source: "conv", since: DAY(3) });
  expect(since.hits.map((h) => h.date).sort()).toEqual([DAY(3), DAY(4), DAY(5)]);

  const until = searchPage(db, "widget", { limit: 10, source: "conv", until: DAY(2) });
  expect(until.hits.map((h) => h.date).sort()).toEqual([DAY(1), DAY(2)]);

  const both = searchPage(db, "widget", { limit: 10, source: "conv", since: DAY(2), until: DAY(4) });
  expect(both.hits.map((h) => h.date).sort()).toEqual([DAY(2), DAY(3), DAY(4)]);
});

test("--oldest / --newest reorder by date and select the actual oldest/newest k, not just re-sort the relevance top-k", () => {
  const oldest = searchPage(db, "widget", { limit: 2, source: "conv", order: "oldest" });
  expect(oldest.hits.map((h) => h.date)).toEqual([DAY(1), DAY(2)]);
  expect(oldest.truncated).toBe(true);

  const newest = searchPage(db, "widget", { limit: 2, source: "conv", order: "newest" });
  expect(newest.hits.map((h) => h.date)).toEqual([DAY(5), DAY(4)]);
  expect(newest.truncated).toBe(true);
});

test("file source: hits carry a c: ref, date comes from files.mtime, and truncation works the same way", () => {
  const page = searchPage(db, "gadget", { limit: 1, source: "files" });
  expect(page.hits.length).toBe(1);
  expect(page.truncated).toBe(true);
  expect(page.hits[0].ref.startsWith("c:")).toBe(true);
  expect(typeof page.hits[0].date).toBe("number");

  const both = searchPage(db, "gadget", { limit: 10, source: "files" });
  expect(both.hits.length).toBe(2);
  expect(both.truncated).toBe(false);
});

test("source=all: truncation reflects the merged pool across conv+files, not either source alone", () => {
  // 5 conv "widget" hits + 0 "widget" file hits; limit 5 exactly covers conv,
  // so merged truncation should be false here.
  const exact = searchPage(db, "widget", { limit: 5, source: "all" });
  expect(exact.truncated).toBe(false);
  expect(exact.hits.length).toBe(5);
});

test("no matches: empty hits, never truncated", () => {
  const page = searchPage(db, "xyzzy-nonexistent-term-9182", { limit: 5 });
  expect(page.hits).toEqual([]);
  expect(page.truncated).toBe(false);
});

test("fetchByRef re-fetches the exact same conversation and file snippets by ref", () => {
  const page = searchPage(db, "widget", { limit: 1, source: "conv" });
  const ref = page.hits[0].ref;
  const fetched = fetchByRef(db, ref);
  expect(fetched?.ref).toBe(ref);
  expect(fetched?.kind).toBe("conversation");
  expect(fetched?.title).toBe("Widget planning");

  const filePage = searchPage(db, "gadget", { limit: 1, source: "files" });
  const fileRef = filePage.hits[0].ref;
  const fetchedFile = fetchByRef(db, fileRef);
  expect(fetchedFile?.ref).toBe(fileRef);
  expect(fetchedFile?.kind).toBe("file");
  expect(fetchedFile?.path).toBe(filePage.hits[0].path);
});

test("fetchByRef returns null for a ref that doesn't resolve", () => {
  expect(fetchByRef(db, "claude:widgets:does-not-exist")).toBeNull();
  expect(fetchByRef(db, "c:999999")).toBeNull();
});

test("search() (the backward-compatible wrapper) still returns a plain Hit[] with no truncation info", async () => {
  const { search } = await import("../scripts/query");
  const hits = search(db, "widget", { limit: 2, source: "conv" });
  expect(Array.isArray(hits)).toBe(true);
  expect(hits.length).toBe(2);
  expect((hits as any).truncated).toBeUndefined();
});
