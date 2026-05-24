import {
  demoteInlineSystemMessages,
  ensureModelMessageContentFormat,
} from "../tool-mapping.js";
import { repairToolCallPairIntegrity } from "../validation/tool-pair-integrity.js";

export interface OpenAIStreamPreflightMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

export interface OpenAIStreamMessagePreflightLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
}

export interface OpenAIStreamMessagePreflightInput<TMessage extends OpenAIStreamPreflightMessage> {
  requestId: string;
  messages: TMessage[];
  adapterFamily: string;
  debugProtocol: boolean;
  samplingOptions?: Record<string, unknown>;
  logger: OpenAIStreamMessagePreflightLogger;
  recordSessionEvent(event: {
    eventKind: string;
    component: string;
    detail: string;
  }): void;
}

export function prepareOpenAIStreamMessages<TMessage extends OpenAIStreamPreflightMessage>(
  input: OpenAIStreamMessagePreflightInput<TMessage>,
): TMessage[] {
  let messages = input.messages;
  const pairRepair = repairToolCallPairIntegrity(messages);
  if (pairRepair.repaired) {
    messages = pairRepair.messages as TMessage[];
    input.logger.warn(
      {
        reqId: input.requestId,
        orphanedToolCallIds: pairRepair.orphanedToolCallIds,
        count: pairRepair.orphanedToolCallIds.length,
      },
      "tool_pair_integrity_repair_applied",
    );
    input.recordSessionEvent({
      eventKind: "tool_pair_integrity_repaired",
      component: "validation",
      detail: `orphaned=${pairRepair.orphanedToolCallIds.length} ids=${pairRepair.orphanedToolCallIds.slice(0, 3).join(",")}`,
    });
  }

  if (input.adapterFamily === "minimax") {
    messages = demoteInlineSystemMessages(messages);
  }

  if (input.debugProtocol) {
    logPreStreamMessageDiagnostic({
      logger: input.logger,
      requestId: input.requestId,
      messages,
      samplingOptions: input.samplingOptions,
      adapterFamily: input.adapterFamily,
    });
  }

  return ensureModelMessageContentFormat(messages);
}

function logPreStreamMessageDiagnostic(input: {
  logger: OpenAIStreamMessagePreflightLogger;
  requestId: string;
  messages: OpenAIStreamPreflightMessage[];
  samplingOptions?: Record<string, unknown>;
  adapterFamily: string;
}): void {
  const msgShapes = input.messages.map((m, i) => {
    const role = m.role;
    const contentLen = typeof m.content === "string"
      ? m.content.length
      : m.content != null ? JSON.stringify(m.content).length : 0;
    const parts = Array.isArray(m.content) ? (m.content as Array<{ type?: string; toolCallId?: string; toolName?: string }>).map(
      (p) => ({ type: p.type, ...(p.toolCallId ? { toolCallId: p.toolCallId } : {}), ...(p.toolName ? { toolName: p.toolName } : {}) }),
    ) : undefined;
    return { i, role, contentLen, ...(parts ? { parts } : {}) };
  });
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const m of input.messages) {
    if (Array.isArray(m.content)) {
      for (const p of m.content as Array<{ type?: string; toolCallId?: string }>) {
        if (p.type === "tool-call" && p.toolCallId) toolCallIds.add(p.toolCallId);
        if (p.type === "tool-result" && p.toolCallId) toolResultIds.add(p.toolCallId);
      }
    }
  }
  const orphanedCalls = [...toolCallIds].filter((id) => !toolResultIds.has(id));
  const orphanedResults = [...toolResultIds].filter((id) => !toolCallIds.has(id));
  input.logger.info(
    {
      reqId: input.requestId,
      messageCount: msgShapes.length,
      msgShapes: msgShapes.slice(-20),
      orphanedCalls,
      orphanedResults,
      totalChars: msgShapes.reduce((sum, shape) => sum + shape.contentLen, 0),
      effectiveSampling: input.samplingOptions,
      adapterFamily: input.adapterFamily,
    },
    "pre_stream_message_diagnostic",
  );
}
