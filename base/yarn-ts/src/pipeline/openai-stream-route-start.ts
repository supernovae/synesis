import {
  type StreamRouteEvent,
  type StreamRouteEventSink,
  type StreamRouteScope,
} from "../streaming/stream-route-scope.js";
import {
  startStreamRoute,
  type StreamAdmissionQueue,
  type StreamRouteCircuitBreakers,
  type StreamRouteSpan,
} from "../streaming/stream-route-start.js";
import type { OpenAIChatPipelineResult } from "./openai-chat-results.js";

export interface OpenAIStreamRouteStartInput {
  scope: StreamRouteScope;
  resolvedModelId: string;
  logger: {
    warn(obj: Record<string, unknown>, msg?: string): void;
  };
  streamAdmission: StreamAdmissionQueue;
  circuitBreakers: StreamRouteCircuitBreakers;
  recordSessionEvent: StreamRouteEventSink;
  startSpan(name: string, attributes: Record<string, string | number | boolean>): StreamRouteSpan;
}

export type OpenAIStreamRouteStartResult =
  | {
      ok: false;
      result: OpenAIChatPipelineResult;
    }
  | {
      ok: true;
      startedAtMs: number;
      admission: Awaited<ReturnType<StreamAdmissionQueue["acquire"]>>;
      scope: StreamRouteScope;
      recordEvent(event: StreamRouteEvent): void;
      span: StreamRouteSpan;
    };

export async function startOpenAIStreamRoute(
  input: OpenAIStreamRouteStartInput,
): Promise<OpenAIStreamRouteStartResult> {
  const started = await startStreamRoute({
    scope: input.scope,
    resolvedModelId: input.resolvedModelId,
    spanName: "yarn.openai.stream",
    logger: input.logger,
    streamAdmission: input.streamAdmission,
    circuitBreakers: input.circuitBreakers,
    recordSessionEvent: input.recordSessionEvent,
    startSpan: input.startSpan,
    admissionRejection: {
      logMessage: "stream_admission_rejected",
      payload: { error: { type: "service_unavailable", message: "Server at capacity. Try again shortly." } },
    },
    circuitBreakerRejection: {
      detail: `Circuit breaker open for ${input.resolvedModelId} (stream)`,
      logMessage: "circuit_breaker_open_stream",
      payload: { error: { type: "service_unavailable", message: "Model provider temporarily unavailable. Try again shortly." } },
    },
  });
  if (!started.ok) {
    return {
      ok: false,
      result: {
        kind: "error",
        statusCode: started.statusCode,
        headers: { "Retry-After": started.retryAfter },
        body: started.payload,
      },
    };
  }

  return {
    ok: true,
    startedAtMs: started.startedAtMs,
    admission: started.admission,
    scope: started.scope,
    recordEvent: started.recordEvent,
    span: started.span,
  };
}
