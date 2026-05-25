import type { ModelAdapter } from "../providers/model-adapter.js";
import { buildCacheShapeDiagnostics } from "../telemetry/cache-shape-diagnostics.js";
import type { OptimizationCacheDiagnostics } from "../telemetry/optimization-ledger.js";
import {
  createClaudeStreamRouteComponents,
  type ClaudeStreamComponents,
} from "./claude-stream-components.js";
import {
  prepareClaudeStreamProviderRequest,
  type ClaudeStreamProviderMessage,
  type ClaudeStreamProviderPreflightResult,
} from "./claude-stream-provider-request.js";
import {
  startClaudeStreamRouteRuntime,
  type ClaudeStreamRouteRuntime,
} from "./claude-stream-runtime.js";
import type { OpenAIStreamHeartbeat, OpenAIStreamSseRaw } from "./openai-stream-runtime.js";
import type { StreamRouteEventSink, StreamRouteScope } from "./stream-route-scope.js";

export interface ClaudeStreamRouteStartedStream {
  fullStream: AsyncIterable<unknown>;
  totalUsage: PromiseLike<unknown>;
  text: PromiseLike<string>;
}

export interface ClaudeStreamRouteStartInput<TMessage extends ClaudeStreamProviderMessage> {
  scope: StreamRouteScope;
  recordSessionEvent: StreamRouteEventSink;
  raw: OpenAIStreamSseRaw;
  headers: Record<string, string>;
  heartbeatIntervalMs: number;
  longWaitEventMs: number;
  startHeartbeat(input: {
    raw: OpenAIStreamSseRaw;
    intervalMs: number;
    longWaitEventMs: number;
    onLongWait?: (elapsedMs: number) => void;
  }): OpenAIStreamHeartbeat;
  createMessageId(): string;
  sendSse(event: string, data: unknown): boolean;
  streamText(options: unknown): ClaudeStreamRouteStartedStream;
  request: {
    requestId: string;
    model: unknown;
    messages: TMessage[];
    adapter: Pick<ModelAdapter, "family" | "supportsThinking">;
    abortSignal: AbortSignal;
    orchestrationMaxOutputTokens: number;
    requestMaxTokens?: number | null;
    samplingOptions?: Record<string, unknown>;
    stopSequences?: unknown;
    tools?: unknown;
    toolChoice?: unknown;
    providerOptions?: unknown;
    clampMaxOutputTokens(tokens: number): number;
    logger: {
      warn(obj: Record<string, unknown>, msg?: string): void;
    };
  };
  components: {
    tierConfig?: {
      baseUrl?: string;
      backendModel?: string;
    };
    resolvedModelId: string;
    tools: unknown[];
    computePrefixFingerprint(messages: Array<{ role: string; content: unknown }>): string | undefined;
  };
}

export interface ClaudeStreamRouteStartResult<TMessage extends ClaudeStreamProviderMessage> {
  providerRequest: ClaudeStreamProviderPreflightResult<TMessage>;
  messages: TMessage[];
  cacheShapeDiagnostics: OptimizationCacheDiagnostics;
  streamed: ClaudeStreamRouteStartedStream;
  runtime: ClaudeStreamRouteRuntime;
  components: ClaudeStreamComponents;
}

export function startClaudeStreamRoute<TMessage extends ClaudeStreamProviderMessage>(
  input: ClaudeStreamRouteStartInput<TMessage>,
): ClaudeStreamRouteStartResult<TMessage> {
  const providerRequest = prepareClaudeStreamProviderRequest({
    ...input.request,
    recordSessionEvent: (event) => input.recordSessionEvent(
      input.scope.sessionKey,
      input.scope.userId,
      input.scope.orgId,
      event.eventKind,
      event.component,
      event.detail,
      input.scope.requestId,
    ),
  });
  const cacheShapeDiagnostics = buildCacheShapeDiagnostics({
    messages: providerRequest.messages,
    tools: input.components.tools,
    providerOptions: providerRequest.providerOptions,
  });
  const streamed = input.streamText(providerRequest.options);
  const runtime = startClaudeStreamRouteRuntime({
    raw: input.raw,
    headers: input.headers,
    model: input.components.resolvedModelId,
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    longWaitEventMs: input.longWaitEventMs,
    startHeartbeat: input.startHeartbeat,
    ...input.scope,
    createMessageId: input.createMessageId,
    sendSse: input.sendSse,
    recordSessionEvent: input.recordSessionEvent,
  });
  const components = createClaudeStreamRouteComponents({
    modelMessages: providerRequest.messages,
    tierConfig: input.components.tierConfig,
    resolvedModelId: input.components.resolvedModelId,
    ...input.scope,
    computePrefixFingerprint: input.components.computePrefixFingerprint,
    sendSse: input.sendSse,
    recordSessionEvent: input.recordSessionEvent,
  });

  return {
    providerRequest,
    messages: providerRequest.messages,
    cacheShapeDiagnostics,
    streamed,
    runtime,
    components,
  };
}
