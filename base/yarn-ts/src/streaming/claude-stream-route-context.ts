import type { StreamRouteScope } from "./stream-route-scope.js";

export interface ClaudeStreamRouteContextInput {
  sessionKey: string;
  userId: string;
  orgId: string;
  traceRequestId: string;
  responseRequestId: string;
  resolvedModelId: string;
  projectRoot?: string | null;
}

export interface ClaudeStreamRouteContext {
  resolvedModelId: string;
  streamScope: StreamRouteScope;
  requestIds: {
    traceRequestId: string;
    responseRequestId: string;
  };
  eventRoute: {
    sessionKey: string;
    resolvedModelId: string;
    projectRoot?: string | null;
  };
  completionScope: {
    pendingRequestId: string;
    historyRequestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
  };
}

export function createClaudeStreamRouteContext(
  input: ClaudeStreamRouteContextInput,
): ClaudeStreamRouteContext {
  return {
    resolvedModelId: input.resolvedModelId,
    streamScope: {
      sessionKey: input.sessionKey,
      userId: input.userId,
      orgId: input.orgId,
      requestId: input.traceRequestId,
    },
    requestIds: {
      traceRequestId: input.traceRequestId,
      responseRequestId: input.responseRequestId,
    },
    eventRoute: {
      sessionKey: input.sessionKey,
      resolvedModelId: input.resolvedModelId,
      projectRoot: input.projectRoot,
    },
    completionScope: {
      pendingRequestId: input.traceRequestId,
      historyRequestId: input.responseRequestId,
      sessionKey: input.sessionKey,
      userId: input.userId,
      orgId: input.orgId,
    },
  };
}
