// Gemini via Google Takeout: My Activity/Gemini Apps/MyActivity.json — a flat,
// newest-first list of activity items. Each item is one prompt ("Prompted …")
// with the model's reply as HTML in safeHtmlItem[]. Takeout carries NO thread
// id, so threads are inferred by time gap and flagged thread_inferred = 1.
// Thread ids are deterministic (hash of the first prompt's time + text) so a
// re-ingest of the same activity yields the same ids.
import {
  type ParsedConversation,
  type ParsedMessage,
  type ParseOptions,
  type ParseResult,
  isoToMs,
} from "./types";

interface Item {
  header?: string;
  title?: string;
  time?: string;
  products?: string[];
  safeHtmlItem?: { html?: string }[];
}

export const DEFAULT_GAP_MINUTES = 30;

export function looksLikeGemini(data: unknown): boolean {
  if (!Array.isArray(data) || data.length === 0) return false;
  return data.some((i) => {
    if (!i || typeof i !== "object") return false;
    const o = i as Item;
    return o.header === "Gemini Apps" || (Array.isArray(o.products) && o.products.includes("Gemini Apps"));
  });
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", deg: "°", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©",
};

export function htmlToText(html: string): string {
  let t = html;
  t = t.replace(/<\s*br\s*\/?>/gi, "\n");
  t = t.replace(/<\s*li[^>]*>/gi, "- ");
  t = t.replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|ul|ol|pre|blockquote|table)\s*>/gi, "\n");
  t = t.replace(/<\s*(p|div|h[1-6]|tr|ul|ol|pre|blockquote|table)[^>]*>/gi, "\n");
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  t = t.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
  t = t.replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

export function parseGemini(data: unknown, opts: ParseOptions = {}): ParseResult {
  if (!Array.isArray(data)) throw new Error("Gemini Takeout MyActivity.json must be a JSON array");
  const out: ParseResult = { conversations: [], emptySkipped: 0, notes: [] };
  const gapMs = (opts.gapMinutes ?? DEFAULT_GAP_MINUTES) * 60_000;

  type Entry = { time: number; prompt: string; response: string | null };
  const entries: Entry[] = [];
  let notPrompt = 0, notGemini = 0, noTime = 0;
  for (const raw of data as Item[]) {
    const isGemini = Array.isArray(raw?.products) && raw.products.includes("Gemini Apps");
    if (!isGemini) { notGemini++; continue; }
    const title = raw.title ?? "";
    const m = /^Prompted\s+([\s\S]*)$/.exec(title);
    if (!m) { notPrompt++; continue; }
    const time = isoToMs(raw.time);
    if (time === null) { noTime++; continue; }
    const html = (raw.safeHtmlItem ?? []).map((h) => h.html ?? "").join("\n");
    const response = html ? htmlToText(html) : null;
    entries.push({ time, prompt: m[1].trim(), response: response || null });
  }
  entries.sort((a, b) => a.time - b.time);

  let thread: Entry[] = [];
  const flush = () => {
    if (!thread.length) return;
    const first = thread[0];
    const sourceId = "inferred-" + Bun.hash(`${first.time}|${first.prompt}`).toString(16);
    const messages: ParsedMessage[] = [];
    let seq = 0;
    thread.forEach((e, i) => {
      if (e.prompt) {
        messages.push({
          id: `${i}-user`, seq: seq++, role: "user", createdAt: e.time, body: e.prompt,
          parentId: null, onMainPath: true, contentTypes: ["text"],
        });
      } else out.emptySkipped++;
      if (e.response) {
        messages.push({
          id: `${i}-assistant`, seq: seq++, role: "assistant", createdAt: e.time, body: e.response,
          parentId: `${i}-user`, onMainPath: true, contentTypes: ["html"],
        });
      }
    });
    out.conversations.push({
      provider: "gemini",
      sourceId,
      title: first.prompt.length > 80 ? first.prompt.slice(0, 77) + "…" : first.prompt,
      createdAt: first.time,
      updatedAt: thread[thread.length - 1].time,
      threadInferred: true,
      messages,
    });
    thread = [];
  };
  for (const e of entries) {
    if (thread.length && e.time - thread[thread.length - 1].time > gapMs) flush();
    thread.push(e);
  }
  flush();

  out.notes.push(`Takeout has no thread ids; ${out.conversations.length} threads inferred with a ${opts.gapMinutes ?? DEFAULT_GAP_MINUTES}-minute gap (thread_inferred = 1)`);
  if (notPrompt) out.notes.push(`${notPrompt} activity items were not prompts (e.g. "Used Gemini Apps") and were skipped`);
  if (noTime) out.notes.push(`${noTime} prompts had no parseable timestamp and were dropped (threads need time)`);
  if (notGemini) out.notes.push(`${notGemini} items from other Google products were ignored`);
  return out;
}
