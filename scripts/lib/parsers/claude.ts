// Claude export: conversations.json — an array of {uuid, name, created_at,
// updated_at, chat_messages[]}. Each message has sender (human|assistant),
// text, and (newer exports) content[] parts of type text | thinking |
// tool_use | tool_result | token_budget, plus attachments[] with extracted
// text and files[] with names only.
import {
  type ParsedConversation,
  type ParsedMessage,
  type ParseOptions,
  type ParseResult,
  isoToMs,
  normalizeRole,
} from "./types";

interface Part {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
}
interface Msg {
  uuid?: string;
  text?: string;
  content?: Part[];
  sender?: string;
  created_at?: string;
  parent_message_uuid?: string | null;
  attachments?: { file_name?: string; extracted_content?: string }[];
  files?: { file_name?: string }[];
}

export function looksLikeClaude(data: unknown): boolean {
  return Array.isArray(data) && data.length > 0 && data.every((c) => c && typeof c === "object" && "chat_messages" in c);
}

function renderParts(parts: Part[], opts: ParseOptions): string {
  const lines: string[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "text":
        if (p.text) lines.push(p.text);
        break;
      case "thinking":
        if (opts.includeThinking && p.thinking) lines.push(`[thinking]\n${p.thinking}`);
        break;
      case "tool_use":
        lines.push(`[tool_use: ${p.name ?? "unknown"}]`);
        break;
      case "tool_result":
        lines.push("[tool_result]");
        break;
      case "token_budget":
        break;
      default:
        if (p.text) lines.push(p.text);
        else if (p.type) lines.push(`[${p.type}]`);
    }
  }
  return lines.join("\n");
}

export function parseClaude(data: unknown, opts: ParseOptions = {}): ParseResult {
  if (!Array.isArray(data)) throw new Error("Claude export must be a JSON array of conversations");
  const out: ParseResult = { conversations: [], emptySkipped: 0, notes: [] };
  let tools = 0, attachments = 0;

  for (const conv of data as Record<string, unknown>[]) {
    const sourceId = String(conv.uuid ?? "");
    if (!sourceId) continue;
    const msgs = Array.isArray(conv.chat_messages) ? (conv.chat_messages as Msg[]) : [];
    const messages: ParsedMessage[] = [];
    let seq = 0;

    msgs.forEach((m, i) => {
      const parts = Array.isArray(m.content) ? m.content : null;
      const chunks: string[] = [];
      let body = parts ? renderParts(parts, opts) : (m.text ?? "");
      if (body) chunks.push(body);
      for (const a of m.attachments ?? []) {
        attachments++;
        chunks.push(`[attachment: ${a.file_name ?? "unnamed"}]` + (a.extracted_content ? `\n${a.extracted_content}` : ""));
      }
      for (const f of m.files ?? []) chunks.push(`[file: ${f.file_name ?? "unnamed"}]`);
      body = chunks.join("\n\n").trim();
      if (!body) {
        out.emptySkipped++;
        return;
      }
      const types = parts ? [...new Set(parts.map((p) => p.type ?? "unknown"))] : ["text"];
      if (types.includes("tool_use")) tools++;
      messages.push({
        id: m.uuid ?? `${sourceId}-${i}`,
        seq: seq++,
        role: normalizeRole(m.sender),
        createdAt: isoToMs(m.created_at),
        body,
        parentId: m.parent_message_uuid ?? null,
        onMainPath: true,
        contentTypes: types,
      });
    });

    out.conversations.push({
      provider: "claude",
      sourceId,
      title: typeof conv.name === "string" && conv.name ? conv.name : null,
      createdAt: isoToMs(conv.created_at),
      updatedAt: isoToMs(conv.updated_at),
      threadInferred: false,
      messages,
    });
  }
  if (tools) out.notes.push(`${tools} messages had tool calls; kept as [tool_use: name] / [tool_result] markers`);
  if (attachments) out.notes.push(`${attachments} attachments kept as [attachment: name] with their extracted text`);
  if (!opts.includeThinking) out.notes.push("thinking blocks excluded from bodies; pass --include-thinking to keep them");
  return out;
}
