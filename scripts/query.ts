#!/usr/bin/env bun
// Searches encrypted conversation and file memory indexes.
import type { Database } from "bun:sqlite";
import { StoreError, fail, openStore } from "./lib/db.ts";
import { fmtDate, parseArgs, usage } from "./lib/cli.ts";

const USAGE = 'usage: bun scripts/query.ts "<question>" [--limit N] [--source all|conv|files] [--key-file path]';

interface ConversationRow {
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

interface Hit {
  kind: "conversation" | "file";
  score: number;
  heading: string;
  snippet: string;
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

function ftsQuery(question: string): string {
  return question
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" OR ");
}

function conversationHits(db: Database, terms: string, limit: number): Hit[] {
  try {
    const rows = db.query(
      `SELECT c.provider, c.title, m.role, m.created_at,
              snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet,
              bm25(messages_fts) AS score
       FROM messages_fts
       JOIN messages AS m ON m.rid = messages_fts.rowid
       JOIN conversations AS c ON c.id = m.conversation_id
       WHERE messages_fts MATCH ?
       ORDER BY score
       LIMIT ?`,
    ).all(terms, limit) as ConversationRow[];

    return rows.map((row) => {
      const provider = requireText(row.provider, "conversation provider");
      const role = requireText(row.role, "conversation role");
      const title = row.title === null ? "(untitled)" : requireText(row.title, "conversation title");
      const createdAt = optionalDate(row.created_at);
      return {
        kind: "conversation",
        score: requireScore(row.score),
        heading: `${provider} · ${title} · ${role} · ${fmtDate(createdAt)}`,
        snippet: requireText(row.snippet, "conversation snippet"),
      };
    });
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
      heading: `file · ${requireText(row.path, "file path")}`,
      snippet: requireText(row.snippet, "file snippet"),
    }));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
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

  const terms = ftsQuery(parsed.positional[0]);
  if (!terms) {
    console.log("no matches");
    return;
  }

  const db = openStore({ readonly: true });
  try {
    const hits: Hit[] = [];
    if (source === "all" || source === "conv") hits.push(...conversationHits(db, terms, limit));
    if (source === "all" || source === "files") hits.push(...fileHits(db, terms, limit));
    hits.sort((left, right) => left.score - right.score);

    if (hits.length === 0) {
      console.log("no matches");
      return;
    }

    for (const hit of hits.slice(0, limit)) {
      console.log(`\n── ${hit.heading} · score ${hit.score.toFixed(2)}\n${hit.snippet}`);
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  fail(error);
}
