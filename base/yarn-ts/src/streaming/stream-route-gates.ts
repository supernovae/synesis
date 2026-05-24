import type { StreamRouteEventSink, StreamRouteScope } from "./stream-route-scope.js";

export interface StreamRouteGateLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface StreamAdmissionResult {
  admitted: boolean;
  reason?: string;
  retryAfterSeconds?: number;
  release?: () => void;
}

export interface StreamRouteRejection<TPayload> {
  statusCode: number;
  retryAfter: string;
  payload: TPayload;
}

export interface StreamAdmissionRejectionInput<TPayload> {
  admission: StreamAdmissionResult;
  queueStats: unknown;
  logMessage: string;
  scope: StreamRouteScope;
  logger: StreamRouteGateLogger;
  recordSessionEvent: StreamRouteEventSink;
  payload: TPayload;
}

export interface StreamCircuitBreakerRejectionInput<TPayload> {
  allowed: boolean;
  admission: Pick<StreamAdmissionResult, "release">;
  model: string;
  orgId: string;
  detail: string;
  logMessage: string;
  scope: StreamRouteScope;
  logger: StreamRouteGateLogger;
  recordSessionEvent: StreamRouteEventSink;
  payload: TPayload;
}

export function buildStreamAdmissionRejection<TPayload>(
  input: StreamAdmissionRejectionInput<TPayload>,
): StreamRouteRejection<TPayload> | null {
  if (input.admission.admitted) return null;

  input.logger.warn(
    { reason: input.admission.reason, queueStats: input.queueStats },
    input.logMessage,
  );
  input.recordSessionEvent(
    input.scope.sessionKey,
    input.scope.userId,
    input.scope.orgId,
    "stream_admission_reject",
    "stream-admission",
    input.admission.reason ?? "stream admission rejected",
    input.scope.requestId,
  );

  return {
    statusCode: 503,
    retryAfter: String(input.admission.retryAfterSeconds ?? 5),
    payload: input.payload,
  };
}

export function buildStreamCircuitBreakerRejection<TPayload>(
  input: StreamCircuitBreakerRejectionInput<TPayload>,
): StreamRouteRejection<TPayload> | null {
  if (input.allowed) return null;

  input.admission.release?.();
  input.logger.warn(
    { model: input.model, orgId: input.orgId },
    input.logMessage,
  );
  input.recordSessionEvent(
    input.scope.sessionKey,
    input.scope.userId,
    input.scope.orgId,
    "breaker_open_reject",
    "circuit-breaker",
    input.detail,
    input.scope.requestId,
    { model: input.model },
  );

  return {
    statusCode: 503,
    retryAfter: "30",
    payload: input.payload,
  };
}
