import type { AppConfig } from "../config.js";
import {
  effectiveSawtoothCheckpointToolCalls,
  effectiveSawtoothHistoryLengthThreshold,
  inferCompactionSensitivity,
  type CompactionSensitivity,
} from "../context/compaction-sensitivity.js";
import type { SawtoothContextManager } from "../context/sawtooth-manager.js";
import type { SessionContinuityService } from "../context/session-continuity.js";
import { formatPlanProgressBlock, serializePlanGraph, deserializePlanGraph } from "../planning/plan-graph.js";
import { parsePlanGraph } from "../planning/planning-state-helpers.js";
import type { SnapshotVisibilityState } from "../reduction/file-snapshot-registry.js";
import type { SessionIdentity } from "../session/session-key.js";
import { resolveSessionKey } from "../session/session-key.js";
import { serializeTaskLedger, deserializeTaskLedger } from "../task-ledger/index.js";
import type { SessionState } from "./session-state.js";
import type { SessionContinuity, SessionRecord, SessionStateSnapshot, SessionStore } from "./session-store.js";

const SYNESIS_COMPACTION_BACKEND_META = "synesis_compaction_backend_model";

type LoggerLike = {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
};

type RecordSessionEvent = (
  sessionKey: string,
  userId: string,
  orgId: string,
  eventType: string,
  source: string,
  summary: string,
  requestId?: string,
  metadata?: Record<string, unknown>,
) => void;

type UsageContinuityReader = {
  loadLatestContinuity(userId: string, maxAgeMs: number): Promise<SessionContinuity | null>;
};

type TierRegistryLike = {
  getTierConfig(tierId: string): { backendModel?: string | null } | null | undefined;
};

type CounterLike = {
  inc(value?: unknown): void;
};

export interface SessionLifecycleHelpersInput {
  config: AppConfig;
  logger: LoggerLike;
  sessions: Map<string, SessionState>;
  rotatedSessionByBaseKey: Map<string, string>;
  sessionStore: SessionStore;
  sessionContinuity: SessionContinuityService;
  usageWriter: UsageContinuityReader;
  tierRegistry: TierRegistryLike;
  sawtooth: SawtoothContextManager;
  metrics: {
    compactionTotal: CounterLike;
    sessionCheckpointTotal: CounterLike;
    compactionCharsSaved: CounterLike;
  };
  createDiffStats(): SessionState["diffStats"];
  resetRecoveryCounters(): void;
  clearImplicitSessionResources(baseKey: string): void;
  getFileSnapshotRegistry(sessionKey: string): { markCompaction(kind?: SnapshotVisibilityState): void };
  getContentDedup(sessionKey: string): { reset(): void };
  recordSessionEvent: RecordSessionEvent;
}

export interface SessionLifecycleHelpers {
  getSessionKey(identity: SessionIdentity): Promise<string>;
  getSessionState(key: string, identity: SessionIdentity): Promise<SessionState>;
  buildSessionStateSnapshot(state: SessionState): SessionStateSnapshot;
  casSessionSave(state: SessionState): Promise<void>;
  resolveCompactionBackendModelHintFromRequestModel(modelId: string | undefined): string;
  pinchCompactionBackendModelMetadata(session: SessionState, tierId: string, requestedFallback: string): void;
  maybeCheckpoint(state: SessionState): void;
  forceCheckpoint(state: SessionState): Promise<boolean>;
}

