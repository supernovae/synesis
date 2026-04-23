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
 */

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

/**
 * Scan messages for orphaned tool_calls (assistant has tool_calls with IDs
 * that have no matching tool result) and inject synthetic stub results.
 */
export function repairToolCallPairIntegrity(messages: MessageLike[]): ToolPairRepairResult {
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      toolResultIds.add(m.tool_call_id);
    }
  }

  const orphanedCalls: Array<{ msgIndex: number; callId: string; toolName: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      if (!tc.id) continue;
      if (!toolResultIds.has(tc.id)) {
        orphanedCalls.push({
          msgIndex: i,
          callId: tc.id,
          toolName: tc.function?.name ?? "unknown",
        });
      }
    }
  }

  if (orphanedCalls.length === 0) {
    return { messages, repaired: false, orphanedToolCallIds: [] };
  }

  const result = [...messages];
  const insertions: Array<{ afterIndex: number; msg: MessageLike }> = [];

  for (const orphan of orphanedCalls) {
    const stubResult: MessageLike = {
      role: "tool",
      tool_call_id: orphan.callId,
      name: orphan.toolName,
      content: `[Tool result unavailable — output was compacted from context. The ${orphan.toolName} call completed but its result is no longer in the conversation window.]`,
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
