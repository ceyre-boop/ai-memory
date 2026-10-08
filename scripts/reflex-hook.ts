#!/usr/bin/env bun
// Claude Code UserPromptSubmit hook: pipes the typed prompt through reflex and
// prints the matching rules as added context. The program decides what the
// model is reminded of; the model never does. Reads the rules file only.
// Verification is skipped here (no passphrase in a hook); run reflex by hand
// when you want refs checked.
import { existsSync, readFileSync } from "node:fs";
import { parseRules, matchRules, rulesPath } from "./reflex";

const raw = await Bun.stdin.text();
let prompt = "";
try { prompt = String(JSON.parse(raw).prompt ?? ""); } catch { process.exit(0); }
const path = rulesPath();
if (!prompt.trim() || !existsSync(path)) process.exit(0);
let fired;
try { fired = matchRules(parseRules(readFileSync(path, "utf8")), prompt); } catch { process.exit(0); }
if (fired.length === 0) process.exit(0);
const lines = ["[reflex — the operator's own rules matched this prompt; quote them, do not reinterpret them]"];
for (const { rule } of fired) {
  lines.push(`## ${rule.name}${rule.ref ? ` (${rule.ref})` : ""}`);
  for (const l of rule.quote.split("\n")) lines.push(`> ${l}`);
}
console.log(lines.join("\n"));
