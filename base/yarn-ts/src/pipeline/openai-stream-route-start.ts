import {
  buildStreamAdmissionRejection,
  buildStreamCircuitBreakerRejection,
  type StreamAdmissionResult,
  type StreamRouteGateLogger,
} from "../streaming/stream-route-gates.js";
import {
  createStreamRouteScopeBundle,
  type StreamRouteEvent,
  type StreamRouteEventSink,
  type StreamRouteScope,
} from "../streaming/stream-route-scope.js";
import type { OpenAIChatPipelineResult } from "./openai-chat-results.js";

export interface OpenAIStreamAdmissionQueue {
  acquire(): Promise<StreamAdmissionResult>;
  getStats(): unknown;
}

export interface OpenAIStreamRouteCircuitBreakers {
  allowRequest(model: string, orgId: string): boolean;
}

export interface OpenAIStreamRouteSpan {
  setStatus(status: string, message?: string): void;
  end(): void;
}

export interface OpenAIStreamRouteStartInput {
  scope: StreamRouteScope;
  resolvedModelId: string;
  logger: StreamRouteGateLogger;
  streamAdmission: OpenAIStreamAdmissionQueue;
  circuitBreakers: OpenAIStreamRouteCircuitBreakers;
  recordSessionEvent: StreamRouteEventSink;
  startSpan(name: string, attributes: Record<string, string | number | boolean>): OpenAIStreamRouteSpan;
}

export type OpenAIStreamRouteStartResult =
  | {
      ok: false;
      result: OpenAIChatPipelineResult;
    }
  | {
      ok: true;
      startedAtMs: number;
      admission: StreamAdmissionResult;
      scope: StreamRouteScope;
      recordEvent(event: StreamRouteEvent): void;
      span: OpenAIStreamRouteSpan;
    };

export async function startOpenAIStreamRoute(
  input: OpenAIStreamRouteStartInput,
): Promise<OpenAIStreamRouteStartResult> {
  const admission = await input.streamAdmission.acquire();
  const admissionRejection = buildStreamAdmissionRejection({
    admission,
    queueStats: input.streamAdmission.getStats(),
    logMessage: "stream_admission_rejected",
    scope: input.scope,
    logger: input.logger,
    recordSessionEvent: input.recordSessionEvent,
    payload: { error: { type: "service_unavailable", message: "Server at capacity. Try again shortly." } },
  });
  if (admissionRejection) {
    return {
      ok: false,
      result: {
        kind: "error",
        statusCode: admissionRejection.statusCode,
        headers: { "Retry-After": admissionRejection.retryAfter },
        body: admissionRejection.payload,
      },
    };
  }

  const breakerRejection = buildStreamCircuitBreakerRejection({
    allowed: input.circuitBreakers.allowRequest(input.resolvedModelId, input.scope.orgId),
    admission,
    model: input.resolvedModelId,
    orgId: input.scope.orgId,
    detail: `Circuit breaker open for ${input.resolvedModelId} (stream)`,
    logMessage: "circuit_breaker_open_stream",
    scope: input.scope,
    logger: input.logger,
    recordSessionEvent: input.recordSessionEvent,
    payload: { error: { type: "service_unavailable", message: "Model provider temporarily unavailable. Try again shortly." } },
  });
  if (breakerRejection) {
    return {
      ok: false,
      result: {
        kind: "error",
        statusCode: breakerRejection.statusCode,
        headers: { "Retry-After": breakerRejection.retryAfter },
        body: breakerRejection.payload,
      },
    };
  }

  const startedAtMs = Date.now();
  const scopeBundle = createStreamRouteScopeBundle(input.scope, input.recordSessionEvent);
  return {
    ok: true,
    startedAtMs,
    admission,
    scope: scopeBundle.scope,
    recordEvent: scopeBundle.recordEvent,
    span: input.startSpan("yarn.openai.stream", {
      model: input.resolvedModelId,
      sessionKey: input.scope.sessionKey,
    }),
  };
}
