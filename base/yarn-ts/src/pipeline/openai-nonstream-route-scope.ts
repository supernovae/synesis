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
    optimizationLedger?: unknown;
    clientRequestedModel: string;
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
      optimizationLedger: telemetry.optimizationLedger,
      clientRequestedModel: input.clientRequestedModel,
    }),
  };
}
