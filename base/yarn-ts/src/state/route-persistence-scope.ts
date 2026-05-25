import {
  createStreamRouteEventRecorder,
  type StreamRouteEvent,
  type StreamRouteEventSink,
  type StreamRouteScope,
} from "../streaming/stream-route-scope.js";
import {
  createDecisionTelemetryPersister,
  type DecisionTelemetryPayload,
  type PersistDecisionTelemetry,
} from "./decision-telemetry-persister.js";
import type { SessionPersistenceRunnerState } from "./session-persistence-runner.js";

export type RouteScopedSessionEventRecorder = (
  eventKind: string,
  component: string,
  detail: string,
  metadataJson?: Record<string, unknown>,
) => void;

export interface RoutePersistenceScopeInput<TState extends SessionPersistenceRunnerState>
  extends StreamRouteScope {
  state: TState;
  resolvedModelId: string;
  clientRequestedModel: string;
  recordSessionEvent: StreamRouteEventSink;
  persistDecisionTelemetry: PersistDecisionTelemetry<TState>;
}

export interface RoutePersistenceScope {
  scope: StreamRouteScope;
  recordEvent(event: StreamRouteEvent): void;
  recordSessionEvent: RouteScopedSessionEventRecorder;
  persistDecisionTelemetry(payload: DecisionTelemetryPayload): void;
}

export function createRoutePersistenceScope<TState extends SessionPersistenceRunnerState>(
  input: RoutePersistenceScopeInput<TState>,
): RoutePersistenceScope {
  const scope: StreamRouteScope = {
    sessionKey: input.sessionKey,
    userId: input.userId,
    orgId: input.orgId,
    requestId: input.requestId,
  };
  const recordEvent = createStreamRouteEventRecorder(scope, input.recordSessionEvent);
  return {
    scope,
    recordEvent,
    recordSessionEvent: (eventKind, component, detail, metadataJson) => recordEvent({
      eventKind,
      component,
      detail,
      metadataJson,
    }),
    persistDecisionTelemetry: createDecisionTelemetryPersister({
      state: input.state,
      requestId: input.requestId,
      resolvedModelId: input.resolvedModelId,
      sessionKey: input.sessionKey,
      userId: input.userId,
      orgId: input.orgId,
      clientRequestedModel: input.clientRequestedModel,
    }, input.persistDecisionTelemetry),
  };
}
