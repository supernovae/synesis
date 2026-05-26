import type { AppConfig } from "../config.js";
import type { FastPathResult, PatternPrefetchResult } from "../evidence/fast-path.js";
import type { GovernorInputMessage } from "../governance/execution-governor.js";
import type { WorkflowPhase } from "../orchestration/phase-model-orchestrator.js";
import type { SensemakingResult } from "../sensemaking/index.js";

type Logger = {
  info(record: Record<string, unknown>, message?: string): void;
};

type SessionLike = {
  record: {
    metadata: Record<string, unknown>;
    consecutiveFailedVerifications: number;
    escalationCount: number;
    lastTier?: string;
  };
  awaitingToolLoopUserAck: boolean;
  toolLoopAckAnchorUserHash: string;
  toolLoopNoUserAckCount: number;
  artifactEditTurns: unknown;
  scopeEnvelope: unknown;
  diffStats: unknown;
  regroundCooldownRemaining: number;
  editMissForceReadPending?: boolean;
  taskLedger?: unknown;
};

type ClaudeMessage = {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: unknown };
    name?: string;
    input?: unknown;
  }>;
};

type LatestReadRefreshLike = {
  hasRecentReadSuccess: boolean;
};

type EditMissGuardLike = {
  active?: boolean;
} | null | undefined;

export interface ClaudeContextPreparationInput {
  config: AppConfig;
  logger: Logger;
  session: SessionLike;
  sessionKey: string;
  identity: { userId: string; orgId: string };
  requestId: string;
  requestedModel: string;
  latestUser?: { role: string; content: unknown };
  latestUserIsRealAck: boolean;
  taskCue: unknown;
  normalizedMessages: ClaudeMessage[];
  manifest: { riskProfile: unknown };
  recallDecision: {
    resolution?: { confidence?: number } | null;
    routing?: unknown;
  } | null | undefined;
  verificationState: {
    round: number;
    stalled?: boolean;
  };
  workingPhase?: WorkflowPhase;
  workingFrameGoal?: string;
  workspaceInspection: {
    isEmpty: boolean;
    projectInstructionFiles: unknown[];
  };
  latestReadRefresh: LatestReadRefreshLike;
  editMissGuard: EditMissGuardLike;
  knowledgeSearch: unknown;
  knowledgeContext: unknown;
  phaseOrchestrator: {
    decide(input: unknown, sessionKey: string): {
      tier: string;
      selectedModel: string;
      phase: unknown;
      escalated?: boolean;
    };
  };
  pinchCompactionBackendModelMetadata(session: unknown, tier: string, requestedModel: string): void;
  runEvidencePrefetch(
    text: string,
    knowledgeSearch: unknown,
    timeoutMs: number,
    confidenceMin: number,
    options: { retryEnabled: boolean },
    context: unknown,
  ): Promise<FastPathResult>;
  runPatternPrefetch(
    text: string,
    knowledgeSearch: unknown,
    timeoutMs: number,
    workingPhase: WorkflowPhase | undefined,
    context: unknown,
  ): Promise<PatternPrefetchResult>;
  runSensemaking(input: unknown): { result: SensemakingResult; block?: string; evaluated: boolean };
  detectLanguagesFromMessages(messages: unknown[]): string[];
  applySensemakingStats(stats: unknown, result: SensemakingResult, evaluated: boolean): void;
  sensemakingStats: unknown;
  hashTextSignal(content: unknown): string;
  resetQwenInterventionOnUserTurn(sessionKey: string): void;
  detectToolProgress(session: unknown, messages: ClaudeMessage[], options: {
    normalizeSignal(content: unknown): string;
    looksLikeFailure(content: unknown): boolean;
  }): unknown;
  normalizedToolOutputSignal(content: unknown): string;
  looksLikeFailureSignal(content: unknown): boolean;
  analyzeRecentCommandLoop(messages: ClaudeMessage[]): unknown;
  buildArtifactShadows(registry: unknown, artifactEditTurns: unknown): unknown;
  getFileSnapshotRegistry(sessionKey: string): unknown;
  summarizeArtifactContext(shadows: unknown): unknown;
  deriveFileState(input: unknown): unknown;
  readPersistedChatStateSnapshot(metadata: Record<string, unknown>): unknown;
  deriveChatState(messages: GovernorInputMessage[], options: unknown): unknown;
  chatPhaseFromWorkflowPhase(phase?: WorkflowPhase): unknown;
  classifyIntentScope(directive: string): { envelope: unknown };
  createDiffStats(): unknown;
  applyObjectiveScopeAndPersist(input: unknown): {
    scopedMessages: unknown[];
    epochId: unknown;
    boundaryIndex: unknown;
    retainedEvidenceCount: number;
    droppedPreBoundaryCount: number;
    relevantEvidenceBlock?: string | null;
    artifactBridgeBlock?: string | null;
  };
  extractTextFromUnknownContent(content: unknown): string;
  assessStateConfidence(input: unknown): {
    needsReground: boolean;
    recommendedReadPath: string | null;
    reasons: string[];
    chatConfidence: number;
    fileConfidence: number;
    overallConfidence: number;
  };
  projectInstructionFilePresent(path: string | null): boolean;
  persistStateConfidence(metadata: Record<string, unknown>, confidence: unknown): void;
  formatStateConfidenceBlock(confidence: unknown): string | null;
  prepareProtocolPauseState(input: unknown): {
    pauseChatSummary: unknown;
    pauseFileSummary: unknown;
    pauseTaskContext: unknown;
    chatStateBlock?: string | null;
    fileStateBlock?: string | null;
  };
  recordSessionEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    eventKind: string,
    component: string,
    detail: string,
    requestId?: string,
    metadataJson?: Record<string, unknown>,
  ): void;
}

