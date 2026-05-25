import crypto from "node:crypto";

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasClaudeNativeWebSearchTool(tools: unknown[] | undefined): boolean {
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return tools.some((tool) => {
    if (!isObjectRecord(tool)) return false;
    const type = String(tool.type ?? "").toLowerCase();
    const name = String(tool.name ?? "").toLowerCase();
    return type.startsWith("web_search_") || name === "web_search";
  });
}

export function isClaudeWebSearchToolName(toolName: string): boolean {
  return toolName.trim().toLowerCase() === "web_search";
}

export type ClaudeServerWebSearchEvent = {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  query: string;
  results: Array<{ type: "web_search_result"; url: string; title: string; snippet: string }>;
  errorCode?: string;
};

export function toClaudeServerWebSearchEvent(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): ClaudeServerWebSearchEvent {
  const query = String(response.query ?? input.query ?? "");
  const rawResults = Array.isArray(response.results) ? response.results : [];
  const results = rawResults
    .map((row) => {
      if (!isObjectRecord(row)) return null;
      return {
        type: "web_search_result" as const,
        url: String(row.url ?? ""),
        title: String(row.title ?? ""),
        snippet: String(row.snippet ?? ""),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  let errorCode: string | undefined;
  if (typeof response.error === "string" && response.error.trim().length > 0) {
    errorCode = response.error;
  } else if (typeof response.status === "number" && response.status >= 400) {
    errorCode = "upstream_error";
  }

  return {
    toolUseId: `srvtoolu_${toolCallId || crypto.randomUUID().replace(/-/g, "")}`,
    toolName,
    input,
    query,
    results,
    errorCode,
  };
}

export function resolveClaudeConversationId(
  metadata: Record<string, unknown> | undefined,
  headers: Record<string, unknown>,
  options: {
    debugProtocol?: boolean;
    debugLog?: (record: Record<string, unknown>, message: string) => void;
  } = {},
): string {
  if (metadata) {
    for (const key of ["synesis_conversation_id", "conversation_id", "session_id"]) {
      const val = metadata[key];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
    // Claude Code nests session_id inside metadata.user_id as a JSON string:
    // {"device_id":"...","account_uuid":"","session_id":"<uuid>"}
    const rawUserId = metadata.user_id;
    if (typeof rawUserId === "string" && rawUserId.startsWith("{")) {
      try {
        const parsed = JSON.parse(rawUserId) as Record<string, unknown>;
        const nested = parsed.session_id;
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      } catch { /* not JSON, ignore */ }
    }
  }
  for (const hdr of ["x-synesis-conversation-id", "x-claude-session-id"]) {
    const val = headers[hdr];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  if (options.debugProtocol) {
    options.debugLog?.({
      metadata,
      knownHeaders: {
        "x-synesis-conversation-id": headers["x-synesis-conversation-id"],
        "x-claude-session-id": headers["x-claude-session-id"],
        "x-request-id": headers["x-request-id"],
      },
    }, "claude_conversation_id_resolution_miss");
  }
  return "";
}

/**
 * Convert Claude's top-level `system` field (string or content-block array)
 * into a system-role message that can be prepended to the OpenAI message list.
 */
export function claudeSystemToMessage(system: unknown): {
  role: "system";
  content: string;
  providerOptions?: Record<string, unknown>;
} | null {
  if (!system) return null;
  if (typeof system === "string") {
    return system.length > 0 ? { role: "system", content: system } : null;
  }
  if (Array.isArray(system)) {
    const textParts = system
      .filter((b: unknown) => isObjectRecord(b) && b.type === "text")
      .map((b: unknown) => String((b as Record<string, unknown>).text ?? ""));
    const joined = textParts.join("\n");
    if (joined.length === 0) return null;

    const lastCacheControl = system
      .filter((b: unknown) => isObjectRecord(b) && b.cache_control)
      .map((b: unknown) => (b as Record<string, unknown>).cache_control)
      .pop();

    if (lastCacheControl) {
      return {
        role: "system",
        content: joined,
        providerOptions: { anthropic: { cacheControl: lastCacheControl } },
      };
    }
    return { role: "system", content: joined };
  }
  return null;
}