export function createSessionLifecycleHelpers(input: SessionLifecycleHelpersInput): SessionLifecycleHelpers {
  const {
    config,
    logger,
    sessions,
    rotatedSessionByBaseKey,
    sessionStore,
    sessionContinuity,
    usageWriter,
    tierRegistry,
    sawtooth,
    metrics,
    createDiffStats,
    resetRecoveryCounters,
    clearImplicitSessionResources,
    getFileSnapshotRegistry,
    getContentDedup,
    recordSessionEvent,
  } = input;

  async function getSessionKey(identity: SessionIdentity): Promise<string> {
    const decision = await resolveSessionKey({
      identity,
      nowMs: Date.now(),
      inactivityRotationMs: config.SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS,
      activeByBaseKey: rotatedSessionByBaseKey,
      loadRecord: async (sessionKey) => sessions.get(sessionKey)?.record ?? await sessionStore.load(sessionKey),
      loadActiveSessionKey: (baseKey) => sessionStore.loadActiveSessionKey(baseKey),
      saveActiveSessionKey: (baseKey, sessionKey) => sessionStore.saveActiveSessionKey(baseKey, sessionKey),
    });
    if (decision.reason === "new_implicit_conversation") {
      clearImplicitSessionResources(decision.baseKey);
      logger.info(
        { baseKey: decision.baseKey, sessionKey: decision.sessionKey, clientKind: identity.clientKind },
        "session_implicit_conversation_rotation"
      );
    }
    return decision.sessionKey;
  }

  async function getSessionState(key: string, identity: SessionIdentity): Promise<SessionState> {
    const existing = sessions.get(key);
    if (existing) {
      existing.record.lastActiveAt = Date.now();
      if (existing.record.userId === "anon" && identity.userId !== "anon") {
        existing.record.userId = identity.userId;
        existing.record.orgId = identity.orgId;
      }
      return existing;
    }
    const loaded = await sessionStore.load(key);
    const record: SessionRecord = loaded ?? {
      sessionKey: key,
      userId: identity.userId,
      orgId: identity.orgId,
      conversationId: identity.conversationId,
      clientKind: identity.clientKind,
      displayName: identity.displayName,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalTokensCached: 0,
      totalTokensSaved: 0,
      requestCount: 0,
      escalationCount: 0,
      consecutiveFailedVerifications: 0,
      metadata: {},
      version: 0
    };
    if (identity.displayName && !record.displayName) {
      record.displayName = identity.displayName;
    }
    const metaConsecutive = Number(record.metadata?.consecutive_tool_calls ?? 0);
    const metaStagnant = Number(record.metadata?.stagnant_tool_cycles ?? 0);
    const metaToolSignalHash = String(record.metadata?.last_tool_signal_hash ?? "");
    const metaAwaitingAck = record.metadata?.awaiting_tool_loop_user_ack === true;
    const metaAckAnchorHash = String(record.metadata?.tool_loop_ack_anchor_user_hash ?? "");
    const metaNoAckCount = Number(record.metadata?.tool_loop_no_user_ack_count ?? 0);
    const metaBlockBroadVerification = record.metadata?.block_broad_verification_until_edit === true;
    const metaBlockFailingVerification = record.metadata?.block_failing_verification_until_edit === true;
    const history: SessionState["history"] = [];

    if (!loaded) {
      resetRecoveryCounters();
    }

    const hasExplicitConversation = typeof identity.conversationId === "string" && identity.conversationId.trim().length > 0;
    const allowCarryForwardBootstrap =
      !hasExplicitConversation && config.SYNESIS_YARN_SESSION_CARRY_FORWARD_BOOTSTRAP_ENABLED;

    if (!loaded && identity.userId !== "anon" && config.SYNESIS_YARN_SESSION_CONTINUITY_ENABLED && allowCarryForwardBootstrap) {
      const prevContinuity = await sessionStore.loadContinuity(identity.userId);
      if (prevContinuity) {
        const block = sessionContinuity.toSystemBlock(prevContinuity);
        if (block) {
          history.push({ role: "system", content: block });
        }
      }
    }

    if (!loaded && identity.userId !== "anon" && config.SYNESIS_YARN_CROSS_CONVERSATION_RECALL_ENABLED && allowCarryForwardBootstrap) {
      try {
        const pgContinuity = await usageWriter.loadLatestContinuity(identity.userId, config.SYNESIS_YARN_RECALL_MAX_AGE_MS);
        if (pgContinuity) {
          const recallBlock = sessionContinuity.toRecallBlock(pgContinuity);
          if (recallBlock) {
            history.push({ role: "system", content: recallBlock });
            recordSessionEvent(key, identity.userId, identity.orgId, "cross_conversation_recall", "getSessionState", `Loaded prior continuity (age ${Math.round((Date.now() - pgContinuity.updatedAt) / 3600000)}h)`);
          }
          if (pgContinuity.planGraph && typeof pgContinuity.planGraph === "object") {
            const restoredPlan = deserializePlanGraph(pgContinuity.planGraph as Record<string, unknown>);
            if (restoredPlan) {
              let planBlock = formatPlanProgressBlock(restoredPlan);
              if (planBlock && pgContinuity.planFilePath) {
                planBlock += `\nplan_file=${pgContinuity.planFilePath}\nTo continue this plan, read the plan file: Read(${pgContinuity.planFilePath})`;
              }
              if (planBlock) {
                history.push({ role: "system", content: planBlock });
              }
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, "Cross-conversation recall failed (non-fatal)");
      }
    }

    const state: SessionState = {
      history,
      toolCallsSinceCheckpoint: 0,
      consecutiveToolCalls: Number.isFinite(metaConsecutive) ? metaConsecutive : 0,
      stagnantToolCycles: Number.isFinite(metaStagnant) ? metaStagnant : 0,
      lastToolSignalHash: metaToolSignalHash,
      awaitingToolLoopUserAck: metaAwaitingAck,
      toolLoopAckAnchorUserHash: metaAckAnchorHash,
      toolLoopNoUserAckCount: Number.isFinite(metaNoAckCount) ? metaNoAckCount : 0,
      blockBroadVerificationUntilEdit: metaBlockBroadVerification,
      blockFailingVerificationUntilEdit: metaBlockFailingVerification,
      record,
      pruningWatermark: 0,
      consecutiveRecoveryFires: 0,
      consecutiveEditContextMisses: 0,
      editReplayHardStopGraceUsed: false,
      editMissForceReadPending: false,
      artifactEditTurns: new Map(),
      seenFailureSignatures: new Set(),
      previousFailureSignature: null,
      lastEvidenceDelta: null,
      lastIncomingMessageCount: 0,
      governorPrePauseAttemptsByRule: new Map(),
      implementationSoftStallNudgeStrikes: 0,
      regroundCooldownRemaining: 0,
      lastGovernorNoPauseAt: 0,
      lastGovernorCachedResult: null,
      skipToolIdStabilization: false,
      gitInspectionBlockCount: 0,
      scopeEnvelope: "unconstrained",
      diffStats: createDiffStats(),
      taskLedger: record.metadata.task_ledger
        ? deserializeTaskLedger(record.metadata.task_ledger)
        : null,
      taskCapabilities: null,
    };

    if (loaded) {
      try {
        const snap = await sessionStore.loadSessionState(key);
        if (snap && snap.snapshotAt > 0) {
          rehydrateFromSnapshot(state, snap);
          logger.info({ sessionKey: key, snapshotAge: Date.now() - snap.snapshotAt }, "session_state_rehydrated");
        }
      } catch (err) {
        logger.warn({ err, sessionKey: key }, "Session state rehydration failed (non-fatal)");
      }
    }

    sessions.set(key, state);
    return state;
  }

  function buildSessionStateSnapshot(state: SessionState): SessionStateSnapshot {
    return {
      history: state.history,
      toolCallsSinceCheckpoint: state.toolCallsSinceCheckpoint,
      consecutiveToolCalls: state.consecutiveToolCalls,
      stagnantToolCycles: state.stagnantToolCycles,
      lastToolSignalHash: state.lastToolSignalHash,
      awaitingToolLoopUserAck: state.awaitingToolLoopUserAck,
      toolLoopAckAnchorUserHash: state.toolLoopAckAnchorUserHash,
      toolLoopNoUserAckCount: state.toolLoopNoUserAckCount,
      blockBroadVerificationUntilEdit: state.blockBroadVerificationUntilEdit,
      blockFailingVerificationUntilEdit: state.blockFailingVerificationUntilEdit,
      pruningWatermark: state.pruningWatermark,
      consecutiveRecoveryFires: state.consecutiveRecoveryFires,
      consecutiveEditContextMisses: state.consecutiveEditContextMisses,
      editReplayHardStopGraceUsed: state.editReplayHardStopGraceUsed,
      editMissForceReadPending: state.editMissForceReadPending,
      lastGovernorPhase: state.lastGovernorPhase ?? null,
      artifactEditTurns: Object.fromEntries(state.artifactEditTurns),
      seenFailureSignatures: [...state.seenFailureSignatures],
      previousFailureSignature: state.previousFailureSignature,
      lastIncomingMessageCount: state.lastIncomingMessageCount,
      implementationSoftStallNudgeStrikes: state.implementationSoftStallNudgeStrikes,
      regroundCooldownRemaining: state.regroundCooldownRemaining,
      lastGovernorNoPauseAt: state.lastGovernorNoPauseAt,
      skipToolIdStabilization: state.skipToolIdStabilization,
      gitInspectionBlockCount: state.gitInspectionBlockCount,
      snapshotAt: Date.now(),
    };
  }

  function rehydrateFromSnapshot(state: SessionState, snap: SessionStateSnapshot): void {
    state.history = snap.history as SessionState["history"];
    state.toolCallsSinceCheckpoint = snap.toolCallsSinceCheckpoint;
    state.consecutiveToolCalls = snap.consecutiveToolCalls;
    state.stagnantToolCycles = snap.stagnantToolCycles;
    state.lastToolSignalHash = snap.lastToolSignalHash;
    state.awaitingToolLoopUserAck = snap.awaitingToolLoopUserAck;
    state.toolLoopAckAnchorUserHash = snap.toolLoopAckAnchorUserHash;
    state.toolLoopNoUserAckCount = snap.toolLoopNoUserAckCount;
    state.blockBroadVerificationUntilEdit = snap.blockBroadVerificationUntilEdit;
    state.blockFailingVerificationUntilEdit = snap.blockFailingVerificationUntilEdit;
    state.pruningWatermark = snap.pruningWatermark;
    state.consecutiveRecoveryFires = snap.consecutiveRecoveryFires;
    state.consecutiveEditContextMisses = snap.consecutiveEditContextMisses;
    state.editReplayHardStopGraceUsed = snap.editReplayHardStopGraceUsed;
    state.editMissForceReadPending = snap.editMissForceReadPending;
    state.lastGovernorPhase = (snap.lastGovernorPhase as SessionState["lastGovernorPhase"]) ?? undefined;
    state.artifactEditTurns = new Map(Object.entries(snap.artifactEditTurns));
    state.seenFailureSignatures = new Set(snap.seenFailureSignatures);
    state.previousFailureSignature = snap.previousFailureSignature;
    state.lastIncomingMessageCount = snap.lastIncomingMessageCount;
    state.implementationSoftStallNudgeStrikes = (snap.implementationSoftStallNudgeStrikes === 1 ? 1 : 0) as 0 | 1;
    state.regroundCooldownRemaining = snap.regroundCooldownRemaining;
    state.lastGovernorNoPauseAt = snap.lastGovernorNoPauseAt;
    state.skipToolIdStabilization = snap.skipToolIdStabilization;
    state.gitInspectionBlockCount = snap.gitInspectionBlockCount;
  }

  async function casSessionSave(state: SessionState): Promise<void> {
    try {
      if (state.history.length > 2 && state.record.userId !== "anon") {
        const continuity = sessionContinuity.extract(state.history);
        const existingPlanGraph = parsePlanGraph(state.record.metadata);
        if (existingPlanGraph) {
          continuity.planGraph = serializePlanGraph(existingPlanGraph);
        }
        const metaPlanFilePath = state.record.metadata.plan_file_path;
        if (typeof metaPlanFilePath === "string" && metaPlanFilePath) {
          continuity.planFilePath = metaPlanFilePath;
        }
        state.record.continuity = continuity;
        void sessionStore.saveContinuity(state.record.userId, continuity).catch((err) => { console.warn("[session] saveContinuity failed:", (err as Error).message ?? err); });
      }
      if (state.taskLedger && state.taskLedger.tasks.length > 0) {
        state.record.metadata.task_ledger = serializeTaskLedger(state.taskLedger);
      }
      const ok = await sessionStore.save(state.record);
      if (!ok) {
        const reloaded = await sessionStore.load(state.record.sessionKey);
        if (reloaded) {
          reloaded.totalTokensIn = Math.max(reloaded.totalTokensIn, state.record.totalTokensIn);
          reloaded.totalTokensOut = Math.max(reloaded.totalTokensOut, state.record.totalTokensOut);
          reloaded.totalTokensCached = Math.max(reloaded.totalTokensCached, state.record.totalTokensCached);
          reloaded.totalTokensSaved = Math.max(reloaded.totalTokensSaved ?? 0, state.record.totalTokensSaved ?? 0);
          reloaded.requestCount = Math.max(reloaded.requestCount, state.record.requestCount);
          reloaded.lastActiveAt = Math.max(reloaded.lastActiveAt, state.record.lastActiveAt);
          const remoteEstimated = Number(reloaded.metadata.total_estimated_cost_usd ?? 0);
          const localEstimated = Number(state.record.metadata.total_estimated_cost_usd ?? 0);
          reloaded.metadata.total_estimated_cost_usd = Math.max(remoteEstimated, localEstimated);

          const remoteActual = Number(reloaded.metadata.total_actual_cost_usd ?? 0);
          const localActual = Number(state.record.metadata.total_actual_cost_usd ?? 0);
          reloaded.metadata.total_actual_cost_usd = Math.max(remoteActual, localActual);
          state.record = reloaded;
          await sessionStore.save(state.record);
        }
      }
      void sessionStore.saveSessionState(state.record.sessionKey, buildSessionStateSnapshot(state)).catch((err) => {
        logger.warn({ err }, "Session state snapshot persist failed (non-fatal)");
      });
    } catch (err) {
      logger.warn({ err }, "Session persistence failed (non-fatal)");
      recordSessionEvent(state.record.sessionKey, state.record.userId, state.record.orgId, "persistence_error", "casSessionSave", String(err instanceof Error ? err.message : err).slice(0, 500));
    }
  }

  function resolveCompactionBackendModelHintFromRequestModel(modelId: string | undefined): string {
    const id = (modelId ?? "").trim();
    const fallbackTier = tierRegistry.getTierConfig(config.SYNESIS_YARN_DEFAULT_TIER);
    if (!id) return (fallbackTier?.backendModel ?? "").trim();
    const tier = tierRegistry.getTierConfig(id) ?? fallbackTier;
    return (tier?.backendModel ?? id).trim();
  }

  function pinchCompactionBackendModelMetadata(
    session: SessionState,
    tierId: string,
    requestedFallback: string,
  ): void {
    const tier = tierRegistry.getTierConfig(tierId) ?? tierRegistry.getTierConfig(config.SYNESIS_YARN_DEFAULT_TIER);
    const backend = (tier?.backendModel ?? requestedFallback).trim();
    if (backend) {
      session.record.metadata[SYNESIS_COMPACTION_BACKEND_META] = backend;
    }
  }

  function compactionCheckpointHints(state: SessionState): { backendHint: string; sensitivity: CompactionSensitivity } {
    const meta = String(state.record.metadata[SYNESIS_COMPACTION_BACKEND_META] ?? "").trim();
    const tierId = String(state.record.lastTier ?? "").trim();
    const backendHint = meta || resolveCompactionBackendModelHintFromRequestModel(tierId);
    return { backendHint, sensitivity: inferCompactionSensitivity(backendHint) };
  }

  function maybeCheckpoint(state: SessionState): void {
    const { sensitivity } = compactionCheckpointHints(state);
    const isMinimal = config.SYNESIS_YARN_CONTEXT_BUDGET_COMPACTION_MODE === "minimal";
    const baseToolCalls = config.SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS;
    const baseHistLen = 60;
    const toolTh = effectiveSawtoothCheckpointToolCalls(isMinimal ? baseToolCalls * 2 : baseToolCalls, sensitivity);
    const histTh = effectiveSawtoothHistoryLengthThreshold(isMinimal ? baseHistLen * 2 : baseHistLen, sensitivity);
    if (!sawtooth.shouldCheckpoint(state.history, state.toolCallsSinceCheckpoint, {
      toolCallsThreshold: toolTh,
      historyLengthThreshold: histTh,
    })) {
      return;
    }
    const charsBefore = state.history.reduce((sum, m) => sum + m.content.length, 0);
    void sawtooth.compressTrajectory(state.history, { sensitivity }).then((consolidated) => {
      state.history = [{ role: "system", content: consolidated.summary }];
      state.toolCallsSinceCheckpoint = 0;
      getFileSnapshotRegistry(state.record.sessionKey).markCompaction("SUMMARY_ONLY");
      getContentDedup(state.record.sessionKey).reset();
      metrics.compactionTotal.inc({ type: "sawtooth" });
      metrics.sessionCheckpointTotal.inc();
      const charsAfter = consolidated.summary.length;
      const charsSaved = Math.max(0, charsBefore - charsAfter);
      metrics.compactionCharsSaved.inc(charsSaved);
    }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn({ err, sessionKey: state.record.sessionKey }, "compaction_failed");
      recordSessionEvent(state.record.sessionKey, state.record.userId, state.record.orgId, "compaction_error", "sawtooth", detail.slice(0, 500));
    });
  }

  async function forceCheckpoint(state: SessionState): Promise<boolean> {
    if (state.history.length <= 1) return false;
    const charsBefore = state.history.reduce((sum, m) => sum + m.content.length, 0);
    try {
      const { sensitivity } = compactionCheckpointHints(state);
      const consolidated = await sawtooth.compressTrajectory(state.history, { sensitivity });
      state.history = [{ role: "system", content: consolidated.summary }];
      state.toolCallsSinceCheckpoint = 0;
      getFileSnapshotRegistry(state.record.sessionKey).markCompaction("SUMMARY_ONLY");
      getContentDedup(state.record.sessionKey).reset();
      metrics.compactionTotal.inc({ type: "manual" });
      metrics.sessionCheckpointTotal.inc();
      const charsAfter = consolidated.summary.length;
      const charsSaved = Math.max(0, charsBefore - charsAfter);
      metrics.compactionCharsSaved.inc(charsSaved);
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn({ err, sessionKey: state.record.sessionKey }, "forced_compaction_failed");
      recordSessionEvent(state.record.sessionKey, state.record.userId, state.record.orgId, "compaction_error", "forced", detail.slice(0, 500));
      return false;
    }
  }

  return {
    getSessionKey,
    getSessionState,
    buildSessionStateSnapshot,
    casSessionSave,
    resolveCompactionBackendModelHintFromRequestModel,
    pinchCompactionBackendModelMetadata,
    maybeCheckpoint,
    forceCheckpoint,
  };
}
