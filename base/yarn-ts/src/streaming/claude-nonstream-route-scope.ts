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
  state: TSession;
  resolvedModelId: string;
  clientRequestedModel: string;
  recordSessionEvent: StreamRouteEventSink;
  persistDecisionTelemetry(input: {
    state: TSession;
    requestId: string;
    resolvedModelId: string;
    usage: StreamTokenUsage;
    latencyMs: number;
    finishReason: string;
    tokensSavedByReduction: number;
    escalated: boolean;
    snapshot: DecisionSnapshot;
    trajectory?: RequestTrajectoryInput;
    sessionKey: string;
    userId: string;
    orgId: string;
    clientRequestedModel: string;
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
    persistDecisionTelemetry: (telemetry) => input.persistDecisionTelemetry({
      state: input.state,
      requestId: input.requestId,
      resolvedModelId: input.resolvedModelId,
      usage: telemetry.usage,
      latencyMs: telemetry.latencyMs,
      finishReason: telemetry.finishReason,
      tokensSavedByReduction: telemetry.tokensSavedByReduction,
      escalated: telemetry.escalated,
      snapshot: telemetry.snapshot,
      trajectory: telemetry.trajectory,
      sessionKey: input.sessionKey,
      userId: input.userId,
      orgId: input.orgId,
      clientRequestedModel: input.clientRequestedModel,
    }),
  };
}
