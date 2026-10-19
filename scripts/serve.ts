#!/usr/bin/env bun
// Local backend for the ai-memory display (ui/). Serves the static page and a
// small read-only JSON API over the encrypted store. Loopback only.
//
// Usage: bun scripts/serve.ts [--port 3131] [--key-file <path>]
//
// CONSTRAINTS.md: read-only over the store; binds 127.0.0.1; no CORS; the
// passphrase never leaves the process; results come from the user's own
// record or say "no matches". The one generative route is POST /api/ghostwrite
// (item 10) — it drafts from SOUL + retrieval through lib/ask.ts, opens no new
// socket, and refuses when the server was started inside an AI coding session.
// POST /api/ask is the same one-question act as `ask.ts`: retrieve, answer from the
// snippets only, cite them. Pull-only; it drafts nothing and delivers nothing.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { openStore, counts, fail, ROOT, DB_PATH, readMeta, StoreError } from "./lib/db";
import { parseArgs, usage } from "./lib/cli";
import { complete, ask } from "./lib/ask";
import { loadRegistry, buildActionsMessage, parseActions, ACTIONS_SYSTEM_PROMPT, type Action } from "./lib/actions";
import { buildSystem, buildUser, requireHumanOperator } from "./lib/ghostwrite";
import type { Database } from "bun:sqlite";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const USAGE = `
usage: bun scripts/serve.ts [--port 3131] [--key-file <path>] [--remote]

  Serves ui/ and a read-only JSON API over the store on http://127.0.0.1:<port>.
  Needs the passphrase (AI_MEMORY_KEY, --key-file, or prompt).

  --remote  Gate every /api request behind a bearer token so the loopback port
            can be exposed through a tunnel (see ops/remote.sh). Requires
            AI_MEMORY_WEB_TOKEN; refuses to start without it. The server still
            binds 127.0.0.1 — the tunnel, not the server, does the exposing.
`;

const UI_DIR = fileURLToPath(new URL("../ui", import.meta.url));
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

import { search, ftsQuery, heading } from "./query";

const CLUSTER: Record<string, string> = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };

export function buildApi(db: Database) {
  const t0 = Date.now();
  // The store is read-only for this process, so counts only change when
  // another process writes; refresh every 10 min. (counts() itself is cheap
  // now — it reads FTS5's docsize table, not the content — but on a slow
  // card even cheap reads add up under a 3 s telemetry poll.)
  let cached: { at: number; c: ReturnType<typeof counts> } | null = null;
  const total = () => {
    if (!cached || Date.now() - cached.at > 600_000) cached = { at: Date.now(), c: counts(db) };
    return cached.c;
  };

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
    /** One retrieval path for the whole product: query.ts search(). */
    search(q: string, limit: number, source: "all" | "conv" | "files") {
      return { query: q, results: search(db, q, { limit, source }) };
    },
    /** The remote surface of `ask.ts` for the phone: one message, answered only from
     *  retrieved snippets (no hits → no answer call, "Not in your record."), plus
     *  validated actions[] the phone dispatches. Nothing here executes an action. */
    async ask(message: string, k: number) {
      const registry = loadRegistry();
      const hits = search(db, message, { limit: k });
      const r = hits.length ? await ask(message, hits) : null;
      let actions: Action[] = [];
      try { actions = parseActions(await complete(ACTIONS_SYSTEM_PROMPT, buildActionsMessage(message, registry), 512), registry); } catch { /* no actions on planner failure */ }
      return {
        reply: r ? r.answer : "Not in your record.",
        actions,
        grounded: hits.length,
        sources: hits.map((h, i) => ({ n: i + 1, heading: heading(h) })),
      };
    },
    /** The browser surface of `ghostwrite` (CONSTRAINTS.md item 10). Reads the
     *  store and SOUL.md, assembles the shared prompt, and drafts through the
     *  one outbound path. Refuses when the server process was started inside an
     *  AI coding session — a draft comes only from a server the operator ran at
     *  their own terminal. It drafts; it never delivers. */
    async ghostwrite(topic: string, k: number) {
      requireHumanOperator(false);
      const soulPath = join(REPO, "SOUL.md");
      if (!existsSync(soulPath))
        throw new StoreError(`no SOUL profile at ${soulPath} — build SOUL.md from your corpus first.`);
      const soul = readFileSync(soulPath, "utf8");
      const hits = search(db, topic, { limit: k });
      const draft = await complete(buildSystem(soul), buildUser(topic, hits), 2048);
      return {
        draft,
        grounded: hits.length,
        soul_chars: soul.length,
        snippets: hits.map((h, i) => ({ n: i + 1, heading: heading(h), score: Number(h.score.toFixed(2)) })),
      };
    },
  };
}

