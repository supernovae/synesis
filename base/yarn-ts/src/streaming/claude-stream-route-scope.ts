export interface ClaudeStreamRouteScope {
  sessionKey: string;
  userId: string;
  orgId: string;
  requestId: string;
}

export interface ClaudeStreamRouteEvent {
  eventKind: string;
  component: string;
  detail: string;
  metadataJson?: Record<string, unknown>;
}

export type ClaudeStreamRouteEventSink = (
  sessionKey: string,
  userId: string,
  orgId: string,
  eventKind: string,
  component: string,
  detail: string,
  requestId: string,
  metadataJson?: Record<string, unknown>,
) => void;

export function createClaudeStreamEventRecorder(
  scope: ClaudeStreamRouteScope,
  recordSessionEvent: ClaudeStreamRouteEventSink,
): (event: ClaudeStreamRouteEvent) => void {
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
