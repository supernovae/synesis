import type { OpenAIChatCompletionsRouteDependencies } from "../index.js";
import { OptimizationLedger } from "../telemetry/optimization-ledger.js";
import { prepareOpenAIRouteNormalization } from "../pipeline/openai-route-normalization.js";
import { prepareOpenAISessionWorkspace } from "../pipeline/openai-session-workspace-preparation.js";
import { prepareOpenAIGovernedStage } from "../pipeline/openai-governed-stage.js";
import { prepareOpenAIEnrichment } from "../pipeline/openai-enrichment-preparation.js";
import { prepareOpenAIProviderRuntimeForRoute } from "../pipeline/openai-provider-runtime-preparation.js";
import { executeOpenAIProviderForRoute } from "../pipeline/openai-provider-route-execution.js";
import { sendOpenAIChatPipelineResult } from "../pipeline/openai-chat-pipeline.js";

type AuthUser = import("../auth.js").AuthUser;
type SessionIdentity = import("../session/session-key.js").SessionIdentity;

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
    const oaiGovernedStage = await prepareOpenAIGovernedStage({
      deps: {
        analyzeRecentCommandLoop,
        app,
        applyObjectiveScopeAndPersist,
        applySensemakingStats,
        assessStateConfidence,
        buildArtifactShadows,
        buildExecutionGovernorHardStopUserMessage,
        buildExecutionGovernorPauseEnvelope,
        buildGovernorPauseResumeBlockForUser,
        buildSensemakingGuidanceInjection,
        buildSensemakingPauseMessage,
        casSessionSave,
        chatPhaseFromWorkflowPhase,
        classifyIntentScope,
        classifyLatestReadRefresh,
        classifyLatestToolProgress,
        classifyToolResultAsEvidence,
        clearGovernorPauseContextMetadata,
        clientAdapterPacks,
        collectToolExecutionFailureObservations,
        config,
        countTurnsSinceLastUser,
        createDiffStats,
        deriveChatState,
        deriveEditContextMissGuardState,
        deriveFileState,
        detectLanguagesFromMessages,
        detectToolProgress,
        distributedCounters,
        evaluateYarnPromptIntakeSteer,
        extractCommandEvents,
        extractEditedFileHints,
        extractTextFromUnknownContent,
        formatStateConfidenceBlock,
        getBlockedDiscoveryCount,
        getChecklistSourceHash,
        getFileSnapshotRegistry,
        governanceClient,
        governorService,
        hashTextSignal,
        inferGovernorPhaseFromMessages,
        injectGovernorRecoveryMessage,
        isPlanRecoveryDiscoveryIntent,
        knowledgeResolveContext,
        knowledgeSearch,
        logAndPersistSafetyEvent,
        looksLikeFailureSignal,
        maybeBuildPlannerTodoPacketBlock,
        maybeCheckpoint,
        maybeUpdateTaskLedgerFromEvidence,
        mergeSessionPathHints,
        mergeSynesisClarificationFromRequestMetadata,
        normalizedToolOutputSignal,
        parseOrchestratorPhaseHeader,
        persistGovernorPauseContextMetadata,
        persistGovernorPauseSoftFail,
        persistPromptIntakeSnapshot,
        persistStateConfidence,
        phaseFromFrame,
        phaseOrchestrator,
        pinchCompactionBackendModelMetadata,
        policyEngine,
        processWorkspaceHandshakeRoute,
        projectInstructionFilePresent,
        readPersistedChatStateSnapshot,
        recordPromptIntakeEvent,
        recordSessionEvent,
        refreshRequirementChecklist,
        refreshTaskIntake,
        resetGovernorPauseRecoveryState,
        resetQwenInterventionOnUserTurn,
        resolveWorkingPhase,
        runEvidencePrefetch,
        runPatternPrefetch,
        runSensemaking,
        sensemakingStats,
        sessionPersistenceRunner,
        shouldStripGlobFromTools,
        sliceMessagesSinceLastUserPrompt,
        stripGlobFromTools,
        summarizeArtifactContext,
        summarizeEvidenceDelta,
        toSessionExecutionContextSystemBlock,
        toolResultReduction,
        updatePlanGraph,
        updateTracePromptMetadata,
        withSpan,
        withSpanAsync,
        workingFrameService,
      },
      authUser,
      req: { headers: req.headers as Record<string, string | string[] | undefined> },
      session,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      request,
      normalizedOpenAI,
      bodyMetadata: oaiBodyMeta as Record<string, unknown> | null | undefined,
      latestUserText,
      taskCue: oaiTaskCue,
      clientToolCapabilities: oaiClientToolCapabilities,
      pathContext: oaiPathCtx,
      adapterProfile,
      adapterBlock,
      verificationAssessment: oaiVerificationAssessment,
      preManifest,
      workspaceInspection: oaiWorkspaceInspection,
      pipelineMode: oaiPipelineMode,
      governorCooldownMs: GOVERNOR_COOLDOWN_MS,
      runtimePreferences: oaiRuntimePreferences,
      endContextStage: endOaiContextStage,
      startGovernorStage: () => oaiOptLedger.startStage("governor"),
    });
    if (oaiGovernedStage.kind === "workspaceHandshake") {
      return sendOpenAIWorkspaceHandshake(reply, oaiTraceReqId, request.model, !!request.stream, oaiGovernedStage.toolCallId);
    }
    if (oaiGovernedStage.kind === "softFail") {
      return sendOpenAISoftFail(reply, oaiTraceReqId, oaiGovernedStage.selectedModel, oaiGovernedStage.content, !!request.stream, oaiGovernedStage.envelope as never);
    }
    if (oaiGovernedStage.kind === "reject") {
      return reply.code(400).send(policyRejectOpenAIBody(oaiGovernedStage.decision as never));
    }
    let effectiveOaiPathCtx = oaiGovernedStage.effectivePathContext;
    const effectiveOaiAdapterBlock = oaiGovernedStage.effectiveAdapterBlock;
    const buildEffectiveOaiAdapterBlock = oaiGovernedStage.buildEffectiveAdapterBlock;
    const oaiRequirementChecklist = oaiGovernedStage.requirementChecklist;
    const oaiTaskIntake = oaiGovernedStage.taskIntake;
    const oaiPlanGraph = oaiGovernedStage.planGraph;
    const oaiPromptIntake = oaiGovernedStage.promptIntake;
    const oaiPlannerTodoPacketBlock = oaiGovernedStage.plannerTodoPacketBlock;
    const oaiEditMissGuard = oaiGovernedStage.editMissGuard;
    const oaiLatestReadRefresh = oaiGovernedStage.latestReadRefresh;
    const oaiPrefetchResult = oaiGovernedStage.prefetchResult;
    const oaiPatternResult = oaiGovernedStage.patternResult;
    const combinedEvidenceConfidence = oaiGovernedStage.combinedEvidenceConfidence;
    const orchestration = oaiGovernedStage.orchestration;
    const oaiEvidencePrefetched = oaiGovernedStage.evidencePrefetched;
    const oaiSensemakingResult = oaiGovernedStage.sensemakingResult;
    const oaiSensemakingBlock = oaiGovernedStage.sensemakingBlock;
    const oaiArtifactShadows = oaiGovernedStage.artifactShadows;
    const oaiFileState = oaiGovernedStage.fileState;
    const oaiChatState = oaiGovernedStage.chatState;
    const oaiObjectiveScope = oaiGovernedStage.objectiveScope;
    const oaiScopedMessages = oaiGovernedStage.scopedMessages;
    const oaiStateConfidence = oaiGovernedStage.stateConfidence;
    const oaiStateConfidenceBlock = oaiGovernedStage.stateConfidenceBlock;
    const oaiNeedsStateReground = oaiGovernedStage.needsStateReground;
    const oaiPauseChatSummary = oaiGovernedStage.pauseChatSummary;
    const oaiPauseFileSummary = oaiGovernedStage.pauseFileSummary;
    const oaiChatStateBlock = oaiGovernedStage.chatStateBlock;
    const oaiFileStateBlock = oaiGovernedStage.fileStateBlock;
    const oaiExecutionGovernor = oaiGovernedStage.executionGovernor;
    const oaiGovernorPauseResumeBlock = oaiGovernedStage.governorPauseResumeBlock;
    const oaiSensemakingDecision = oaiGovernedStage.sensemakingDecision;
    const policyPrecheck = oaiGovernedStage.policyPrecheck;
    const oaiClientToolInventory = oaiGovernedStage.clientToolInventory;
    const oaiGovernorPhase = oaiGovernedStage.governorPhase;
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
      objectiveScope: oaiObjectiveScope as { relevantEvidenceBlock?: string | null; artifactBridgeBlock?: string | null },
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
      policyPrecheck: policyPrecheck as { pivotPrompt?: string | null; matchedRules: string[] },
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
        governorPhase: oaiGovernorPhase as never,
        executionGovernor: oaiExecutionGovernor as { matchedRules: string[] },
        editMissGuard: oaiEditMissGuard,
        needsStateReground: oaiNeedsStateReground,
        stateConfidence: oaiStateConfidence as { recommendedReadPath?: string | null; reasons?: string[] },
        clientToolInventory: oaiClientToolInventory,
        workspaceInspection: oaiWorkspaceInspection,
        latestReadRefresh: oaiLatestReadRefresh as { filePath?: string | null },
        promptIntake: oaiPromptIntake,
        sensemakingDecision: oaiSensemakingDecision as { responseLevel?: string; shouldPause?: boolean; shouldRestrictDiscovery?: boolean } | null | undefined,
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
        sensemakingResult: oaiSensemakingResult as { triggered?: boolean; reason?: string } | null | undefined,
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
