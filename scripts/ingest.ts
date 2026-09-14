#!/usr/bin/env bun
// Export ingester — the on-ramp. Takes the archive a provider gave the user
// (ChatGPT, Claude, Gemini Takeout) and lands its conversations in the
// encrypted store with timestamps, thread boundaries, and roles intact.
//
// Usage: bun scripts/ingest.ts <export.zip|dir|file> [--provider chatgpt|claude|gemini]
//        [--dry] [--include-thinking] [--gap-minutes 30] [--key-file <path>]
//
// CONSTRAINTS.md: the user supplies the file (never fetched); zip entries are
// streamed with `unzip -p` (no plaintext extraction); account-identity files
// are never read; --dry needs no key and writes nothing.
import { readdirSync, statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { openStore, fail, StoreError, readManifest, writeManifest, counts } from "./lib/db";
import { parseArgs, usage, fmtInt } from "./lib/cli";
import { PROVIDERS, type Provider, type ParseResult, type ParseOptions } from "./lib/parsers/types";
import { parseChatGPT, looksLikeChatGPT } from "./lib/parsers/chatgpt";
import { parseClaude, looksLikeClaude } from "./lib/parsers/claude";
import { parseGemini, looksLikeGemini } from "./lib/parsers/gemini";

const USAGE = `
usage: bun scripts/ingest.ts <export.zip|dir|file> [--provider chatgpt|claude|gemini]
                             [--dry] [--include-thinking] [--gap-minutes 30] [--key-file <path>]

  You download the export; this reads it. Nothing is fetched.
  --dry              parse and report; write nothing, no passphrase needed
  --include-thinking keep model reasoning blocks in message bodies
  --gap-minutes N    Gemini only: minutes of silence that start a new inferred thread (default 30)
`;

// files we recognise but deliberately do not read
const SKIP_REASON: Record<string, string> = {
  "users.json": "account identity — never stored",
  "user.json": "account identity — never stored",
  "memories.json": "provider-side memory summary — not a conversation",
  "projects.json": "project documents — not ingested in this pass",
  "message_feedback.json": "thumbs-up/down metadata — not a conversation",
  "shared_conversations.json": "share-link metadata — not a conversation",
  "chat.html": "HTML rendering — conversations.json is the source",
  "model_comparisons.json": "A/B metadata — not a conversation",
  "MyActivity.html": "HTML Takeout — re-export as JSON",
};
const CONV_NAMES = new Set(["conversations.json", "MyActivity.json"]);
const HTML_ONLY = "this Takeout is HTML only — re-export as JSON (Takeout → Gemini Apps → format JSON)";

interface Source {
  /** what the user passed */
  label: string;
  /** conversations.json / MyActivity.json text */
  text: string;
  entry: string;
  skipped: { name: string; reason: string }[];
}

// ── locating the conversations file ────────────────────────────────────────

function pickEntry(entries: string[], strip = 0): { pick: string | null; skipped: Source["skipped"] } {
  const skipped: Source["skipped"] = [];
  let pick: string | null = null;
  for (const e of entries) {
    const name = basename(e);
    if (CONV_NAMES.has(name)) {
      if (name === "MyActivity.json" && !e.includes("Gemini Apps")) continue;
      if (!pick || e.length < pick.length) pick = e;
    } else if (SKIP_REASON[name]) skipped.push({ name: e.slice(strip), reason: SKIP_REASON[name] });
  }
  return { pick, skipped };
}

async function readZip(zip: string): Promise<Source> {
  const which = Bun.spawnSync(["sh", "-c", "command -v unzip"]);
  if (which.exitCode !== 0) {
    throw new StoreError("`unzip` not found — extract the archive yourself and pass the folder instead");
  }
  const list = Bun.spawnSync(["unzip", "-Z1", zip]);
  if (list.exitCode !== 0) throw new StoreError(`cannot list ${zip}: ${list.stderr.toString().trim()}`);
  const entries = list.stdout.toString().split("\n").filter(Boolean);
  const { pick, skipped } = pickEntry(entries);
  if (!pick) {
    if (skipped.some((s) => s.name.endsWith("MyActivity.html"))) throw new StoreError(HTML_ONLY);
    throw new StoreError(`no conversations.json or Gemini MyActivity.json inside ${zip}`);
  }
  // stream the one entry we need straight into memory — nothing is extracted to disk
  const proc = Bun.spawn(["unzip", "-p", zip, pick], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new StoreError(`unzip failed on ${pick}`);
  return { label: basename(zip), text, entry: pick, skipped };
}

function walk(dir: string, depth: number, acc: string[]) {
  if (depth > 6) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1, acc);
    else acc.push(p);
  }
}

async function readDir(dir: string): Promise<Source> {
  const files: string[] = [];
  walk(dir, 0, files);
  const { pick, skipped } = pickEntry(files, dir.length + 1);
  if (existsSync(join(dir, "projects")) && statSync(join(dir, "projects")).isDirectory())
    skipped.push({ name: "projects/", reason: "project documents — not ingested in this pass" });
  if (!pick) {
    if (skipped.some((s) => s.name.endsWith("MyActivity.html"))) throw new StoreError(HTML_ONLY);
    throw new StoreError(`no conversations.json or Gemini MyActivity.json under ${dir}`);
  }
  return { label: basename(dir), text: await Bun.file(pick).text(), entry: pick.slice(dir.length + 1), skipped };
}

