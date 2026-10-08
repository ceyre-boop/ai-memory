#!/usr/bin/env bun
// reflex — rules you wrote yourself, matched by substring or regex, printed
// back in your own words. No model, no socket, no write, no ranking, no
// schedule. CONSTRAINTS.md item 9, GOVERNANCE.md Tier 1.
//
// Usage: bun scripts/reflex.ts "text" [--rules <path>] [--no-verify] [--key-file <path>]
//        echo "text" | bun scripts/reflex.ts --stdin
//
// Rules file (default ~/.config/ai-memory/rules.md, or AI_MEMORY_RULES):
//
//   ## polishing
//   match: polish, tidy up, /make it (look )?nicer/
//   ref: claude:retro:1
//   > I keep polishing the demo instead of shipping the feature. Stop doing that.
//
// This carries no CLAUDECODE guard on purpose: nothing leaves the machine and
// nothing is written, so an AI coding session may run it for real.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openStore, fail, StoreError, DB_PATH } from "./lib/db";
import { parseArgs, usage } from "./lib/cli";
import { fetchByRef, heading } from "./query";

const USAGE = `
usage: bun scripts/reflex.ts "text" [--rules <path>] [--no-verify] [--key-file <path>]
       bun scripts/reflex.ts --stdin [--rules <path>] [--no-verify]

  Matches the text against rules you wrote by hand and prints the matching rule's quote — your words.
  --rules     rules file (default ~/.config/ai-memory/rules.md, or AI_MEMORY_RULES)
  --stdin     read the text from stdin instead of the argument
  --no-verify skip checking each rule's ref against the store (no passphrase needed)
`;

export interface Rule {
  name: string;
  match: Array<string | RegExp>;
  ref: string | null;
  quote: string;
  line: number;
}

export function rulesPath(): string {
  return process.env.AI_MEMORY_RULES || join(homedir(), ".config", "ai-memory", "rules.md");
}

function parseMatch(spec: string, line: number): Array<string | RegExp> {
  const terms: Array<string | RegExp> = [];
  for (const raw of spec.split(/\s*,\s*/)) {
    const t = raw.trim();
    if (!t) continue;
    const re = /^\/(.+)\/([a-z]*)$/.exec(t);
    if (re) {
      try { terms.push(new RegExp(re[1], re[2].includes("i") ? re[2] : re[2] + "i")); }
      catch (e) { throw new StoreError(`rules line ${line}: bad regex ${t}: ${(e as Error).message}`); }
    } else {
      terms.push(t.toLowerCase());
    }
  }
  return terms;
}

/** Parse the rules file. Pure; never writes. Malformed rules are errors, not guesses. */
export function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  let cur: Rule | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      if (cur) rules.push(finish(cur));
      cur = { name: h[1], match: [], ref: null, quote: "", line: n };
      continue;
    }
    if (!cur) continue; // preamble before the first heading is ignored
    const m = /^match:\s*(.+)$/.exec(line);
    if (m) { cur.match.push(...parseMatch(m[1], n)); continue; }
    const r = /^ref:\s*(\S+)\s*$/.exec(line);
    if (r) { cur.ref = r[1]; continue; }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { cur.quote = cur.quote ? `${cur.quote}\n${q[1]}` : q[1]; continue; }
  }
  if (cur) rules.push(finish(cur));
  return rules;

  function finish(r: Rule): Rule {
    if (r.match.length === 0) throw new StoreError(`rule "${r.name}" (line ${r.line}) has no match: line`);
    if (!r.quote.trim()) throw new StoreError(`rule "${r.name}" (line ${r.line}) has no quoted line — a rule is your own words or nothing`);
    r.quote = r.quote.trim();
    return r;
  }
}

/** Which rules fire on this text. Order is the file's order; nothing is ranked. */
export function matchRules(rules: Rule[], text: string): Array<{ rule: Rule; term: string }> {
  const lower = text.toLowerCase();
  const out: Array<{ rule: Rule; term: string }> = [];
  for (const rule of rules) {
    for (const t of rule.match) {
      if (typeof t === "string" ? lower.includes(t) : t.test(text)) {
        out.push({ rule, term: typeof t === "string" ? t : t.toString() });
        break;
      }
    }
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export type Verdict = "verified" | "unverified" | "unchecked";

/** A ref is verified only if it resolves and the chunk contains the quote. */
export function verifyRule(db: import("bun:sqlite").Database, rule: Rule): { verdict: Verdict; where: string | null } {
  if (!rule.ref) return { verdict: "unchecked", where: null };
  const hit = fetchByRef(db, rule.ref);
  if (!hit) return { verdict: "unverified", where: null };
  const ok = norm(hit.snippet).includes(norm(rule.quote.split("\n")[0]));
  return { verdict: ok ? "verified" : "unverified", where: heading(hit) };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), ["stdin", "no-verify", "help"], ["rules"]);
  } catch (e) {
    usage(`${(e as Error).message}\n${USAGE}`);
  }
  if (args.flags.has("help")) usage(USAGE, 0);
  let text: string;
  if (args.flags.has("stdin")) {
    if (args.positional.length) usage(USAGE);
    text = await Bun.stdin.text();
  } else {
    if (args.positional.length !== 1) usage(USAGE);
    text = args.positional[0];
  }
  if (!text.trim()) usage("nothing to match");

  const path = args.opts.get("rules") ?? rulesPath();
  if (!existsSync(path)) {
    console.log(`no rules file at ${path} — nothing to match. Write one by hand; this tool never will.`);
    return;
  }
  const rules = parseRules(readFileSync(path, "utf8"));
  const fired = matchRules(rules, text);
  if (fired.length === 0) {
    console.log(`no rule matched (${rules.length} rule${rules.length === 1 ? "" : "s"} in ${path})`);
    return;
  }

  const wantVerify = !args.flags.has("no-verify") && fired.some((f) => f.rule.ref);
  let db: import("bun:sqlite").Database | null = null;
  if (wantVerify) {
    if (!existsSync(DB_PATH)) {
      console.error(`(store not found at ${DB_PATH}; refs left unchecked — pass --no-verify to silence)`);
    } else {
      try { db = openStore({ readonly: true }); }
      catch (e) { console.error(`(could not open store, refs left unchecked: ${(e as Error).message})`); }
    }
  }

  for (const { rule, term } of fired) {
    const v = db ? verifyRule(db, rule) : { verdict: "unchecked" as Verdict, where: null };
    const tag = rule.ref ? ` [${rule.ref}: ${v.verdict}]` : "";
    console.log(`## ${rule.name}  (matched ${term})${tag}`);
    if (v.where) console.log(`   ${v.where}`);
    for (const l of rule.quote.split("\n")) console.log(`   > ${l}`);
    console.log();
  }
  db?.close();
}

if (import.meta.main) main().catch(fail);
