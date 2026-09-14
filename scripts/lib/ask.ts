// The only outbound network code in ai-memory. See CONSTRAINTS.md → "ask".
// Sends the user's question plus the matching snippets to the Messages API
// (raw HTTP; this repo has no package dependencies by mandate) and returns an
// answer grounded in those snippets. No key → no call.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

/** Load ANTHROPIC_API_KEY (and friends) from <repo>/.env if not already in env. Never logs values. */
export function loadDotEnv(file = join(REPO, ".env")) {
  if (process.env.AI_MEMORY_NO_DOTENV === "1" || !existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

export type Provider = "claude-cli" | "api";
export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_EXPAND_MODEL = "claude-haiku-4-5";
// The claude CLI takes aliases; these bill to the signed-in subscription.
export const DEFAULT_CLI_MODEL = "opus";
export const DEFAULT_CLI_EXPAND_MODEL = "haiku";
export const DEFAULT_URL = "https://api.anthropic.com/v1/messages";

function cliBinary(): string | null {
  const explicit = process.env.AI_MEMORY_CLAUDE_BIN;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const r = Bun.spawnSync(["sh", "-c", "command -v claude"], { stdout: "pipe", stderr: "ignore" });
  const p = r.stdout.toString().trim();
  return r.exitCode === 0 && p ? p : null;
}

/**
 * Two ways out: `claude-cli` (default) shells out to the signed-in Claude Code
 * CLI, so the call bills to the user's own subscription; `api` uses the
 * Messages API with ANTHROPIC_API_KEY. Set AI_MEMORY_PROVIDER to choose.
 */
export function modelConfig() {
  loadDotEnv();
  const provider = ((process.env.AI_MEMORY_PROVIDER || "claude-cli").toLowerCase() === "api" ? "api" : "claude-cli") as Provider;
  const key = process.env.ANTHROPIC_API_KEY;
  const bin = provider === "claude-cli" ? cliBinary() : null;
  return {
    provider,
    configured: provider === "api" ? !!key : !!bin,
    key,
    bin,
    model: process.env.AI_MEMORY_MODEL || (provider === "api" ? DEFAULT_MODEL : DEFAULT_CLI_MODEL),
    expandModel: process.env.AI_MEMORY_EXPAND_MODEL || (provider === "api" ? DEFAULT_EXPAND_MODEL : DEFAULT_CLI_EXPAND_MODEL),
    url: process.env.AI_MEMORY_MODEL_URL || DEFAULT_URL,
    label: provider === "api" ? "Messages API" : "claude CLI (subscription)",
  };
}

/** One retrieval hit, as produced by scripts/query.ts `search()`. */
export interface Hit {
  kind: "conversation" | "file";
  id?: string;
  conversation_id?: string;
  provider?: string;
  title?: string | null;
  role?: string;
  created_at?: number | null;
  path?: string;
  snippet: string;
  score: number;
}

// Character contract (project brief): warm, state-aware, admits empty results
// rather than inventing, may disagree, no grievance state, scope stated
// plainly, points the user outward toward people rather than inward.
export const SYSTEM_PROMPT = `You answer questions about one person's own past AI conversations and notes. You are given numbered snippets retrieved from their private record. Those snippets are your entire source of truth for this reply.

Hard rules:
- Use only what the snippets say. Do not use general knowledge, guesses, or anything you would "expect" to be true. A confident wrong answer about the user's own history is worse than no answer.
- If the snippets do not contain the answer, reply with exactly: "Not in your record." You may add one short sentence about what the snippets do cover, if that helps them re-ask. Do not speculate.
- Cite every claim with the snippet number in square brackets, like [2]. Never cite a number that was not provided.
- Be warm and direct. Short paragraphs. No preamble, no headers, no bullet lists unless the user asked for a list.
- You may disagree with the question's premise when the record contradicts it, and say so.
- Other people named in the snippets are the user's contacts, not yours: repeat only what the record says about them, and where useful suggest the user talk to that person.
- Say what you cannot see when it matters: you are reading search hits over a local store, not the whole history.`;

export const EXPAND_PROMPT = `You rewrite a question into search keywords for a full-text index (FTS5, keyword matching, no semantics). Return a JSON array of exactly 3 short alternative phrasings (2–6 words each) that someone might have used when originally discussing this topic — synonyms, concrete nouns, likely jargon. No explanations, JSON array only.`;

function when(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "undated";
}

export function describeHit(h: Hit): string {
  return h.kind === "conversation"
    ? `${h.provider ?? "chat"} · "${h.title ?? "untitled"}" · ${h.role ?? "?"} · ${when(h.created_at)}`
    : `file · ${h.path ?? "?"}`;
}

export function buildUserMessage(question: string, hits: Hit[]): string {
  if (!hits.length) return `Question: ${question}\n\n(no matching snippets in the record)`;
  const lines = hits.map((h, i) =>
    `[${i + 1}] (${describeHit(h)})\n${h.snippet.replace(/[«»]/g, "").replace(/\s+/g, " ").trim()}`);
  return `Question: ${question}\n\nSnippets from the record:\n\n${lines.join("\n\n")}`;
}

/** Snippet numbers the answer cites, in order of first appearance, 1-based, only those ≤ n. */
export function citedIndices(answer: string, n: number): number[] {
  const out: number[] = [];
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const i = Number(m[1]);
    if (i >= 1 && i <= n && !out.includes(i)) out.push(i);
  }
  return out;
}

/** Union hits from several searches; dedupe by message id (conversations) or path+snippet (files); best score first. */
export function mergeHits(lists: Hit[][], limit: number): Hit[] {
  const seen = new Map<string, Hit>();
  for (const list of lists) {
    for (const h of list) {
      const key = h.kind === "conversation" ? `c:${h.id ?? h.conversation_id + "|" + h.snippet}` : `f:${h.path}|${h.snippet}`;
      const prev = seen.get(key);
      if (!prev || h.score < prev.score) seen.set(key, h);
    }
  }
  return [...seen.values()].sort((a, b) => a.score - b.score).slice(0, limit);
}

/** Run one prompt through the claude CLI. No tools, no settings, no session file; stdin carries the user message. */
async function viaCli(cfg: ReturnType<typeof modelConfig>, body: { model: string; system: string; messages: { role: string; content: string }[] }): Promise<any> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.CLAUDECODE;            // allow running from inside a Claude Code session
  delete env.ANTHROPIC_API_KEY;     // these outrank OAuth in the CLI's precedence chain and would
  delete env.ANTHROPIC_AUTH_TOKEN;  // silently move the call onto API billing
  // --tools "" drops built-in tools; --strict-mcp-config (with no --mcp-config) drops the
  // user's MCP servers too, so the model can neither act on accounts nor claim it can.
  const args = ["--print", "--model", body.model, "--tools", "", "--strict-mcp-config", "--output-format", "text",
    "--setting-sources", "", "--no-session-persistence", "--system-prompt", body.system];
  const proc = Bun.spawn([cfg.bin!, ...args], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(body.messages.map((m) => m.content).join("\n\n"));
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill(), 240_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`claude CLI failed (exit ${code}): ${(err || out).trim().split("\n").slice(-3).join(" ")}`);
  return { model: body.model, stop_reason: "end_turn", content: [{ type: "text", text: out.trim() }] };
}

