import {
  applyClaudeNonStreamDiscoveryGuardrails,
  type ClaudeNonStreamDiscoveryInput,
} from "./claude-nonstream-discovery.js";
import {
  finalizeClaudeNonStreamText,
  type ClaudeNonStreamFinalizerInput,
  type ClaudeNonStreamFinalizerResult,
} from "./claude-nonstream-finalizer.js";
import {
  buildClaudeNonStreamResponseContent,
  type ClaudeNonStreamResponseContentBlock,
  type ClaudeNonStreamServerWebSearchEvent,
} from "./claude-nonstream-response.js";
import { runClaudeNonStreamTelemetry, type ClaudeNonStreamTelemetryInput } from "./claude-nonstream-telemetry.js";
import {
  prepareClaudeNonStreamRouteToolCalls,
  type ClaudeNonStreamExternalToolCall,
  type ClaudeNonStreamRouteToolCallInput,
  type ClaudeNonStreamToolCall,
} from "./claude-nonstream-tool-calls.js";
import type { StreamTokenUsage } from "./openai-stream-finalizer.js";

export interface ClaudeNonStreamProviderResultFields {
  text?: string;
  reasoning?: unknown;
  usage?: unknown;
  toolCalls?: ClaudeNonStreamToolCall[];
}

export interface ClaudeNonStreamPostProviderInput<TChecklist, TVerification, TPlanGraph> {
  result: ClaudeNonStreamProviderResultFields;
  serverWebSearchEvents: ClaudeNonStreamServerWebSearchEvent[];
  readUsage(usage: unknown): StreamTokenUsage;
  toolCallInput: Omit<ClaudeNonStreamRouteToolCallInput, "toolCalls">;
  discoveryInput: Omit<
    ClaudeNonStreamDiscoveryInput<ClaudeNonStreamExternalToolCall>,
    "calls" | "finalText" | "stopReason"
  >;
  finalizerInput: Omit<
    ClaudeNonStreamFinalizerInput<TChecklist, TVerification, TPlanGraph>,
    "stopReason" | "assistantText"
  >;
  telemetryInput: Omit<
    ClaudeNonStreamTelemetryInput,
    "finishReason" | "usage" | "toolNames" | "gate"
  >;
}

export interface ClaudeNonStreamPostProviderResult {
  content: ClaudeNonStreamResponseContentBlock[];
  usage: StreamTokenUsage;
  stopReason: string;
  finalText: string;
  toolCalls: ClaudeNonStreamExternalToolCall[];
  finalized: ClaudeNonStreamFinalizerResult;
}

export async function processClaudeNonStreamProviderResult<TChecklist, TVerification, TPlanGraph>(
  input: ClaudeNonStreamPostProviderInput<TChecklist, TVerification, TPlanGraph>,
): Promise<ClaudeNonStreamPostProviderResult> {
  let toolCalls = prepareClaudeNonStreamRouteToolCalls({
    ...input.toolCallInput,
    toolCalls: input.result.toolCalls ?? [],
  });
  const usage = input.readUsage(input.result.usage);
  let stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";
  let finalText = input.result.text ?? "";

  const discovery = await applyClaudeNonStreamDiscoveryGuardrails({
    ...input.discoveryInput,
    calls: toolCalls,
    finalText,
    stopReason,
  });
  toolCalls = discovery.calls;
  finalText = discovery.finalText;
  stopReason = discovery.stopReason;

  const finalized = await finalizeClaudeNonStreamText({
    ...input.finalizerInput,
    stopReason,
    assistantText: finalText,
  });
  finalText = finalized.finalText;

  runClaudeNonStreamTelemetry({
    ...input.telemetryInput,
    finishReason: stopReason,
    usage,
    toolNames: toolCalls.map((toolCall) => toolCall.toolName),
    gate: {
      applied: finalized.gateApplied,
      missingMust: finalized.missingMust,
      missingShould: finalized.missingShould,
      blockedVerification: finalized.gateBlockedVerification,
      criticBlocked: finalized.criticBlocked,
    },
  });

  const content = buildClaudeNonStreamResponseContent({
    reasoning: input.result.reasoning,
    serverWebSearchEvents: input.serverWebSearchEvents,
    finalText,
    toolCalls,
  });

  return {
    content,
    usage,
    stopReason,
    finalText,
    toolCalls,
    finalized,
  };
}
