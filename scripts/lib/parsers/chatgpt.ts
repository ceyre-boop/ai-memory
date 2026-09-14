// ChatGPT export: conversations.json — an array of conversations, each a tree
// (`mapping`) of nodes {id, message, parent, children} with `current_node`
// marking the leaf of the path the user last saw. Edited or regenerated turns
// survive as sibling branches; we keep them and mark on_main_path = 0.
import {
  type ParsedConversation,
  type ParsedMessage,
  type ParseOptions,
  type ParseResult,
  normalizeRole,
  secondsToMs,
} from "./types";

interface Node {
  id: string;
  parent?: string | null;
  children?: string[];
  message?: Msg | null;
}
interface Msg {
  id: string;
  author?: { role?: string };
  create_time?: number | null;
  content?: Content;
  metadata?: Record<string, unknown>;
}
interface Content {
  content_type?: string;
  parts?: unknown[];
  text?: string;
  language?: string;
  result?: string;
  thoughts?: { summary?: string; content?: string }[];
  content?: string;
  user_profile?: string;
  user_instructions?: string;
}

export function looksLikeChatGPT(data: unknown): boolean {
  return Array.isArray(data) && data.length > 0 && data.every((c) => c && typeof c === "object" && "mapping" in c);
}

function renderContent(c: Content | undefined, opts: ParseOptions): string {
  if (!c) return "";
  const parts = Array.isArray(c.parts) ? c.parts : [];
  switch (c.content_type) {
    case "text":
      return parts.filter((p): p is string => typeof p === "string").join("\n");
    case "code":
      return "```" + (c.language ?? "") + "\n" + (c.text ?? "") + "\n```";
    case "execution_output":
      return c.text ?? "";
    case "multimodal_text":
      return parts
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object") {
            const o = p as Record<string, unknown>;
            if (typeof o.asset_pointer === "string") return `[image: ${o.asset_pointer}]`;
            if (typeof o.text === "string") return o.text;
            return `[${String(o.content_type ?? "part")}]`;
          }
          return "";
        })
        .join("\n");
    case "thoughts":
      if (!opts.includeThinking) return "";
      return (c.thoughts ?? []).map((t) => [t.summary, t.content].filter(Boolean).join("\n")).join("\n\n");
    case "reasoning_recap":
      return opts.includeThinking ? (c.content ?? "") : "";
    case "user_editable_context":
      return [c.user_profile && `[custom instructions: about me]\n${c.user_profile}`,
        c.user_instructions && `[custom instructions: how to respond]\n${c.user_instructions}`]
        .filter(Boolean)
        .join("\n\n");
    case "tether_quote":
    case "tether_browsing_display":
      return c.text ?? c.result ?? "";
    case "system_error":
      return c.text ?? "";
    default:
      if (typeof c.text === "string") return c.text;
      return parts.filter((p): p is string => typeof p === "string").join("\n");
  }
}

export function parseChatGPT(data: unknown, opts: ParseOptions = {}): ParseResult {
  if (!Array.isArray(data)) throw new Error("ChatGPT export must be a JSON array of conversations");
  const out: ParseResult = { conversations: [], emptySkipped: 0, notes: [] };
  let branches = 0;

  for (const conv of data as Record<string, unknown>[]) {
    const mapping = (conv.mapping ?? {}) as Record<string, Node>;
    const sourceId = String(conv.conversation_id ?? conv.id ?? "");
    if (!sourceId) continue;

    // main path: walk from current_node to the root
    const main = new Set<string>();
    let cur = typeof conv.current_node === "string" ? conv.current_node : null;
    const guard = new Set<string>();
    while (cur && mapping[cur] && !guard.has(cur)) {
      guard.add(cur);
      main.add(cur);
      cur = mapping[cur].parent ?? null;
    }

    // depth-first from the roots, parent before child, sibling order = children[]
    const roots = Object.values(mapping).filter((n) => !n.parent || !mapping[n.parent]);
    const messages: ParsedMessage[] = [];
    const visited = new Set<string>();
    let seq = 0;
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = mapping[id];
      if (!node) return;
      const m = node.message;
      if (m) {
        const body = renderContent(m.content, opts).trim();
        if (!body) {
          out.emptySkipped++;
        } else {
          const onMain = main.size === 0 ? true : main.has(id);
          if (!onMain) branches++;
          messages.push({
            id: m.id ?? id,
            seq: seq++,
            role: normalizeRole(m.author?.role),
            createdAt: secondsToMs(m.create_time),
            body,
            parentId: node.parent ?? null,
            onMainPath: onMain,
            contentTypes: [m.content?.content_type ?? "unknown"],
          });
        }
      }
      for (const c of node.children ?? []) visit(c);
    };
    for (const r of roots) visit(r.id);

    out.conversations.push({
      provider: "chatgpt",
      sourceId,
      title: typeof conv.title === "string" ? conv.title : null,
      createdAt: secondsToMs(conv.create_time),
      updatedAt: secondsToMs(conv.update_time),
      threadInferred: false,
      messages,
    });
  }
  if (branches) out.notes.push(`${branches} edited/regenerated messages kept off the main path (on_main_path = 0)`);
  if (!opts.includeThinking) out.notes.push("model reasoning (thoughts) excluded from bodies; pass --include-thinking to keep it");
  return out;
}