export async function prepareClaudeContext(input: ClaudeContextPreparationInput) {
  let prefetchResult: FastPathResult | undefined;
  if (input.config.SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED && input.latestUser) {
    const prefetchText = typeof input.latestUser.content === "string" ? input.latestUser.content : "";
    if (prefetchText.length > 0) {
      prefetchResult = await input.runEvidencePrefetch(
        prefetchText,
        input.knowledgeSearch,
        input.config.SYNESIS_YARN_EVIDENCE_PREFETCH_TIMEOUT_MS,
        input.config.SYNESIS_YARN_EVIDENCE_CONFIDENCE_MIN,
        { retryEnabled: input.config.SYNESIS_YARN_EVIDENCE_PREFETCH_RETRY_ENABLED },
        input.knowledgeContext,
      );
      if (prefetchResult.matched) {
        input.logger.info({
          pattern: prefetchResult.pattern,
          hasEvidence: Boolean(prefetchResult.evidence),
          timedOut: prefetchResult.timedOut,
          latencyMs: Math.round(prefetchResult.latencyMs),
          confidence: prefetchResult.confidence,
          authoritative: prefetchResult.authoritative,
        }, "evidence_prefetch_result_claude");
      }
    }
  }

  let patternResult: PatternPrefetchResult | undefined;
  if (input.config.SYNESIS_YARN_PATTERN_RECALL_ENABLED && input.latestUser && !prefetchResult?.matched) {
    const patternText = typeof input.latestUser.content === "string" ? input.latestUser.content : "";
    if (patternText.length > 0) {
      patternResult = await input.runPatternPrefetch(
        patternText,
        input.knowledgeSearch,
        input.config.SYNESIS_YARN_EVIDENCE_PREFETCH_TIMEOUT_MS,
        input.workingPhase,
        input.knowledgeContext,
      );
    }
  }

  const combinedConfidence = Math.max(
    prefetchResult?.confidence ?? 0,
    patternResult?.confidence ?? 0,
  );

  const orchestration = input.phaseOrchestrator.decide({
    requestedModel: input.requestedModel,
    modelSelectionMode: input.config.SYNESIS_YARN_GOVERNANCE_DISABLED ? "lock" : input.config.SYNESIS_YARN_MODEL_SELECTION_MODE,
    latestUserText: String(input.latestUser?.content ?? ""),
    workingPhase: input.workingPhase,
    planningUseHorizon: input.config.SYNESIS_YARN_PLANNING_USE_HORIZON,
    riskProfile: input.manifest.riskProfile,
    decisionMatrixEnabled: input.config.SYNESIS_YARN_DECISION_MATRIX_ENABLED,
    evidence: {
      recallConfidence: input.recallDecision?.resolution?.confidence,
      recallRouting: input.recallDecision?.routing,
      evidenceConfidence: combinedConfidence || undefined,
      evidenceAuthoritative: prefetchResult?.authoritative,
      verificationRound: input.verificationState.round > 0 ? input.verificationState.round : undefined,
      verificationStalled: input.verificationState.stalled || undefined,
      consecutiveFailedVerifications: input.session.record.consecutiveFailedVerifications,
    },
  }, input.sessionKey);
  if (orchestration.escalated) {
    input.session.record.escalationCount += 1;
  }
  input.session.record.lastTier = orchestration.tier;
  input.pinchCompactionBackendModelMetadata(input.session, orchestration.tier, input.requestedModel);

  const evidencePrefetched = Boolean(prefetchResult?.matched || patternResult?.matched);
  let sensemakingResult: SensemakingResult | undefined;
  let sensemakingBlock: string | null = null;
  if (input.config.SYNESIS_YARN_SENSEMAKING_ENABLED) {
    const sensemaking = input.runSensemaking({
      config: input.config,
      messages: input.normalizedMessages,
      getLanguages: input.detectLanguagesFromMessages,
      orchestration,
      recallDecision: input.recallDecision,
      verificationState: input.verificationState,
      evidencePrefetched,
      evidenceConfidence: combinedConfidence,
      evidenceAuthoritative: prefetchResult?.authoritative,
      userText: String(input.latestUser?.content ?? ""),
      workingFrameGoal: input.workingFrameGoal,
      consecutiveFailedVerifications: input.session.record.consecutiveFailedVerifications,
    });
    sensemakingResult = sensemaking.result;
    sensemakingBlock = input.config.SYNESIS_YARN_SENSEMAKING_PROMPT_BLOCK_ENABLED
      ? (sensemaking.block || null)
      : null;
    input.applySensemakingStats(input.sensemakingStats, sensemaking.result, sensemaking.evaluated);
  }

  const latestUserHash = input.hashTextSignal(input.latestUser?.content ?? "");
  if (input.session.awaitingToolLoopUserAck) {
    if (input.latestUserIsRealAck && latestUserHash !== input.session.toolLoopAckAnchorUserHash) {
      input.session.awaitingToolLoopUserAck = false;
      input.session.toolLoopNoUserAckCount = 0;
      input.session.toolLoopAckAnchorUserHash = "";
      input.resetQwenInterventionOnUserTurn(input.sessionKey);
    } else {
      input.session.toolLoopNoUserAckCount += 1;
    }
  }
  const toolProgress = input.detectToolProgress(
    input.session,
    input.normalizedMessages,
    {
      normalizeSignal: (content) => input.normalizedToolOutputSignal(content),
      looksLikeFailure: input.looksLikeFailureSignal,
    },
  );
  const commandLoop = input.analyzeRecentCommandLoop(input.normalizedMessages);
  const artifactShadows = input.buildArtifactShadows(
    input.getFileSnapshotRegistry(input.sessionKey),
    input.session.artifactEditTurns,
  );
  const artifactContext = input.summarizeArtifactContext(artifactShadows);
  const fileState = input.deriveFileState({
    registry: input.getFileSnapshotRegistry(input.sessionKey),
    artifactShadows,
    messages: input.normalizedMessages,
  });
  const persistedChatState = input.readPersistedChatStateSnapshot(input.session.record.metadata);
  const chatState = input.deriveChatState(
    input.normalizedMessages as Array<GovernorInputMessage>,
    {
      phaseHint: input.chatPhaseFromWorkflowPhase(input.workingPhase),
      previousSnapshot: persistedChatState,
    },
  );

  const pendingUserDirective = (chatState as { pendingUserDirective?: string }).pendingUserDirective;
  if (input.config.SYNESIS_YARN_PROPORTIONALITY_ENABLED && pendingUserDirective) {
    const scopeClassification = input.classifyIntentScope(pendingUserDirective);
    if (scopeClassification.envelope !== "unconstrained") {
      input.session.scopeEnvelope = scopeClassification.envelope;
      input.session.diffStats = input.createDiffStats();
    }
  }

  const objectiveScope = input.applyObjectiveScopeAndPersist({
    state: input.session,
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    userId: input.identity.userId,
    orgId: input.identity.orgId,
    messages: input.normalizedMessages,
    chatState,
    fileState,
    latestUserPromptText: input.latestUser ? input.extractTextFromUnknownContent(input.latestUser.content) : "",
  });
  const scopedMessages = objectiveScope.scopedMessages;
  const rawStateConfidence = input.assessStateConfidence({
    chatState,
    fileState,
    recentReadSatisfied: input.latestReadRefresh.hasRecentReadSuccess,
  });
  const suppressInstructionReground =
    input.workspaceInspection.isEmpty
    && input.workspaceInspection.projectInstructionFiles.length === 0
    && input.projectInstructionFilePresent(rawStateConfidence.recommendedReadPath);
  const stateConfidence = suppressInstructionReground
    ? {
        ...rawStateConfidence,
        needsReground: false,
        recommendedReadPath: null,
        reasons: [...new Set([...rawStateConfidence.reasons, "empty_workspace_project_guidance_absent"])],
      }
    : rawStateConfidence;
  input.persistStateConfidence(input.session.record.metadata, stateConfidence);
  const stateConfidenceBlock = input.formatStateConfidenceBlock(stateConfidence);
  if (input.session.regroundCooldownRemaining > 0) {
    input.session.regroundCooldownRemaining -= 1;
  }
  const needsStateReground =
    stateConfidence.needsReground
    && !input.editMissGuard?.active
    && !input.session.editMissForceReadPending
    && input.session.regroundCooldownRemaining <= 0;
  if (needsStateReground) {
    input.session.regroundCooldownRemaining = 2;
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "state_confidence_reground_required",
      "state-confidence",
      `overall=${stateConfidence.overallConfidence.toFixed(3)} path=${stateConfidence.recommendedReadPath ?? "<none>"}`,
      input.requestId,
      {
        chat_confidence: stateConfidence.chatConfidence,
        file_confidence: stateConfidence.fileConfidence,
        overall_confidence: stateConfidence.overallConfidence,
        recommended_read_path: stateConfidence.recommendedReadPath,
        reasons: stateConfidence.reasons,
      },
    );
  }
  const pauseState = input.prepareProtocolPauseState({
    metadata: input.session.record.metadata,
    chatState,
    fileState,
    taskLedger: input.session.taskLedger,
  });

  return {
    prefetchResult,
    patternResult,
    combinedConfidence,
    orchestration,
    evidencePrefetched,
    sensemakingResult,
    sensemakingBlock,
    latestUserHash,
    toolProgress,
    commandLoop,
    artifactShadows,
    artifactContext,
    fileState,
    chatState,
    objectiveScope,
    scopedMessages,
    stateConfidence,
    stateConfidenceBlock,
    needsStateReground,
    pauseChatSummary: pauseState.pauseChatSummary,
    pauseFileSummary: pauseState.pauseFileSummary,
    pauseTaskContext: pauseState.pauseTaskContext,
    chatStateBlock: pauseState.chatStateBlock,
    fileStateBlock: pauseState.fileStateBlock,
  };
}
