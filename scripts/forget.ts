#!/usr/bin/env bun
// Deletes selected conversations and their searchable messages.
import type { Database } from "bun:sqlite";
import { StoreError, fail, openStore } from "./lib/db.ts";
import { fmtInt, parseArgs, usage } from "./lib/cli.ts";

const USAGE = "usage: bun scripts/forget.ts <conversation-id> | --provider <provider> [--dry] [--key-file path]";

interface ConversationRow {
  id: unknown;
  provider: unknown;
  title: unknown;
  messages: unknown;
}

interface ConversationTarget {
  id: string;
  provider: string;
  title: string;
  messages: number;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new StoreError(`forget query returned an invalid ${field}`);
  return value;
}

function requireCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StoreError("forget query returned an invalid message count");
  }
  return value;
}

function targetsFor(db: Database, field: "id" | "provider", value: string): ConversationTarget[] {
  const rows = db.query(
    `SELECT c.id, c.provider, c.title, count(m.rid) AS messages
     FROM conversations AS c
     LEFT JOIN messages AS m ON m.conversation_id = c.id
     WHERE c.${field} = ?
     GROUP BY c.id, c.provider, c.title
     ORDER BY c.id`,
  ).all(value) as ConversationRow[];

  return rows.map((row) => ({
    id: requireText(row.id, "conversation id"),
    provider: requireText(row.provider, "provider"),
    title: row.title === null ? "(untitled)" : requireText(row.title, "title"),
    messages: requireCount(row.messages),
  }));
}

function printTargets(targets: ConversationTarget[]): number {
  let messageTotal = 0;
  for (const target of targets) {
    console.log(`${target.id} · ${target.provider} · ${target.title} · ${fmtInt(target.messages)} messages`);
    messageTotal += target.messages;
  }
  console.log(`total: ${fmtInt(targets.length)} conversations · ${fmtInt(messageTotal)} messages`);
  return messageTotal;
}

function deleteTargets(db: Database, ids: string[]): void {
  const placeholders = ids.map(() => "?").join(", ");
  const removeMessages = db.query(`DELETE FROM messages WHERE conversation_id IN (${placeholders})`);
  const removeConversations = db.query(`DELETE FROM conversations WHERE id IN (${placeholders})`);
  db.transaction(() => {
    removeMessages.run(...ids);
    removeConversations.run(...ids);
  })();
}

function main(): void {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2), ["dry", "help"], ["provider"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    usage(`${USAGE}\n${message}`);
  }

  const provider = parsed.opts.get("provider");
  const conversationId = parsed.positional.length === 1 ? parsed.positional[0] : undefined;
  if (
    parsed.flags.has("help") ||
    parsed.positional.length > 1 ||
    (conversationId === undefined && provider === undefined) ||
    (conversationId !== undefined && provider !== undefined) ||
    (conversationId !== undefined && conversationId.length === 0) ||
    (provider !== undefined && provider.length === 0)
  ) {
    usage(USAGE);
  }

  const selectorField = conversationId === undefined ? "provider" : "id";
  const selectorValue = conversationId ?? (provider as string);
  const db = openStore();
  try {
    const targets = targetsFor(db, selectorField, selectorValue);
    if (targets.length === 0) {
      throw new StoreError(
        selectorField === "id"
          ? `no conversation found with id ${selectorValue}`
          : `no conversations found for provider ${selectorValue}`,
      );
    }

    const messageTotal = printTargets(targets);
    if (parsed.flags.has("dry")) {
      console.log("DRY RUN — nothing deleted");
      return;
    }

    deleteTargets(db, targets.map((target) => target.id));
    console.log(`✓ deleted ${fmtInt(targets.length)} conversations · ${fmtInt(messageTotal)} messages`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  fail(error);
}
