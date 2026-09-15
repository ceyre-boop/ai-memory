#!/usr/bin/env bun
// Searches encrypted conversation and file memory indexes.
// `search()` is the single retrieval path; ask.ts imports it. The CLI below
// only formats its output.
import type { Database } from "bun:sqlite";
import { StoreError, fail, openStore } from "./lib/db.ts";
import { fmtDate, parseArgs, usage } from "./lib/cli.ts";
import { hasVectors, rrf, vectorSearch } from "./lib/vsearch.ts";

const USAGE = 'usage: bun scripts/query.ts "<question>" [--limit N] [--source all|conv|files] [--keyword] [--key-file path]';

interface ConversationRow {
  id: unknown;
  conversation_id: unknown;
  provider: unknown;
  title: unknown;
  role: unknown;
  created_at: unknown;
  snippet: unknown;
  score: unknown;
}

interface FileRow {
  path: unknown;
  snippet: unknown;
  score: unknown;
}

export interface Hit {
  kind: "conversation" | "file";
  score: number;
  snippet: string;
  /** Stable identity: "<message id>" for conversations, "c:<chunks rowid>" for
   *  files. Re-fetchable later with fetchByRef() — a snippet cited N turns
   *  ago is the same object, not a fresh approximation. */
  ref: string;
  /** General sort date for --oldest/--newest across mixed sources: same value
   *  as created_at for conversations, the file's mtime for files. */
  date: number | null;
  /** conversation hits */
  id?: string;
  conversation_id?: string;
  provider?: string;
  title?: string | null;
  role?: string;
  created_at?: number | null;
  /** file hits */
  path?: string;
}

export type Source = "all" | "conv" | "files";
export type Order = "relevance" | "oldest" | "newest";

export interface SearchOptions {
  limit?: number;
  source?: Source;
  /** unix ms, inclusive */
  since?: number;
  /** unix ms, inclusive */
  until?: number;
  order?: Order;
  /** refs (Hit.ref) to exclude — how --more asks for the next batch */
  exclude?: string[];
}

export interface SearchPage {
  hits: Hit[];
  /** true when more matches existed beyond what was returned — the only
   *  thing the model is told about coverage; never a count. See
   *  GOVERNANCE.md and CONSTRAINTS.md on why a count is deliberately not here. */
  truncated: boolean;
}

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new StoreError(`query returned an invalid ${field}`);
  return value;
}

function requireScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StoreError("query returned an invalid score");
  }
  return value;
}

function optionalDate(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StoreError("query returned an invalid message date");
  }
  return value;
}

// Function words that match everything and rank nothing. Dropped from OR
// queries unless nothing else remains.
const STOPWORDS = new Set(("a an and are as at be but by can did do does for from had has have he her his how i if in is it its " +
  "me my no not of on or our she should so than that the their them then there these they this to us was we were what when " +
  "where which who why will with would you your").split(" "));

/** FTS5-safe query: each whitespace term becomes a quoted phrase, ORed; stopwords dropped when other terms exist. */
export function ftsQuery(question: string): string {
  const all = question.split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter((t) => t.length > 0);
  const kept = all.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  return (kept.length ? kept : all).map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}

interface SubOpts {
  limit: number;
  since?: number;
  until?: number;
  order: Order;
  exclude: string[];
}

