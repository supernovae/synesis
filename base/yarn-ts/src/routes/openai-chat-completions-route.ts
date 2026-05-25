import type { OpenAIChatCompletionsRouteDependencies } from "../index.js";
import { OptimizationLedger } from "../telemetry/optimization-ledger.js";
import { prepareOpenAIRouteNormalization } from "../pipeline/openai-route-normalization.js";
import { prepareOpenAISessionWorkspace } from "../pipeline/openai-session-workspace-preparation.js";
import { runOpenAIGovernancePrecheck } from "../pipeline/openai-governance-precheck.js";
import { prepareOpenAIExecutionGovernor } from "../pipeline/openai-execution-governor-preparation.js";
import { prepareOpenAIContext } from "../pipeline/openai-context-preparation.js";
import { prepareOpenAITurn } from "../pipeline/openai-turn-preparation.js";
import { prepareOpenAIEnrichment } from "../pipeline/openai-enrichment-preparation.js";
import { prepareOpenAIProviderRuntimeForRoute } from "../pipeline/openai-provider-runtime-preparation.js";
import { executeOpenAIProviderForRoute } from "../pipeline/openai-provider-route-execution.js";
import { handleOpenAIGovernorResponse } from "../pipeline/openai-governor-response.js";
import { sendOpenAIChatPipelineResult } from "../pipeline/openai-chat-pipeline.js";
import { shouldRunGovernorForMode } from "../pipeline/modes.js";

type AuthUser = import("../auth.js").AuthUser;
type SessionIdentity = import("../session/session-key.js").SessionIdentity;
type GovernorInputMessage = import("../governance/execution-governor.js").GovernorInputMessage;

