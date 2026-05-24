import type { ModelAdapter } from "../providers/model-adapter.js";
import type { ToolArgHardeningStats } from "../governance/tool-call-observability.js";
import {
  createOpenAIStreamAfterEventsHandler,
  type OpenAIStreamAfterEventsHandler,
} from "../streaming/openai-stream-after-events.js";
import {
  createOpenAIStreamComponents,
  type OpenAIStreamComponents,
} from "../streaming/openai-stream-components.js";
import {
  createOpenAIStreamLifecycleHandlers,
  type OpenAIStreamLifecycleCircuitBreaker,
  type OpenAIStreamLifecycleHandlers,
  type OpenAIStreamLifecycleLogger,
  type OpenAIStreamLifecycleSession,
  type OpenAIStreamLifecycleSpan,
  type OpenAIStreamUpstreamErrorDiagnostics,
} from "../streaming/openai-stream-lifecycle.js";
import {
  startOpenAIStreamSseRuntime,
  type OpenAIStreamAbortRuntime,
  type OpenAIStreamHeartbeat,
  type OpenAIStreamSseRaw,
} from "../streaming/openai-stream-runtime.js";
import type { StreamRouteEvent, StreamRouteScope } from "../streaming/stream-route-scope.js";

export interface OpenAIStreamRouteRuntimeInput {
  raw: OpenAIStreamSseRaw;
  headers: Record<string, string>;
  scope: StreamRouteScope;
  resolvedModelId: string;
  messages: Array<{ role: string; content: unknown }>;
  tierConfig?: {
    baseUrl?: string;
    backendModel?: string;
  };
  write(raw: NodeJS.WritableStream & { destroyed?: boolean }, data: string): boolean;
  computePrefixFingerprint(messages: Array<{ role: string; content: unknown }>): string | undefined;
  heartbeatIntervalMs: number;
  longWaitEventMs: number;
  startHeartbeat(input: {
    raw: OpenAIStreamSseRaw;
    intervalMs: number;
    longWaitEventMs: number;
    onLongWait?: (elapsedMs: number) => void;
  }): OpenAIStreamHeartbeat;
  recordSessionEvent(event: StreamRouteEvent): void;
  abortRuntime: OpenAIStreamAbortRuntime;
  admissionRelease(): void;
  session: OpenAIStreamLifecycleSession;
  span: OpenAIStreamLifecycleSpan;
  circuitBreakers: OpenAIStreamLifecycleCircuitBreaker;
  logger: OpenAIStreamLifecycleLogger & {
    warn(obj: Record<string, unknown>, msg?: string): void;
  };
  extractUpstreamErrorDiagnostics(error: unknown): OpenAIStreamUpstreamErrorDiagnostics;
  adapter: Pick<ModelAdapter, "family">;
  stats: Pick<ToolArgHardeningStats, "qwenParserMismatchSuspectCount">;
  recordBlockedDiscovery(sessionKey: string, count: number): void;
  getBlockedDiscoveryCount(sessionKey: string): number;
}

export interface OpenAIStreamRouteRuntime {
  heartbeat: OpenAIStreamHeartbeat;
  components: OpenAIStreamComponents;
  lifecycle: OpenAIStreamLifecycleHandlers;
  afterEvents: OpenAIStreamAfterEventsHandler;
}

export function createOpenAIStreamRouteRuntime(
  input: OpenAIStreamRouteRuntimeInput,
): OpenAIStreamRouteRuntime {
  const heartbeat = startOpenAIStreamSseRuntime({
    raw: input.raw,
    headers: input.headers,
    model: input.resolvedModelId,
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    longWaitEventMs: input.longWaitEventMs,
    startHeartbeat: input.startHeartbeat,
    recordSessionEvent: input.recordSessionEvent,
  });

  const components = createOpenAIStreamComponents({
    raw: input.raw,
    requestId: input.scope.requestId,
    resolvedModelId: input.resolvedModelId,
    messages: input.messages,
    tierConfig: input.tierConfig,
    write: input.write,
    computePrefixFingerprint: input.computePrefixFingerprint,
    recordSessionEvent: input.recordSessionEvent,
  });

  const lifecycle = createOpenAIStreamLifecycleHandlers({
    requestId: input.scope.requestId,
    model: input.resolvedModelId,
    orgId: input.scope.orgId,
    sessionKey: input.scope.sessionKey,
    userId: input.scope.userId,
    session: input.session,
    abortSignal: input.abortRuntime.abortController.signal,
    hardTimeout: input.abortRuntime.hardTimeout,
    admissionRelease: input.admissionRelease,
    streamState: components.streamState,
    writer: components.writer,
    span: input.span,
    circuitBreakers: input.circuitBreakers,
    logger: input.logger,
    extractUpstreamErrorDiagnostics: input.extractUpstreamErrorDiagnostics,
    recordSessionEvent: input.recordSessionEvent,
  });

  const afterEvents = createOpenAIStreamAfterEventsHandler({
    adapter: input.adapter,
    localLikeBaseUrl: components.localLikeBaseUrl,
    requestId: input.scope.requestId,
    resolvedModelId: input.resolvedModelId,
    baseUrl: components.tierConfig?.baseUrl,
    sessionKey: input.scope.sessionKey,
    userId: input.scope.userId,
    orgId: input.scope.orgId,
    streamState: components.streamState,
    accumulator: components.accumulator,
    blockedDetails: components.blockedDetails,
    stats: input.stats,
    logger: input.logger,
    recordBlockedDiscovery: input.recordBlockedDiscovery,
    getBlockedDiscoveryCount: input.getBlockedDiscoveryCount,
    recordSessionEvent: input.recordSessionEvent,
  });

  return {
    heartbeat,
    components,
    lifecycle,
    afterEvents,
  };
}