function conversationHits(db: Database, terms: string, opts: SubOpts): Hit[] {
  try {
    const needsDate = opts.order !== "relevance" || opts.since !== undefined || opts.until !== undefined;
    const conds = ["messages_fts MATCH ?"];
    const params: unknown[] = [terms];
    if (needsDate) conds.push("m.created_at IS NOT NULL");
    if (opts.since !== undefined) { conds.push("m.created_at >= ?"); params.push(opts.since); }
    if (opts.until !== undefined) { conds.push("m.created_at <= ?"); params.push(opts.until); }
    if (opts.exclude.length) { conds.push(`m.id NOT IN (${opts.exclude.map(() => "?").join(",")})`); params.push(...opts.exclude); }
    const orderSql = opts.order === "oldest" ? "m.created_at ASC" : opts.order === "newest" ? "m.created_at DESC" : "score";
    params.push(opts.limit);
    const rows = db.query(
      `SELECT m.id, c.id AS conversation_id, c.provider, c.title, m.role, m.created_at,
              snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet,
              bm25(messages_fts) AS score
       FROM messages_fts
       JOIN messages AS m ON m.rid = messages_fts.rowid
       JOIN conversations AS c ON c.id = m.conversation_id
       WHERE ${conds.join(" AND ")}
       ORDER BY ${orderSql}
       LIMIT ?`,
    ).all(...params) as ConversationRow[];

    return rows.map((row) => {
      const created_at = optionalDate(row.created_at);
      const id = requireText(row.id, "message id");
      return {
        kind: "conversation" as const,
        score: requireScore(row.score),
        snippet: requireText(row.snippet, "conversation snippet"),
        ref: id,
        date: created_at,
        id,
        conversation_id: requireText(row.conversation_id, "conversation id"),
        provider: requireText(row.provider, "conversation provider"),
        title: row.title === null ? null : requireText(row.title, "conversation title"),
        role: requireText(row.role, "conversation role"),
        created_at,
      };
    });
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

function fileHits(db: Database, terms: string, opts: SubOpts): Hit[] {
  try {
    const conds = ["chunks MATCH ?"];
    const params: unknown[] = [terms];
    const needsDate = opts.order !== "relevance" || opts.since !== undefined || opts.until !== undefined;
    if (needsDate) conds.push("f.mtime IS NOT NULL");
    if (opts.since !== undefined) { conds.push("f.mtime >= ?"); params.push(opts.since); }
    if (opts.until !== undefined) { conds.push("f.mtime <= ?"); params.push(opts.until); }
    if (opts.exclude.length) { conds.push(`('c:' || chunks.rowid) NOT IN (${opts.exclude.map(() => "?").join(",")})`); params.push(...opts.exclude); }
    const orderSql = opts.order === "oldest" ? "f.mtime ASC" : opts.order === "newest" ? "f.mtime DESC" : "score";
    params.push(opts.limit);
    const rows = db.query(
      `SELECT chunks.rowid AS rowid, chunks.path AS path,
              snippet(chunks, 1, '«', '»', '…', 24) AS snippet, bm25(chunks) AS score, f.mtime AS mtime
       FROM chunks LEFT JOIN files AS f ON f.path = chunks.path
       WHERE ${conds.join(" AND ")}
       ORDER BY ${orderSql}
       LIMIT ?`,
    ).all(...params) as (FileRow & { rowid: number; mtime: number | null })[];

    return rows.map((row) => ({
      kind: "file" as const,
      score: requireScore(row.score),
      snippet: requireText(row.snippet, "file snippet"),
      path: requireText(row.path, "file path"),
      ref: `c:${row.rowid}`,
      date: typeof row.mtime === "number" ? row.mtime : null,
    }));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

/** Look up the display rows for vector hits, which carry only ids. */
function hydrate(db: Database, hits: { kind: "message" | "file"; ref_id: number; score: number }[]): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    if (h.kind === "message") {
      const r = db.query(
        `SELECT m.id, c.id AS conversation_id, c.provider, c.title, m.role, m.created_at,
                substr(m.body, 1, 240) AS snippet
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.rid = ?`).get(h.ref_id) as any;
      if (r) {
        const created_at = typeof r.created_at === "number" ? r.created_at : null;
        out.push({ kind: "conversation", score: -h.score, snippet: String(r.snippet ?? ""), ref: String(r.id), date: created_at,
          id: String(r.id), conversation_id: String(r.conversation_id), provider: String(r.provider),
          title: r.title === null ? null : String(r.title), role: String(r.role), created_at });
      }
    } else {
      const r = db.query("SELECT path, substr(body,1,240) AS snippet FROM chunks WHERE rowid = ?")
        .get(h.ref_id) as any;
      if (r) out.push({ kind: "file", score: -h.score, snippet: String(r.snippet ?? ""), path: String(r.path), ref: `c:${h.ref_id}`, date: null });
    }
  }
  return out;
}

const hitKey = (h: Hit): string => h.kind === "conversation" ? `m:${h.id}` : `f:${h.path}:${h.snippet.slice(0,40)}`;

/**
 * Hybrid retrieval: bm25 and vector lists fused by reciprocal rank. Falls back
 * to keyword-only when the store has no vectors, so query works either way.
 */
export async function searchHybrid(
  db: Database, question: string, opts: { limit?: number; source?: Source } = {},
): Promise<Hit[]> {
  const limit = opts.limit ?? 8;
  const source = opts.source ?? "all";
  const keyword = search(db, question, { limit: limit * 4, source });
  if (!hasVectors(db)) return keyword.slice(0, limit);

  const kinds = source === "conv" ? ["message"] as const
              : source === "files" ? ["file"] as const
              : ["message", "file"] as const;
  let vec: Hit[] = [];
  try {
    vec = hydrate(db, await vectorSearch(db, question, { limit: limit * 4, kinds: [...kinds] }));
  } catch { vec = []; }                       // embedder down → keyword still works

  const fused = rrf([keyword, vec], hitKey);
  const byKey = new Map<string, Hit>();
  for (const h of [...keyword, ...vec]) if (!byKey.has(hitKey(h))) byKey.set(hitKey(h), h);
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => byKey.get(k)!)
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * Full-text search over conversations and collected files, with a truncation
 * signal: whether more matches existed beyond the returned batch. Internally
 * over-fetches by one across every active source so the merged pool's true
 * size is known before the final cut — never a match count, just the one bit
 * that tells the caller whether --more has anything to give.
 */
export function searchPage(db: Database, question: string, opts: SearchOptions = {}): SearchPage {
  const limit = opts.limit ?? 8;
  const source = opts.source ?? "all";
  const order = opts.order ?? "relevance";
  const exclude = opts.exclude ?? [];
  const terms = ftsQuery(question);
  if (!terms) return { hits: [], truncated: false };

  const subOpts: SubOpts = { limit: limit + 1, since: opts.since, until: opts.until, order, exclude };
  const hits: Hit[] = [];
  if (source === "all" || source === "conv") hits.push(...conversationHits(db, terms, subOpts));
  if (source === "all" || source === "files") hits.push(...fileHits(db, terms, subOpts));

  if (order === "oldest") hits.sort((a, b) => (a.date ?? Infinity) - (b.date ?? Infinity));
  else if (order === "newest") hits.sort((a, b) => (b.date ?? -Infinity) - (a.date ?? -Infinity));
  else hits.sort((a, b) => a.score - b.score);

  const truncated = hits.length > limit;
  return { hits: hits.slice(0, limit), truncated };
}

/** Merged full-text search over conversations and collected files, best bm25 first. Thin wrapper over searchPage() for callers that don't need the truncation signal. */
export function search(db: Database, question: string, opts: SearchOptions = {}): Hit[] {
  return searchPage(db, question, opts).hits;
}

/**
 * Direct lookup by stable ref — the counterpart to Hit.ref, so a snippet
 * cited earlier can be re-fetched as the same object rather than
 * re-approximated by a fresh search. Returns null if the ref no longer
 * resolves (e.g. the conversation was forgotten).
 */
export function fetchByRef(db: Database, ref: string): Hit | null {
  if (ref.startsWith("c:")) {
    const rowid = Number(ref.slice(2));
    if (!Number.isFinite(rowid)) return null;
    const row = db.query(
      `SELECT chunks.rowid AS rowid, chunks.path AS path, substr(chunks.body, 1, 600) AS snippet, f.mtime AS mtime
       FROM chunks LEFT JOIN files AS f ON f.path = chunks.path
       WHERE chunks.rowid = ?`,
    ).get(rowid) as { rowid: number; path: string; snippet: string; mtime: number | null } | null;
    if (!row) return null;
    return {
      kind: "file", score: 0, snippet: row.snippet ?? "", path: row.path,
      ref: `c:${row.rowid}`, date: typeof row.mtime === "number" ? row.mtime : null,
    };
  }
  const row = db.query(
    `SELECT m.id, c.id AS conversation_id, c.provider, c.title, m.role, m.created_at, substr(m.body, 1, 600) AS snippet
     FROM messages AS m JOIN conversations AS c ON c.id = m.conversation_id
     WHERE m.id = ?`,
  ).get(ref) as { id: string; conversation_id: string; provider: string; title: string | null; role: string; created_at: number | null; snippet: string } | null;
  if (!row) return null;
  return {
    kind: "conversation", score: 0, snippet: row.snippet ?? "", ref: row.id,
    id: row.id, conversation_id: row.conversation_id, provider: row.provider,
    title: row.title, role: row.role, created_at: row.created_at, date: row.created_at,
  };
}

export function heading(hit: Hit): string {
  return hit.kind === "conversation"
    ? `${hit.provider} · ${hit.title ?? "(untitled)"} · ${hit.role} · ${fmtDate(hit.created_at)}`
    : `file · ${hit.path}`;
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2), ["help", "keyword"], ["limit", "source"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    usage(`${USAGE}\n${message}`, 2);
  }

  if (parsed.flags.has("help") || parsed.positional.length !== 1 || parsed.positional[0].trim().length === 0) {
    usage(USAGE);
  }

  const limitOption = parsed.opts.get("limit");
  const limit = limitOption === undefined ? 8 : parsePositiveInteger(limitOption);
  if (limit === null) usage(`${USAGE}\n--limit must be a positive integer`, 2);

  const source = parsed.opts.get("source") ?? "all";
  if (source !== "all" && source !== "conv" && source !== "files") {
    usage(`${USAGE}\n--source must be all, conv, or files`);
  }

  const db = openStore({ readonly: true });
  try {
    const hits = parsed.flags.has("keyword")
      ? search(db, parsed.positional[0], { limit, source })
      : await searchHybrid(db, parsed.positional[0], { limit, source });
    if (hits.length === 0) {
      console.log("no matches");
      return;
    }
    for (const hit of hits) {
      console.log(`\n── ${heading(hit)} · score ${hit.score.toFixed(2)}\n${hit.snippet}`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main().catch(fail);
}
