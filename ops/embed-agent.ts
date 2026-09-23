#!/usr/bin/env bun
// Installs (or removes) the launchd agent that keeps `embed.ts` grinding through
// the corpus across sleep, logout, and reboot.
//
// Paths are derived at run time, never hardcoded, so this works for any user
// and any checkout location.
//
// Governance: Tier 2 — it changes machine state, so it is a human act. Inside an
// AI coding session (CLAUDECODE set) every real action is refused; --dry always
// works and prints the exact plist that would be written.
//
// Usage: bun ops/embed-agent.ts install|uninstall|status [--dry]
import { $ } from "bun";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { StoreError, ROOT, fail } from "../scripts/lib/db.ts";
import { parseArgs, usage } from "../scripts/lib/cli.ts";

const LABEL = "com.taboost.ai-memory.embed";
const USAGE = `
usage: bun ops/embed-agent.ts install|uninstall|status [--dry]

  install    write ~/Library/LaunchAgents/${LABEL}.plist and load it
  uninstall  unload and remove it
  status     report whether it is loaded and running

  The agent runs: caffeinate -dimsu bun scripts/embed.ts --kind file
  KeepAlive is SuccessfulExit=false — launchd restarts the job when it is
  killed (sleep, logout, OOM) but stops for good once embed.ts exits 0, which
  it does only when every chunk has a vector.

  Requires ollama running. Make it durable with: brew services start ollama
`;

const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function buildPlist(root: string, bun: string): string {
  const log = join(root, "embed.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-dimsu</string>
    <string>${bun}</string><string>scripts/embed.ts</string>
    <string>--kind</string><string>file</string>
  </array>
  <key>WorkingDirectory</key><string>${root}</string>
  <!-- restart when killed; stop for good on a clean finish -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${join(homedir(), ".bun", "bin")}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>AI_MEMORY_HOME</key><string>${root}</string>
  </dict>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>5</integer>
</dict>
</plist>
`;
}

function requireHumanOperator(dry: boolean): void {
  if (dry) return;
  if (process.env.CLAUDECODE) {
    throw new StoreError(
      "refusing to install or remove a launchd agent from inside an AI coding session " +
      "(CLAUDECODE is set) — changing machine state is a human act here. Run this " +
      "command yourself in a normal terminal. --dry still works from here.");
  }
}

async function domain(): Promise<string> {
  return `gui/${(await $`id -u`.text()).trim()}`;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2), ["dry", "help"], []); }
  catch (e) { usage(`${USAGE}\n${(e as Error).message}`, 2); }
  if (args.flags.has("help") || args.positional.length !== 1) usage(USAGE);

  const cmd = args.positional[0];
  const dry = args.flags.has("dry");
  const dom = await domain();

  if (cmd === "status") {
    const out = await $`launchctl print ${dom}/${LABEL}`.nothrow().quiet();
    if (out.exitCode !== 0) { console.log(`${LABEL}: not loaded`); return; }
    const text = out.stdout.toString();
    const state = /state = (\w+)/.exec(text)?.[1] ?? "unknown";
    const pid = /pid = (\d+)/.exec(text)?.[1];
    console.log(`${LABEL}: loaded · state ${state}${pid ? ` · pid ${pid}` : ""}`);
    console.log(`plist: ${plistPath}`);
    return;
  }

  if (cmd === "uninstall") {
    requireHumanOperator(dry);
    if (dry) { console.log(`would unload ${dom}/${LABEL} and remove ${plistPath}`); return; }
    await $`launchctl bootout ${dom}/${LABEL}`.nothrow().quiet();
    await $`rm -f ${plistPath}`.quiet();
    console.log(`✓ removed ${LABEL}`);
    return;
  }

  if (cmd !== "install") usage(`unknown command ${cmd}\n${USAGE}`);

  const root = resolve(ROOT);
  const bunPath = (await $`command -v bun`.text()).trim() || join(homedir(), ".bun", "bin", "bun");
  const plist = buildPlist(root, bunPath);

  if (dry) {
    console.log(`would write ${plistPath}:\n`);
    console.log(plist);
    console.log(`then: launchctl bootstrap ${dom} ${plistPath}`);
    return;
  }
  requireHumanOperator(dry);

  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await Bun.write(plistPath, plist);
  const lint = await $`plutil -lint ${plistPath}`.nothrow().quiet();
  if (lint.exitCode !== 0) throw new StoreError(`generated plist is malformed: ${lint.stderr}`);

  await $`launchctl bootout ${dom}/${LABEL}`.nothrow().quiet();
  const boot = await $`launchctl bootstrap ${dom} ${plistPath}`.nothrow();
  if (boot.exitCode !== 0) throw new StoreError(`launchctl bootstrap failed: ${boot.stderr}`);

  console.log(`✓ installed ${LABEL}`);
  console.log(`  root ${root}`);
  console.log(`  bun  ${bunPath}`);
  console.log(`  log  ${join(root, "embed.log")}`);
  console.log(`\ncheck it:  bun ops/embed-agent.ts status`);
  console.log(`ollama must stay up:  brew services start ollama`);
}

main().catch(fail);
