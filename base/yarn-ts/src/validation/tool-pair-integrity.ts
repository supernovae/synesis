/**
 * Pre-flight validation and repair for tool-call / tool-result pair integrity.
 *
 * The Vercel AI SDK's `standardizePrompt` and `convertToLanguageModelPrompt`
 * reject messages where an assistant tool_call has no matching tool result.
 * Multiple pipeline stages can create orphans: heavy compaction, transcript
 * pruning, tool-ID stabilization, or the client itself sending incomplete
 * transcripts.
 *
 * This module runs as a last-chance safety net just before the SDK call.
 * It scans for orphaned assistant tool_calls and synthesizes stub tool
 * results so the SDK validation passes.
 *
 * Handles BOTH formats:
 *  - OpenAI format: assistant.tool_calls[].id, tool.tool_call_id
 *  - SDK ModelMessage format: assistant.content[{type:"tool-call",toolCallId}],
 *    tool.content[{type:"tool-result",toolCallId}]
 */

type ContentBlock = Record<string, unknown>;

interface MessageLike {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

export interface ToolPairRepairResult {
  messages: MessageLike[];
  repaired: boolean;
  orphanedToolCallIds: string[];
}

function extractToolResultIds(m: MessageLike): string[] {
  const ids: string[] = [];
  if (m.role === "tool") {
    if (m.tool_call_id) ids.push(m.tool_call_id);
    if (Array.isArray(m.content)) {
      for (const block of m.content as ContentBlock[]) {
        if (block && typeof block === "object" && block.type === "tool-result" && typeof block.toolCallId === "string") {
          ids.push(block.toolCallId);
        }
      }
    }
  }
  return ids;
}

function extractToolCallIds(m: MessageLike): Array<{ callId: string; toolName: string }> {
  const calls: Array<{ callId: string; toolName: string }> = [];
  if (m.role !== "assistant") return calls;

  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      if (tc.id) calls.push({ callId: tc.id, toolName: tc.function?.name ?? "unknown" });
    }
  }

  if (Array.isArray(m.content)) {
    for (const block of m.content as ContentBlock[]) {
      if (block && typeof block === "object" && block.type === "tool-call" && typeof block.toolCallId === "string") {
        calls.push({ callId: block.toolCallId, toolName: typeof block.toolName === "string" ? block.toolName : "unknown" });
      }
    }
  }
  return calls;
}

function isSDKFormat(messages: MessageLike[]): boolean {
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content as ContentBlock[]) {
        if (block && typeof block === "object" && (block.type === "tool-call" || block.type === "text")) return true;
      }
    }
  }
  return false;
}

/**
 * Scan messages for orphaned tool_calls (assistant has tool_calls with IDs
 * that have no matching tool result) and inject synthetic stub results.
 */
export function repairToolCallPairIntegrity(messages: MessageLike[]): ToolPairRepairResult {
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    for (const id of extractToolResultIds(m)) {
      toolResultIds.add(id);
    }
  }

  const orphanedCalls: Array<{ msgIndex: number; callId: string; toolName: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    for (const tc of extractToolCallIds(messages[i])) {
      if (!toolResultIds.has(tc.callId)) {
        orphanedCalls.push({ msgIndex: i, callId: tc.callId, toolName: tc.toolName });
      }
    }
  }

  if (orphanedCalls.length === 0) {
    return { messages, repaired: false, orphanedToolCallIds: [] };
  }

  const sdk = isSDKFormat(messages);
  const result = [...messages];
  const insertions: Array<{ afterIndex: number; msg: MessageLike }> = [];

  for (const orphan of orphanedCalls) {
    const stubText = `[Tool result unavailable — output was compacted from context. The ${orphan.toolName} call completed but its result is no longer in the conversation window.]`;
    const stubResult: MessageLike = sdk
      ? {
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: orphan.callId,
            toolName: orphan.toolName,
            output: { type: "text", value: stubText },
          }],
        }
      : {
          role: "tool",
          tool_call_id: orphan.callId,
          name: orphan.toolName,
          content: stubText,
        };
    insertions.push({ afterIndex: orphan.msgIndex, msg: stubResult });
  }

  insertions.sort((a, b) => b.afterIndex - a.afterIndex);
  for (const ins of insertions) {
    let insertAt = ins.afterIndex + 1;
    while (insertAt < result.length && result[insertAt].role === "tool") {
      insertAt++;
    }
    result.splice(insertAt, 0, ins.msg);
  }

  return {
    messages: result,
    repaired: true,
    orphanedToolCallIds: orphanedCalls.map((o) => o.callId),
  };
}
