import {
  buildAiSdkTextRequestOptions,
  type AiSdkTextRequestOptions,
} from "../providers/ai-sdk-request-options.js";
import type { ModelAdapter } from "../providers/model-adapter.js";
import {
  demoteInlineSystemMessages,
  ensureModelMessageContentFormat,
} from "../tool-mapping.js";
import { repairToolCallPairIntegrity } from "../validation/tool-pair-integrity.js";

export interface ClaudeStreamProviderMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

export interface ClaudeStreamProviderRequestInput {
  model: unknown;
  messages: unknown;
  abortSignal: AbortSignal;
  orchestrationMaxOutputTokens: number;
  requestMaxTokens?: number | null;
  samplingOptions?: Record<string, unknown>;
  stopSequences?: unknown;
  tools?: unknown;
  toolChoice?: unknown;
  providerOptions?: unknown;
  clampMaxOutputTokens(tokens: number): number;
}

export interface ClaudeStreamProviderPreflightInput<TMessage extends ClaudeStreamProviderMessage>
  extends Omit<ClaudeStreamProviderRequestInput, "messages" | "providerOptions"> {
  requestId: string;
  messages: TMessage[];
  adapter: Pick<ModelAdapter, "family" | "supportsThinking">;
  providerOptions?: unknown;
  logger: {
    warn(obj: Record<string, unknown>, msg?: string): void;
  };
  recordSessionEvent(event: {
    eventKind: string;
    component: string;
    detail: string;
  }): void;
}

export interface ClaudeStreamProviderPreflightResult<TMessage extends ClaudeStreamProviderMessage> {
  messages: TMessage[];
  providerOptions?: unknown;
  options: AiSdkTextRequestOptions;
}

export function prepareClaudeStreamProviderRequest<TMessage extends ClaudeStreamProviderMessage>(
  input: ClaudeStreamProviderPreflightInput<TMessage>,
): ClaudeStreamProviderPreflightResult<TMessage> {
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

  if (input.adapter.family === "minimax") {
    messages = demoteInlineSystemMessages(messages);
  }

  const providerOptions = removeUnsupportedThinkingProviderOptions(
    input.providerOptions,
    input.adapter.supportsThinking,
  );
  messages = ensureModelMessageContentFormat(messages) as TMessage[];

  return {
    messages,
    providerOptions,
    options: createClaudeStreamProviderRequestOptions({
      model: input.model,
      messages,
      abortSignal: input.abortSignal,
      orchestrationMaxOutputTokens: input.orchestrationMaxOutputTokens,
      requestMaxTokens: input.requestMaxTokens,
      samplingOptions: input.samplingOptions,
      stopSequences: input.stopSequences,
      tools: input.tools,
      toolChoice: input.toolChoice,
      providerOptions,
      clampMaxOutputTokens: input.clampMaxOutputTokens,
    }),
  };
}

export function createClaudeStreamProviderRequestOptions(
  input: ClaudeStreamProviderRequestInput,
): AiSdkTextRequestOptions {
  return buildAiSdkTextRequestOptions({
    model: input.model,
    messages: input.messages,
    abortSignal: input.abortSignal,
    maxOutputTokens: input.clampMaxOutputTokens(
      Math.max(input.orchestrationMaxOutputTokens, input.requestMaxTokens ?? 0),
    ),
    samplingOptions: input.samplingOptions,
    stopSequences: input.stopSequences,
    tools: input.tools,
    toolChoice: input.toolChoice,
    providerOptions: input.providerOptions,
  });
}

function removeUnsupportedThinkingProviderOptions(
  providerOptions: unknown,
  supportsThinking: boolean,
): unknown {
  if (supportsThinking || !providerOptions || typeof providerOptions !== "object") {
    return providerOptions;
  }
  const next = { ...(providerOptions as Record<string, Record<string, unknown>>) };
  if (next.openai) {
    next.openai = { ...next.openai };
    delete next.openai.thinking;
    delete next.openai.enable_thinking;
    if (Object.keys(next.openai).length === 0) {
      delete next.openai;
    }
  }
  return Object.keys(next).length === 0 ? undefined : next;
}