async function readSource(path: string): Promise<Source> {
  if (!existsSync(path)) throw new StoreError(`${path} does not exist`);
  const st = statSync(path);
  if (st.isDirectory()) return readDir(path);
  if (path.toLowerCase().endsWith(".zip")) return readZip(path);
  if (basename(path) === "MyActivity.html") throw new StoreError(HTML_ONLY);
  return { label: basename(path), text: await Bun.file(path).text(), entry: basename(path), skipped: [] };
}

// ── provider detection ─────────────────────────────────────────────────────

function detect(data: unknown): Provider | null {
  if (looksLikeChatGPT(data)) return "chatgpt";
  if (looksLikeClaude(data)) return "claude";
  if (looksLikeGemini(data)) return "gemini";
  return null;
}

function parse(provider: Provider, data: unknown, opts: ParseOptions): ParseResult {
  switch (provider) {
    case "chatgpt": return parseChatGPT(data, opts);
    case "claude": return parseClaude(data, opts);
    case "gemini": return parseGemini(data, opts);
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), ["dry", "include-thinking", "help"], ["provider", "gap-minutes"]);
  } catch (e) {
    usage(`${(e as Error).message}\n${USAGE}`);
  }
  if (args.flags.has("help") || args.positional.length !== 1) usage(USAGE);
  const DRY = args.flags.has("dry");
  const providerArg = args.opts.get("provider");
  if (providerArg && !PROVIDERS.includes(providerArg as Provider))
    usage(`unknown provider ${providerArg}; supported: ${PROVIDERS.join(", ")}`);
  const opts: ParseOptions = {
    includeThinking: args.flags.has("include-thinking"),
    gapMinutes: args.opts.has("gap-minutes") ? Number(args.opts.get("gap-minutes")) : undefined,
  };
  if (opts.gapMinutes !== undefined && !(opts.gapMinutes > 0)) usage("--gap-minutes must be a positive number");

  const src = await readSource(args.positional[0]);
  let data: unknown;
  try {
    data = JSON.parse(src.text);
  } catch {
    throw new StoreError(`${src.entry} is not valid JSON`);
  }
  const provider = (providerArg as Provider | undefined) ?? detect(data);
  if (!provider) {
    throw new StoreError(
      `could not recognise ${src.entry} as a ChatGPT, Claude, or Gemini export (supported: ${PROVIDERS.join(", ")}); ` +
        "pass --provider to force one",
    );
  }
  const exportHash = Bun.hash(src.text).toString(16);
  const result = parse(provider, data, opts);

  // summary
  const byRole: Record<string, number> = {};
  let total = 0, inferred = 0;
  for (const c of result.conversations) {
    if (c.threadInferred) inferred++;
    for (const m of c.messages) { byRole[m.role] = (byRole[m.role] ?? 0) + 1; total++; }
  }
  console.log(`▸ ${src.label} → ${src.entry}  (provider: ${provider})`);
  console.log(`  ${fmtInt(result.conversations.length)} conversations · ${fmtInt(total)} messages` +
    Object.entries(byRole).map(([r, n]) => ` · ${r} ${fmtInt(n)}`).join(""));
  if (inferred) console.log(`  ${fmtInt(inferred)} threads inferred (no thread id in this export)`);
  if (result.emptySkipped) console.log(`  ${fmtInt(result.emptySkipped)} empty messages skipped`);
  for (const n of result.notes) console.log(`  · ${n}`);
  for (const s of src.skipped) console.log(`  skipped ${s.name} (${s.reason})`);

  if (DRY) {
    console.log("\nDRY RUN — nothing written");
    return;
  }

  const db = openStore({ create: true });
  const before = counts(db);
  const upsertConv = db.prepare(`INSERT INTO conversations
    (id, provider, source_id, title, created_at, updated_at, message_count, thread_inferred, export_file, export_hash, imported_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, created_at=excluded.created_at, updated_at=excluded.updated_at,
      message_count=excluded.message_count, thread_inferred=excluded.thread_inferred, export_file=excluded.export_file,
      export_hash=excluded.export_hash, imported_at=excluded.imported_at`);
  const delMsgs = db.prepare("DELETE FROM messages WHERE conversation_id = ?");
  const insMsg = db.prepare(`INSERT INTO messages
    (id, conversation_id, seq, role, created_at, body, parent_id, on_main_path, content_types)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  let replaced = 0;
  const existing = new Set((db.query("SELECT id FROM conversations WHERE provider = ?").all(provider) as { id: string }[]).map((r) => r.id));

  const tx = db.transaction(() => {
    for (const c of result.conversations) {
      const cid = `${provider}:${c.sourceId}`;
      if (existing.has(cid)) replaced++;
      delMsgs.run(cid);
      upsertConv.run(cid, provider, c.sourceId, c.title, c.createdAt, c.updatedAt, c.messages.length,
        c.threadInferred ? 1 : 0, src.label, exportHash, now);
      for (const m of c.messages) {
        insMsg.run(`${provider}:${c.sourceId}:${m.id}`, cid, m.seq, m.role, m.createdAt, m.body,
          m.parentId, m.onMainPath ? 1 : 0, JSON.stringify(m.contentTypes));
      }
    }
  });
  tx();
  const after = counts(db);
  db.close();

  const m = readManifest();
  m.stats = { ...(m.stats ?? {}), conversations: after.conversations, messages: after.messages,
    files: after.files, chunks: after.chunks, last_ingest: new Date(now).toISOString() };
  await writeManifest(m);

  console.log(`\n✓ stored ${fmtInt(result.conversations.length)} conversations (${fmtInt(replaced)} replaced)` +
    ` · store now ${fmtInt(after.conversations)} conversations · ${fmtInt(after.messages)} messages` +
    ` (+${fmtInt(after.messages - before.messages)})`);
}

main().catch(fail);
