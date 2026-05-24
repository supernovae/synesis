import { buildAiSdkTextRequestOptions } from "../providers/ai-sdk-request-options.js";
import {
  buildRequiredRepairPrompt,
  validateRequiredToolCalls,
  type PhaseExecutionPolicyDecision,
} from "../governance/phase-execution-policy.js";
import type { SessionPhase } from "../governance/execution-governor.js";
import { appendSystemMessageAndNormalize } from "../transcript/system-message-ordering.js";
import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import type { ClaudeNonStreamServerWebSearchEvent } from "./claude-nonstream-response.js";
import type { StreamTokenUsage } from "./openai-stream-finalizer.js";

export interface ClaudeNonStreamProviderToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ClaudeNonStreamProviderResultLike {
  text?: string;
  usage?: unknown;
  toolCalls?: ClaudeNonStreamProviderToolCall[];
}

export interface ClaudeNonStreamProviderMessage {
  role: string;
  content?: unknown;
}

export interface ClaudeNonStreamProviderExecutorInput<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
> {
  initialMessages: TMessage[];
  model: unknown;
  resolvedModelId: string;
  orchestrationMaxOutputTokens: number;
  requestMaxTokens?: number | null;
  samplingOptions?: Record<string, unknown>;
  stopSequences?: unknown;
  tools?: unknown;
  initialToolChoice?: unknown;
  providerOptions?: unknown;
  phasePolicy: PhaseExecutionPolicyDecision;
  governorPhase: SessionPhase;
  nativeWebSearchRequested: boolean;
  clampMaxOutputTokens(tokens: number): number;
  generateText(options: Record<string, unknown>): Promise<TResult>;
  readUsage(usage: unknown): StreamTokenUsage;
  captureForensics(messages: TMessage[], toolChoice: unknown): unknown;
  finalizeForensics(forensics: unknown, usage: StreamTokenUsage): RequestForensicsRecord | undefined;
  recordSessionEvent(event: {
    eventKind: string;
    component: string;
    detail: string;
  }): void;
  isServerWebSearchTool(toolName: string): boolean;
  resolveServerWebSearch(input: Record<string, unknown>): Promise<unknown>;
  toServerWebSearchEvent(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
    response: Record<string, unknown>,
  ): ClaudeNonStreamServerWebSearchEvent;
}

export interface ClaudeNonStreamProviderExecutorResult<TResult extends ClaudeNonStreamProviderResultLike> {
  result: TResult;
  serverWebSearchEvents: ClaudeNonStreamServerWebSearchEvent[];
  requestForensicsDone?: RequestForensicsRecord;
}

export async function executeClaudeNonStreamProviderLoop<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
>(
  input: ClaudeNonStreamProviderExecutorInput<TMessage, TResult>,
): Promise<ClaudeNonStreamProviderExecutorResult<TResult>> {
  let currentMessages = input.initialMessages;
  let effectiveToolChoice = input.initialToolChoice;
  let result: TResult | null = null;
  let requestForensicsDone: RequestForensicsRecord | undefined;
  let requiredValidationCompleted = false;
  const serverWebSearchEvents: ClaudeNonStreamServerWebSearchEvent[] = [];

  for (let round = 0; round < 3; round++) {
    const roundResult = await generateWithForensics(input, currentMessages, effectiveToolChoice);
    result = roundResult.result;
    requestForensicsDone = roundResult.requestForensicsDone;

    let allCalls = result.toolCalls ?? [];
    if (!requiredValidationCompleted && input.phasePolicy.toolChoice === "required") {
      requiredValidationCompleted = true;
      const requiredResult = await satisfyRequiredToolPolicy({
        input,
        currentMessages,
        effectiveToolChoice,
        result,
        requestForensicsDone,
        allCalls,
      });
      currentMessages = requiredResult.currentMessages;
      effectiveToolChoice = requiredResult.effectiveToolChoice;
      result = requiredResult.result;
      requestForensicsDone = requiredResult.requestForensicsDone;
      allCalls = result.toolCalls ?? [];
    }

    const serverCalls = input.nativeWebSearchRequested
      ? allCalls.filter((toolCall) => input.isServerWebSearchTool(toolCall.toolName))
      : [];
    if (serverCalls.length === 0) break;

    const replay = await buildServerWebSearchReplay(input, result, serverCalls);
    serverWebSearchEvents.push(...replay.events);
    currentMessages = [
      ...currentMessages,
      { role: "assistant", content: replay.assistantParts } as TMessage,
      { role: "tool", content: replay.toolResults } as TMessage,
    ];
  }

  if (!result) {
    throw new Error("empty_generation_result");
  }

  return {
    result,
    serverWebSearchEvents,
    requestForensicsDone,
  };
}

