import type { DecisionSnapshot } from "../telemetry/decision-snapshot.js";
import type { RequestTrajectoryInput } from "../state/session-usage-persistence.js";
import type { StreamTokenUsage } from "./openai-stream-finalizer.js";
import {
  createStreamRouteEventRecorder,
  type StreamRouteEvent,
  type StreamRouteEventSink,
} from "./stream-route-scope.js";

export interface ClaudeNonStreamRouteScopeInput<TSession> {
  sessionKey: string;
  userId: string;
  orgId: string;
  requestId: string;
  recordSessionEvent: StreamRouteEventSink;
  persistDecisionTelemetry(input: {
    usage: StreamTokenUsage;
    latencyMs: number;
    finishReason: string;
    tokensSavedByReduction: number;
    escalated: boolean;
    snapshot: DecisionSnapshot;
    trajectory?: RequestTrajectoryInput;
  }): void;
}

export interface ClaudeNonStreamRouteScope {
  sessionKey: string;
  userId: string;
  orgId: string;
  requestId: string;
  recordEvent(event: StreamRouteEvent): void;
  persistDecisionTelemetry(input: {
    usage: StreamTokenUsage;
    latencyMs: number;
    finishReason: string;
    tokensSavedByReduction: number;
    escalated: boolean;
    snapshot: DecisionSnapshot;
    trajectory?: RequestTrajectoryInput;
  }): void;
}

export function createClaudeNonStreamRouteScope<TSession>(
  input: ClaudeNonStreamRouteScopeInput<TSession>,
): ClaudeNonStreamRouteScope {
  const recordEvent = createStreamRouteEventRecorder({
    sessionKey: input.sessionKey,
    userId: input.userId,
    orgId: input.orgId,
    requestId: input.requestId,
  }, input.recordSessionEvent);

  return {
    sessionKey: input.sessionKey,
    userId: input.userId,
    orgId: input.orgId,
    requestId: input.requestId,
    recordEvent,
    persistDecisionTelemetry: input.persistDecisionTelemetry,
  };
}
