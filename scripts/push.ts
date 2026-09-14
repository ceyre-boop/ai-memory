#!/usr/bin/env bun
// Copies an encrypted ai-memory store to or from a removable target.
import {
  DB_PATH,
  INSTALL_HINT,
  ROOT,
  StoreError,
  counts,
  fail,
  getKey,
  isPlaintextSqlite,
  openStore,
  readManifest,
  writeManifest,
  type Counts,
} from "./lib/db.ts";
import { fmtInt, parseArgs, usage } from "./lib/cli.ts";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USAGE = "usage: bun scripts/push.ts <target> [--dry] [--pull] [--key-file path]";
// Allowlist, not a blocklist: only these top-level entries ever reach media.
// .env, *.key, corpus/, wip/, .git/ can never ride along by omission.
const COPY_ENTRIES = ["embeddings", "scripts", "ui", "tests", "manifest.json", "package.json", "CONSTRAINTS.md", "README.md", "ISA.md"];
const NEVER_COPIED = "corpus/, .git/, node_modules/, wip/, .env*, *.key, *.db-wal, *.db-shm";
const EXCLUDES = ["*.db-wal", "*.db-shm", ".env", ".env.*", "*.key", "node_modules/"];
const SECRET_NAME = /^\.env(\..*)?$|\.key$/;

/** Children never see the passphrase or any API key. */
function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/KEY|TOKEN|SECRET|PASS/i.test(k)) env[k] = v;
  }
  return env;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function textOutput(value: unknown, command: string, stream: "stdout" | "stderr"): string {
  if (!(value instanceof Uint8Array)) {
    throw new StoreError(`${command} returned an unreadable ${stream}`);
  }
  return new TextDecoder().decode(value);
}

