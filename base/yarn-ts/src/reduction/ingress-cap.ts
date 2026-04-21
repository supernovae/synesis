/**
 * Ingress cap for tool message bodies — runs before reducers so Node does not
 * retain multi-hundred-MB strings from a single tool result (H3).
 */

export interface IngressCapResult<T extends { role: string; content?: unknown }> {
  messages: T[];
  cappedToolResults: number;
  bytesReclaimed: number;
}

const CAP_ENVELOPE = "synesis_ingress_tool_cap";

export function applyIngressCapToToolMessages<T extends { role: string; content?: unknown }>(
  messages: T[],
  maxBytes: number,
): IngressCapResult<T> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { messages, cappedToolResults: 0, bytesReclaimed: 0 };
  }

  let cappedToolResults = 0;
  let bytesReclaimed = 0;
  const out = messages.map((m) => {
    if (m.role !== "tool" && m.role !== "tool_result") return m;
    if (typeof m.content !== "string") return m;
    const raw = m.content;
    const byteLen = Buffer.byteLength(raw, "utf8");
    if (byteLen <= maxBytes) return m;
    cappedToolResults += 1;
    bytesReclaimed += byteLen;
    const replacement = JSON.stringify({
      [CAP_ENVELOPE]: true,
      error: "tool_message_exceeded_max_bytes",
      max_bytes: maxBytes,
      original_bytes: byteLen,
      hint:
        "Output was not loaded into context. Narrow the command (e.g. tail/head/rg with a pattern), read a file range, or use synesis_artifact_retrieve if you have a handle from a prior summary.",
    });
    return { ...m, content: replacement } as T;
  });

  return { messages: out, cappedToolResults, bytesReclaimed };
}