async function messages(body: { model: string; max_tokens: number; system: string; messages: { role: string; content: string }[] }): Promise<any> {
  const cfg = modelConfig();
  if (!cfg.configured) {
    throw new Error(cfg.provider === "api"
      ? "no model configured — set ANTHROPIC_API_KEY in .env (AI_MEMORY_PROVIDER=api)"
      : "claude CLI not found — install Claude Code and sign in, or set AI_MEMORY_PROVIDER=api with ANTHROPIC_API_KEY");
  }
  if (cfg.provider === "claude-cli") return viaCli(cfg, body);
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.key!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`model call failed (${res.status}): ${data?.error?.message ?? res.statusText}`);
  return data;
}

function textOf(data: any): string {
  return (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
}

/** Ask the model for 3 keyword variants of the question. Returns [] on any malformed reply. */
export async function expandQuestion(question: string): Promise<string[]> {
  const cfg = modelConfig();
  const data = await messages({
    model: cfg.expandModel, max_tokens: 200, system: EXPAND_PROMPT,
    messages: [{ role: "user", content: question }],
  });
  const text = textOf(data);
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()).slice(0, 3) : [];
  } catch {
    return [];
  }
}

export interface AskResult {
  answer: string;
  model: string;
  snippets_sent: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

export async function ask(question: string, hits: Hit[]): Promise<AskResult> {
  const cfg = modelConfig();
  const data = await messages({
    model: cfg.model, max_tokens: 2048, system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(question, hits) }],
  });
  if (data.stop_reason === "refusal") {
    return { answer: "The model declined to answer this one.", model: data.model ?? cfg.model, snippets_sent: hits.length, usage: data.usage, stop_reason: "refusal" };
  }
  return { answer: textOf(data) || "(empty reply)", model: data.model ?? cfg.model, snippets_sent: hits.length, usage: data.usage, stop_reason: data.stop_reason };
}
