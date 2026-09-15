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

  // Tests simulate a person at a normal terminal, not an AI session issuing the
  // command — scrub CLAUDECODE so push.ts's human-operator guard doesn't fire
  // for every test. A dedicated test in audit.test.ts re-adds it to prove the guard works.
  //
  // Also never let a script under test load the repo's real .env: ask.ts and
  // contradictions.ts call modelConfig(), which loads it unless told not to,
  // and the repo .env holds a real ANTHROPIC_API_KEY. Without this, a test
  // that reaches modelConfig() can silently pick up real credentials and
  // fire a real, billed model call instead of the mock it thinks it's using.
  const spawnEnv: Record<string, string | undefined> = { ...process.env, AI_MEMORY_HOME: home, AI_MEMORY_KEY: KEY, AI_MEMORY_NO_DOTENV: "1", ANTHROPIC_API_KEY: "", ...env };
  delete spawnEnv.CLAUDECODE;
  if (env.CLAUDECODE !== undefined) spawnEnv.CLAUDECODE = env.CLAUDECODE;

  const result = Bun.spawnSync({
    cmd: ["bun", join(import.meta.dir, "..", "scripts", script), ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv,
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
