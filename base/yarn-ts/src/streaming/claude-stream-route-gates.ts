import type {
  StreamAdmissionQueue,
  StreamRouteCircuitBreakers,
  StreamRouteSpan,
  StreamRouteStartResult,
} from "./stream-route-start.js";
import { startStreamRoute } from "./stream-route-start.js";
import type { StreamRouteEventSink, StreamRouteScope } from "./stream-route-scope.js";

export interface ClaudeStreamRouteGateLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface ClaudeStreamRouteGatesInput {
  scope: StreamRouteScope;
  resolvedModelId: string;
  logger: ClaudeStreamRouteGateLogger;
  streamAdmission: StreamAdmissionQueue;
  circuitBreakers: StreamRouteCircuitBreakers;
  recordSessionEvent: StreamRouteEventSink;
  startSpan(name: string, attributes: Record<string, string | number | boolean>): StreamRouteSpan;
}

export interface ClaudeStreamRouteErrorPayload {
  type: "error";
  error: {
    type: "overloaded_error";
    message: string;
  };
}

export type ClaudeStreamRouteGatesResult = StreamRouteStartResult<ClaudeStreamRouteErrorPayload>;

export async function startClaudeStreamRouteGates(
  input: ClaudeStreamRouteGatesInput,
): Promise<ClaudeStreamRouteGatesResult> {
  return startStreamRoute({
    scope: input.scope,
    resolvedModelId: input.resolvedModelId,
    spanName: "yarn.claude.stream",
    logger: input.logger,
    streamAdmission: input.streamAdmission,
    circuitBreakers: input.circuitBreakers,
    recordSessionEvent: input.recordSessionEvent,
    startSpan: input.startSpan,
    admissionRejection: {
      logMessage: "stream_admission_rejected_claude",
      payload: {
        type: "error",
        error: { type: "overloaded_error", message: "Server at capacity. Try again shortly." },
      },
    },
    circuitBreakerRejection: {
      detail: `Circuit breaker open for ${input.resolvedModelId} (claude stream)`,
      logMessage: "circuit_breaker_open_claude_stream",
      payload: {
        type: "error",
        error: { type: "overloaded_error", message: "Model provider temporarily unavailable. Try again shortly." },
      },
    },
  });
}
