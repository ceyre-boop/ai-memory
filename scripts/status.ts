#!/usr/bin/env bun
// Reports encryption state, store counts, and verified pushes.
import { existsSync, statSync } from "node:fs";
import {
  DB_PATH,
  StoreError,
  counts,
  fail,
  isPlaintextSqlite,
  openStore,
  readManifest,
  readMeta,
} from "./lib/db.ts";
import { type ParsedArgs, fmtDate, fmtInt, parseArgs, usage } from "./lib/cli.ts";

const USAGE = "usage: bun scripts/status.ts";

function printLocked(reason: string): void {
  console.log("files: locked");
  console.log("chunks: locked");
  console.log("conversations: locked");
  console.log("messages: locked");
  console.log(`locked: ${reason}`);
}

function printManifest(): void {
  const manifest = readManifest();
  const stats = manifest.stats && Object.keys(manifest.stats).length > 0
    ? Object.entries(manifest.stats).map(([name, value]) => `${name}=${String(value)}`).join(" ")
    : "(none)";
  console.log(`manifest stats: ${stats}`);
  const pushes = manifest.pushes ?? [];
  if (pushes.length === 0) {
    console.log("pushes: (none)");
    return;
  }
  console.log("pushes: last 5 (oldest to newest)");
  for (const push of pushes.slice(-5)) {
    console.log(
      `- ${push.target} · ${fmtDate(Date.parse(push.at))} · files=${fmtInt(push.counts.files)} chunks=${fmtInt(push.counts.chunks)} conversations=${fmtInt(push.counts.conversations)} messages=${fmtInt(push.counts.messages)}`,
    );
  }
}

function main(): void {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2), ["help"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    throw new StoreError(`${USAGE}\n${message}`);
  }
  if (parsed.flags.has("help") || parsed.positional.length > 0 || parsed.opts.size > 0) usage(USAGE);

  console.log(`store: ${DB_PATH}${existsSync(DB_PATH) ? ` (${statSync(DB_PATH).size} bytes)` : " (missing)"}`);
  console.log(`encrypted: ${isPlaintextSqlite(DB_PATH) === false}`);
  const meta = readMeta(DB_PATH);
  if (meta) {
    console.log(
      `meta: cipher=${meta.cipher} compatibility=${meta.cipher_compatibility} kdf_iter=${meta.kdf_iter} page size=${meta.cipher_page_size} created=${meta.created}`,
    );
  } else {
    console.log("meta: (none)");
  }

  try {
    const db = openStore({ readonly: true });
    try {
      const value = counts(db);
      console.log(`files: ${fmtInt(value.files)}`);
      console.log(`chunks: ${fmtInt(value.chunks)}`);
      console.log(`conversations: ${fmtInt(value.conversations)}`);
      console.log(`messages: ${fmtInt(value.messages)}`);
    } finally {
      db.close();
    }
  } catch (error) {
    if (error instanceof StoreError) printLocked(error.message);
    else throw error;
  }
  printManifest();
}

try {
  main();
} catch (error) {
  fail(error);
}
