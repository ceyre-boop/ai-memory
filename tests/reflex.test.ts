// reflex — hand-written rules, matched deterministically, verified against
// the store. No model, no socket. The guard-free property is asserted too:
// it must run for real with CLAUDECODE set, because nothing leaves the machine.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseRules, matchRules } from "../scripts/reflex";
import { makeHome, run, KEY, dbPath } from "./helpers";

let HOME: string;
let RULES: string;

const RULES_TEXT = `# my rules

## polishing
match: polish, tidy up, /make it (look )?nicer/
ref: claude:retro:1
> I keep polishing the demo instead of shipping the feature. Stop doing that.

## drifted
match: drift
ref: claude:retro:1
> these words are not in the record

## noref
match: scope
> one thing at a time
`;

beforeAll(async () => {
  HOME = makeHome();
  RULES = join(HOME, "rules.md");
  writeFileSync(RULES, RULES_TEXT);
  const { openStore } = await import("../scripts/lib/db");
  const db = openStore({ path: dbPath(HOME), key: KEY, create: true });
  db.prepare(`INSERT INTO conversations (id, provider, source_id, title, created_at, message_count, thread_inferred, imported_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run("claude:retro", "claude", "retro", "Sprint retro", Date.parse("2026-04-10"), 1, 0, Date.now());
  db.prepare(`INSERT INTO messages (id, conversation_id, seq, role, created_at, body, on_main_path, content_types) VALUES (?,?,?,?,?,?,?,?)`)
    .run("claude:retro:1", "claude:retro", 0, "user", Date.parse("2026-04-10"),
      "That was a mistake — I keep polishing the demo instead of shipping the feature. Stop doing that.", 1, '["text"]');
  db.close();
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

test("parseRules: headings, match terms, regex, ref, multi-line quote", () => {
  const rules = parseRules(RULES_TEXT);
  expect(rules.map((r) => r.name)).toEqual(["polishing", "drifted", "noref"]);
  expect(rules[0].match.length).toBe(3);
  expect(rules[0].match[2]).toBeInstanceOf(RegExp);
  expect(rules[0].ref).toBe("claude:retro:1");
  expect(rules[2].ref).toBeNull();
});

test("parseRules: a rule without a quote or without match is an error, not a guess", () => {
  expect(() => parseRules("## x\nmatch: a\n")).toThrow(/no quoted line/);
  expect(() => parseRules("## x\n> words\n")).toThrow(/no match/);
});

test("matchRules: substring is case-insensitive, regex works, order is file order", () => {
  const rules = parseRules(RULES_TEXT);
  expect(matchRules(rules, "Let me TIDY UP the scope").map((m) => m.rule.name)).toEqual(["polishing", "noref"]);
  expect(matchRules(rules, "make it look nicer").map((m) => m.rule.name)).toEqual(["polishing"]);
  expect(matchRules(rules, "ship it")).toEqual([]);
});

test("cli: prints the operator's words, verifies a good ref, marks a drifted quote unverified", () => {
  const r = run("reflex.ts", ["I want to polish this and I think I drift", "--rules", RULES], { AI_MEMORY_HOME: HOME });
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("## polishing");
  expect(r.stdout).toContain("[claude:retro:1: verified]");
  expect(r.stdout).toContain("> I keep polishing the demo");
  expect(r.stdout).toContain("## drifted");
  expect(r.stdout).toContain("[claude:retro:1: unverified]");
});

test("cli: runs for real inside an AI coding session — nothing leaves the machine", () => {
  const r = run("reflex.ts", ["time to polish", "--rules", RULES, "--no-verify"], { AI_MEMORY_HOME: HOME, CLAUDECODE: "1" });
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("## polishing");
  expect(r.stdout).not.toContain("refusing");
});

test("cli: missing rules file matches nothing and says so; never creates one", () => {
  const missing = join(HOME, "nope.md");
  const r = run("reflex.ts", ["polish", "--rules", missing], { AI_MEMORY_HOME: HOME });
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("no rules file");
  expect(require("node:fs").existsSync(missing)).toBe(false);
});

test("cli: --stdin", () => {
  const p = Bun.spawnSync({ cmd: ["bun", join(import.meta.dir, "..", "scripts", "reflex.ts"), "--stdin", "--rules", RULES, "--no-verify"],
    stdin: new TextEncoder().encode("scope creep"), env: { ...process.env, AI_MEMORY_HOME: HOME } });
  expect(new TextDecoder().decode(p.stdout)).toContain("## noref");
});
