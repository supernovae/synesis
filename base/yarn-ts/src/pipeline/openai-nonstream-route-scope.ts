import type { DecisionSnapshot } from "../telemetry/decision-snapshot.js";
import type { RequestTrajectoryInput } from "../state/session-usage-persistence.js";
import type { StreamTokenUsage } from "../streaming/openai-stream-finalizer.js";
import {
  createStreamRouteEventRecorder,
  type StreamRouteEvent,
  type StreamRouteEventSink,
} from "../streaming/stream-route-scope.js";

export interface OpenAINonStreamRouteScopeInput<TSession> {
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
    optimizationLedger?: unknown;
  }): void;
}

export interface OpenAINonStreamRouteScope {
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
    optimizationLedger?: unknown;
  }): void;
}

export function createOpenAINonStreamRouteScope<TSession>(
  input: OpenAINonStreamRouteScopeInput<TSession>,
): OpenAINonStreamRouteScope {
  const scope = {
    sessionKey: input.sessionKey,
    userId: input.userId,
    orgId: input.orgId,
    requestId: input.requestId,
  };
  const recordEvent = createStreamRouteEventRecorder(scope, input.recordSessionEvent);

  return {
    ...scope,
    recordEvent,
    persistDecisionTelemetry: input.persistDecisionTelemetry,
  };
}
