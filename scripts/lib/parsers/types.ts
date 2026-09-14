// Normalized shape every provider parser produces. See CONSTRAINTS.md §1–3.
export type Provider = "chatgpt" | "claude" | "gemini";
export const PROVIDERS: Provider[] = ["chatgpt", "claude", "gemini"];

export type Role = "user" | "assistant" | "system" | "tool";

export interface ParsedMessage {
  /** provider-local message id (unique within the conversation) */
  id: string;
  seq: number;
  role: Role;
  /** unix ms, or null when the export carried no timestamp */
  createdAt: number | null;
  body: string;
  parentId: string | null;
  /** false for edited/regenerated branches that are not on the current path */
  onMainPath: boolean;
  /** part types seen in the source message, e.g. ["thinking","text"] */
  contentTypes: string[];
}

export interface ParsedConversation {
  provider: Provider;
  sourceId: string;
  title: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  /** true when thread boundaries were reconstructed rather than read */
  threadInferred: boolean;
  messages: ParsedMessage[];
}

export interface ParseOptions {
  includeThinking?: boolean;
  gapMinutes?: number;
}

export interface ParseResult {
  conversations: ParsedConversation[];
  /** messages dropped because they had no body after rendering */
  emptySkipped: number;
  /** human-readable notes about what was not kept verbatim */
  notes: string[];
}

export function isoToMs(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function secondsToMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.round(v * 1000);
}

export function normalizeRole(r: unknown): Role {
  if (r === "user" || r === "human") return "user";
  if (r === "assistant" || r === "model") return "assistant";
  if (r === "system") return "system";
  if (r === "tool") return "tool";
  return "system";
}