async function satisfyRequiredToolPolicy<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
>(args: {
  input: ClaudeNonStreamProviderExecutorInput<TMessage, TResult>;
  currentMessages: TMessage[];
  effectiveToolChoice: unknown;
  result: TResult;
  requestForensicsDone?: RequestForensicsRecord;
  allCalls: ClaudeNonStreamProviderToolCall[];
}): Promise<{
  currentMessages: TMessage[];
  effectiveToolChoice: unknown;
  result: TResult;
  requestForensicsDone?: RequestForensicsRecord;
}> {
  const { input } = args;
  let currentMessages = args.currentMessages;
  let effectiveToolChoice = args.effectiveToolChoice;
  let validation = validateRequiredToolCalls(args.allCalls, input.phasePolicy);
  if (validation.valid) {
    return {
      currentMessages,
      effectiveToolChoice,
      result: args.result,
      requestForensicsDone: args.requestForensicsDone,
    };
  }

  input.recordSessionEvent({
    eventKind: "phase_required_validation_retry",
    component: "execution-governor",
    detail: `reasons=${validation.reasons.join(",") || "unknown"}`,
  });
  currentMessages = appendSystemMessageAndNormalize(
    currentMessages,
    buildRequiredRepairPrompt(input.governorPhase, input.phasePolicy.allowedCanonicalTools),
  );
  let generated = await generateWithForensics(input, currentMessages, effectiveToolChoice);
  let result = generated.result;
  let requestForensicsDone = generated.requestForensicsDone;
  validation = validateRequiredToolCalls(result.toolCalls ?? [], input.phasePolicy);
  if (!validation.valid) {
    input.recordSessionEvent({
      eventKind: "phase_required_validation_fallback",
      component: "execution-governor",
      detail: `fallback_after_retry reasons=${validation.reasons.join(",") || "unknown"}`,
    });
    effectiveToolChoice = "auto";
    currentMessages = appendSystemMessageAndNormalize(
      currentMessages,
      "Phase execution policy fallback: required tool-call contract failed after retry. Continue with tool_choice=auto and recover safely.",
    );
    generated = await generateWithForensics(input, currentMessages, effectiveToolChoice);
    result = generated.result;
    requestForensicsDone = generated.requestForensicsDone;
  }

  return {
    currentMessages,
    effectiveToolChoice,
    result,
    requestForensicsDone,
  };
}

async function generateWithForensics<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
>(
  input: ClaudeNonStreamProviderExecutorInput<TMessage, TResult>,
  messages: TMessage[],
  toolChoice: unknown,
): Promise<{ result: TResult; requestForensicsDone?: RequestForensicsRecord }> {
  const forensics = input.captureForensics(messages, toolChoice);
  const result = await input.generateText(buildAiSdkTextRequestOptions({
    model: input.model,
    messages,
    maxOutputTokens: input.clampMaxOutputTokens(
      Math.max(input.orchestrationMaxOutputTokens, input.requestMaxTokens ?? 0),
    ),
    samplingOptions: input.samplingOptions,
    stopSequences: input.stopSequences,
    tools: input.tools,
    toolChoice,
    providerOptions: input.providerOptions,
  }));
  const usage = input.readUsage(result.usage);
  return {
    result,
    requestForensicsDone: input.finalizeForensics(forensics, usage),
  };
}

async function buildServerWebSearchReplay<
  TMessage extends ClaudeNonStreamProviderMessage,
  TResult extends ClaudeNonStreamProviderResultLike,
>(
  input: ClaudeNonStreamProviderExecutorInput<TMessage, TResult>,
  result: TResult,
  serverCalls: ClaudeNonStreamProviderToolCall[],
): Promise<{
  events: ClaudeNonStreamServerWebSearchEvent[];
  assistantParts: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    output: { type: "text"; value: string };
  }>;
}> {
  const events: ClaudeNonStreamServerWebSearchEvent[] = [];
  const assistantParts: Array<
    { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = [];
  if (result.text) assistantParts.push({ type: "text", text: result.text });
  const toolResults: Array<{
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    output: { type: "text"; value: string };
  }> = [];

  for (const call of serverCalls) {
    const callInput = toObjectRecord(call.input);
    const searchOutput = await input.resolveServerWebSearch(callInput);
    const searchPayload = toObjectRecord(searchOutput, { error: "invalid_server_tool_payload" });
    events.push(input.toServerWebSearchEvent(call.toolCallId, call.toolName, callInput, searchPayload));
    assistantParts.push({
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: callInput,
    });
    toolResults.push({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: { type: "text", value: JSON.stringify(searchPayload) },
    });
  }

  if (assistantParts.length === 0) assistantParts.push({ type: "text", text: "" });
  return { events, assistantParts, toolResults };
}

function toObjectRecord(input: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : fallback;
}
