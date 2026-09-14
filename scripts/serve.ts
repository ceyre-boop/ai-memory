#!/usr/bin/env bun
// Local backend for the ai-memory display (ui/). Serves the static page and a
// small read-only JSON API over the encrypted store. Loopback only.
//
// Usage: bun scripts/serve.ts [--port 3131] [--key-file <path>]
//
// CONSTRAINTS.md: read-only over the store; binds 127.0.0.1; no CORS; the
// passphrase never leaves the process; results come from the user's own
// record or say "no matches". Nothing here fetches or generates anything.
import { join } from "node:path";
import { openStore, counts, fail, ROOT, DB_PATH, readMeta } from "./lib/db";
import { parseArgs, usage } from "./lib/cli";
import type { Database } from "bun:sqlite";

const USAGE = `
usage: bun scripts/serve.ts [--port 3131] [--key-file <path>]

  Serves ui/ and a read-only JSON API over the store on http://127.0.0.1:<port>.
  Needs the passphrase (AI_MEMORY_KEY, --key-file, or prompt).
`;

const UI_DIR = new URL("../ui", import.meta.url).pathname;
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
};
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** FTS5-safe query: each whitespace term becomes a quoted phrase, ORed. */
export function ftsQuery(q: string): string {
  const terms = q.trim().split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`);
  return terms.join(" OR ");
}

const CLUSTER: Record<string, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };

export function buildApi(db: Database) {
  const t0 = Date.now();
  const total = () => counts(db);

  const nodesRecent = db.prepare(`SELECT c.id, c.provider, c.title, c.created_at, c.updated_at, c.message_count, c.thread_inferred,
      (SELECT substr(body, 1, 160) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY seq LIMIT 1) AS first
    FROM conversations c ORDER BY COALESCE(c.updated_at, c.created_at, 0) DESC LIMIT ?`);
  // MATERIALIZED keeps bm25() inside the FTS query; a flattened subquery would
  // hoist it into the aggregate, where SQLite refuses to evaluate it.
  const nodesMatching = db.prepare(`WITH h AS MATERIALIZED (
      SELECT m.conversation_id AS cid, bm25(messages_fts) AS score
      FROM messages_fts JOIN messages m ON m.rid = messages_fts.rowid WHERE messages_fts MATCH ?)
    SELECT c.id, c.provider, c.title, c.created_at, c.updated_at, c.message_count, c.thread_inferred,
      (SELECT substr(body, 1, 160) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY seq LIMIT 1) AS first,
      min(h.score) AS score
    FROM h JOIN conversations c ON c.id = h.cid GROUP BY c.id ORDER BY score LIMIT ?`);
  const convOne = db.prepare("SELECT * FROM conversations WHERE id = ?");
  const convMsgs = db.prepare("SELECT seq, role, created_at, body, parent_id, on_main_path, content_types FROM messages WHERE conversation_id = ? ORDER BY seq");
  const searchMsgs = db.prepare(`SELECT m.id, m.role, m.created_at, c.provider, c.title, c.id AS conversation_id,
      snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet, bm25(messages_fts) AS score
    FROM messages_fts JOIN messages m ON m.rid = messages_fts.rowid JOIN conversations c ON c.id = m.conversation_id
    WHERE messages_fts MATCH ? ORDER BY score LIMIT ?`);
  const searchFiles = db.prepare(`SELECT path, snippet(chunks, 1, '«', '»', '…', 24) AS snippet, bm25(chunks) AS score
    FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT ?`);

  return {
    telemetry() {
      const c = total();
      return {
        status: "ONLINE",
        engine: "ai-memory store (SQLCipher + FTS5)",
        encrypted: true,
        store: DB_PATH.replace(ROOT, "").replace(/^\//, ""),
        cipher: readMeta(DB_PATH)?.cipher_compatibility ?? null,
        counts: c,
        uptime: ((Date.now() - t0) / 1000).toFixed(1),
        timestamp: new Date().toISOString(),
      };
    },
    nodes(q: string | null, limit: number) {
      const rows = (q ? nodesMatching.all(ftsQuery(q), limit) : nodesRecent.all(limit)) as Record<string, unknown>[];
      return rows.map((r) => ({ ...r, cluster: CLUSTER[r.provider as string] ?? r.provider, thread_inferred: !!r.thread_inferred }));
    },
    conversation(id: string) {
      const c = convOne.get(id) as Record<string, unknown> | null;
      if (!c) return null;
      return { ...c, cluster: CLUSTER[c.provider as string] ?? c.provider, thread_inferred: !!c.thread_inferred, messages: convMsgs.all(id) };
    },
    search(q: string, limit: number, source: "all" | "conv" | "files") {
      const fq = ftsQuery(q);
      if (!fq) return { query: q, results: [] };
      const conv = source === "files" ? [] : (searchMsgs.all(fq, limit) as Record<string, unknown>[]).map((r) => ({ kind: "conversation", ...r }));
      const files = source === "conv" ? [] : (searchFiles.all(fq, limit) as Record<string, unknown>[]).map((r) => ({ kind: "file", ...r }));
      const results = [...conv, ...files].sort((a, b) => (a.score as number) - (b.score as number)).slice(0, limit);
      return { query: q, results };
    },
  };
}

export function makeFetch(api: ReturnType<typeof buildApi>) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method !== "GET") return json({ error: "read-only" }, 405);
    const p = url.pathname;
    try {
      if (p === "/api/telemetry") return json(api.telemetry());
      if (p === "/api/nodes") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 32) || 32, 1), 200);
        return json({ nodes: api.nodes(url.searchParams.get("q"), limit) });
      }
      if (p.startsWith("/api/conversation/")) {
        const c = api.conversation(decodeURIComponent(p.slice("/api/conversation/".length)));
        return c ? json(c) : json({ error: "not found" }, 404);
      }
      if (p === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 8) || 8, 1), 50);
        const source = (url.searchParams.get("source") ?? "all") as "all" | "conv" | "files";
        return json(api.search(q, limit, ["all", "conv", "files"].includes(source) ? source : "all"));
      }
      if (p.startsWith("/api/")) return json({ error: "not found" }, 404);
      const file = STATIC[p];
      if (!file) return new Response("not found", { status: 404 });
      const f = Bun.file(join(UI_DIR, file));
      if (!(await f.exists())) return new Response("ui/ missing", { status: 404 });
      return new Response(f, { headers: { "content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" } });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  };
}

if (import.meta.main) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), ["help"], ["port"]);
  } catch (e) {
    usage(`${(e as Error).message}\n${USAGE}`);
  }
  if (args.flags.has("help") || args.positional.length) usage(USAGE);
  const port = Number(args.opts.get("port") ?? 3131);
  if (!(port > 0 && port < 65536)) usage("--port must be 1–65535");
  try {
    const db = openStore({ readonly: true });
    const api = buildApi(db);
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: makeFetch(api) });
    const c = counts(db);
    console.log(`▸ ai-memory display on http://127.0.0.1:${server.port}  (loopback only, read-only)`);
    console.log(`  ${c.conversations.toLocaleString()} conversations · ${c.messages.toLocaleString()} messages · ${c.files.toLocaleString()} files · ${c.chunks.toLocaleString()} chunks`);
    process.on("SIGINT", () => { server.stop(); db.close(); process.exit(0); });
  } catch (e) {
    fail(e);
  }
}
