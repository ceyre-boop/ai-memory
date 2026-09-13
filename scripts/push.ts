#!/usr/bin/env bun
// Push the memory store to removable media, with checkpoint + verification.
// Usage: bun scripts/push.ts /Volumes/MYCHIP [--pull]
import { Database } from "bun:sqlite";
import { join, basename } from "node:path";
import { stat, mkdir } from "node:fs/promises";
import { $ } from "bun";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const target = process.argv[2];
const PULL = process.argv.includes("--pull");
if (!target) {
  console.error("usage: bun scripts/push.ts /Volumes/CHIP [--pull]");
  console.error("\nmounted volumes:");
  for (const v of (await $`ls /Volumes`.text()).trim().split("\n")) console.error("  " + v);
  process.exit(1);
}

// 1. target must exist and be writable
try { await stat(target); } catch {
  console.error(`✗ ${target} not mounted. Plug it in.`); process.exit(1);
}
const probe = join(target, `.write-probe-${Date.now()}`);
try { await Bun.write(probe, "x"); await $`rm -f ${probe}`.quiet(); }
catch { console.error(`✗ ${target} is not writable (read-only or locked).`); process.exit(1); }

const dest = join(target, "ai-memory");

if (PULL) {
  console.log(`◂ pulling ${dest} → ${ROOT}`);
  await $`ditto ${join(dest)} ${ROOT}`;
  console.log("✓ pulled");
  process.exit(0);
}

// 2. checkpoint WAL so index.db is self-contained before copying
const db = new Database(join(ROOT, "embeddings", "index.db"));
db.run("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log("✓ WAL checkpointed — index.db is self-contained");

// 3. capacity check
const free = Number((await $`df -k ${target}`.text()).trim().split("\n")[1].split(/\s+/)[3]) * 1024;
const size = Number((await $`du -sk ${ROOT}`.text()).split(/\s+/)[0]) * 1024;
console.log(`  store ${(size/1073741824).toFixed(2)} GB · free ${(free/1073741824).toFixed(2)} GB`);
if (size > free) { console.error("✗ not enough space on target"); process.exit(1); }

// 4. copy
console.log(`▸ pushing ${ROOT} → ${dest}`);
const t0 = Date.now();
await mkdir(dest, { recursive: true });
await $`ditto ${ROOT} ${dest}`;
const secs = (Date.now() - t0) / 1000;
console.log(`✓ copied in ${secs.toFixed(1)}s (${(size/1048576/secs).toFixed(0)} MB/s)`);

// 5. verify the index actually opens on the target
try {
  const v = new Database(join(dest, "embeddings", "index.db"), { readonly: true });
  const n = v.prepare("SELECT count(*) c FROM chunks").get() as any;
  const f = v.prepare("SELECT count(*) c FROM files").get() as any;
  v.close();
  console.log(`✓ verified on chip: ${n.c.toLocaleString()} chunks · ${f.c.toLocaleString()} files`);
} catch (e) { console.error("✗ index did not open on target:", e); process.exit(1); }

console.log(`\nquery it directly:\n  bun ${join(dest,"scripts","query.ts")} "your question"`);
console.log(`eject when done:\n  diskutil eject ${target}`);
