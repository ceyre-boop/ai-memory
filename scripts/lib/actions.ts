// Phone-side actions JARVIS may ask the iPhone to perform. The server NEVER
// executes any of them: /api/ask returns them and the Shortcut dispatches. Every
// action is validated against this closed schema; anything else is dropped.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

export type Action =
  | { type: "run_shortcut"; name: string; input?: string; requires_approval: boolean }
  | { type: "open_url"; url: string }
  | { type: "open_app"; name: string }
  | { type: "speak"; text: string }
  | { type: "copy"; text: string };

export interface ShortcutEntry { name: string; purpose: string; inputs: string; writes?: boolean }

export function loadRegistry(file = join(REPO, "shortcuts.json")): ShortcutEntry[] {
  if (!existsSync(file)) return [];
  try {
    const d = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(d.shortcuts) ? d.shortcuts : [];
  } catch { return []; }
}

const isWebUrl = (u: string) => { try { return ["http:", "https:"].includes(new URL(u).protocol); } catch { return false; } };
const str = (v: unknown, max = 2000) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

/** Keep only well-formed actions of the five allowed types. run_shortcut must name a
 *  registered shortcut; a shortcut marked `writes` (send/email/calendar/purchase) is
 *  flagged requires_approval so the phone shows a confirmation before running it. */
export function validateActions(raw: unknown, registry: ShortcutEntry[]): Action[] {
  if (!Array.isArray(raw)) return [];
  const out: Action[] = [];
  for (const a of raw.slice(0, 5)) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    if (o.type === "run_shortcut") {
      const name = str(o.name, 200);
      const reg = registry.find((s) => s.name === name);
      if (!name || !reg) continue;
      out.push({ type: "run_shortcut", name, input: str(o.input) ?? undefined, requires_approval: !!reg.writes });
    } else if (o.type === "open_url") {
      const url = str(o.url, 2000);
      if (url && isWebUrl(url)) out.push({ type: "open_url", url });
    } else if (o.type === "open_app") {
      const name = str(o.name, 100);
      if (name) out.push({ type: "open_app", name });
    } else if (o.type === "speak" || o.type === "copy") {
      const text = str(o.text);
      if (text) out.push({ type: o.type, text });
    }
  }
  return out;
}

export const ACTIONS_SYSTEM_PROMPT = `You decide whether the phone should do something in response to the user's message. Output a JSON array only, no prose. Allowed action objects:
{"type":"run_shortcut","name":"<registered name>","input":"<text>"}
{"type":"open_url","url":"<absolute web URL>"}
{"type":"open_app","name":"<app>"}
{"type":"speak","text":"..."}
{"type":"copy","text":"..."}
Use run_shortcut only with a name from the REGISTERED SHORTCUTS list. If the message asks for nothing the phone should do, output []. Never invent shortcuts. You do not send, email, schedule or buy anything yourself; if the user asks for that, pick the matching registered shortcut and the phone will ask them to approve it.`;

export function buildActionsMessage(message: string, registry: ShortcutEntry[]): string {
  const list = registry.length
    ? registry.map((s) => `- ${s.name}: ${s.purpose} (input: ${s.inputs})${s.writes ? " [WRITES]" : ""}`).join("\n")
    : "(none)";
  return `REGISTERED SHORTCUTS:\n${list}\n\nUSER MESSAGE:\n${message}`;
}

export function parseActions(reply: string, registry: ShortcutEntry[]): Action[] {
  const m = /\[[\s\S]*\]/.exec(reply);
  if (!m) return [];
  try { return validateActions(JSON.parse(m[0]), registry); } catch { return []; }
}
