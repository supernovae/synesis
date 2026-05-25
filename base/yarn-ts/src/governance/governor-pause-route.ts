import type { GovernorPauseEnvelope } from "./execution-governor.js";

export interface GovernorPauseRouteSession {
  consecutiveRecoveryFires: number;
  governorPrePauseAttemptsByRule: Map<string, number>;
  editReplayHardStopGraceUsed: boolean;
  editMissForceReadPending: boolean;
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
}

export interface GovernorPauseRouteIdentity {
  userId: string;
  orgId: string;
}

export interface GovernorPauseBuildResult {
  content: string;
  envelope: GovernorPauseEnvelope;
  eventType: string;
  eventSource: string;
  eventSummary: string;
  eventMetadata?: Record<string, unknown>;
}

export interface GovernorPauseRouteInput<TSession extends GovernorPauseRouteSession> {
  session: TSession;
  sessionKey: string;
  identity: GovernorPauseRouteIdentity;
  requestId: string;
  selectedModel: string;
  originalModel: string;
  finishReason: string;
  buildPause: (consecutiveRecoveryFires: number) => GovernorPauseBuildResult;
  persistPauseContext: (params: {
    session: TSession;
    pauseEnvelope: GovernorPauseEnvelope;
    pauseContent: string;
  }) => void;
  persistSessionAndUsage: (input: {
    state: TSession;
    requestId: string;
    resolvedModelId: string;
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheCreationTokens: number; costUsd: number };
    latencyMs: number;
    finishReason: string;
    tokensSavedByReduction?: number;
    escalated?: boolean;
    clientRequestedModel?: string;
  }) => void;
  maybeCheckpoint: (session: TSession) => void;
  recordSessionEvent: (
    sessionKey: string,
    userId: string,
    orgId: string,
    eventType: string,
    source: string,
    summary: string,
    requestId: string,
    metadata?: Record<string, unknown>,
  ) => void;
}

export interface GovernorPauseRouteResult {
  content: string;
  envelope: GovernorPauseEnvelope;
}

export function persistGovernorPauseSoftFail<TSession extends GovernorPauseRouteSession>(
  input: GovernorPauseRouteInput<TSession>,
): GovernorPauseRouteResult {
  const pauseStarted = Date.now();
  input.session.consecutiveRecoveryFires += 1;
  const pause = input.buildPause(input.session.consecutiveRecoveryFires);
  input.persistPauseContext({
    session: input.session,
    pauseEnvelope: pause.envelope,
    pauseContent: pause.content,
  });
  input.recordSessionEvent(
    input.sessionKey,
    input.identity.userId,
    input.identity.orgId,
    pause.eventType,
    pause.eventSource,
    pause.eventSummary,
    input.requestId,
    pause.eventMetadata,
  );
  input.session.history.push({ role: "assistant", content: pause.content });
  input.persistSessionAndUsage({
    state: input.session,
    requestId: input.requestId,
    resolvedModelId: input.selectedModel,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
    latencyMs: Date.now() - pauseStarted,
    finishReason: input.finishReason,
    tokensSavedByReduction: 0,
    escalated: false,
    clientRequestedModel: input.originalModel,
  });
  input.maybeCheckpoint(input.session);
  return {
    content: pause.content,
    envelope: pause.envelope,
  };
}

export function resetGovernorPauseRecoveryState<TSession extends GovernorPauseRouteSession>(
  session: TSession,
  hasActiveEditMissFailure: boolean,
  clearPauseContextMetadata: (session: TSession) => void,
): void {
  session.consecutiveRecoveryFires = 0;
  session.governorPrePauseAttemptsByRule.clear();
  clearPauseContextMetadata(session);
  if (!hasActiveEditMissFailure) {
    session.editReplayHardStopGraceUsed = false;
    session.editMissForceReadPending = false;
  }
}
