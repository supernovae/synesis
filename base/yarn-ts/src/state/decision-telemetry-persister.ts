import type { DecisionSnapshot } from "../telemetry/decision-snapshot.js";
import type { OptimizationLedgerSnapshot } from "../telemetry/optimization-ledger.js";
import type { RequestTrajectoryInput } from "./session-usage-persistence.js";
import type {
  PersistAndEmitDecisionTelemetryInput,
  SessionPersistenceRunnerState,
} from "./session-persistence-runner.js";
import type { PersistenceTokenEconomicsUsage } from "./persistence-token-economics.js";

export interface DecisionTelemetryRouteContext<TState extends SessionPersistenceRunnerState> {
  state: TState;
  requestId: string;
  resolvedModelId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  clientRequestedModel: string;
}

export interface DecisionTelemetryPayload {
  usage: PersistenceTokenEconomicsUsage;
  latencyMs: number;
  finishReason: string;
  tokensSavedByReduction: number;
  escalated: boolean;
  snapshot: DecisionSnapshot;
  trajectory?: RequestTrajectoryInput;
  optimizationLedger?: unknown;
}

export type PersistDecisionTelemetry<TState extends SessionPersistenceRunnerState> = (
  input: PersistAndEmitDecisionTelemetryInput<TState>,
) => void;

export function buildDecisionTelemetryPersistenceInput<TState extends SessionPersistenceRunnerState>(
  context: DecisionTelemetryRouteContext<TState>,
  payload: DecisionTelemetryPayload,
): PersistAndEmitDecisionTelemetryInput<TState> {
  return {
    state: context.state,
    requestId: context.requestId,
    resolvedModelId: context.resolvedModelId,
    usage: payload.usage,
    latencyMs: payload.latencyMs,
    finishReason: payload.finishReason,
    tokensSavedByReduction: payload.tokensSavedByReduction,
    escalated: payload.escalated,
    snapshot: payload.snapshot,
    trajectory: payload.trajectory,
    sessionKey: context.sessionKey,
    userId: context.userId,
    orgId: context.orgId,
    optimizationLedger: payload.optimizationLedger as OptimizationLedgerSnapshot | undefined,
    clientRequestedModel: context.clientRequestedModel,
  };
}

export function createDecisionTelemetryPersister<TState extends SessionPersistenceRunnerState>(
  context: DecisionTelemetryRouteContext<TState>,
  persist: PersistDecisionTelemetry<TState>,
): (payload: DecisionTelemetryPayload) => void {
  return (payload) => persist(buildDecisionTelemetryPersistenceInput(context, payload));
}
