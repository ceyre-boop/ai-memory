// Vector retrieval over the quantized store. Streams int8 vectors in batches
// and keeps a bounded top-k, so a 900k-vector scan never loads the whole set
// into memory. See CONSTRAINTS.md item 6.
import type { Database } from "bun:sqlite";
import { embedTexts, quantize } from "./embed.ts";

export interface VecHit { kind: "message" | "file"; ref_id: number; score: number }

const SCAN_BATCH = 20_000;

/** Dot product of two int8 buffers, both unit-norm by construction. */
function dot(a: Int8Array, b: Int8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function hasVectors(db: Database): boolean {
  const r = db.prepare(
    "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='vectors'").get() as { c: number };
  if (!r.c) return false;
  return ((db.prepare("SELECT count(*) c FROM vectors").get() as { c: number }).c) > 0;
}

/** Embed the question once, then scan stored vectors for the nearest k. */
export async function vectorSearch(
  db: Database,
  question: string,
  opts: { limit?: number; kinds?: ("message" | "file")[] } = {},
): Promise<VecHit[]> {
  if (!hasVectors(db)) return [];
  const limit = opts.limit ?? 8;
  const kinds = opts.kinds ?? ["message", "file"];

  const [qvec] = await embedTexts([question]);
  const q = new Int8Array(quantize(qvec).buffer.slice(0));
  const qnorm = Math.sqrt(dot(q, q)) || 1;

  // bounded min-heap, kept as a sorted array — k is small (<= 100)
  const top: VecHit[] = [];
  let floor = -Infinity;

  const place = new Array(kinds.length).fill("?").join(",");
  const stmt = db.prepare(
    `SELECT kind, ref_id, vec FROM vectors WHERE kind IN (${place}) LIMIT ? OFFSET ?`);

  for (let offset = 0; ; offset += SCAN_BATCH) {
    const rows = stmt.all(...kinds, SCAN_BATCH, offset) as
      { kind: "message" | "file"; ref_id: number; vec: Uint8Array }[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const v = new Int8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength);
      if (v.length !== q.length) continue;          // model changed mid-store
      const score = dot(q, v) / (qnorm * (Math.sqrt(dot(v, v)) || 1));
      if (top.length === limit && score <= floor) continue;
      top.push({ kind: row.kind, ref_id: row.ref_id, score });
      top.sort((a, b) => b.score - a.score);
      if (top.length > limit) top.length = limit;
      floor = top[top.length - 1].score;
    }
    if (rows.length < SCAN_BATCH) break;
  }
  return top;
}

/**
 * Reciprocal rank fusion. Combines independently-ranked lists without needing
 * their scores to be on the same scale — bm25 is negative-lower-better, cosine
 * is positive-higher-better, and RRF only reads position.
 */
export function rrf<T>(lists: T[][], key: (t: T) => string, k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, i) => {
      const id = key(item);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return scores;
}
