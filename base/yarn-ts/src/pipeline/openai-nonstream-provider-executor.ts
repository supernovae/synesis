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
import type { OpenAINonStreamRouteScope } from "./openai-nonstream-route-scope.js";

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

export interface OpenAINonStreamProviderForensicsContext<TMessage extends OpenAINonStreamProviderMessage> {
  sessionKey: string;
  requestId: string;
  path: string;
  resolvedModelId: string;
  stream: boolean;
  messages: TMessage[];
  tools?: unknown;
  toolChoice: PhaseAwareToolChoice | undefined;
  providerOptions?: unknown;
  phasePolicy?: RequestForensicsRecord["phasePolicy"];
  capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"];
}

export interface OpenAINonStreamProviderFinalizeForensicsContext {
  sessionKey: string;
  requestId: string;
  resolvedModelId: string;
}

export interface OpenAINonStreamProviderExecutorRouteInput<
  TMessage extends OpenAINonStreamProviderMessage,
  TResult extends OpenAINonStreamProviderResultLike,
  TForensics,
> extends Omit<
    OpenAINonStreamProviderExecutorInput<TMessage, TResult, TForensics>,
    "captureForensics" | "finalizeForensics" | "recordSessionEvent" | "serverSideToolResolvers"
  > {
  scope: Pick<OpenAINonStreamRouteScope, "sessionKey" | "requestId" | "recordEvent">;
  resolvedModelId: string;
  forensics: {
    path: string;
    stream: boolean;
    tools?: unknown;
    phasePolicy?: RequestForensicsRecord["phasePolicy"];
    capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"];
    capture(context: OpenAINonStreamProviderForensicsContext<TMessage>): TForensics | null;
    finalize(
      forensics: TForensics | null,
      usage: StreamTokenUsage,
      context: OpenAINonStreamProviderFinalizeForensicsContext,
    ): RequestForensicsRecord | undefined;
  };
  serverSideToolResolvers: ServerSideToolReplayResolvers;
}

export interface OpenAINonStreamProviderForensicsAdapterInput<TMessage extends OpenAINonStreamProviderMessage, TForensics> {
  path: string;
  stream: boolean;
  tools?: unknown;
  phasePolicy?: RequestForensicsRecord["phasePolicy"];
  capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"];
  captureRequestForensics(
    sessionKey: string,
    requestId: string,
    path: string,
    resolvedModelId: string,
    stream: boolean,
    messages: TMessage[],
    tools: unknown[] | undefined,
    toolChoice: PhaseAwareToolChoice | undefined,
    providerOptions: unknown,
    phasePolicy?: RequestForensicsRecord["phasePolicy"],
    capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"],
  ): TForensics | null;
  finalizeRequestForensics(
    forensics: TForensics | null,
    usage: StreamTokenUsage,
    context: OpenAINonStreamProviderFinalizeForensicsContext,
  ): RequestForensicsRecord | undefined;
}

export function createOpenAINonStreamProviderForensics<
  TMessage extends OpenAINonStreamProviderMessage,
  TForensics,
>(
  input: OpenAINonStreamProviderForensicsAdapterInput<TMessage, TForensics>,
): OpenAINonStreamProviderExecutorRouteInput<TMessage, OpenAINonStreamProviderResultLike, TForensics>["forensics"] {
  return {
    path: input.path,
    stream: input.stream,
    tools: input.tools,
    phasePolicy: input.phasePolicy,
    capabilityMatrix: input.capabilityMatrix,
    capture: (context) => input.captureRequestForensics(
      context.sessionKey,
      context.requestId,
      context.path,
      context.resolvedModelId,
      context.stream,
      context.messages,
      context.tools as unknown[] | undefined,
      context.toolChoice,
      context.providerOptions,
      context.phasePolicy,
      context.capabilityMatrix,
    ),
    finalize: input.finalizeRequestForensics,
  };
}

export interface OpenAINonStreamServerSideToolResolverInput {
  artifactToolName: string;
  knowledgeToolName: string;
  devDocsToolName: string;
  webSearchToolName: string;
  webSearchToolAlias: string;
  retrieveArtifact(handle: string, query?: string): Promise<{ content: string }>;
  resolveKnowledge(input: Record<string, unknown>): Promise<unknown>;
  resolveDevDocs(input: Record<string, unknown>): Promise<unknown>;
  resolveWebSearch(input: Record<string, unknown>): Promise<unknown>;
}

export function createOpenAINonStreamServerSideToolResolvers(
  input: OpenAINonStreamServerSideToolResolverInput,
): ServerSideToolReplayResolvers {
  return {
    artifactToolName: input.artifactToolName,
    knowledgeToolName: input.knowledgeToolName,
    devDocsToolName: input.devDocsToolName,
    webSearchToolName: input.webSearchToolName,
    webSearchToolAlias: input.webSearchToolAlias,
    retrieveArtifact: async (toolInput) => {
      const result = await input.retrieveArtifact(
        typeof toolInput.artifact_handle === "string" ? toolInput.artifact_handle : "",
        typeof toolInput.query === "string" ? toolInput.query : undefined,
      );
      return result.content;
    },
    resolveKnowledge: input.resolveKnowledge,
    resolveDevDocs: input.resolveDevDocs,
    resolveWebSearch: input.resolveWebSearch,
  };
}

export function createOpenAINonStreamProviderExecutorInput<
  TMessage extends OpenAINonStreamProviderMessage,
  TResult extends OpenAINonStreamProviderResultLike,
  TForensics,
>(
  input: OpenAINonStreamProviderExecutorRouteInput<TMessage, TResult, TForensics>,
): OpenAINonStreamProviderExecutorInput<TMessage, TResult, TForensics> {
  return {
    ...input,
    recordSessionEvent: input.scope.recordEvent,
    captureForensics: (messages, toolChoice) => input.forensics.capture({
      sessionKey: input.scope.sessionKey,
      requestId: input.scope.requestId,
      path: input.forensics.path,
      resolvedModelId: input.resolvedModelId,
      stream: input.forensics.stream,
      messages,
      tools: input.forensics.tools,
      toolChoice,
      providerOptions: input.providerOptions,
      phasePolicy: input.forensics.phasePolicy,
      capabilityMatrix: input.forensics.capabilityMatrix,
    }),
    finalizeForensics: (forensics, usage) => input.forensics.finalize(
      forensics,
      usage,
      {
        sessionKey: input.scope.sessionKey,
        requestId: input.scope.requestId,
        resolvedModelId: input.resolvedModelId,
      },
    ),
  };
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
