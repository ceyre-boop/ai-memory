// Local vector embeddings. See CONSTRAINTS.md item 6 — this file enforces:
// embedding happens on this machine, over loopback, or it fails. There is no
// hosted fallback and no API key. It is, with scripts/lib/ask.ts, one of only
// two files in the repository permitted to open a network socket.
import { StoreError } from "./db.ts";

export const DEFAULT_MODEL = "nomic-embed-text";
export const DEFAULT_DIM = 768;

/** Ollama base URL. Loopback only — a non-loopback host is refused. */
export function ollamaUrl(): string {
  const raw = process.env.AI_MEMORY_OLLAMA_URL ?? "http://127.0.0.1:11434";
  let u: URL;
  try { u = new URL(raw); } catch { throw new StoreError(`AI_MEMORY_OLLAMA_URL is not a URL: ${raw}`); }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) {
    throw new StoreError(
      `refusing a non-loopback embedding host (${u.hostname}). ` +
      `CONSTRAINTS.md: embedding is local-only over loopback, or it fails.`);
  }
  return u.origin;
}

export function embedModel(): string {
  return process.env.AI_MEMORY_EMBED_MODEL ?? DEFAULT_MODEL;
}

export const OLLAMA_HINT =
  "start the local embedder: `brew install ollama && ollama serve`, then " +
  "`ollama pull nomic-embed-text` (override with AI_MEMORY_EMBED_MODEL / AI_MEMORY_OLLAMA_URL)";

export const VECTOR_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS vectors (
  kind   TEXT    NOT NULL,
  ref_id INTEGER NOT NULL,
  dim    INTEGER NOT NULL,
  vec    BLOB    NOT NULL,
  model  TEXT    NOT NULL,
  PRIMARY KEY (kind, ref_id)
)`;

// ── quantization ───────────────────────────────────────────────────────────
// Vectors are L2-normalized then stored as int8. At 768 dims that is 768 bytes
// instead of 3072, and cosine similarity survives to ~0.01 absolute error.

export function quantize(vec: number[] | Float32Array): Buffer {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = Buffer.allocUnsafe(vec.length);
  for (let i = 0; i < vec.length; i++) {
    let q = Math.round((vec[i] / norm) * 127);
    if (q > 127) q = 127; else if (q < -127) q = -127;
    out.writeInt8(q, i);
  }
  return out;
}

export function dequantize(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf.readInt8(i) / 127;
  return out;
}

/** Cosine similarity of two quantized vectors. Both are unit-norm by construction. */
export function cosine(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) {
    throw new StoreError(`vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a.readInt8(i), y = b.readInt8(i);
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── the local embedder ─────────────────────────────────────────────────────

export interface EmbedOpts {
  model?: string;
  signal?: AbortSignal;
  /** ms before a single request is abandoned. */
  timeoutMs?: number;
}

/** Context-overflow is retried at progressively shorter input before giving up. */
const SHRINK = [1, 0.5, 0.25, 0.1];

async function embedOne(text: string, opts: EmbedOpts): Promise<number[]> {
  let last: unknown;
  for (const factor of SHRINK) {
    const slice = factor === 1 ? text : text.slice(0, Math.max(200, Math.floor(text.length * factor)));
    try {
      return await embedOnce(slice, opts);
    } catch (e) {
      last = e;
      const msg = (e as Error).message ?? "";
      if (!/context length|too large|exceeds/i.test(msg)) throw e;
    }
  }
  throw last;
}

async function embedOnce(text: string, opts: EmbedOpts): Promise<number[]> {
  const model = opts.model ?? embedModel();
  const url = `${ollamaUrl()}/api/embeddings`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: text, options: { num_ctx: 8192 } }),
      signal: opts.signal ?? ctl.signal,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      if (res.status === 404) {
        throw new StoreError(`ollama has no model "${model}" — run \`ollama pull ${model}\`. ${body}`);
      }
      throw new StoreError(`ollama returned ${res.status} for model "${model}". ${body}`);
    }
    const json = await res.json() as { embedding?: number[] };
    if (!Array.isArray(json.embedding) || json.embedding.length === 0) {
      throw new StoreError(`ollama returned no embedding for model "${model}"`);
    }
    return json.embedding;
  } catch (e) {
    if (e instanceof StoreError) throw e;
    const msg = (e as Error)?.name === "AbortError"
      ? `ollama timed out embedding with "${model}"`
      : `cannot reach the local embedder at ${ollamaUrl()} for model "${model}": ${(e as Error).message}`;
    throw new StoreError(`${msg}\n${OLLAMA_HINT}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Embed texts with bounded concurrency. Order of results matches input order. */
export async function embedTexts(
  texts: string[],
  opts: EmbedOpts & { concurrency?: number } = {},
): Promise<number[][]> {
  const out = new Array<number[]>(texts.length);
  const n = Math.max(1, opts.concurrency ?? 4);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, texts.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= texts.length) return;
      out[i] = await embedOne(texts[i], opts);
    }
  }));
  return out;
}

/** One probe call, so callers can fail fast with a clear message. */
export async function probeEmbedder(opts: EmbedOpts = {}): Promise<{ model: string; dim: number }> {
  const model = opts.model ?? embedModel();
  const v = await embedOne("probe", { ...opts, model, timeoutMs: opts.timeoutMs ?? 15_000 });
  return { model, dim: v.length };
}