export function registerOpenAIChatCompletionsRoute(deps: OpenAIChatCompletionsRouteDependencies): void {
  const {
    applyAuthKeyAttribution,
    applyEditContextMissReadGate,
    applyMarkdownGuardrail,
    artifactStore,
    buildEditContextMissForcedReadPrompt,
    buildEditContextMissGuardPrompt,
    buildStateRegroundReadPrompt,
    circuitBreakers,
    computePrefixFingerprint,
    emitPlanWriteAuditEvent,
    enrichmentPool,
    extractUpstreamErrorDiagnostics,
    finalizeCompletionText,
    finalizePostStreamText,
    findPreferredReadToolName,
    getContentDedup,
    getSessionKey,
    getSessionState,
    inferVerificationSteps,
    isWriteCapableToolName,
    loadProviderCachePolicyWindow,
    markerBackendForRequest,
    maybeCheckpoint,
    maybeLogEnvelopeUnwrapSample,
    maybeUpdateTaskLedgerFromToolCall,
    prefixOptimizer,
    readUsage,
    recordBlockedDiscovery,
    runOpenAIRequest,
    securityIngestConfig,
    shouldRestrictDiscoveryForPlanWork,
    streamAdmission,
    transcriptPruning,
    updateDiffAccumulator,
    validationNormalization,
    adapterUsesToolLoopSteering,
    analyzeRecentCommandLoop,
    annotatePlanFileReads,
    annotateVerificationGaps,
    app,
    appendPathContextToAdapterBlock,
    applyClarificationRoundResponseHeader,
    applyDiscoveryToolGuardrail,
    applyIngressCapToToolMessages,
    applyObjectiveScopeAndPersist,
    applySensemakingStats,
    applySessionTaskCapabilities,
    applyWorkspaceBoundary,
    applyWorkspaceMetadataPrebackfill,
    ARTIFACT_TOOL_NAME,
    artifactRetrieval,
    assessStateConfidence,
    assessVerificationSignals,
    authResolver,
    buildArtifactShadows,
    buildBlockedDiscoveryRecoverySnapshot,
    buildDefaultPolicy,
    buildEvidenceTraceSummary,
    buildExecutionGovernorHardStopUserMessage,
    buildExecutionGovernorPauseEnvelope,
    buildFreshImplicitSessionNotice,
    buildGovernorPauseResumeBlockForUser,
    buildRouteGovernanceBlocks,
    buildSensemakingGuidanceInjection,
    buildSensemakingPauseMessage,
    captureRequestForensics,
    casSessionSave,
    chatPhaseFromWorkflowPhase,
    clampMaxOutputTokensForSafety,
    classifyIntentScope,
    classifyLatestReadRefresh,
    classifyLatestToolProgress,
    classifyToolResultAsEvidence,
    clearGovernorPauseContextMetadata,
    clientAdapterPacks,
    collectToolExecutionFailureObservations,
    config,
    contextAdmissionStats,
    countTurnsSinceLastUser,
    createDiffStats,
    debugProtocolLog,
    deriveChatState,
    deriveEditContextMissGuardState,
    deriveFileState,
    deserializeShadow,
    detectClientTaskCapabilities,
    detectClientToolCapabilities,
    detectLanguagesFromMessages,
    detectToolProgress,
    DEV_DOCS_TOOL_NAME,
    distributedCounters,
    enrichWithFrameAndManifest,
    ensureReadToolAvailabilityForEditMissGuard,
    evaluateCachePolicyForSession,
    evaluateYarnPromptIntakeSteer,
    extractCommandEvents,
    extractEditedFileHints,
    extractLatestUserPromptFromMessages,
    extractMetadataFromMessages,
    extractPlanContentShadow,
    extractTextFromUnknownContent,
    fgaCheck,
    finalizePostEnrichmentMessages,
    finalizeRequestForensics,
    forceCheckpoint,
    formatEvidenceBlock,
    formatPatternBlock,
    formatStateConfidenceBlock,
    generateText,
    getBlockedDiscoveryCount,
    getCachedTopLevelDirs,
    getChecklistSourceHash,
    getFileSnapshotRegistry,
    getMemoryGovernor,
    getMetadataString,
    getSessionMemoryCount,
    getStructuralIndex,
    getTracer,
    governanceClient,
    GOVERNOR_COOLDOWN_MS,
    governorService,
    hashTextSignal,
    hasPersistedWorkspaceState,
    inferGovernorPhaseFromMessages,
    inferModelFamily,
    inferTrajectoryDiagnosticsFromMessages,
    injectGovernorRecoveryMessage,
    injectPlanModeRecoveryHint,
    injectSessionContext,
    isGenuineUserPromptMessage,
    isOpenClawProfile,
    isPlanRecoveryDiscoveryIntent,
    KNOWLEDGE_TOOL_NAME,
    knowledgeResolveContext,
    knowledgeSearch,
    loadUserRuntimePreferences,
    logAndPersistSafetyEvent,
    looksLikeFailureSignal,
    maybeBuildPlannerTodoPacketBlock,
    maybeUpdateTaskLedgerFromEvidence,
    mergeSessionPathHints,
    mergeSynesisClarificationFromRequestMetadata,
    normalizedToolOutputSignal,
    openAiChatPipeline,
    openClawProfileStats,
    parseOrchestratorPhaseHeader,
    parseSessionExecutionContext,
    persistGovernorPauseContextMetadata,
    persistGovernorPauseSoftFail,
    persistPromptIntakeSnapshot,
    persistStateConfidence,
    phaseFromFrame,
    phaseOrchestrator,
    pinchCompactionBackendModelMetadata,
    policyEngine,
    policyRejectOpenAIBody,
    processWorkspaceHandshakeRoute,
    projectInstructionFilePresent,
    projectManifestService,
    pushDiagnostic,
    readdir,
    readPersistedChatStateSnapshot,
    recordPromptIntakeEvent,
    recordSessionEvent,
    recordUpperHarnessDecision,
    refreshRequirementChecklist,
    refreshTaskIntake,
    remediatePlanFileStubs,
    resetGovernorPauseRecoveryState,
    resetQwenInterventionOnUserTurn,
    resetWorkspaceScopedSessionState,
    resolveCompactionBackendModelHintFromRequestModel,
    resolveEndpointCapabilityId,
    resolveRequestId,
    resolveWorkingPhase,
    roleAssignmentRegistry,
    runEvidencePrefetch,
    runPatternPrefetch,
    runProtocolSessionBootstrap,
    runSensemaking,
    runValidationTierCFallback,
    safeEnd,
    safeWrite,
    sendOpenAISoftFail,
    sendOpenAIWorkspaceHandshake,
    sensemakingStats,
    serializeShadow,
    sessionPersistenceRunner,
    sessions,
    setSessionWorkspaceContext,
    shouldResetImplicitSessionForFreshTranscript,
    shouldSampleBySeed,
    shouldStripGlobFromTools,
    sliceMessagesSinceLastUserPrompt,
    sseHeadersWithClarification,
    startSseHeartbeat,
    streamText,
    stripGlobFromTools,
    summarizeArtifactContext,
    summarizeEvidenceDelta,
    TIER_TO_ROLE,
    tierRegistry,
    toolArgHardeningStats,
    toolResultReduction,
    toSessionExecutionContextSystemBlock,
    updatePlanGraph,
    updateTracePromptMetadata,
    userRateLimiter,
    WEB_SEARCH_TOOL_ALIAS,
    WEB_SEARCH_TOOL_NAME,
    webSearch,
    webSearchResolveContext,
    withSpan,
    withSpanAsync,
    workingFrameService,
    workspaceStatePresence,
    yarnDedupeLayer,
    yarnToolPrefixCache,
  } = deps;

  // --- OpenAI chat completions ---
  app.post("/v1/chat/completions", async (req, reply) => {
    const oaiOptLedger = new OptimizationLedger();
    const endOaiIngressStage = oaiOptLedger.startStage("ingress");
    const oaiTraceReqId = resolveRequestId(req.headers as Record<string, unknown>);
    const oaiIngress = openAiChatPipeline.prepareIngress({
      body: req.body,
      headers: req.headers as Record<string, unknown>,
      config,
    });
    for (const truncation of oaiIngress.truncations) {
      app.log.warn({ reqId: oaiTraceReqId, ...truncation }, "tool_description_truncated");
    }
    if (!oaiIngress.ok) {
      endOaiIngressStage();
      return sendOpenAIChatPipelineResult(reply, {
        kind: "error",
        statusCode: oaiIngress.statusCode,
        body: oaiIngress.body,
      });
    }
    let authUser: AuthUser;
    try {
      authUser = await authResolver.resolve(req.headers.authorization);
    } catch {
      return reply.code(401).send({ error: { type: "auth_error", message: "Authentication required" } });
    }

    try {
      authResolver.requireCoderScope(authUser);
    } catch {
      return reply.code(403).send({ error: { type: "authz_error", message: "Insufficient scope for coder access" } });
    }

    const fgaResult = await fgaCheck(`user:${authUser.userId}`, "can_invoke", "yarn_endpoint", "completions");
    if (!fgaResult.allowed) {
      return reply.code(403).send({ error: { type: "authz_error", message: "Authorization denied by policy" } });
    }

    const oaiRateResult = await userRateLimiter.check(authUser.userId);
    if (!oaiRateResult.allowed) {
      app.log.warn({ userId: authUser.userId, count: oaiRateResult.currentCount, limit: oaiRateResult.limit }, "rate_limit_rejected");
      recordSessionEvent("", authUser.userId, authUser.orgId, "rate_limit_reject", "user-rate-limiter",
        `${oaiRateResult.currentCount}/${oaiRateResult.limit} in window — retry after ${oaiRateResult.retryAfterSeconds}s`);
      return sendOpenAIChatPipelineResult(reply, {
        kind: "error",
        statusCode: 429,
        headers: { "Retry-After": String(oaiRateResult.retryAfterSeconds) },
        body: { error: { type: "rate_limit_error", message: `Rate limit exceeded. Retry after ${oaiRateResult.retryAfterSeconds} seconds.` } },
      });
    }

    const request = oaiIngress.request;
    const oaiPipelineModeResolution = oaiIngress.modeResolution;
    const oaiPipelineMode = oaiPipelineModeResolution.mode;
    if (!oaiPipelineModeResolution.valid) {
      app.log.warn(
        {
          reqId: oaiTraceReqId,
          requestedMode: oaiPipelineModeResolution.requested,
          source: oaiPipelineModeResolution.source,
          fallbackMode: oaiPipelineMode,
        },
        "invalid_pipeline_mode",
      );
    }
    const oaiCanonicalRequest = oaiIngress.canonicalRequest;
    const oaiBodyMeta = oaiIngress.bodyMetadata;
    const oaiClientKind = oaiIngress.clientKind;
    const oaiConversationId = oaiIngress.conversationId;
    const oaiIdentity = openAiChatPipeline.resolveIdentity(oaiIngress, authUser);
    const oaiIdentityUserId = oaiIdentity.identityUserId;
    const oaiDisplayName = oaiIdentity.displayName;
    endOaiIngressStage();

    const oaiNormalization = await prepareOpenAIRouteNormalization({
      deps: {
        app,
        appendPathContextToAdapterBlock,
        applyIngressCapToToolMessages,
        assessVerificationSignals,
        clientAdapterPacks,
        config,
        debugProtocolLog,
        enrichmentPool,
        extractLatestUserPromptFromMessages,
        governanceClient,
        inferTrajectoryDiagnosticsFromMessages,
        isOpenClawProfile,
        openClawProfileStats,
        parseSessionExecutionContext,
        projectManifestService,
        resolveCompactionBackendModelHintFromRequestModel,
        runValidationTierCFallback,
        sessions,
        toolResultReduction,
        transcriptPruning,
        validationNormalization,
      },
      request,
      requestId: oaiTraceReqId,
      authUser,
      identity: {
        userId: oaiIdentityUserId,
        orgId: authUser.orgId,
        conversationId: oaiConversationId,
        clientKind: oaiClientKind,
        displayName: oaiDisplayName,
      },
      canonicalRequest: oaiCanonicalRequest,
      pipelineMode: oaiPipelineMode,
      bodyMetadata: oaiBodyMeta as Record<string, unknown> | null,
      headers: req.headers as Record<string, string | string[] | undefined>,
      optimizationLedger: oaiOptLedger,
    });
    const oaiTaskCue = oaiNormalization.taskCue;
    const oaiCompactionOpts = oaiNormalization.compactionOpts;
    const oaiMatrixModelPath = oaiNormalization.matrixModelPath;
    const oaiMatrixModelId = oaiNormalization.matrixModelId;
    const oaiMatrixFamily = oaiNormalization.matrixFamily;
    const oaiCapabilityResolution = oaiNormalization.capabilityResolution;
    const oaiPhasePolicyEnabledByMatrix = oaiNormalization.phasePolicyEnabledByMatrix;
    const oaiContentDedupeEnabled = oaiNormalization.contentDedupeEnabled;
    const oaiResponseDedupeEnabled = oaiNormalization.responseDedupeEnabled;
    const oaiHistoricalNormalizeEnabled = oaiNormalization.historicalNormalizeEnabled;
    const reducedOpenAI = oaiNormalization.reducedOpenAI;
    const normalizedOpenAI = oaiNormalization.normalizedOpenAI;
    const toolResultCount = oaiNormalization.toolResultCount;
    const endOaiPruningStage = oaiNormalization.endPruningStage;
    const oaiTrajectoryDiagnostics = oaiNormalization.trajectoryDiagnostics;
    const oaiVerificationAssessment = oaiNormalization.verificationAssessment;
    const adapterProfile = oaiNormalization.adapterProfile;
    const openClawStrictGovernance = oaiNormalization.openClawStrictGovernance;
    const oaiPathCtx = oaiNormalization.pathContext;
    const adapterBlock = oaiNormalization.adapterBlock;
    const latestUserText = oaiNormalization.latestUserText;
    const preManifest = oaiNormalization.preManifest;
    const identity: SessionIdentity = oaiIdentity.identity;
    const oaiSessionWorkspace = await prepareOpenAISessionWorkspace({
      deps: {
        app,
        annotatePlanFileReads,
        annotateVerificationGaps,
        applyAuthKeyAttribution,
        applySessionTaskCapabilities,
        applyWorkspaceBoundary,
        buildFreshImplicitSessionNotice,
        config,
        detectClientTaskCapabilities,
        detectClientToolCapabilities,
        distributedCounters,
        extractPlanContentShadow,
        getContentDedup,
        getFileSnapshotRegistry,
        getMemoryGovernor,
        getSessionKey,
        getSessionState,
        hasPersistedWorkspaceState,
        injectPlanModeRecoveryHint,
        isGenuineUserPromptMessage,
        loadUserRuntimePreferences,
        recordSessionEvent,
        readdir,
        remediatePlanFileStubs,
        resetWorkspaceScopedSessionState,
        runProtocolSessionBootstrap,
        serializeShadow,
        shouldResetImplicitSessionForFreshTranscript,
        transcriptPruning,
        workspaceStatePresence,
        yarnDedupeLayer,
      },
      authUser,
      identity,
      request,
      normalizedOpenAI,
      requestId: oaiTraceReqId,
      clientKind: oaiClientKind,
      conversationId: oaiConversationId,
      taskCue: oaiTaskCue,
      pathContext: oaiPathCtx,
      capabilityResolution: oaiCapabilityResolution,
      matrixModelId: oaiMatrixModelId,
      matrixModelPath: oaiMatrixModelPath,
      matrixFamily: oaiMatrixFamily,
      compactionBackendModelHint: oaiCompactionOpts.backendModelHint,
      contentDedupeEnabled: oaiContentDedupeEnabled,
      responseDedupeEnabled: oaiResponseDedupeEnabled,
      historicalNormalizeEnabled: oaiHistoricalNormalizeEnabled,
      optimizationLedger: oaiOptLedger,
    });
    const sessionKey = oaiSessionWorkspace.sessionKey;
    const session = oaiSessionWorkspace.session;
    const oaiRuntimePreferences = oaiSessionWorkspace.runtimePreferences;
    const oaiClientToolCapabilities = oaiSessionWorkspace.clientToolCapabilities;
    const oaiForensicsCapabilityMatrix = oaiSessionWorkspace.forensicsCapabilityMatrix;
    const oaiWorkspaceInspection = oaiSessionWorkspace.workspaceInspection;
    const oaiFreshImplicitSessionNotice = oaiSessionWorkspace.freshImplicitSessionNotice;
    endOaiPruningStage?.();
    const endOaiContextStage = oaiOptLedger.startStage("context");
    const oaiTurn = await prepareOpenAITurn({
      deps: {
        casSessionSave,
        classifyLatestReadRefresh,
        classifyLatestToolProgress,
        classifyToolResultAsEvidence,
        clientAdapterPacks,
        collectToolExecutionFailureObservations,
        config,
        deriveEditContextMissGuardState,
        evaluateYarnPromptIntakeSteer,
        getChecklistSourceHash,
        inferGovernorPhaseFromMessages,
        maybeBuildPlannerTodoPacketBlock,
        maybeUpdateTaskLedgerFromEvidence,
        mergeSessionPathHints,
        mergeSynesisClarificationFromRequestMetadata,
        parseOrchestratorPhaseHeader,
        persistPromptIntakeSnapshot,
        phaseFromFrame,
        processWorkspaceHandshakeRoute,
        recordPromptIntakeEvent,
        recordSessionEvent,
        refreshRequirementChecklist,
        refreshTaskIntake,
        resolveWorkingPhase,
        sliceMessagesSinceLastUserPrompt,
        toSessionExecutionContextSystemBlock,
        toolResultReduction,
        updatePlanGraph,
        updateTracePromptMetadata,
        workingFrameService,
      },
      session,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      request: request as {
        model: string;
        messages: unknown[];
        tools?: unknown[];
        stream?: unknown;
        extra_body?: Record<string, unknown> | null;
      },
      normalizedMessages: normalizedOpenAI.messages as Array<{
        role: string;
        content: unknown;
        name?: string;
        tool_call_id?: string;
        tool_calls?: unknown;
      }>,
      bodyMetadata: oaiBodyMeta as Record<string, unknown> | null | undefined,
      latestUserText,
      latestUserPrompt: oaiTaskCue,
      clientToolCapabilities: oaiClientToolCapabilities,
      pathContext: oaiPathCtx,
      adapterProfile,
      adapterBlock,
      failingVerificationSignals: oaiVerificationAssessment.failingSignals,
      headers: req.headers as Record<string, unknown>,
    });
    const oaiRequirementChecklist = oaiTurn.requirementChecklist;
    const oaiTaskIntake = oaiTurn.taskIntake;
    const oaiPlanGraph = oaiTurn.planGraph;
    const oaiPromptIntake = oaiTurn.promptIntake;
    const oaiPlannerTodoPacketBlock = oaiTurn.plannerTodoPacketBlock;
    const oaiToolFailures = oaiTurn.toolFailures;
    const oaiEditMissGuard = oaiTurn.editMissGuard;
    const oaiLatestToolProgress = oaiTurn.latestToolProgress;
    const oaiLatestReadRefresh = oaiTurn.latestReadRefresh;
    const oaiEditMissFailureCount = oaiTurn.editMissFailureCount;
    const oaiHasActiveEditMissFailure = oaiTurn.hasActiveEditMissFailure;
    const oaiWorkspaceHandshakeAction = oaiTurn.workspaceHandshakeAction;
    if (oaiWorkspaceHandshakeAction.kind === "send") {
      return sendOpenAIWorkspaceHandshake(reply, oaiTraceReqId, request.model, !!request.stream, oaiWorkspaceHandshakeAction.toolCallId);
    }
    let effectiveOaiPathCtx = oaiTurn.effectivePathContext;
    const effectiveOaiAdapterBlock = oaiTurn.effectiveAdapterBlock;
    const buildEffectiveOaiAdapterBlock = oaiTurn.buildEffectiveAdapterBlock;
    const oaiRecallDecision = oaiTurn.recallDecision;
    const oaiVerifState = oaiTurn.verificationState;
    const oaiOrchestratorPhaseOverride = oaiTurn.orchestratorPhaseOverride;
    const oaiWorkingPhase = oaiTurn.workingPhase;
    const oaiWorkingFrameGoal = oaiTurn.workingFrameGoal;

    const oaiContext = await prepareOpenAIContext({
      deps: {
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
      },
      authUser,
      req,
      session,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      request,
      normalizedMessages: normalizedOpenAI.messages as Array<{
        role: string;
        content: unknown;
        name?: string;
        tool_call_id?: string;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown }; name?: string; input?: unknown }>;
      }>,
      latestUserText,
      preManifest,
      recallDecision: oaiRecallDecision,
      verificationState: oaiVerifState,
      workingPhase: oaiWorkingPhase,
      workingFrameGoal: oaiWorkingFrameGoal,
      workspaceInspection: oaiWorkspaceInspection,
      latestReadRefresh: oaiLatestReadRefresh,
      editMissGuard: oaiEditMissGuard,
    });
    const oaiPrefetchResult = oaiContext.prefetchResult;
    const oaiPatternResult = oaiContext.patternResult;
    const combinedEvidenceConfidence = oaiContext.combinedEvidenceConfidence;
    const orchestration = oaiContext.orchestration;
    const oaiEvidencePrefetched = oaiContext.evidencePrefetched;
    const oaiSensemakingResult = oaiContext.sensemakingResult;
    const oaiSensemakingBlock = oaiContext.sensemakingBlock;
    const oaiLastToolId = oaiContext.lastToolId;
    const latestOpenAIUserHash = oaiContext.latestUserHash;
    const oaiToolProgress = oaiContext.toolProgress;
    const oaiCommandLoop = oaiContext.commandLoop;
    const oaiArtifactShadows = oaiContext.artifactShadows;
    const oaiArtifactContext = oaiContext.artifactContext;
    const oaiFileState = oaiContext.fileState;
    const oaiChatState = oaiContext.chatState;
    const oaiObjectiveScope = oaiContext.objectiveScope;
    const oaiScopedMessages = oaiContext.scopedMessages;
    const oaiStateConfidence = oaiContext.stateConfidence;
    const oaiStateConfidenceBlock = oaiContext.stateConfidenceBlock;
    const oaiNeedsStateReground = oaiContext.needsStateReground;
    const oaiPauseChatSummary = oaiContext.pauseChatSummary;
    const oaiPauseFileSummary = oaiContext.pauseFileSummary;
    const oaiPauseTaskContext = oaiContext.pauseTaskContext;
    const oaiChatStateBlock = oaiContext.chatStateBlock;
    const oaiFileStateBlock = oaiContext.fileStateBlock;
    endOaiContextStage();
    const endOaiGovernorStage = oaiOptLedger.startStage("governor");
    const oaiExecutionGovernorPreparation = await prepareOpenAIExecutionGovernor({
      config,
      session,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      headers: req.headers as Record<string, unknown>,
      pipelineMode: oaiPipelineMode,
      taskCue: oaiTaskCue,
      scopedMessages: oaiScopedMessages,
      planGraph: oaiPlanGraph,
      editMissGuard: oaiEditMissGuard,
      latestToolProgress: oaiLatestToolProgress,
      toolFailures: oaiToolFailures,
      artifactShadows: oaiArtifactShadows,
      chatState: oaiChatState,
      fileState: oaiFileState,
      workingPhase: oaiWorkingPhase,
      editMissFailureCount: oaiEditMissFailureCount,
      governorCooldownMs: GOVERNOR_COOLDOWN_MS,
      stateConfidence: oaiStateConfidence,
      needsStateReground: oaiNeedsStateReground,
      objectiveScope: oaiObjectiveScope,
      artifactContext: oaiArtifactContext,
      pauseSummaries: {
        chat: oaiPauseChatSummary,
        file: oaiPauseFileSummary,
      },
      shouldRunGovernorForMode,
      governorService,
      withSpanAsync,
      summarizeEvidenceDelta,
      recordSessionEvent,
      buildGovernorPauseResumeBlockForUser,
    });
    const oaiExecutionGovernor = oaiExecutionGovernorPreparation.executionGovernor;
    const oaiGovernorPauseResumeBlock = oaiExecutionGovernorPreparation.governorPauseResumeBlock;

    const oaiGovernancePrecheck = await runOpenAIGovernancePrecheck({
      config,
      session,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      request,
      scopedMessages: oaiScopedMessages,
      taskCue: oaiTaskCue,
      executionGovernor: oaiExecutionGovernor,
      pipelineMode: oaiPipelineMode,
      shouldRunGovernorForMode,
      commandLoop: oaiCommandLoop,
      lastToolId: oaiLastToolId,
      latestUserHash: latestOpenAIUserHash,
      latestToolProgress: oaiLatestToolProgress,
      toolProgress: oaiToolProgress,
      runtimePreferences: oaiRuntimePreferences,
      orchestration,
      workingPhase: oaiWorkingPhase,
      orchestratorPhaseOverride: oaiOrchestratorPhaseOverride,
      normalizedMessages: normalizedOpenAI.messages as GovernorInputMessage[],
      distributedCounters,
      policyEngine,
      governanceClient,
      withSpan,
      extractCommandEvents,
      extractEditedFileHints,
      isPlanRecoveryDiscoveryIntent,
      countTurnsSinceLastUser,
      shouldStripGlobFromTools,
      stripGlobFromTools,
      getBlockedDiscoveryCount,
      logWarn: (record, message) => app.log.warn(record, message),
      logAndPersistSafetyEvent,
      persistSessionAndUsage: sessionPersistenceRunner.persistSessionAndUsage,
      maybeCheckpoint,
      recordSessionEvent,
    });
    const oaiSensemakingDecision = oaiGovernancePrecheck.sensemakingDecision;
    const policyPrecheck = oaiGovernancePrecheck.policyPrecheck;
    const oaiPolicyAction = oaiGovernancePrecheck.policyAction;
    if (oaiPolicyAction.kind === "softFail") {
      return sendOpenAISoftFail(reply, oaiTraceReqId, orchestration.selectedModel, oaiPolicyAction.content, !!request.stream);
    }
    if (oaiPolicyAction.kind === "reject") {
      return reply.code(400).send(policyRejectOpenAIBody(oaiPolicyAction.decision as never));
    }
    const oaiClientToolInventory = oaiGovernancePrecheck.clientToolInventory;
    const oaiGovernorPhase = oaiGovernancePrecheck.governorPhase;

    const oaiSensemakingPrimaryEnabled =
      config.SYNESIS_YARN_SENSEMAKING_ENABLED
      && !config.SYNESIS_YARN_SENSEMAKING_HARD_STOP_ONLY;
    const oaiGovernorResponse = handleOpenAIGovernorResponse({
      deps: {
        buildExecutionGovernorHardStopUserMessage,
        buildExecutionGovernorPauseEnvelope,
        buildSensemakingGuidanceInjection,
        buildSensemakingPauseMessage,
        clearGovernorPauseContextMetadata,
        config,
        injectGovernorRecoveryMessage,
        maybeCheckpoint,
        persistGovernorPauseContextMetadata,
        persistGovernorPauseSoftFail,
        recordSessionEvent,
        resetGovernorPauseRecoveryState,
        sessionPersistenceRunner,
        summarizeEvidenceDelta,
      },
      session,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      selectedModel: orchestration.selectedModel,
      originalModel: request.model,
      messages: normalizedOpenAI.messages as Array<{ role: string; content: unknown }>,
      executionGovernor: oaiExecutionGovernor,
      sensemakingDecision: oaiSensemakingDecision,
      sensemakingPrimaryEnabled: oaiSensemakingPrimaryEnabled,
      hasActiveEditMissFailure: oaiHasActiveEditMissFailure,
      clientToolCapabilities: oaiClientToolCapabilities,
      pauseContext: {
        artifactContext: oaiArtifactContext,
        chatStateSummary: oaiPauseChatSummary,
        fileStateSummary: oaiPauseFileSummary,
        taskContext: oaiPauseTaskContext,
      },
    });
    if (oaiGovernorResponse.kind === "softFail") {
      return sendOpenAISoftFail(reply, oaiTraceReqId, orchestration.selectedModel, oaiGovernorResponse.content, !!request.stream, oaiGovernorResponse.envelope);
    }
    endOaiGovernorStage();
    const endOaiEnrichmentStage = oaiOptLedger.startStage("enrichment");
    const oaiEnrichment = await prepareOpenAIEnrichment({
      deps: {
        app,
        applyWorkspaceMetadataPrebackfill,
        buildRouteGovernanceBlocks,
        config,
        enrichWithFrameAndManifest,
        extractMetadataFromMessages,
        finalizePostEnrichmentMessages,
        getCachedTopLevelDirs,
        getMemoryGovernor,
        getSessionMemoryCount,
        getStructuralIndex,
        inferModelFamily,
        recordSessionEvent,
        roleAssignmentRegistry,
        securityIngestConfig,
        setSessionWorkspaceContext,
        TIER_TO_ROLE,
      },
      session,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      pathContext: effectiveOaiPathCtx,
      adapterBlock: effectiveOaiAdapterBlock,
      buildAdapterBlock: buildEffectiveOaiAdapterBlock,
      scopedMessages: oaiScopedMessages,
      normalizedMessages: normalizedOpenAI.messages as unknown[],
      orchestration,
      clientToolCapabilities: oaiClientToolCapabilities,
      taskIntake: oaiTaskIntake,
      planGraph: oaiPlanGraph,
      objectiveScope: oaiObjectiveScope,
      stateConfidenceBlock: oaiStateConfidenceBlock,
      freshImplicitSessionNotice: oaiFreshImplicitSessionNotice,
      governorPauseResumeBlock: oaiGovernorPauseResumeBlock,
      plannerTodoPacketBlock: oaiPlannerTodoPacketBlock,
      chatStateBlock: oaiChatStateBlock,
      fileStateBlock: oaiFileStateBlock,
      requirementChecklist: oaiRequirementChecklist,
    });
    effectiveOaiPathCtx = oaiEnrichment.pathContext;
    if (!oaiEnrichment.ok) {
      return sendOpenAIChatPipelineResult(reply, oaiEnrichment.result);
    }
    const oaiEnriched = oaiEnrichment.enriched;
    const oaiEnrichedMsgs = oaiEnrichment.enrichedMessages;
    const reqId = oaiTraceReqId;
    endOaiEnrichmentStage();
    const endOaiProviderRequestStage = oaiOptLedger.startStage("provider_request");
    const oaiProviderRuntime = await prepareOpenAIProviderRuntimeForRoute({
      deps: {
        adapterUsesToolLoopSteering,
        app,
        applyEditContextMissReadGate,
        applyMarkdownGuardrail,
        artifactRetrieval,
        artifactStore,
        buildDefaultPolicy,
        buildEditContextMissForcedReadPrompt,
        buildEditContextMissGuardPrompt,
        buildEvidenceTraceSummary,
        buildStateRegroundReadPrompt,
        config,
        contextAdmissionStats,
        deserializeShadow,
        ensureReadToolAvailabilityForEditMissGuard,
        evaluateCachePolicyForSession,
        finalizeCompletionText,
        findPreferredReadToolName,
        forceCheckpoint,
        formatEvidenceBlock,
        formatPatternBlock,
        getMetadataString,
        inferVerificationSteps,
        injectSessionContext,
        isOpenClawProfile,
        isWriteCapableToolName,
        knowledgeSearch,
        loadProviderCachePolicyWindow,
        markerBackendForRequest,
        prefixOptimizer,
        pushDiagnostic,
        recordSessionEvent,
        recordUpperHarnessDecision,
        resolveEndpointCapabilityId,
        runOpenAIRequest,
        sessionPersistenceRunner,
        setSessionWorkspaceContext,
        shouldRestrictDiscoveryForPlanWork,
        shouldSampleBySeed,
        tierRegistry,
        toolArgHardeningStats,
        transcriptPruning,
        webSearch,
      },
      request,
      normalizedOpenAI,
      enrichedMessages: oaiEnrichedMsgs,
      toolResultCount,
      session,
      sessionKey,
      requestId: reqId,
      identity,
      pathContext: effectiveOaiPathCtx,
      selectedModel: orchestration.selectedModel,
      prefetchResult: oaiPrefetchResult,
      patternResult: oaiPatternResult,
      sensemakingBlock: oaiSensemakingBlock,
      policyPrecheck,
      latestUserText,
      runtimePreferences: oaiRuntimePreferences,
      enriched: oaiEnriched,
      normalizedRequestContext: {
        clientToolCapabilities: oaiClientToolCapabilities,
        clientTaskCue: oaiTaskCue,
        clientKind: oaiClientKind,
        orchestration,
        adapterProfile,
        openClawStrictGovernance,
        phasePolicyEnabledByMatrix: oaiPhasePolicyEnabledByMatrix,
        governorPhase: oaiGovernorPhase,
        executionGovernor: oaiExecutionGovernor,
        editMissGuard: oaiEditMissGuard,
        needsStateReground: oaiNeedsStateReground,
        stateConfidence: oaiStateConfidence,
        clientToolInventory: oaiClientToolInventory,
        workspaceInspection: oaiWorkspaceInspection,
        latestReadRefresh: oaiLatestReadRefresh,
        promptIntake: oaiPromptIntake,
        sensemakingDecision: oaiSensemakingDecision,
        chatState: oaiChatState,
        fileState: oaiFileState,
        compactionOptions: oaiCompactionOpts,
        reductions: {
          toolResultReduction,
          validationNormalization,
        },
        reducedToolResults: reducedOpenAI.reducedCount,
        evidencePrefetched: oaiEvidencePrefetched,
        evidenceConfidence: combinedEvidenceConfidence || undefined,
        sensemakingResult: oaiSensemakingResult,
        governorSummaries: {
          chat: oaiPauseChatSummary,
          file: oaiPauseFileSummary,
        },
        trajectoryDiagnostics: oaiTrajectoryDiagnostics,
        requirementChecklist: oaiRequirementChecklist,
        verificationAssessment: oaiVerificationAssessment,
        planGraph: oaiPlanGraph,
        artifactShadows: oaiArtifactShadows,
      },
      optimizationLedger: oaiOptLedger,
    });
    effectiveOaiPathCtx = oaiProviderRuntime.pathContext;
    if (!oaiProviderRuntime.ok) {
      return sendOpenAIChatPipelineResult(reply, oaiProviderRuntime.result);
    }
    const normalizedRequest = oaiProviderRuntime.normalizedRequest;
    const resolved = oaiProviderRuntime.resolved as never;
    const oaiProviderPreparation = oaiProviderRuntime.providerPreparation;
    endOaiProviderRequestStage();

    const providerExecution = await executeOpenAIProviderForRoute({
      deps: {
        ARTIFACT_TOOL_NAME,
        DEV_DOCS_TOOL_NAME,
        KNOWLEDGE_TOOL_NAME,
        WEB_SEARCH_TOOL_ALIAS,
        WEB_SEARCH_TOOL_NAME,
        app,
        applyDiscoveryToolGuardrail,
        artifactRetrieval,
        buildBlockedDiscoveryRecoverySnapshot,
        captureRequestForensics,
        circuitBreakers,
        clampMaxOutputTokensForSafety,
        computePrefixFingerprint,
        emitPlanWriteAuditEvent,
        extractUpstreamErrorDiagnostics,
        finalizePostStreamText,
        finalizeRequestForensics,
        generateText,
        getBlockedDiscoveryCount,
        getCachedTopLevelDirs,
        getTracer,
        knowledgeResolveContext,
        knowledgeSearch,
        maybeLogEnvelopeUnwrapSample,
        maybeUpdateTaskLedgerFromToolCall,
        openAiChatPipeline,
        openClawProfileStats,
        readUsage,
        recordBlockedDiscovery,
        recordSessionEvent,
        recordUpperHarnessDecision,
        safeEnd,
        safeWrite,
        sseHeadersWithClarification,
        startSseHeartbeat,
        streamAdmission,
        streamText,
        tierRegistry,
        toolArgHardeningStats,
        updateDiffAccumulator,
        webSearch,
        webSearchResolveContext,
        yarnDedupeLayer,
        yarnToolPrefixCache,
      },
      authUser,
      requestHeaders: req.headers as Record<string, string | string[] | undefined>,
      rawReply: reply.raw,
      session,
      identity,
      config,
      sessionKey,
      requestId: reqId,
      normalizedRequest,
      request,
      resolved,
      providerPreparation: oaiProviderPreparation,
      governorPhase: oaiGovernorPhase,
      forensicsCapabilityMatrix: oaiForensicsCapabilityMatrix,
      orchestration,
      optimizationLedger: oaiOptLedger,
      pathContext: effectiveOaiPathCtx,
      bodyMetadata: oaiBodyMeta as Record<string, unknown> | null,
      prefetchResult: oaiPrefetchResult,
      clientKind: oaiClientKind,
    });
    if (providerExecution.applyClarificationHeader) {
      applyClarificationRoundResponseHeader(reply, session.record.metadata);
    }
    return sendOpenAIChatPipelineResult(reply, providerExecution.result);
  });
}
