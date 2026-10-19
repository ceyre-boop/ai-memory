#!/usr/bin/env bun
// Shortcut factory: build a .shortcut, sign it, open it on the Mac (iCloud syncs it
// to the iPhone), and register it in shortcuts.json so JARVIS knows it can call it.
//
// usage: bun ops/make-shortcut.ts "Jarvis Ping" --notify "Jarvis ping ok" \
//          --purpose "Test: shows a notification" [--inputs none] [--writes] [--no-open]
// Only the notification action is built here; extend ACTIONS for more.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./../scripts/lib/cli";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const args = parseArgs(process.argv.slice(2), ["writes", "no-open"], ["notify", "purpose", "inputs"]);
const name = args.positional[0];
const notify = args.opts.get("notify");
if (!name || !notify) { console.error('usage: bun ops/make-shortcut.ts "<name>" --notify "<text>" --purpose "<why>"'); process.exit(2); }

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>WFWorkflowClientVersion</key><string>2900</string>
  <key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
  <key>WFWorkflowMinimumClientVersionString</key><string>900</string>
  <key>WFWorkflowTypes</key><array/>
  <key>WFWorkflowInputContentItemClasses</key><array/>
  <key>WFWorkflowIcon</key><dict><key>WFWorkflowIconStartColor</key><integer>431817727</integer><key>WFWorkflowIconGlyphNumber</key><integer>59511</integer></dict>
  <key>WFWorkflowActions</key><array>
    <dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.notification</string>
      <key>WFWorkflowActionParameters</key><dict>
        <key>WFNotificationActionTitle</key><string>${esc(name)}</string>
        <key>WFNotificationActionBody</key><string>${esc(notify)}</string>
        <key>WFNotificationActionSound</key><true/>
      </dict>
    </dict>
  </array>
</dict></plist>
`;

const dir = join(REPO, "shortcuts"); mkdirSync(dir, { recursive: true });
const slug = name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
const raw = join(dir, `${slug}.unsigned.shortcut`), signed = join(dir, `${slug}.shortcut`);
writeFileSync(raw + ".xml", xml);
const run = (cmd: string[]) => { const r = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" }); if (r.exitCode) { console.error(cmd.join(" "), "\n" + r.stderr.toString()); process.exit(1); } };
run(["plutil", "-convert", "binary1", "-o", raw, raw + ".xml"]);
run(["shortcuts", "sign", "--mode", "anyone", "--input", raw, "--output", signed]);
Bun.spawnSync({ cmd: ["rm", "-f", raw, raw + ".xml"] });

const regFile = join(REPO, "shortcuts.json");
const reg = existsSync(regFile) ? JSON.parse(readFileSync(regFile, "utf8")) : { shortcuts: [] };
reg.shortcuts = reg.shortcuts.filter((s: { name: string }) => s.name !== name);
reg.shortcuts.push({ name, purpose: args.opts.get("purpose") ?? "", inputs: args.opts.get("inputs") ?? "none", ...(args.flags.has("writes") ? { writes: true } : {}) });
writeFileSync(regFile, JSON.stringify(reg, null, 2) + "\n");
console.log(`built + signed ${signed}; registered "${name}" in shortcuts.json`);
if (!args.flags.has("no-open")) run(["open", signed]);
