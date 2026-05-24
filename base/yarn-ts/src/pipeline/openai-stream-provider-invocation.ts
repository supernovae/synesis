import { annotateCacheBreakpoints } from "../context/provider-cache-hints.js";
import type { ModelAdapter } from "../providers/model-adapter.js";
import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import {
  createOpenAIStreamProviderRequestOptions,
  type OpenAIStreamProviderRequestInput,
} from "../streaming/openai-stream-provider-request.js";
import {
  prepareOpenAIStreamMessages,
  type OpenAIStreamMessagePreflightLogger,
  type OpenAIStreamPreflightMessage,
} from "../streaming/openai-stream-message-preflight.js";
import {
  createOpenAIStreamAbortRuntime,
  type OpenAIStreamAbortRuntime,
  type OpenAIStreamRuntimeEventRecorder,
} from "../streaming/openai-stream-runtime.js";
import { captureStreamRequestForensics } from "../streaming/stream-request-forensics.js";
import type { StreamRouteScope } from "../streaming/stream-route-scope.js";

export interface OpenAIStreamProviderInvocationInput<
  TMessage extends OpenAIStreamPreflightMessage,
  TForensics,
  TStreamed,
> {
  scope: StreamRouteScope;
  startedAtMs: number;
  path: string;
  resolvedModelId: string;
  providerModel: unknown;
  messages: TMessage[];
  effectiveTools: unknown[];
  sdkTools?: unknown;
  toolChoice: unknown;
  providerOptions?: unknown;
  output?: unknown;
  samplingOptions?: Record<string, unknown>;
  orchestrationMaxOutputTokens: number;
  requestMaxTokens?: number | null;
  requestMaxCompletionTokens?: number | null;
  adapter: Pick<ModelAdapter, "family" | "cacheMarkerBackend">;
  debugProtocol: boolean;
  longWaitEventMs: number;
  hardTimeoutMs: number;
  phasePolicy?: RequestForensicsRecord["phasePolicy"];
  capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"];
  logger: OpenAIStreamMessagePreflightLogger;
  recordSessionEvent: OpenAIStreamRuntimeEventRecorder;
  clampMaxOutputTokens(tokens: number): number;
  captureForensics: Parameters<typeof captureStreamRequestForensics<TForensics>>[0]["capture"];
  streamText(options: Record<string, unknown>): TStreamed;
}

export interface OpenAIStreamProviderInvocationResult<
  TMessage extends OpenAIStreamPreflightMessage,
  TForensics,
  TStreamed,
> {
  messages: TMessage[];
  requestForensics: TForensics;
  abortRuntime: OpenAIStreamAbortRuntime;
  streamed: TStreamed;
}

export function invokeOpenAIStreamProvider<
  TMessage extends OpenAIStreamPreflightMessage,
  TForensics,
  TStreamed,
>(
  input: OpenAIStreamProviderInvocationInput<TMessage, TForensics, TStreamed>,
): OpenAIStreamProviderInvocationResult<TMessage, TForensics, TStreamed> {
  const requestForensics = captureStreamRequestForensics({
    scope: input.scope,
    path: input.path,
    resolvedModelId: input.resolvedModelId,
    messages: input.messages,
    tools: input.effectiveTools,
    toolChoice: input.toolChoice,
    providerOptions: input.providerOptions,
    phasePolicy: input.phasePolicy,
    capabilityMatrix: input.capabilityMatrix,
    capture: input.captureForensics,
  });

  let messages = input.messages;
  const adapterCacheBackend = input.adapter.cacheMarkerBackend?.() ?? "none";
  if (adapterCacheBackend === "anthropic") {
    messages = annotateCacheBreakpoints(messages, "anthropic_explicit").messages as TMessage[];
  }

  const abortRuntime = createOpenAIStreamAbortRuntime({
    requestId: input.scope.requestId,
    model: input.resolvedModelId,
    startedAtMs: input.startedAtMs,
    longWaitEventMs: input.longWaitEventMs,
    hardTimeoutMs: input.hardTimeoutMs,
    recordSessionEvent: input.recordSessionEvent,
  });

  messages = prepareOpenAIStreamMessages({
    requestId: input.scope.requestId,
    messages,
    adapterFamily: input.adapter.family,
    debugProtocol: input.debugProtocol,
    samplingOptions: input.samplingOptions,
    logger: input.logger,
    recordSessionEvent: input.recordSessionEvent,
  });

  const providerRequest = createOpenAIStreamProviderRequestOptions({
    model: input.providerModel,
    messages,
    abortSignal: abortRuntime.abortController.signal,
    orchestrationMaxOutputTokens: input.orchestrationMaxOutputTokens,
    requestMaxTokens: input.requestMaxTokens,
    requestMaxCompletionTokens: input.requestMaxCompletionTokens,
    output: input.output,
    samplingOptions: input.samplingOptions,
    tools: input.sdkTools,
    toolChoice: input.toolChoice,
    providerOptions: input.providerOptions,
    clampMaxOutputTokens: input.clampMaxOutputTokens,
  } satisfies OpenAIStreamProviderRequestInput);

  return {
    messages,
    requestForensics,
    abortRuntime,
    streamed: input.streamText(providerRequest as Record<string, unknown>),
  };
}
