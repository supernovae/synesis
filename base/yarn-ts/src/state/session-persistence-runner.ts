import type { LlmUsage } from "@synesis/telemetry";

import type { DecisionSnapshot } from "../telemetry/decision-snapshot.js";
import type { OptimizationLedgerSnapshot } from "../telemetry/optimization-ledger.js";
import { getTracer } from "../telemetry/otel.js";
import type { TierConfig } from "../providers/admin-tier-registry.js";
import type { StateTransitionGlobalCalibrator } from "../governance/state-transition-global-calibrator.js";
import { summarizeEvidenceDelta, type TurnEvidenceDelta } from "../governance/evidence-delta.js";
import {
  runEvalObserverPersistence,
  type ObserverHistoryMessage,
} from "../eval/session-observer-persistence.js";
import {
  runPersistenceTokenEconomicsAccounting,
  type PersistenceTokenEconomicsUsage,
} from "./persistence-token-economics.js";
import type { ProviderCacheObservation } from "./session-store.js";
import {
  runSessionUsagePersistence,
  type ConsecutiveToolCallCounter,
  type HourlyTokenWindowCounter,
  type RequestTrajectoryInput,
  type SessionUsagePersistenceState,
  type SessionUsagePersistenceWriter,
  type YarnTraceRecord,
} from "./session-usage-persistence.js";
import type { SessionEventRecorder } from "./session-event-recorder.js";
import type { SessionEventInsert } from "./usage-writer.js";

export interface SessionPersistenceRunnerState extends SessionUsagePersistenceState {
  history: ObserverHistoryMessage[];
  toolCallsSinceCheckpoint: number;
  lastEvidenceDelta: TurnEvidenceDelta | null;
}

export interface SessionPersistenceRunnerConfig {
  cachePolicyProviderWindowHours: number;
  conversationMemoryEnabled: boolean;
  hourlyTokenThrottleEnabled: boolean;
  hourlyTokenThrottleWindowMs: number;
  hourlyTokenThrottleSessionLimit: number;
  hourlyTokenThrottleUserLimit: number;
}

export interface SessionPersistenceRunnerTierRegistry {
  getTierConfig(modelId: string): TierConfig | undefined;
}

export interface SessionPersistenceRunnerSessionStore {
  recordProviderCacheObservation(
    orgId: string,
    observation: ProviderCacheObservation,
    ttlMs: number,
  ): Promise<void>;
}

export interface SessionPersistenceRunnerLogger {
  info(obj: unknown, message: string): void;
  warn(obj: unknown, message: string): void;
}

export interface PersistSessionAndUsageInput<TState extends SessionPersistenceRunnerState = SessionPersistenceRunnerState> {
  state: TState;
  requestId: string;
  resolvedModelId: string;
  usage: PersistenceTokenEconomicsUsage;
  latencyMs: number;
  finishReason: string;
  tokensSavedByReduction?: number;
  escalated?: boolean;
  snapshot?: DecisionSnapshot;
  trajectory?: RequestTrajectoryInput;
  optimizationLedger?: OptimizationLedgerSnapshot;
  clientRequestedModel?: string;
}

export interface PersistAndEmitDecisionTelemetryInput<TState extends SessionPersistenceRunnerState = SessionPersistenceRunnerState>
  extends PersistSessionAndUsageInput<TState> {
  tokensSavedByReduction: number;
  escalated: boolean;
  snapshot: DecisionSnapshot;
  sessionKey: string;
  userId: string;
  orgId: string;
}

export interface CreateSessionPersistenceRunnerInput<TState extends SessionPersistenceRunnerState = SessionPersistenceRunnerState> {
  config: SessionPersistenceRunnerConfig;
  tierRegistry: SessionPersistenceRunnerTierRegistry;
  sessionStore: SessionPersistenceRunnerSessionStore;
  writer: SessionUsagePersistenceWriter;
  saveSession: (state: TState) => void | Promise<void>;
  counter: ConsecutiveToolCallCounter & HourlyTokenWindowCounter;
  globalCalibrator: StateTransitionGlobalCalibrator;
  recordSessionEvent: SessionEventRecorder;
  maybeCheckpoint: (state: TState) => void;
  emitDecisionEvents: (
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    snapshot: DecisionSnapshot | undefined,
  ) => void;
  recordUsageMetrics: (
    traceModel: string,
    resolvedModelId: string,
    telemetryUsage: LlmUsage,
    latencySeconds: number,
  ) => void;
  emitTrace: (trace: YarnTraceRecord) => void;
  logger: SessionPersistenceRunnerLogger;
}

export interface SessionPersistenceRunner<TState extends SessionPersistenceRunnerState = SessionPersistenceRunnerState> {
  persistSessionAndUsage(input: PersistSessionAndUsageInput<TState>): void;
  persistAndEmitDecisionTelemetry(input: PersistAndEmitDecisionTelemetryInput<TState>): void;
}

export function traceModelForPersistence(resolvedModelId: string, clientRequestedModel?: string): string {
  const origRaw = (clientRequestedModel ?? "").trim();
  const orig = origRaw && origRaw.toLowerCase() !== "auto" ? origRaw : "";
  return orig || resolvedModelId;
}

