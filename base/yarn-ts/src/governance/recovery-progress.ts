type MessageLike = {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
};

export type LatestToolProgressSignal = {
  hasRecentWriteSuccess: boolean;
  hasRecentEditContextMiss: boolean;
  hasRecentFailure: boolean;
  toolName: string;
  toolCallId: string;
  snippet: string;
};

const EDIT_CONTEXT_MISS_PATTERNS: RegExp[] = [
  /\bfailed to find context\b/i,
  /\bold[_\s-]?string\b.*\bnot found\b/i,
  /\bnot found in file\b/i,
  /\bexactly once\b/i,
  /file has not been read yet/i,
  /read it first before writing/i,
];

const GENERIC_FAILURE_PATTERN = /\b(error|failed|invalid|permission denied|operation not permitted)\b/i;

const WRITE_CAPABLE_TOOLS = new Set([
  "write",
  "writefile",
  "write_file",
  "edit",
  "update",
  "applypatch",
  "apply_patch",
  "strreplace",
  "str_replace",
  "filewrite",
  "replace",
  "multi_edit",
  "multiedit",
  "todowrite",
]);

export function classifyLatestToolProgress(messages: MessageLike[]): LatestToolProgressSignal {
  const latestToolResult = findLatestToolResult(messages);
  if (!latestToolResult) {
    return {
      hasRecentWriteSuccess: false,
      hasRecentEditContextMiss: false,
      hasRecentFailure: false,
      toolName: "",
      toolCallId: "",
      snippet: "",
    };
  }

  const toolNameById = buildToolNameById(messages);
  const toolCallId = typeof latestToolResult.tool_call_id === "string" ? latestToolResult.tool_call_id.trim() : "";
  const mappedName = toolCallId ? (toolNameById.get(toolCallId) ?? "") : "";
  const toolName = (typeof latestToolResult.name === "string" ? latestToolResult.name : mappedName).trim();
  const chunks = collectTextChunks(latestToolResult.content);
  const rawText = chunks.join("\n").trim();
  const snippet = rawText.replace(/\s+/g, " ").slice(0, 220);
  const isWriteCapable = WRITE_CAPABLE_TOOLS.has(toolName.toLowerCase());
  // Edit-context-miss signals are only meaningful for write-capable tools.
  const hasEditContextMiss = isWriteCapable && EDIT_CONTEXT_MISS_PATTERNS.some((re) => re.test(rawText));
  const hasGenericFailure = GENERIC_FAILURE_PATTERN.test(rawText);
  const hasRecentFailure = hasEditContextMiss || hasGenericFailure;
  const hasWriteSuccess = isWriteCapable && !!rawText && !hasEditContextMiss && !hasGenericFailure;

  return {
    hasRecentWriteSuccess: hasWriteSuccess,
    hasRecentEditContextMiss: hasEditContextMiss,
    hasRecentFailure,
    toolName,
    toolCallId,
    snippet,
  };
}

function findLatestToolResult(messages: MessageLike[]): MessageLike | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    if (collectTextChunks(message.content).length === 0) continue;
    return message;
  }
  return null;
}

function buildToolNameById(messages: MessageLike[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const row = message as Record<string, unknown>;
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const id = typeof call.id === "string" ? call.id.trim() : "";
      const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : null;
      const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
      if (id && name) out.set(id, name);
    }
    const parts = Array.isArray(row.content) ? row.content : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "tool_use") continue;
      const id = typeof p.id === "string" ? p.id.trim() : "";
      const name = typeof p.name === "string" ? p.name.trim() : "";
      if (id && name) out.set(id, name);
    }
  }
  return out;
}

function collectTextChunks(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || value === null || value === undefined || out.length >= 12) return out;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextChunks(item, depth + 1, out);
      if (out.length >= 12) break;
    }
    return out;
  }
  if (typeof value !== "object") return out;
  const row = value as Record<string, unknown>;
  const text = typeof row.text === "string" ? row.text.trim() : "";
  if (text) out.push(text);
  for (const key of ["message", "error", "stderr", "stdout", "summary", "content", "result", "data", "payload", "output"]) {
    if (!(key in row)) continue;
    collectTextChunks(row[key], depth + 1, out);
    if (out.length >= 12) break;
  }
  return out;
}