function runCommand(command: string, args: string[]): CommandResult {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({ cmd: [command, ...args], stdout: "pipe", stderr: "pipe", env: scrubbedEnv() });
  } catch (error) {
    throw new StoreError(`${command} could not run: ${errorMessage(error)}`);
  }
  if (typeof result.exitCode !== "number") {
    throw new StoreError(`${command} did not return an exit code`);
  }
  const label = [command, ...args].join(" ");
  const stdout = textOutput(result.stdout, label, "stdout");
  const stderr = textOutput(result.stderr, label, "stderr");
  if (result.exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${result.exitCode}`;
    throw new StoreError(`${label} failed: ${detail}`);
  }
  return { stdout, stderr };
}

function readableMountedVolumes(): string[] | null {
  try {
    return readdirSync("/Volumes").sort();
  } catch {
    // A missing or unreadable /Volumes directory intentionally adds no volume list to usage.
    return null;
  }
}

function usageText(): string {
  const volumes = readableMountedVolumes();
  if (volumes === null) return USAGE;
  const listed = volumes.length === 0 ? "  (none)" : volumes.map((volume) => `  ${volume}`).join("\n");
  return `${USAGE}\n\nmounted volumes:\n${listed}`;
}

function targetIsMountedDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    // A target that cannot be statted is treated as unavailable removable media.
    return false;
  }
}

function requireMountedWritableTarget(target: string): void {
  if (!targetIsMountedDirectory(target)) {
    throw new StoreError(`${target} not mounted. Plug it in.`);
  }

  const probe = join(target, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, "x", { flag: "wx" });
  } catch {
    throw new StoreError(`${target} is not writable (read-only or locked)`);
  } finally {
    if (existsSync(probe)) {
      try {
        unlinkSync(probe);
      } catch {
        throw new StoreError(`${target} is not writable (read-only or locked)`);
      }
    }
  }
}

function withTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : path + "/";
}

/** Copy only the allowlisted entries; prune anything else at the top level of the destination. */
function copyAllowlisted(source: string, destination: string, prune: boolean, scanSecrets: boolean): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of COPY_ENTRIES) {
    const from = join(source, entry);
    if (!existsSync(from)) continue;
    const isDir = statSync(from).isDirectory();
    const options = ["-a", "--delete"];
    for (const exclude of EXCLUDES) options.push("--exclude", exclude);
    if (isDir) runCommand("rsync", [...options, withTrailingSlash(from), withTrailingSlash(join(destination, entry))]);
    else runCommand("rsync", ["-a", from, join(destination, entry)]);
  }
  if (prune) {
    for (const entry of readdirSync(destination)) {
      if (!COPY_ENTRIES.includes(entry)) rmSync(join(destination, entry), { recursive: true, force: true });
    }
  }
  // Only media is scanned. The local primary legitimately holds .env / key files
  // and must never be pruned by a pull.
  const leaked = scanSecrets ? findSecrets(destination) : [];
  if (leaked.length) {
    for (const f of leaked) rmSync(f, { force: true });
    throw new StoreError(`secret-looking files were about to land on the target and were removed: ${leaked.join(", ")}`);
  }
}

function findSecrets(dir: string, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 4) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (SECRET_NAME.test(entry)) out.push(p);
    else if (statSync(p).isDirectory()) out.push(...findSecrets(p, depth + 1));
  }
  return out;
}

function parseKilobytes(value: string, command: string): number {
  const match = /^\s*(\d+)\b/.exec(value);
  if (!match) throw new StoreError(`${command} returned no leading size`);
  const kilobytes = Number(match[1]);
  if (!Number.isSafeInteger(kilobytes) || kilobytes < 0) {
    throw new StoreError(`${command} returned an invalid size`);
  }
  return kilobytes;
}

function targetFreeBytes(target: string): number {
  const command = `df -k ${target}`;
  const lines = runCommand("df", ["-k", target]).stdout.trimEnd().split("\n");
  if (lines.length < 2) throw new StoreError(`${command} returned no filesystem row`);
  const fields = lines[1].trim().split(/\s+/);
  if (fields.length < 4 || !/^\d+$/.test(fields[3])) {
    throw new StoreError(`${command} returned an invalid available-space field`);
  }
  const kilobytes = Number(fields[3]);
  if (!Number.isSafeInteger(kilobytes) || kilobytes < 0) {
    throw new StoreError(`${command} returned an invalid available-space value`);
  }
  return kilobytes * 1024;
}

/** Size of what would actually be copied (allowlisted entries only). */
function storeBytes(root: string = ROOT): number {
  let total = 0;
  for (const entry of COPY_ENTRIES) {
    const p = join(root, entry);
    if (!existsSync(p)) continue;
    total += parseKilobytes(runCommand("du", ["-sk", p]).stdout, `du -sk ${p}`) * 1024;
  }
  return total;
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function describeCounts(value: Counts): string {
  return `files=${value.files} chunks=${value.chunks} conversations=${value.conversations} messages=${value.messages}`;
}

function printCapacity(size: number, free: number): void {
  console.log(`store ${formatGigabytes(size)} · free ${formatGigabytes(free)}`);
}

function printDryPlan(size: number, free: number, source: string = ROOT): void {
  printCapacity(size, free);
  console.log("would copy top-level entries:");
  for (const entry of COPY_ENTRIES) if (existsSync(join(source, entry))) console.log(`  ${entry}`);
  console.log(`never copied: ${NEVER_COPIED}`);
}

function checkpointAndCount(key: string): Counts {
  const db = openStore({ key });
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    return counts(db);
  } finally {
    db.close();
  }
}

function verifyTarget(path: string, key: string): Counts {
  try {
    const db = openStore({ path, key, readonly: true });
    let value: Counts;
    try {
      value = counts(db, true); // strict: a missing table is a failure, not a zero
    } finally {
      db.close();
    }
    for (const sidecar of [path + "-wal", path + "-shm"]) {
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    return value;
  } catch (error) {
    throw new StoreError(`index did not open on target: ${errorMessage(error)}`);
  }
}

function printVerifiedCounts(value: Counts): void {
  console.log(
    `✓ verified on target: ${fmtInt(value.chunks)} chunks · ${fmtInt(value.files)} files · ${fmtInt(value.conversations)} conversations · ${fmtInt(value.messages)} messages`,
  );
}

async function push(target: string, destination: string, dry: boolean): Promise<void> {
  const plaintext = isPlaintextSqlite(DB_PATH);
  if (plaintext === null) throw new StoreError(`no store at ${DB_PATH}`);
  if (plaintext) throw new StoreError("refusing to push a plaintext store — run encrypt.ts migrate");

  const size = storeBytes();
  const free = targetFreeBytes(target);
  if (dry) {
    printDryPlan(size, free);
    return;
  }
  requireMountedWritableTarget(target);
  if (size > free) throw new StoreError("not enough space on target");

  const key = getKey(process.argv.slice(2));
  const sourceCounts = checkpointAndCount(key);
  console.log("✓ WAL checkpointed — index.db is self-contained");
  printCapacity(size, free);

  console.log(`▸ pushing ${ROOT} → ${destination}`);
  const started = Date.now();
  copyAllowlisted(ROOT, destination, true, true);
  const elapsedSeconds = Math.max((Date.now() - started) / 1000, 0.001);
  const megabytesPerSecond = size / 1024 ** 2 / elapsedSeconds;
  console.log(`✓ copied in ${elapsedSeconds.toFixed(1)}s (${megabytesPerSecond.toFixed(0)} MB/s)`);

  const destinationCounts = verifyTarget(join(destination, "embeddings", "index.db"), key);
  printVerifiedCounts(destinationCounts);
  if (describeCounts(sourceCounts) !== describeCounts(destinationCounts)) {
    throw new StoreError(
      `verification counts did not match\nsource counts: ${describeCounts(sourceCounts)}\ntarget counts: ${describeCounts(destinationCounts)}`,
    );
  }

  const manifest = readManifest();
  manifest.pushes = [...(manifest.pushes ?? []), { target: destination, at: new Date().toISOString(), counts: destinationCounts }];
  await writeManifest(manifest);

  console.log(INSTALL_HINT);
  console.log(`query it directly:\n  bun ${join(destination, "scripts", "query.ts")} "your question"`);
  console.log(`eject when done:\n  diskutil eject ${target}`);
}

/** The inverse of push, held to the same rule: the source index must open with the key before it may replace the primary. */
function pull(destination: string, dry: boolean): void {
  if (!existsSync(destination) || !targetIsMountedDirectory(destination)) {
    throw new StoreError(`no store at ${destination}`);
  }
  const remoteIndex = join(destination, "embeddings", "index.db");
  const plaintext = isPlaintextSqlite(remoteIndex);
  if (plaintext === null) throw new StoreError(`no index at ${remoteIndex}`);
  if (plaintext) throw new StoreError("refusing to pull a plaintext store");
  const size = storeBytes(destination);
  if (dry) {
    console.log(`would pull ${destination} → ${ROOT}`);
    printDryPlan(size, Number.POSITIVE_INFINITY, destination);
    return;
  }
  const key = getKey(process.argv.slice(2));
  const remoteCounts = verifyTarget(remoteIndex, key);
  console.log(`✓ source index opens with the key: ${describeCounts(remoteCounts)}`);
  copyAllowlisted(destination, ROOT, false, false);
  const localCounts = verifyTarget(DB_PATH, key);
  if (describeCounts(remoteCounts) !== describeCounts(localCounts)) {
    throw new StoreError(`pulled index does not match source\nsource: ${describeCounts(remoteCounts)}\nlocal: ${describeCounts(localCounts)}`);
  }
  console.log(`✓ pulled and verified: ${describeCounts(localCounts)}`);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2), ["dry", "pull", "help"], []);
  } catch (error) {
    usage(`${usageText()}\n${errorMessage(error)}`);
  }
  if (parsed.flags.has("help") || parsed.positional.length !== 1) usage(usageText());

  const target = parsed.positional[0];
  // --dry must not touch the target: the write probe runs only on a real push.
  if (!targetIsMountedDirectory(target)) throw new StoreError(`${target} not mounted. Plug it in.`);
  const destination = join(target, "ai-memory");
  if (parsed.flags.has("pull")) {
    pull(destination, parsed.flags.has("dry"));
    return;
  }
  await push(target, destination, parsed.flags.has("dry"));
}

try {
  await main();
} catch (error) {
  fail(error);
}
