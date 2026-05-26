import type { AuthUser } from "../auth.js";
import type { SessionIdentity } from "../session/session-key.js";
import { prepareProtocolPauseState } from "../session/protocol-pause-state.js";
import type { OpenAIChatCompletionsRouteDependencies } from "../server/route-dependencies.js";
import type { GovernorInputMessage } from "../governance/execution-governor.js";
import type { WorkflowPhase } from "../orchestration/phase-model-orchestrator.js";

type Deps = Pick<
  OpenAIChatCompletionsRouteDependencies,
  | "app"
  | "analyzeRecentCommandLoop"
  | "applyObjectiveScopeAndPersist"
  | "applySensemakingStats"
  | "assessStateConfidence"
  | "buildArtifactShadows"
  | "chatPhaseFromWorkflowPhase"
  | "classifyIntentScope"
  | "config"
  | "createDiffStats"
  | "deriveChatState"
  | "deriveFileState"
  | "detectLanguagesFromMessages"
  | "detectToolProgress"
  | "extractTextFromUnknownContent"
  | "formatStateConfidenceBlock"
  | "getFileSnapshotRegistry"
  | "hashTextSignal"
  | "knowledgeResolveContext"
  | "knowledgeSearch"
  | "looksLikeFailureSignal"
  | "normalizedToolOutputSignal"
  | "phaseOrchestrator"
  | "pinchCompactionBackendModelMetadata"
  | "persistStateConfidence"
  | "projectInstructionFilePresent"
  | "readPersistedChatStateSnapshot"
  | "recordSessionEvent"
  | "resetQwenInterventionOnUserTurn"
  | "runEvidencePrefetch"
  | "runPatternPrefetch"
  | "runSensemaking"
  | "sensemakingStats"
  | "summarizeArtifactContext"
>;

type SessionState = Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["getSessionState"]>>;
type RequestLike = {
  model: string;
  messages: unknown[];
};
type RequestForKnowledgeContext = { headers: { authorization?: string } };
type MessageWithToolState = {
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
type ToolLoopMessage = {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: unknown };
    name?: string;
    input?: unknown;
  }>;
};

interface PrepareOpenAIContextInput {
  deps: Deps;
  authUser: AuthUser;
  req: RequestForKnowledgeContext;
  session: SessionState;
  sessionKey: string;
  identity: SessionIdentity;
  requestId: string;
  request: RequestLike;
  normalizedMessages: MessageWithToolState[];
  latestUserText: { role: string; content: unknown } | undefined;
  preManifest: ReturnType<OpenAIChatCompletionsRouteDependencies["projectManifestService"]["build"]>;
  recallDecision: ReturnType<OpenAIChatCompletionsRouteDependencies["toolResultReduction"]["getLastRecallDecision"]>;
  verificationState: ReturnType<ReturnType<OpenAIChatCompletionsRouteDependencies["toolResultReduction"]["getVerificationTracker"]>["getState"]>;
  workingPhase: WorkflowPhase | undefined;
  workingFrameGoal: string | undefined;
  workspaceInspection: Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["applyWorkspaceBoundary"]>>;
  latestReadRefresh: ReturnType<OpenAIChatCompletionsRouteDependencies["classifyLatestReadRefresh"]>;
  editMissGuard: ReturnType<OpenAIChatCompletionsRouteDependencies["deriveEditContextMissGuardState"]>;
}

