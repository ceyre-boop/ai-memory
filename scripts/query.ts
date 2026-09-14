#!/usr/bin/env bun
// Searches encrypted conversation and file memory indexes.
// `search()` is the single retrieval path; ask.ts imports it. The CLI below
// only formats its output.
import type { Database } from "bun:sqlite";
import { StoreError, fail, openStore } from "./lib/db.ts";
import { fmtDate, parseArgs, usage } from "./lib/cli.ts";

const USAGE = 'usage: bun scripts/query.ts "<question>" [--limit N] [--source all|conv|files] [--key-file path]';

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

function conversationHits(db: Database, terms: string, limit: number): Hit[] {
  try {
    const rows = db.query(
      `SELECT m.id, c.id AS conversation_id, c.provider, c.title, m.role, m.created_at,
              snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet,
              bm25(messages_fts) AS score
       FROM messages_fts
       JOIN messages AS m ON m.rid = messages_fts.rowid
       JOIN conversations AS c ON c.id = m.conversation_id
       WHERE messages_fts MATCH ?
       ORDER BY score
       LIMIT ?`,
    ).all(terms, limit) as ConversationRow[];

    return rows.map((row) => ({
      kind: "conversation",
      score: requireScore(row.score),
      snippet: requireText(row.snippet, "conversation snippet"),
      id: requireText(row.id, "message id"),
      conversation_id: requireText(row.conversation_id, "conversation id"),
      provider: requireText(row.provider, "conversation provider"),
      title: row.title === null ? null : requireText(row.title, "conversation title"),
      role: requireText(row.role, "conversation role"),
      created_at: optionalDate(row.created_at),
    }));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

function fileHits(db: Database, terms: string, limit: number): Hit[] {
  try {
    const rows = db.query(
      `SELECT path, snippet(chunks, 1, '«', '»', '…', 24) AS snippet, bm25(chunks) AS score
       FROM chunks
       WHERE chunks MATCH ?
       ORDER BY score
       LIMIT ?`,
    ).all(terms, limit) as FileRow[];

    return rows.map((row) => ({
      kind: "file",
      score: requireScore(row.score),
      snippet: requireText(row.snippet, "file snippet"),
      path: requireText(row.path, "file path"),
    }));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

/** Merged full-text search over conversations and collected files, best bm25 first. */
export function search(db: Database, question: string, opts: { limit?: number; source?: Source } = {}): Hit[] {
  const limit = opts.limit ?? 8;
  const source = opts.source ?? "all";
  const terms = ftsQuery(question);
  if (!terms) return [];
  const hits: Hit[] = [];
  if (source === "all" || source === "conv") hits.push(...conversationHits(db, terms, limit));
  if (source === "all" || source === "files") hits.push(...fileHits(db, terms, limit));
  hits.sort((left, right) => left.score - right.score);
  return hits.slice(0, limit);
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

function main(): void {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2), ["help"], ["limit", "source"]);
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
    const hits = search(db, parsed.positional[0], { limit, source });
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
  try {
    main();
  } catch (error) {
    fail(error);
  }
}
