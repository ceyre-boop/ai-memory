import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const KEY = "forge-test-passphrase-9f2a";

export interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ai-memory-test-"));
  mkdirSync(join(home, "embeddings"), { recursive: true });
  return home;
}

export function dbPath(home: string): string {
  return join(home, "embeddings", "index.db");
}

export function run(
  script: string,
  args: string[] = [],
  env: Record<string, string> = {},
): ScriptResult {
  const home = env.AI_MEMORY_HOME;
  if (!home) throw new Error("run requires env.AI_MEMORY_HOME");

  const result = Bun.spawnSync({
    cmd: ["bun", join(import.meta.dir, "..", "scripts", script), ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AI_MEMORY_HOME: home, AI_MEMORY_KEY: KEY, ...env },
  });
  const decode = (value: unknown): string =>
    value instanceof Uint8Array ? new TextDecoder().decode(value) : "";

  return {
    code: typeof result.exitCode === "number" ? result.exitCode : 1,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

export function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}
