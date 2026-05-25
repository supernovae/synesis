import {
  buildStreamAdmissionRejection,
  buildStreamCircuitBreakerRejection,
  type StreamAdmissionResult,
  type StreamRouteGateLogger,
} from "./stream-route-gates.js";
import {
  createStreamRouteScopeBundle,
  type StreamRouteEvent,
  type StreamRouteEventSink,
  type StreamRouteScope,
} from "./stream-route-scope.js";

export interface StreamAdmissionQueue {
  acquire(): Promise<StreamAdmissionResult>;
  getStats(): unknown;
}

export interface StreamRouteCircuitBreakers {
  allowRequest(model: string, orgId: string): boolean;
}

export interface StreamRouteSpan {
  setStatus(status: string, message?: string): void;
  end(): void;
}

export interface StreamRouteStartInput<TPayload> {
  scope: StreamRouteScope;
  resolvedModelId: string;
  spanName: string;
  logger: StreamRouteGateLogger;
  streamAdmission: StreamAdmissionQueue;
  circuitBreakers: StreamRouteCircuitBreakers;
  recordSessionEvent: StreamRouteEventSink;
  startSpan(name: string, attributes: Record<string, string | number | boolean>): StreamRouteSpan;
  admissionRejection: {
    logMessage: string;
    payload: TPayload;
  };
  circuitBreakerRejection: {
    detail: string;
    logMessage: string;
    payload: TPayload;
  };
}

export type StreamRouteStartResult<TPayload> =
  | {
      ok: false;
      statusCode: number;
      retryAfter: string;
      payload: TPayload;
    }
  | {
      ok: true;
      startedAtMs: number;
      admission: StreamAdmissionResult;
      scope: StreamRouteScope;
      recordEvent(event: StreamRouteEvent): void;
      span: StreamRouteSpan;
    };

export async function startStreamRoute<TPayload>(
  input: StreamRouteStartInput<TPayload>,
): Promise<StreamRouteStartResult<TPayload>> {
  const admission = await input.streamAdmission.acquire();
  const admissionRejection = buildStreamAdmissionRejection({
    admission,
    queueStats: input.streamAdmission.getStats(),
    logMessage: input.admissionRejection.logMessage,
    scope: input.scope,
    logger: input.logger,
    recordSessionEvent: input.recordSessionEvent,
    payload: input.admissionRejection.payload,
  });
  if (admissionRejection) {
    return {
      ok: false,
      statusCode: admissionRejection.statusCode,
      retryAfter: admissionRejection.retryAfter,
      payload: admissionRejection.payload,
    };
  }

  const breakerRejection = buildStreamCircuitBreakerRejection({
    allowed: input.circuitBreakers.allowRequest(input.resolvedModelId, input.scope.orgId),
    admission,
    model: input.resolvedModelId,
    orgId: input.scope.orgId,
    detail: input.circuitBreakerRejection.detail,
    logMessage: input.circuitBreakerRejection.logMessage,
    scope: input.scope,
    logger: input.logger,
    recordSessionEvent: input.recordSessionEvent,
    payload: input.circuitBreakerRejection.payload,
  });
  if (breakerRejection) {
    return {
      ok: false,
      statusCode: breakerRejection.statusCode,
      retryAfter: breakerRejection.retryAfter,
      payload: breakerRejection.payload,
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
    span: input.startSpan(input.spanName, {
      model: input.resolvedModelId,
      sessionKey: input.scope.sessionKey,
    }),
  };
}
