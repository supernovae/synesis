export interface StreamRouteScope {
  sessionKey: string;
  userId: string;
  orgId: string;
  requestId: string;
}

export interface StreamRouteEvent {
  eventKind: string;
  component: string;
  detail: string;
  metadataJson?: Record<string, unknown>;
}

export type StreamRouteEventSink = (
  sessionKey: string,
  userId: string,
  orgId: string,
  eventKind: string,
  component: string,
  detail: string,
  requestId: string,
  metadataJson?: Record<string, unknown>,
) => void;

export interface StreamRouteScopeBundle {
  scope: StreamRouteScope;
  recordEvent(event: StreamRouteEvent): void;
}

export function createStreamRouteEventRecorder(
  scope: StreamRouteScope,
  recordSessionEvent: StreamRouteEventSink,
): (event: StreamRouteEvent) => void {
  return (event) => recordSessionEvent(
    scope.sessionKey,
    scope.userId,
    scope.orgId,
    event.eventKind,
    event.component,
    event.detail,
    scope.requestId,
    event.metadataJson,
  );
}

export function createStreamRouteScopeBundle(
  scope: StreamRouteScope,
  recordSessionEvent: StreamRouteEventSink,
): StreamRouteScopeBundle {
  return {
    scope,
    recordEvent: createStreamRouteEventRecorder(scope, recordSessionEvent),
  };
}