export async function prepareOpenAIContext(input: PrepareOpenAIContextInput) {
  const {
    deps,
    authUser,
    req,
    session,
    sessionKey,
    identity,
    requestId,
    request,
    normalizedMessages,
    latestUserText,
    preManifest,
    recallDecision,
    verificationState,
    workingPhase,
    workingFrameGoal,
    workspaceInspection,
    latestReadRefresh,
    editMissGuard,
  } = input;
  const {
    app,
    analyzeRecentCommandLoop,
    applyObjectiveScopeAndPersist,
    applySensemakingStats,
    assessStateConfidence,
    buildArtifactShadows,
    chatPhaseFromWorkflowPhase,
    classifyIntentScope,
    config,
    createDiffStats,
    deriveChatState,
    deriveFileState,
    detectLanguagesFromMessages,
    detectToolProgress,
    extractTextFromUnknownContent,
    formatStateConfidenceBlock,
    getFileSnapshotRegistry,
    hashTextSignal,
    knowledgeResolveContext,
    knowledgeSearch,
    looksLikeFailureSignal,
    normalizedToolOutputSignal,
    phaseOrchestrator,
    pinchCompactionBackendModelMetadata,
    persistStateConfidence,
    projectInstructionFilePresent,
    readPersistedChatStateSnapshot,
    recordSessionEvent,
    resetQwenInterventionOnUserTurn,
    runEvidencePrefetch,
    runPatternPrefetch,
    runSensemaking,
    sensemakingStats,
    summarizeArtifactContext,
  } = deps;

  let prefetchResult: import("../evidence/fast-path.js").FastPathResult | undefined;
  if (config.SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED && latestUserText) {
    const prefetchText = typeof latestUserText.content === "string" ? latestUserText.content : "";
    if (prefetchText.length > 0) {
      const evidencePrefetchResult = await runEvidencePrefetch(
        prefetchText,
        knowledgeSearch,
        config.SYNESIS_YARN_EVIDENCE_PREFETCH_TIMEOUT_MS,
        config.SYNESIS_YARN_EVIDENCE_CONFIDENCE_MIN,
        { retryEnabled: config.SYNESIS_YARN_EVIDENCE_PREFETCH_RETRY_ENABLED },
        knowledgeResolveContext(authUser, req),
      ) as import("../evidence/fast-path.js").FastPathResult;
      prefetchResult = evidencePrefetchResult;
      if (evidencePrefetchResult.matched) {
        app.log.info({
          pattern: evidencePrefetchResult.pattern,
          hasEvidence: Boolean(evidencePrefetchResult.evidence),
          timedOut: evidencePrefetchResult.timedOut,
          latencyMs: Math.round(evidencePrefetchResult.latencyMs),
          confidence: evidencePrefetchResult.confidence,
          authoritative: evidencePrefetchResult.authoritative,
        }, "evidence_prefetch_result");
      }
    }
  }

  let patternResult: import("../evidence/fast-path.js").PatternPrefetchResult | undefined;
  if (config.SYNESIS_YARN_PATTERN_RECALL_ENABLED && latestUserText && !prefetchResult?.matched) {
    const prefetchText = typeof latestUserText.content === "string" ? latestUserText.content : "";
    if (prefetchText.length > 0) {
      const recallPatternResult = await runPatternPrefetch(
        prefetchText,
        knowledgeSearch,
        config.SYNESIS_YARN_EVIDENCE_PREFETCH_TIMEOUT_MS,
        workingPhase,
        knowledgeResolveContext(authUser, req),
      ) as import("../evidence/fast-path.js").PatternPrefetchResult;
      patternResult = recallPatternResult;
      if (recallPatternResult.matched) {
        app.log.info({
          intent: recallPatternResult.intent,
          hasEvidence: Boolean(recallPatternResult.evidence),
          timedOut: recallPatternResult.timedOut,
          latencyMs: Math.round(recallPatternResult.latencyMs),
          confidence: recallPatternResult.confidence,
        }, "pattern_prefetch_result");
      }
    }
  }

  const combinedEvidenceConfidence = Math.max(
    prefetchResult?.confidence ?? 0,
    patternResult?.confidence ?? 0,
  );

  const orchestration = phaseOrchestrator.decide({
    requestedModel: request.model,
    modelSelectionMode: config.SYNESIS_YARN_GOVERNANCE_DISABLED ? "lock" : config.SYNESIS_YARN_MODEL_SELECTION_MODE,
    latestUserText: String(latestUserText?.content ?? ""),
    workingPhase,
    planningUseHorizon: config.SYNESIS_YARN_PLANNING_USE_HORIZON,
    riskProfile: preManifest.riskProfile,
    decisionMatrixEnabled: config.SYNESIS_YARN_DECISION_MATRIX_ENABLED,
    evidence: {
      recallConfidence: recallDecision?.resolution?.confidence,
      recallRouting: recallDecision?.routing,
      evidenceConfidence: combinedEvidenceConfidence || undefined,
      evidenceAuthoritative: prefetchResult?.authoritative,
      verificationRound: verificationState.round > 0 ? verificationState.round : undefined,
      verificationStalled: verificationState.stalled || undefined,
      consecutiveFailedVerifications: session.record.consecutiveFailedVerifications,
    },
  }, sessionKey);
  if (orchestration.escalated) {
    session.record.escalationCount += 1;
  }
  session.record.lastTier = orchestration.tier;
  pinchCompactionBackendModelMetadata(session, orchestration.tier, request.model);

  const evidencePrefetched = Boolean(
    prefetchResult?.matched
    || patternResult?.matched,
  );
  let sensemakingResult: import("../sensemaking/index.js").SensemakingResult | undefined;
  let sensemakingBlock: string | null = null;
  if (config.SYNESIS_YARN_SENSEMAKING_ENABLED) {
    const sensemaking = runSensemaking({
      config,
      messages: normalizedMessages as Array<{ role: string; content: unknown }>,
      getLanguages: detectLanguagesFromMessages,
      orchestration,
      recallDecision,
      verificationState,
      evidencePrefetched,
      evidenceConfidence: combinedEvidenceConfidence,
      evidenceAuthoritative: prefetchResult?.authoritative,
      userText: String(latestUserText?.content ?? ""),
      workingFrameGoal,
      consecutiveFailedVerifications: session.record.consecutiveFailedVerifications,
    });
    sensemakingResult = sensemaking.result;
    sensemakingBlock = config.SYNESIS_YARN_SENSEMAKING_PROMPT_BLOCK_ENABLED
      ? (sensemaking.block || null)
      : null;
    applySensemakingStats(sensemakingStats, sensemaking.result, sensemaking.evaluated);
  }

  const lastToolId = [...(request.messages as Array<{ role: string; tool_call_id?: string }>)]
    .reverse().find((m) => m.role === "tool")?.tool_call_id ?? "";
  const latestUserHash = hashTextSignal(latestUserText?.content ?? "");
  if (session.awaitingToolLoopUserAck) {
    if (latestUserHash && latestUserHash !== session.toolLoopAckAnchorUserHash) {
      session.awaitingToolLoopUserAck = false;
      session.toolLoopNoUserAckCount = 0;
      session.toolLoopAckAnchorUserHash = "";
      resetQwenInterventionOnUserTurn(sessionKey);
    } else {
      session.toolLoopNoUserAckCount += 1;
    }
  }
  const toolProgress = detectToolProgress(
    session,
    normalizedMessages,
    {
      normalizeSignal: (content: unknown) => normalizedToolOutputSignal(content),
      looksLikeFailure: looksLikeFailureSignal,
    },
  );
  const commandLoop = analyzeRecentCommandLoop(
    normalizedMessages as Array<ToolLoopMessage>,
  );
  const artifactShadows = buildArtifactShadows(
    getFileSnapshotRegistry(sessionKey),
    session.artifactEditTurns,
  );
  const artifactContext = summarizeArtifactContext(artifactShadows);
  const fileState = deriveFileState({
    registry: getFileSnapshotRegistry(sessionKey),
    artifactShadows,
    messages: normalizedMessages as Array<{ role: string; content: unknown; name?: string }>,
  });
  const persistedChatState = readPersistedChatStateSnapshot(session.record.metadata);
  const chatState = deriveChatState(
    normalizedMessages as Array<GovernorInputMessage>,
    {
      phaseHint: chatPhaseFromWorkflowPhase(workingPhase),
      previousSnapshot: persistedChatState,
    },
  );

  if (config.SYNESIS_YARN_PROPORTIONALITY_ENABLED && chatState.pendingUserDirective) {
    const scopeClassification = classifyIntentScope(chatState.pendingUserDirective);
    if (scopeClassification.envelope !== "unconstrained") {
      session.scopeEnvelope = scopeClassification.envelope;
      session.diffStats = createDiffStats();
    }
  }

  const objectiveScope = applyObjectiveScopeAndPersist({
    state: session,
    sessionKey,
    requestId,
    userId: identity.userId,
    orgId: identity.orgId,
    messages: normalizedMessages,
    chatState,
    fileState,
    latestUserPromptText: latestUserText ? extractTextFromUnknownContent(latestUserText.content) : "",
  });
  const scopedMessages = objectiveScope.scopedMessages;
  if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
    const preScopeChars = normalizedMessages.reduce(
      (s, m) => s + (typeof m.content === "string" ? m.content.length : m.content != null ? JSON.stringify(m.content).length : 0),
      0,
    );
    const postScopeChars = (scopedMessages as Array<{ content?: unknown }>).reduce(
      (s, m) => s + (typeof m.content === "string" ? m.content.length : m.content != null ? JSON.stringify(m.content).length : 0),
      0,
    );
    app.log.info(
      {
        reqId: requestId,
        preScopeMsgCount: normalizedMessages.length,
        postScopeMsgCount: scopedMessages.length,
        preScopeChars,
        postScopeChars,
        boundaryIndex: objectiveScope.boundaryIndex,
        droppedPreBoundary: objectiveScope.droppedPreBoundaryCount,
        retainedEvidence: objectiveScope.retainedEvidenceCount,
      },
      "objective_scope_diagnostic",
    );
  }
  const rawStateConfidence = assessStateConfidence({
    chatState,
    fileState,
    recentReadSatisfied: latestReadRefresh.hasRecentReadSuccess,
  });
  const suppressInstructionReground =
    workspaceInspection.isEmpty
    && workspaceInspection.projectInstructionFiles.length === 0
    && projectInstructionFilePresent(rawStateConfidence.recommendedReadPath);
  const stateConfidence = suppressInstructionReground
    ? {
        ...rawStateConfidence,
        needsReground: false,
        recommendedReadPath: null,
        reasons: [...new Set([...rawStateConfidence.reasons, "empty_workspace_project_guidance_absent"])],
      }
    : rawStateConfidence;
  persistStateConfidence(session.record.metadata, stateConfidence);
  const stateConfidenceBlock = formatStateConfidenceBlock(stateConfidence);
  if (session.regroundCooldownRemaining > 0) {
    session.regroundCooldownRemaining -= 1;
  }
  const needsStateReground =
    stateConfidence.needsReground
    && !editMissGuard?.active
    && !session.editMissForceReadPending
    && session.regroundCooldownRemaining <= 0;
  if (needsStateReground) {
    session.regroundCooldownRemaining = 2;
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "state_confidence_reground_required",
      "state-confidence",
      `overall=${stateConfidence.overallConfidence.toFixed(3)} path=${stateConfidence.recommendedReadPath ?? "<none>"}`,
      requestId,
      {
        chat_confidence: stateConfidence.chatConfidence,
        file_confidence: stateConfidence.fileConfidence,
        overall_confidence: stateConfidence.overallConfidence,
        recommended_read_path: stateConfidence.recommendedReadPath,
        reasons: stateConfidence.reasons,
      },
    );
  }
  const pauseState = prepareProtocolPauseState({
    metadata: session.record.metadata,
    chatState,
    fileState,
    taskLedger: session.taskLedger,
  });

  return {
    prefetchResult,
    patternResult,
    combinedEvidenceConfidence,
    orchestration,
    evidencePrefetched,
    sensemakingResult,
    sensemakingBlock,
    lastToolId,
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
