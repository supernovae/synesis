import type { PhaseAwareToolChoice, PhaseExecutionPolicyDecision } from "../governance/phase-execution-policy.js";
import type { SessionPhase } from "../governance/execution-governor.js";
import { executePhaseRequiredProviderCall } from "../providers/openai-provider-executor.js";
import { buildAiSdkTextRequestOptions } from "../providers/ai-sdk-request-options.js";
import {
  buildAssistantReplayParts,
  resolveServerSideToolResults,
  serverSideToolNameSet,
  splitServerSideToolCalls,
  type ServerSideToolCall,
  type ServerSideToolReplayResolvers,
} from "../providers/server-side-tool-replay.js";
import { appendSystemMessageAndNormalize } from "../transcript/system-message-ordering.js";
import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import type { StreamTokenUsage } from "../streaming/openai-stream-finalizer.js";

export interface OpenAINonStreamProviderMessage {
  role: string;
  content?: unknown;
}

export interface OpenAINonStreamProviderResultLike {
  text?: string;
  usage?: unknown;
  toolCalls?: ServerSideToolCall[];
}

export interface OpenAINonStreamProviderExecutorInput<
  TMessage extends OpenAINonStreamProviderMessage,
  TResult extends OpenAINonStreamProviderResultLike,
  TForensics,
> {
  initialMessages: TMessage[];
  model: unknown;
  orchestrationMaxOutputTokens: number;
  requestMaxTokens?: number | null;
  output?: unknown;
  samplingOptions?: Record<string, unknown>;
  tools?: unknown;
  initialToolChoice?: PhaseAwareToolChoice;
  providerOptions?: unknown;
  phasePolicy: PhaseExecutionPolicyDecision;
  governorPhase: SessionPhase;
  clampMaxOutputTokens(tokens: number): number;
  generateText(options: Record<string, unknown>): Promise<TResult>;
  readUsage(usage: unknown): StreamTokenUsage;
  captureForensics(messages: TMessage[], toolChoice: PhaseAwareToolChoice | undefined): TForensics | null;
  finalizeForensics(forensics: TForensics | null, usage: StreamTokenUsage): RequestForensicsRecord | undefined;
  recordSessionEvent(event: {
    eventKind: string;
    component: string;
    detail: string;
  }): void;
  serverSideToolResolvers: ServerSideToolReplayResolvers;
  maxServerSideRounds?: number;
}

export interface OpenAINonStreamProviderExecutorResult<
  TMessage extends OpenAINonStreamProviderMessage,
  TResult extends OpenAINonStreamProviderResultLike,
> {
  result: TResult;
  messages: TMessage[];
  toolChoice: PhaseAwareToolChoice | undefined;
  requestForensicsDone?: RequestForensicsRecord;
}

export async function executeOpenAINonStreamProviderLoop<
  TMessage extends OpenAINonStreamProviderMessage,
  TResult extends OpenAINonStreamProviderResultLike,
  TForensics,
>(
  input: OpenAINonStreamProviderExecutorInput<TMessage, TResult, TForensics>,
): Promise<OpenAINonStreamProviderExecutorResult<TMessage, TResult>> {
  let currentMessages = input.initialMessages;
  let effectiveToolChoice = input.initialToolChoice;
  let requestForensicsDone: RequestForensicsRecord | undefined;

  const providerCall = await executePhaseRequiredProviderCall<TResult, TMessage[], TForensics | null>({
    messages: currentMessages,
    toolChoice: effectiveToolChoice,
    phasePolicy: input.phasePolicy,
    governorPhase: input.governorPhase,
    appendSystemMessage: (messages, content) =>
      appendSystemMessageAndNormalize(
        messages as Array<{ role: string; content?: unknown }>,
        content,
      ) as TMessage[],
    getToolCalls: (result) => result.toolCalls ?? [],
    runAttempt: async (messages, toolChoice) => {
      const forensics = input.captureForensics(messages, toolChoice);
      const result = await generate(input, messages, toolChoice);
      return { result, context: forensics, messages, toolChoice };
    },
    finalizeAttempt: (attempt) => {
      const usage = input.readUsage(attempt.result.usage);
      requestForensicsDone = input.finalizeForensics(attempt.context ?? null, usage);
    },
    onValidationRetry: (reasons) => {
      input.recordSessionEvent({
        eventKind: "phase_required_validation_retry",
        component: "execution-governor",
        detail: `reasons=${reasons.join(",") || "unknown"}`,
      });
    },
    onValidationFallback: (reasons) => {
      input.recordSessionEvent({
        eventKind: "phase_required_validation_fallback",
        component: "execution-governor",
        detail: `fallback_after_retry reasons=${reasons.join(",") || "unknown"}`,
      });
    },
  });

  let finalResult = providerCall.result;
  currentMessages = providerCall.messages;
  effectiveToolChoice = providerCall.toolChoice;

  const serverSideTools = serverSideToolNameSet(input.serverSideToolResolvers);
  const maxServerSideRounds = input.maxServerSideRounds ?? 3;
  for (let round = 0; round < maxServerSideRounds; round++) {
    const allCalls = finalResult.toolCalls ?? [];
    const { serverCalls, clientCalls } = splitServerSideToolCalls(allCalls, serverSideTools);
    if (serverCalls.length === 0) break;
    if (clientCalls.length > 0) break;

    const toolResults = await resolveServerSideToolResults(serverCalls, input.serverSideToolResolvers);
    currentMessages = [
      ...currentMessages,
      { role: "assistant", content: buildAssistantReplayParts(finalResult.text, serverCalls) } as TMessage,
      { role: "tool", content: toolResults } as TMessage,
    ];

    const forensics = input.captureForensics(currentMessages, effectiveToolChoice);
    finalResult = await generate(input, currentMessages, effectiveToolChoice);
    const usage = input.readUsage(finalResult.usage);
    requestForensicsDone = input.finalizeForensics(forensics, usage);
  }

  return {
    result: finalResult,
    messages: currentMessages,
    toolChoice: effectiveToolChoice,
    requestForensicsDone,
  };
}

async function generate<
  TMessage extends OpenAINonStreamProviderMessage,
  TResult extends OpenAINonStreamProviderResultLike,
  TForensics,
>(
  input: OpenAINonStreamProviderExecutorInput<TMessage, TResult, TForensics>,
  messages: TMessage[],
  toolChoice: PhaseAwareToolChoice | undefined,
): Promise<TResult> {
  return input.generateText(buildAiSdkTextRequestOptions({
    model: input.model,
    messages,
    maxOutputTokens: input.clampMaxOutputTokens(
      Math.max(input.orchestrationMaxOutputTokens, input.requestMaxTokens ?? 0),
    ),
    output: input.output,
    samplingOptions: input.samplingOptions,
    tools: input.tools,
    toolChoice,
    providerOptions: input.providerOptions,
  }) as Record<string, unknown>);
}
