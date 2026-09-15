// Local pagination cache for --more. Holds only opaque snippet refs (message
// ids / chunk rowids) per question — never the store's plaintext, never the
// key. Lives outside the repo by default, same convention as the passphrase
// file, so it never rides along on a push and never needs its own --dry
// rehearsal: it's local bookkeeping, not a store write.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Resolved lazily (not a module-load-time const) so tests that import this
// module more than once per process — and real callers that only ever set
// the env var before their first call — both see the path they actually set.
function cachePath(): string {
  return process.env.AI_MEMORY_QUERY_CACHE || join(homedir(), ".config", "ai-memory", "query-cache.json");
}

interface CacheEntry {
  refs: string[];
  updatedAt: number;
}
type Cache = Record<string, CacheEntry>;

function load(): Cache {
  const path = cachePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function save(cache: Cache): void {
  const path = cachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2));
}

/** Deterministic key for a tool+question pair — --more picks up where the same question, on the same tool, left off. */
export function cacheKey(tool: string, question: string): string {
  return `${tool}:${Bun.hash(question.trim().toLowerCase()).toString(16)}`;
}

/** Refs already returned for this key, or [] if nothing's cached yet. */
export function seenRefs(key: string): string[] {
  return load()[key]?.refs ?? [];
}

/** Appends newly-returned refs (deduped against what's already there) to the cache. */
export function recordRefs(key: string, refs: string[]): void {
  if (!refs.length) return;
  const cache = load();
  const prev = cache[key]?.refs ?? [];
  cache[key] = { refs: [...new Set([...prev, ...refs])], updatedAt: Date.now() };
  save(cache);
}
