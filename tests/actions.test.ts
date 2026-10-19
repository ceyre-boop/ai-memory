// actions.ts — the closed schema the phone dispatches. The server never executes these.
import { test, expect } from "bun:test";
import { validateActions, parseActions, type ShortcutEntry } from "../scripts/lib/actions";

const reg: ShortcutEntry[] = [
  { name: "Jarvis Ping", purpose: "test", inputs: "none" },
  { name: "Send Text", purpose: "send an iMessage", inputs: "recipient + body", writes: true },
];

test("keeps the five allowed types and drops everything else", () => {
  const out = validateActions([
    { type: "open_url", url: "https://example.com" },
    { type: "open_url", url: "javascript:alert(1)" },
    { type: "open_app", name: "Notes" },
    { type: "speak", text: "hi" },
    { type: "copy", text: "x" },
    { type: "delete_everything" },
    "nope",
  ], reg);
  expect(out.map((a) => a.type)).toEqual(["open_url", "open_app", "speak", "copy"]);
});

test("run_shortcut must be registered; write shortcuts require approval", () => {
  const out = validateActions([
    { type: "run_shortcut", name: "Jarvis Ping" },
    { type: "run_shortcut", name: "Send Text", input: "mom: hi" },
    { type: "run_shortcut", name: "Not Registered" },
  ], reg);
  expect(out).toHaveLength(2);
  expect(out[0]).toMatchObject({ name: "Jarvis Ping", requires_approval: false });
  expect(out[1]).toMatchObject({ name: "Send Text", requires_approval: true });
});

test("parseActions tolerates prose around the JSON and garbage", () => {
  expect(parseActions('sure: [{"type":"speak","text":"yo"}]', reg)).toHaveLength(1);
  expect(parseActions("no json here", reg)).toEqual([]);
  expect(parseActions("[not json]", reg)).toEqual([]);
});