function recordPersistenceSessionEvent(
  recordSessionEvent: SessionEventRecorder,
  event: SessionEventInsert,
): void {
  recordSessionEvent(
    event.sessionKey,
    event.userId,
    event.orgId,
    event.eventKind,
    event.component,
    event.detail,
    event.requestId,
    event.metadataJson,
  );
}

export function createSessionPersistenceRunner<TState extends SessionPersistenceRunnerState>(
  deps: CreateSessionPersistenceRunnerInput<TState>,
): SessionPersistenceRunner<TState> {
  const persistSessionAndUsage = (input: PersistSessionAndUsageInput<TState>): void => {
    const traceModel = traceModelForPersistence(input.resolvedModelId, input.clientRequestedModel);
    const persistSpan = getTracer().startSpan("yarn.persist_session", {
      "yarn.request_id": input.requestId,
      "yarn.model": traceModel,
      "yarn.latency_ms": input.latencyMs,
    });
    const tier = deps.tierRegistry.getTierConfig(input.resolvedModelId);
    const tokenAccounting = runPersistenceTokenEconomicsAccounting({
      resolvedModelId: input.resolvedModelId,
      traceModel,
      tier,
      metadata: input.state.record.metadata,
      orgId: input.state.record.orgId,
      clientKind: input.state.record.clientKind,
      usage: input.usage,
      optimizationLedger: input.optimizationLedger,
      providerObservationTtlMs: Math.max(2, deps.config.cachePolicyProviderWindowHours + 1) * 3_600_000,
      recordProviderCacheObservation: (...args) => deps.sessionStore.recordProviderCacheObservation(...args),
      logFallbackPricing: (notice) => {
        deps.logger.info(notice, "fallback_pricing_in_effect: set rates in admin Model Registry for accurate costs");
      },
      warnProviderCacheObservation: (err, provider) => {
        deps.logger.warn({ err, provider }, "provider_cache_observation_record_failed");
      },
    });
    runSessionUsagePersistence({
      state: input.state,
      requestId: input.requestId,
      resolvedModelId: input.resolvedModelId,
      traceModel,
      backendModel: tier?.backendModel,
      clientRequestedModel: input.clientRequestedModel,
      usage: input.usage,
      latencyMs: input.latencyMs,
      finishReason: input.finishReason,
      tokensSavedByReduction: input.tokensSavedByReduction ?? 0,
      escalated: input.escalated ?? false,
      snapshot: input.snapshot,
      trajectory: input.trajectory,
      optimizationLedger: input.optimizationLedger,
      costBreakdown: tokenAccounting.costBreakdown,
      normalizedEstimatedCostUsd: tokenAccounting.normalizedEstimatedCostUsd,
      normalizedActualCostUsd: tokenAccounting.normalizedActualCostUsd,
      pricingSource: tokenAccounting.pricingSource,
      tierRates: tokenAccounting.tierRates,
      tokenEconomicsRecommendation: tokenAccounting.tokenEconomicsDecision.recommendation,
      tokenEconomicsWarnings: tokenAccounting.tokenEconomicsDecision.warnings,
      tokenEconomicsMetadata: tokenAccounting.tokenEconomicsMetadata,
      conversationMemoryEnabled: deps.config.conversationMemoryEnabled,
      hourlyTokenThrottleEnabled: deps.config.hourlyTokenThrottleEnabled,
      hourlyTokenThrottleWindowMs: deps.config.hourlyTokenThrottleWindowMs,
      hourlyTokenThrottleSessionLimit: deps.config.hourlyTokenThrottleSessionLimit,
      hourlyTokenThrottleUserLimit: deps.config.hourlyTokenThrottleUserLimit,
      toolCallsSinceCheckpoint: input.state.toolCallsSinceCheckpoint,
      evidenceDelta: summarizeEvidenceDelta(input.state.lastEvidenceDelta),
      writer: deps.writer,
      saveSession: () => deps.saveSession(input.state),
      counter: deps.counter,
      recordSessionEvent: (event) => recordPersistenceSessionEvent(deps.recordSessionEvent, event),
      globalCalibrator: deps.globalCalibrator,
      recordUsageMetrics: deps.recordUsageMetrics,
      emitTrace: deps.emitTrace,
      warn: (message, err) => deps.logger.warn({ err }, message),
    });
    persistSpan.setStatus("ok");
    persistSpan.end();
  };

  const persistAndEmitDecisionTelemetry = (input: PersistAndEmitDecisionTelemetryInput<TState>): void => {
    persistSessionAndUsage(input);
    deps.maybeCheckpoint(input.state);
    deps.emitDecisionEvents(input.sessionKey, input.userId, input.orgId, input.requestId, input.snapshot);
    runEvalObserverPersistence({
      sessionKey: input.sessionKey,
      userId: input.userId,
      orgId: input.orgId,
      requestId: input.requestId,
      history: input.state.history,
      snapshot: input.snapshot,
      recordSessionEvent: (event) => recordPersistenceSessionEvent(deps.recordSessionEvent, event),
      warn: (err) => deps.logger.warn({ err }, "eval_observer_error"),
    });
  };

  return {
    persistSessionAndUsage,
    persistAndEmitDecisionTelemetry,
  };
}