/** Constant-time bearer-token check. No token configured → every request passes
 *  (plain loopback mode). A token configured → /api requires `Authorization:
 *  Bearer <token>`; static files are always served so the page can ask for it. */
export function makeAuthed(token: string) {
  const want = Buffer.from(token);
  return (req: Request): boolean => {
    if (!token) return true;
    const h = req.headers.get("authorization") ?? "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    const got = Buffer.from(m[1]);
    return got.length === want.length && timingSafeEqual(got, want);
  };
}

export function makeFetch(api: ReturnType<typeof buildApi>, token = "") {
  const authed = makeAuthed(token);
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;
    const isGhost = p === "/api/ghostwrite";
    const isAsk = p === "/api/ask";
    // Read-only everywhere except the one generative route, which takes POST.
    if (req.method !== "GET" && !(req.method === "POST" && (isGhost || isAsk)))
      return json({ error: "read-only" }, 405);
    try {
      if (p.startsWith("/api/") && !authed(req)) return json({ error: "unauthorized" }, 401);
      if (isGhost) {
        if (req.method !== "POST") return json({ error: "use POST" }, 405);
        let body: { topic?: unknown; k?: unknown } = {};
        try { body = (await req.json()) as typeof body; } catch { /* empty / bad JSON → topic required */ }
        const topic = typeof body.topic === "string" ? body.topic.trim() : "";
        if (!topic) return json({ error: "topic required" }, 400);
        const k = Math.min(Math.max(Number(body.k ?? 8) || 8, 1), 50);
        try {
          return json(await api.ghostwrite(topic, k));
        } catch (e) {
          const msg = (e as Error).message;
          // The CLAUDECODE human-act guard is a deliberate refusal (403), not a 500.
          return json({ error: msg }, msg.includes("AI coding session") ? 403 : 500);
        }
      }
      if (isAsk) {
        if (req.method !== "POST") return json({ error: "use POST" }, 405);
        let body: { message?: unknown; question?: unknown; image_b64?: unknown; k?: unknown } = {};
        try { body = (await req.json()) as typeof body; } catch { /* empty / bad JSON → question required */ }
        const raw = body.message ?? body.question;
        const question = typeof raw === "string" ? raw.trim() : "";
        if (!question) return json({ error: "message required" }, 400);
        const k = Math.min(Math.max(Number(body.k ?? 8) || 8, 1), 50);
        return json({ ...(await api.ask(question, k)), ...(body.image_b64 ? { image: "ignored: no vision path in this server" } : {}) });
      }
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
    args = parseArgs(process.argv.slice(2), ["help", "remote"], ["port"]);
  } catch (e) {
    usage(`${(e as Error).message}\n${USAGE}`);
  }
  if (args.flags.has("help") || args.positional.length) usage(USAGE);
  const port = Number(args.opts.get("port") ?? 3131);
  if (!(port > 0 && port < 65536)) usage("--port must be 1–65535");
  const remote = args.flags.has("remote");
  const token = process.env.AI_MEMORY_WEB_TOKEN ?? "";
  if (remote && !token)
    usage("--remote needs a token: set AI_MEMORY_WEB_TOKEN so /api is gated before you tunnel to it.");
  try {
    const db = openStore({ readonly: true });
    const api = buildApi(db);
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: makeFetch(api, token) });
    const c = api.telemetry().counts; // warms the count cache before the first page load
    const mode = token ? "token-gated for tunnel use" : "loopback only, read-only";
    console.log(`▸ ai-memory display on http://127.0.0.1:${server.port}  (${mode})`);
    console.log(`  ${c.conversations.toLocaleString()} conversations · ${c.messages.toLocaleString()} messages · ${c.files.toLocaleString()} files · ${c.chunks.toLocaleString()} chunks`);
    process.on("SIGINT", () => { server.stop(); db.close(); process.exit(0); });
  } catch (e) {
    fail(e);
  }
}
