import type { OpenAIChatCompletionsRouteDependencies } from "../index.js";
import { OptimizationLedger } from "../telemetry/optimization-ledger.js";
import { reconstructMissingToolCalls } from "../tool-mapping.js";
import { sortToolSchemas } from "../compat/sorted-tools.js";
import { prepareOpenAIRouteTranscript } from "../pipeline/openai-route-transcript-prep.js";
import { stabilizeOpenAITranscript } from "../pipeline/openai-route-transcript-stabilization.js";
import { finalizeOpenAIProviderRequestForRoute } from "../pipeline/openai-route-provider-finalization.js";
import { prepareOpenAIChatProviderRuntime } from "../pipeline/openai-chat-provider-preparation.js";
import { sendOpenAIChatPipelineResult } from "../pipeline/openai-chat-pipeline.js";
import { shouldRunGovernorForMode } from "../pipeline/modes.js";
import { prepareProtocolPauseState } from "../session/protocol-pause-state.js";

type AuthUser = import("../auth.js").AuthUser;
type SessionIdentity = import("../session/session-key.js").SessionIdentity;
type RequestForensicsRecord = import("../telemetry/request-forensics.js").RequestForensicsRecord;
type GovernorInputMessage = import("../governance/execution-governor.js").GovernorInputMessage;
type WorkflowPhase = import("../orchestration/phase-model-orchestrator.js").WorkflowPhase;
type SessionPathHints = import("../state/workspace-session-boundary.js").SessionPathHints;
type SensemakingResult = import("../sensemaking/index.js").SensemakingResult;
type SensemakingDecision = import("../governance/sensemaking-governor.js").SensemakingDecision;

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
    applyGovernorPhaseRouteBookkeeping,
    applyIngressCapToToolMessages,
    applyObjectiveScopeAndPersist,
    applyRuntimePreferenceLoopLimits,
    applySensemakingStats,
    applySessionTaskCapabilities,
    applyWorkspaceBoundary,
    applyWorkspaceMetadataPrebackfill,
    ARTIFACT_TOOL_NAME,
    artifactRetrieval,
    assessProportionality,
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
    compareSensemakingWithLegacy,
    config,
    contextAdmissionStats,
    countTurnsSinceLastUser,
    createDiffStats,
    crypto,
    debugProtocolLog,
    deriveChatState,
    deriveEditContextMissGuardState,
    deriveFileState,
    deriveGovernorLoopObservability,
    deserializeShadow,
    detectClientTaskCapabilities,
    detectClientToolCapabilities,
    detectLanguagesFromMessages,
    detectToolProgress,
    DEV_DOCS_TOOL_NAME,
    disabledExecutionGovernorDecision,
    distributedCounters,
    enrichWithFrameAndManifest,
    ensureReadToolAvailabilityForEditMissGuard,
    evaluateCachePolicyForSession,
    evaluateSensemakingGovernor,
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
    handleDeterministicPolicyPrecheck,
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
    proportionalityToSignal,
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

    if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
      const rawMsgs = request.messages as Array<Record<string, unknown>>;
      const assistantSample = rawMsgs.filter((m) => m.role === "assistant").slice(0, 3).map((m) => ({
        keys: Object.keys(m),
        hasToolCalls: "tool_calls" in m,
        hasFunctionCall: "function_call" in m,
        hasToolCallsCamel: "toolCalls" in m,
        contentType: typeof m.content,
        contentIsArray: Array.isArray(m.content),
        contentSnippet: typeof m.content === "string" ? m.content.slice(0, 150) : Array.isArray(m.content) ? JSON.stringify(m.content).slice(0, 150) : String(m.content).slice(0, 80),
        toolCallsValue: m.tool_calls ? JSON.stringify(m.tool_calls).slice(0, 200) : undefined,
      }));
      const toolSample = rawMsgs.filter((m) => m.role === "tool").slice(0, 2).map((m) => ({
        keys: Object.keys(m),
        tool_call_id: m.tool_call_id,
        contentSnippet: typeof m.content === "string" ? m.content.slice(0, 100) : String(m.content).slice(0, 100),
      }));
      app.log.info({ reqId: oaiTraceReqId, assistantSample, toolSample }, "raw_message_shape_diagnostic");
    }

    const toolCallReconstruction = reconstructMissingToolCalls(
      request.messages as Array<{ role: string; content?: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>,
    );
    if (toolCallReconstruction.reconstructedCount > 0) {
      request.messages = toolCallReconstruction.messages as never;
      app.log.info(
        { reqId: oaiTraceReqId, reconstructedAssistantMessages: toolCallReconstruction.reconstructedCount },
        "tool_calls_reconstructed",
      );
    }

    const oaiTaskCue = extractLatestUserPromptFromMessages(request.messages as Array<{ role: string; content: unknown }>);
    oaiOptLedger.recordOriginal(request.messages as Array<{ content?: unknown }>);
    const endOaiNormalizationStage = oaiOptLedger.startStage("normalization");

    if (config.SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES > 0 && !config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
      const ingress = applyIngressCapToToolMessages(
        request.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>,
        config.SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES,
      );
      if (ingress.cappedToolResults > 0) {
        request.messages = ingress.messages as never;
        if (config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED) {
          app.log.info(
            {
              reqId: oaiTraceReqId,
              capped_tool_results: ingress.cappedToolResults,
              bytes_reclaimed: ingress.bytesReclaimed,
              max_bytes: config.SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES,
            },
            "yarn_harness_ingress_cap",
          );
        }
      }
    }

    // Sorted tools for cache stability
    if (config.SYNESIS_YARN_SORTED_TOOLS_ENABLED && request.tools) {
      request.tools = sortToolSchemas(request.tools) as never;
    }

    const oaiPeekWatermark = (() => {
      const id: SessionIdentity = {
        userId: oaiIdentityUserId,
        orgId: authUser.orgId,
        conversationId: oaiConversationId,
        clientKind: oaiClientKind,
        displayName: oaiDisplayName,
      };
      const existingKey = `${id.userId}:${id.conversationId}:${id.clientKind}`;
      for (const [k, v] of sessions) {
        if (k.includes(existingKey) || k.includes(id.conversationId)) return v.pruningWatermark;
      }
      return undefined;
    })();
    const oaiTranscriptPrep = await prepareOpenAIRouteTranscript({
      request,
      requestId: oaiTraceReqId,
      taskCue: oaiTaskCue,
      backendModelHint: resolveCompactionBackendModelHintFromRequestModel(request.model),
      pruningWatermark: oaiPeekWatermark,
      config,
      capabilityMatrix: governanceClient?.getCapabilityMatrix() ?? null,
      enrichmentPool,
      toolResultReduction,
      validationNormalization,
      transcriptPruning,
      validationTierCFallback: runValidationTierCFallback,
      optimizationLedger: oaiOptLedger,
      endNormalizationStage: endOaiNormalizationStage,
      startPruningStage: () => oaiOptLedger.startStage("pruning"),
      logger: app.log,
    });
    const {
      compactionOpts: oaiCompactionOpts,
      matrixModelPath: oaiMatrixModelPath,
      matrixModelId: oaiMatrixModelId,
      matrixFamily: oaiMatrixFamily,
      capabilityResolution: oaiCapabilityResolution,
      phasePolicyEnabledByMatrix: oaiPhasePolicyEnabledByMatrix,
      contentDedupeEnabled: oaiContentDedupeEnabled,
      responseDedupeEnabled: oaiResponseDedupeEnabled,
      historicalNormalizeEnabled: oaiHistoricalNormalizeEnabled,
      reducedOpenAI,
      normalizedOpenAI,
      toolResultCount,
      endPruningStage: endOaiPruningStage,
    } = oaiTranscriptPrep;
    const oaiTrajectoryDiagnostics = inferTrajectoryDiagnosticsFromMessages(
      request.messages as Array<{ role: string; content: unknown }>,
    );
    const oaiVerificationAssessment = assessVerificationSignals(
      request.messages as Array<{ role: string; content: unknown; name?: string }>,
    );
    const adapterProfile = clientAdapterPacks.resolve(
      oaiClientKind,
      String((req.headers["x-synesis-mode"] as string | undefined) ?? "")
    );
    const openClawStrictGovernance =
      config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED
      && config.SYNESIS_YARN_OPENCLAW_STRICT_GOVERNANCE_ENABLED
      && isOpenClawProfile(adapterProfile);
    if (isOpenClawProfile(adapterProfile)) {
      openClawProfileStats.requestsObserved += 1;
    }
    const oaiPathCtx = parseSessionExecutionContext(req.headers as Record<string, string | string[] | undefined>, oaiBodyMeta);
    const adapterBlock = appendPathContextToAdapterBlock(
      clientAdapterPacks.toSystemBlock(adapterProfile),
      req.headers as Record<string, string | string[] | undefined>,
      oaiBodyMeta,
      oaiClientKind,
      { gitPolicyMode: config.SYNESIS_YARN_GIT_POLICY_MODE },
    );
    const latestUserText = [...(normalizedOpenAI.messages as Array<{ role: string; content: unknown }>)].reverse().find((m) => m.role === "user");
    const preManifest = projectManifestService.build(normalizedOpenAI.messages as never);

    debugProtocolLog(app.log as never, oaiTraceReqId, "/v1/chat/completions", {
      protocol: oaiCanonicalRequest.protocol,
      pipelineMode: oaiPipelineMode,
      model: request.model,
      messageCount: (request.messages as unknown[]).length,
      hasTools: !!(request.tools as unknown[])?.length,
      stream: request.stream,
      client: adapterProfile.client,
      temperature: request.temperature,
      top_p: request.top_p,
    });
    const identity: SessionIdentity = oaiIdentity.identity;
    let oaiFreshImplicitSessionNotice: string | null = null;
    const oaiBootstrap = await runProtocolSessionBootstrap({
      identity,
      authUser,
      getSessionKey,
      getSessionState,
      applyAuthKeyAttribution,
      loadRuntimePreferences: loadUserRuntimePreferences,
      debugEnabled: config.SYNESIS_YARN_DEBUG_PROTOCOL,
      debugConversationSource: "conversation_resolved",
      debugFallbackSource: "conversation_fallback",
      debugLog: (record) => app.log.debug(record, "session_resolution"),
      afterSessionLoaded: ({ sessionKey: loadedSessionKey, session: loadedSession }) => {
        if (shouldResetImplicitSessionForFreshTranscript({
          clientKind: oaiClientKind,
          conversationId: oaiConversationId,
          messages: request.messages as Array<{ role?: unknown }>,
          hasPersistedState: hasPersistedWorkspaceState(loadedSession, workspaceStatePresence(loadedSessionKey)),
        })) {
          resetWorkspaceScopedSessionState(loadedSessionKey, loadedSession);
          oaiFreshImplicitSessionNotice = buildFreshImplicitSessionNotice(
            oaiClientKind,
            (request.messages as unknown[]).length,
          );
          recordSessionEvent(
            loadedSessionKey,
            identity.userId,
            identity.orgId,
            "implicit_session_fresh_transcript_reset",
            "session-boundary",
            `client=${oaiClientKind} messages=${(request.messages as unknown[]).length}`,
            oaiTraceReqId,
            {
              client_kind: oaiClientKind,
              conversation_id_present: false,
              message_count: (request.messages as unknown[]).length,
            },
          );
        }
      },
    });
    const sessionKey = oaiBootstrap.sessionKey;
    const session = oaiBootstrap.session;
    const oaiRuntimePreferences = oaiBootstrap.runtimePreferences;
    const oaiToolDefs = (request as Record<string, unknown>).tools as Array<{ name?: string; function?: { name?: string } }> | undefined;
    const oaiClientToolCapabilities = detectClientToolCapabilities(oaiToolDefs, oaiClientKind, oaiTaskCue);
    const detectedOaiTaskCapabilities = detectClientTaskCapabilities(oaiToolDefs, oaiClientKind);
    applySessionTaskCapabilities(session, detectedOaiTaskCapabilities);

    const oaiCapabilityHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(oaiCapabilityResolution.resolved_capabilities)
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
      .digest("hex")
      .slice(0, 16);
    const oaiForensicsCapabilityMatrix: RequestForensicsRecord["capabilityMatrix"] = {
      mode: oaiCapabilityResolution.mode,
      globalOptimizationsEnabled: oaiCapabilityResolution.global_optimizations_enabled,
      modelId: oaiMatrixModelId,
      modelPath: oaiMatrixModelPath,
      family: oaiMatrixFamily,
      matchedOverrideIds: oaiCapabilityResolution.matched_override_ids,
      capabilityHash: oaiCapabilityHash,
    };
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "capability_matrix_resolution_v1",
      "capability-matrix",
      `mode=${oaiCapabilityResolution.mode} global=${oaiCapabilityResolution.global_optimizations_enabled ? "on" : "off"} matched=${oaiCapabilityResolution.matched_override_ids.join(",") || "none"}`,
      oaiTraceReqId,
      {
        mode: oaiCapabilityResolution.mode,
        global_optimizations_enabled: oaiCapabilityResolution.global_optimizations_enabled,
        model_id: oaiMatrixModelId,
        model_path: oaiMatrixModelPath,
        family: oaiMatrixFamily,
        matched_override_ids: oaiCapabilityResolution.matched_override_ids,
        matched_selectors: oaiCapabilityResolution.matched_selectors,
        capability_hash: oaiCapabilityHash,
        resolved_capabilities: oaiCapabilityResolution.resolved_capabilities,
      },
    );
    const oaiMsgCount = (request.messages as unknown[]).length;
    const oaiRecentExempt = Number(config.SYNESIS_YARN_TASK_PRUNING_RECENT_EXEMPT) || 0;
    session.pruningWatermark = Math.max(session.pruningWatermark, oaiMsgCount - oaiRecentExempt);
    // Reset loop counters only on a genuine user prompt (not synthetic tool-result wrappers).
    const oaiLastIncomingMessage = Array.isArray(request.messages) && request.messages.length > 0
      ? (request.messages[request.messages.length - 1] as { role?: string; content?: unknown })
      : undefined;
    if (isGenuineUserPromptMessage(oaiLastIncomingMessage)) {
      session.consecutiveToolCalls = 0;
      session.stagnantToolCycles = 0;
      session.lastToolSignalHash = "";
      session.awaitingToolLoopUserAck = false;
      session.toolLoopAckAnchorUserHash = "";
      session.toolLoopNoUserAckCount = 0;
      session.consecutiveRecoveryFires = 0;
      session.consecutiveEditContextMisses = 0;
      session.editReplayHardStopGraceUsed = false;
      session.editMissForceReadPending = false;
      session.lastGovernorCachedResult = null;
      session.lastGovernorNoPauseAt = 0;
      // Also clear verification-block flags so a prior turn's failed/green verification
      // loop does not gate the new task attempt before it even starts.
      session.blockBroadVerificationUntilEdit = false;
      session.blockFailingVerificationUntilEdit = false;
      session.governorPrePauseAttemptsByRule.clear();
      session.implementationSoftStallNudgeStrikes = 0;
      void distributedCounters.setConsecutiveToolCalls(sessionKey, 0).catch((err) => { console.warn("[session] counter reset failed:", (err as Error).message ?? err); });
    }
    const oaiWorkspaceInspection = await applyWorkspaceBoundary({
      state: session,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      pathHints: oaiPathCtx,
      readDir: async (root) => readdir(root, { withFileTypes: true }),
      hasPersistedState: hasPersistedWorkspaceState(session, workspaceStatePresence(sessionKey)),
      resetWorkspaceState: resetWorkspaceScopedSessionState,
      recordSessionEvent,
    });
    const oaiStabilizedTranscript = await stabilizeOpenAITranscript({
      messages: normalizedOpenAI.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }>,
      originalMessageCount: oaiMsgCount,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      pathContext: oaiPathCtx,
      governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
      contentDedupeEnabled: oaiContentDedupeEnabled,
      responseDedupeEnabled: oaiResponseDedupeEnabled,
      historicalNormalizeEnabled: oaiHistoricalNormalizeEnabled,
      compactionBackendModelHint: oaiCompactionOpts.backendModelHint,
      yarnDedupeLayer,
      transcriptPruning,
      optimizationLedger: oaiOptLedger,
      logger: app.log,
      getFileSnapshotRegistry,
      getContentDedup,
      getMemoryGovernor,
      session,
      recordSessionEvent,
    });
    normalizedOpenAI.messages = oaiStabilizedTranscript.messages as never;
    if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
      const oaiPlanRemediation = remediatePlanFileStubs(normalizedOpenAI.messages as Array<{ role: string; content: unknown }>);
      if (oaiPlanRemediation.remediatedCount > 0) {
        normalizedOpenAI.messages = oaiPlanRemediation.messages as never;
        app.log.warn({ reqId: oaiTraceReqId, count: oaiPlanRemediation.remediatedCount }, "plan_file_dedup_remediated");
      }
      const oaiPlanAnnotation = annotatePlanFileReads(normalizedOpenAI.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>);
      if (oaiPlanAnnotation.annotatedCount > 0) {
        normalizedOpenAI.messages = oaiPlanAnnotation.messages as never;
        if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
          app.log.debug({ reqId: oaiTraceReqId, count: oaiPlanAnnotation.annotatedCount }, "plan_file_read_annotated");
        }
      }
      if (oaiPlanAnnotation.planFilePaths.length > 0) {
        session.record.metadata.plan_file_path = oaiPlanAnnotation.planFilePaths[oaiPlanAnnotation.planFilePaths.length - 1];
        const freshShadow = extractPlanContentShadow(
          normalizedOpenAI.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>,
          oaiPlanAnnotation.planFilePaths,
        );
        if (freshShadow) {
          session.record.metadata.plan_content_shadow = serializeShadow(freshShadow) as unknown as Record<string, unknown>;
        }
      }
      const oaiVerifGaps = annotateVerificationGaps(normalizedOpenAI.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>);
      if (oaiVerifGaps.annotatedCount > 0) {
        normalizedOpenAI.messages = oaiVerifGaps.messages as never;
      }
      if (injectPlanModeRecoveryHint(normalizedOpenAI.messages as Array<{ role: string; content: unknown }>)) {
        app.log.info({ reqId: oaiTraceReqId }, "plan_mode_recovery_hint_injected");
      }
    }
    oaiOptLedger.recordAfterPruning(normalizedOpenAI.messages as Array<{ content?: unknown }>);
    endOaiPruningStage?.();
    const endOaiContextStage = oaiOptLedger.startStage("context");
    mergeSynesisClarificationFromRequestMetadata(session.record.metadata, oaiBodyMeta ?? undefined);
    const priorOaiChecklistHash = getChecklistSourceHash(session.record.metadata);
    if (latestUserText && typeof latestUserText.content === "string") {
      updateTracePromptMetadata(session, latestUserText.content);
    }
    const oaiRequirementChecklist = refreshRequirementChecklist(session);
    const oaiTaskIntake = refreshTaskIntake(session);
    const oaiPlanGraph = updatePlanGraph(
      session,
      oaiTaskIntake,
      normalizedOpenAI.messages as Array<{ role: string; content: unknown }>,
      oaiVerificationAssessment.failingSignals,
    );
    const oaiPromptIntake = evaluateYarnPromptIntakeSteer({
      enabled: config.SYNESIS_YARN_PROMPT_INTAKE_STEER_ENABLED && !config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      latestUserPrompt: oaiTaskCue,
      metadata: oaiBodyMeta,
      extraBody: request.extra_body ?? null,
      clientToolCapabilities: oaiClientToolCapabilities,
    });
    persistPromptIntakeSnapshot(session, oaiPromptIntake);
    recordPromptIntakeEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      oaiTraceReqId,
      "openai",
      oaiPromptIntake,
    );
    const oaiPlannerTodoPacketBlock = await maybeBuildPlannerTodoPacketBlock({
      session,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      surface: "openai",
      latestUserPrompt: oaiTaskCue,
      promptIntake: oaiPromptIntake,
      clientToolCapabilities: oaiClientToolCapabilities,
    });
    if (oaiRequirementChecklist && oaiRequirementChecklist.sourceHash !== priorOaiChecklistHash) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "requirements_checklist",
        "completion-gate",
        `Checklist initialized (must=${oaiRequirementChecklist.must.length}, should=${oaiRequirementChecklist.should.length})`,
        oaiTraceReqId,
      );
    }
    const oaiTurnMessages = sliceMessagesSinceLastUserPrompt(
      normalizedOpenAI.messages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>,
    );
    const oaiToolFailures = collectToolExecutionFailureObservations(
      oaiTurnMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>,
    );
    const oaiEditMissGuard = deriveEditContextMissGuardState(
      oaiTurnMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>,
    );
    const oaiLatestToolProgress = classifyLatestToolProgress(
      oaiTurnMessages,
    );
    if (oaiLatestToolProgress.toolName && oaiLatestToolProgress.snippet) {
      const oaiEvidenceSignals = classifyToolResultAsEvidence(
        oaiLatestToolProgress.toolName,
        oaiLatestToolProgress.snippet,
        session.record.requestCount,
      );
      maybeUpdateTaskLedgerFromEvidence(session, oaiEvidenceSignals);
    }
    const oaiLatestReadRefresh = classifyLatestReadRefresh(
      oaiTurnMessages,
    );
    const oaiHadForceReadPending = session.editMissForceReadPending;
    if (oaiHadForceReadPending && oaiLatestReadRefresh.hasRecentReadSuccess) {
      session.editMissForceReadPending = false;
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "edit_context_miss_forced_read_satisfied",
        "execution-governor",
        `Forced read recovery satisfied via ${oaiLatestReadRefresh.toolName || "read"} ${oaiLatestReadRefresh.filePath || "<unknown file>"}`,
        oaiTraceReqId,
        {
          toolName: oaiLatestReadRefresh.toolName || null,
          toolCallId: oaiLatestReadRefresh.toolCallId || null,
          filePath: oaiLatestReadRefresh.filePath || null,
          snippet: oaiLatestReadRefresh.snippet || null,
        },
      );
    }
    for (const failure of oaiToolFailures) {
      const oaiFailureEventKind = failure.reason === "edit_already_applied"
        ? "client_tool_idempotent_observed"
        : "client_tool_error_observed";
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        oaiFailureEventKind,
        "tool-result-monitor",
        `tool=${failure.toolName} reason=${failure.reason} ${failure.snippet}`,
        oaiTraceReqId,
        {
          toolName: failure.toolName,
          toolCallId: failure.toolCallId || null,
          filePath: failure.filePath || null,
          reason: failure.reason,
          snippet: failure.snippet,
        },
      );
    }
    if (oaiEditMissGuard?.active) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "edit_context_miss_guard_active",
        "tool-result-monitor",
        `forcing_read_before_edit file=${oaiEditMissGuard.filePath} misses=${oaiEditMissGuard.missCount}`,
        oaiTraceReqId,
        {
          filePath: oaiEditMissGuard.filePath,
          missCount: oaiEditMissGuard.missCount,
        },
      );
    }
    const oaiEditMissFailureCount = oaiToolFailures.filter((failure) => failure.reason === "edit_context_miss").length;
    const oaiAnyWriteToolEditFailure = oaiToolFailures.some(
      (f) => f.reason === "edit_error"
        || f.reason === "edit_context_miss"
        || f.reason === "write_tool_error"
        || f.reason === "patch_apply_failed",
    );
    const oaiHasActiveEditMissFailure =
      oaiEditMissFailureCount > 0
      || oaiAnyWriteToolEditFailure
      || oaiLatestToolProgress.hasRecentEditContextMiss
      || oaiEditMissGuard?.active === true
      || session.editMissForceReadPending;
    if (oaiLatestToolProgress.hasRecentWriteSuccess && !oaiHasActiveEditMissFailure) {
      session.stagnantToolCycles = 0;
      session.lastToolSignalHash = "";
      session.consecutiveEditContextMisses = 0;
      session.editReplayHardStopGraceUsed = false;
      session.editMissForceReadPending = false;
    } else if (oaiEditMissFailureCount > 0) {
      session.consecutiveEditContextMisses += 1;
    } else if (oaiLatestToolProgress.hasRecentFailure) {
      session.consecutiveEditContextMisses = 0;
    }
    const oaiShouldArmForceReadRecovery =
      oaiLatestToolProgress.hasRecentEditContextMiss
      && (oaiEditMissFailureCount >= 1 || session.consecutiveEditContextMisses >= 1);
    if (oaiShouldArmForceReadRecovery) {
      if (!session.editMissForceReadPending) {
        recordSessionEvent(
          sessionKey,
          identity.userId,
          identity.orgId,
          "edit_context_miss_forced_read_armed",
          "execution-governor",
          `Armed forced read recovery after edit misses (turn=${oaiEditMissFailureCount}, consecutive=${session.consecutiveEditContextMisses})`,
          oaiTraceReqId,
          {
            edit_miss_failures: oaiEditMissFailureCount,
            consecutive_turn_edit_miss_failures: session.consecutiveEditContextMisses,
          },
        );
      }
      session.editMissForceReadPending = true;
    }
    if (oaiLatestToolProgress.hasRecentWriteSuccess && !oaiHasActiveEditMissFailure && session.consecutiveRecoveryFires > 0) {
      session.consecutiveRecoveryFires = 0;
      session.governorPrePauseAttemptsByRule.clear();
      session.implementationSoftStallNudgeStrikes = 0;
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "execution_governor_recovery_reset",
        "execution-governor",
        `Recovery streak reset after successful ${oaiLatestToolProgress.toolName || "write"} tool result`,
        oaiTraceReqId,
        {
          toolName: oaiLatestToolProgress.toolName || null,
          toolCallId: oaiLatestToolProgress.toolCallId || null,
          snippet: oaiLatestToolProgress.snippet || null,
        },
      );
    }
    const oaiWorkspaceHandshakeAction = await processWorkspaceHandshakeRoute({
      protocol: "openai",
      session,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      pathContext: oaiPathCtx,
      messages: request.messages as unknown[],
      tools: request.tools as unknown[] | undefined,
      saveSession: casSessionSave,
      recordSessionEvent,
    });
    if (oaiWorkspaceHandshakeAction.kind === "send") {
      return sendOpenAIWorkspaceHandshake(reply, oaiTraceReqId, request.model, !!request.stream, oaiWorkspaceHandshakeAction.toolCallId);
    }
    let effectiveOaiPathCtx = mergeSessionPathHints(oaiPathCtx, session);
    const buildEffectiveOaiAdapterBlock = (pathCtx: SessionPathHints): string | undefined => {
      const ctxBlock = toSessionExecutionContextSystemBlock(pathCtx);
      if (!ctxBlock) return adapterBlock;
      return `${clientAdapterPacks.toSystemBlock(adapterProfile)}\n\n${ctxBlock}`;
    };
    let effectiveOaiAdapterBlock = buildEffectiveOaiAdapterBlock(effectiveOaiPathCtx);

    const oaiRecallDecision = toolResultReduction.getLastRecallDecision();
    const oaiVerifState = toolResultReduction.getVerificationTracker().getState();

    const oaiPreFrame = config.SYNESIS_YARN_WORKING_FRAME_ENABLED
      ? workingFrameService.build(normalizedOpenAI.messages as never)
      : undefined;
    const oaiOrchestratorPhaseOverride = parseOrchestratorPhaseHeader(
      String(req.headers["x-synesis-orchestrator-phase"] ?? ""),
    );
    const oaiGovernorPreviewPhase = inferGovernorPhaseFromMessages(
      normalizedOpenAI.messages as Array<GovernorInputMessage>,
    );
    const oaiFramePhase = oaiPreFrame ? phaseFromFrame(oaiPreFrame.currentPhase) : undefined;
    const oaiWorkingPhase: WorkflowPhase | undefined = resolveWorkingPhase({
      orchestratorOverride: oaiOrchestratorPhaseOverride,
      framePhase: oaiFramePhase,
      governorPreviewPhase: oaiGovernorPreviewPhase,
    });
    const oaiWorkingFrameGoal: string | undefined = oaiPreFrame?.goal;

    let oaiPrefetchResult: import("../evidence/fast-path.js").FastPathResult | undefined;
    if (config.SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED && latestUserText) {
      const prefetchText = typeof latestUserText.content === "string" ? latestUserText.content : "";
      if (prefetchText.length > 0) {
        oaiPrefetchResult = await runEvidencePrefetch(
          prefetchText, knowledgeSearch,
          config.SYNESIS_YARN_EVIDENCE_PREFETCH_TIMEOUT_MS,
          config.SYNESIS_YARN_EVIDENCE_CONFIDENCE_MIN,
          { retryEnabled: config.SYNESIS_YARN_EVIDENCE_PREFETCH_RETRY_ENABLED },
          knowledgeResolveContext(authUser, req),
        );
        if (oaiPrefetchResult.matched) {
          app.log.info({
            pattern: oaiPrefetchResult.pattern, hasEvidence: Boolean(oaiPrefetchResult.evidence),
            timedOut: oaiPrefetchResult.timedOut, latencyMs: Math.round(oaiPrefetchResult.latencyMs),
            confidence: oaiPrefetchResult.confidence, authoritative: oaiPrefetchResult.authoritative,
          }, "evidence_prefetch_result");
        }
      }
    }

    let oaiPatternResult: import("../evidence/fast-path.js").PatternPrefetchResult | undefined;
    if (config.SYNESIS_YARN_PATTERN_RECALL_ENABLED && latestUserText && !oaiPrefetchResult?.matched) {
      const prefetchText = typeof latestUserText.content === "string" ? latestUserText.content : "";
      if (prefetchText.length > 0) {
        oaiPatternResult = await runPatternPrefetch(
          prefetchText, knowledgeSearch,
          config.SYNESIS_YARN_EVIDENCE_PREFETCH_TIMEOUT_MS,
          oaiWorkingPhase,
          knowledgeResolveContext(authUser, req),
        );
        if (oaiPatternResult.matched) {
          app.log.info({
            intent: oaiPatternResult.intent, hasEvidence: Boolean(oaiPatternResult.evidence),
            timedOut: oaiPatternResult.timedOut, latencyMs: Math.round(oaiPatternResult.latencyMs),
            confidence: oaiPatternResult.confidence,
          }, "pattern_prefetch_result");
        }
      }
    }

    const combinedEvidenceConfidence = Math.max(
      oaiPrefetchResult?.confidence ?? 0,
      oaiPatternResult?.confidence ?? 0,
    );

    const orchestration = phaseOrchestrator.decide({
      requestedModel: request.model,
      modelSelectionMode: config.SYNESIS_YARN_GOVERNANCE_DISABLED ? "lock" : config.SYNESIS_YARN_MODEL_SELECTION_MODE,
      latestUserText: String(latestUserText?.content ?? ""),
      workingPhase: oaiWorkingPhase,
      planningUseHorizon: config.SYNESIS_YARN_PLANNING_USE_HORIZON,
      riskProfile: preManifest.riskProfile,
      decisionMatrixEnabled: config.SYNESIS_YARN_DECISION_MATRIX_ENABLED,
      evidence: {
        recallConfidence: oaiRecallDecision?.resolution?.confidence,
        recallRouting: oaiRecallDecision?.routing,
        evidenceConfidence: combinedEvidenceConfidence || undefined,
        evidenceAuthoritative: oaiPrefetchResult?.authoritative,
        verificationRound: oaiVerifState.round > 0 ? oaiVerifState.round : undefined,
        verificationStalled: oaiVerifState.stalled || undefined,
        consecutiveFailedVerifications: session.record.consecutiveFailedVerifications,
      },
    }, sessionKey);
    if (orchestration.escalated) {
      session.record.escalationCount += 1;
    }
    session.record.lastTier = orchestration.tier;
    pinchCompactionBackendModelMetadata(session, orchestration.tier, request.model);

    const oaiEvidencePrefetched = Boolean(
      oaiPrefetchResult?.matched
      || oaiPatternResult?.matched,
    );
    let oaiSensemakingResult: SensemakingResult | undefined;
    let oaiSensemakingBlock: string | null = null;
    if (config.SYNESIS_YARN_SENSEMAKING_ENABLED) {
      const oaiSm = runSensemaking({
        config,
        messages: normalizedOpenAI.messages as Array<{ role: string; content: unknown }>,
        getLanguages: detectLanguagesFromMessages,
        orchestration,
        recallDecision: oaiRecallDecision,
        verificationState: oaiVerifState,
        evidencePrefetched: oaiEvidencePrefetched,
        evidenceConfidence: combinedEvidenceConfidence,
        evidenceAuthoritative: oaiPrefetchResult?.authoritative,
        userText: String(latestUserText?.content ?? ""),
        workingFrameGoal: oaiWorkingFrameGoal,
        consecutiveFailedVerifications: session.record.consecutiveFailedVerifications,
      });
      oaiSensemakingResult = oaiSm.result;
      oaiSensemakingBlock = config.SYNESIS_YARN_SENSEMAKING_PROMPT_BLOCK_ENABLED
        ? (oaiSm.block || null)
        : null;
      applySensemakingStats(sensemakingStats, oaiSm.result, oaiSm.evaluated);
    }

    const oaiLastToolId = [...(request.messages as Array<{ role: string; tool_call_id?: string }>)]
      .reverse().find((m) => m.role === "tool")?.tool_call_id ?? "";
    const latestOpenAIUserHash = hashTextSignal(latestUserText?.content ?? "");
    if (session.awaitingToolLoopUserAck) {
      if (latestOpenAIUserHash && latestOpenAIUserHash !== session.toolLoopAckAnchorUserHash) {
        session.awaitingToolLoopUserAck = false;
        session.toolLoopNoUserAckCount = 0;
        session.toolLoopAckAnchorUserHash = "";
        resetQwenInterventionOnUserTurn(sessionKey);
      } else {
        session.toolLoopNoUserAckCount += 1;
      }
    }
    const oaiToolProgress = detectToolProgress(
      session,
      normalizedOpenAI.messages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string }; name?: string }> }>,
      {
        normalizeSignal: (content) => normalizedToolOutputSignal(content),
        looksLikeFailure: looksLikeFailureSignal,
      },
    );
    const oaiCommandLoop = analyzeRecentCommandLoop(
      normalizedOpenAI.messages as Array<ToolLoopMessage>,
    );
    const oaiArtifactShadows = buildArtifactShadows(
      getFileSnapshotRegistry(sessionKey),
      session.artifactEditTurns,
    );
    const oaiArtifactContext = summarizeArtifactContext(oaiArtifactShadows);
    const oaiFileState = deriveFileState({
      registry: getFileSnapshotRegistry(sessionKey),
      artifactShadows: oaiArtifactShadows,
      messages: normalizedOpenAI.messages as Array<{ role: string; content: unknown; name?: string }>,
    });
    const oaiPersistedChatState = readPersistedChatStateSnapshot(session.record.metadata);
    const oaiChatState = deriveChatState(
      normalizedOpenAI.messages as Array<GovernorInputMessage>,
      {
        phaseHint: chatPhaseFromWorkflowPhase(oaiWorkingPhase),
        previousSnapshot: oaiPersistedChatState,
      },
    );

    // Proportionality: classify intent scope from the latest user directive
    if (config.SYNESIS_YARN_PROPORTIONALITY_ENABLED && oaiChatState.pendingUserDirective) {
      const scopeClassification = classifyIntentScope(oaiChatState.pendingUserDirective);
      if (scopeClassification.envelope !== "unconstrained") {
        session.scopeEnvelope = scopeClassification.envelope;
        session.diffStats = createDiffStats();
      }
    }

    const oaiObjectiveScope = applyObjectiveScopeAndPersist({
      state: session,
      sessionKey,
      requestId: oaiTraceReqId,
      userId: identity.userId,
      orgId: identity.orgId,
      messages: normalizedOpenAI.messages as Array<{
        role: string;
        content: unknown;
        name?: string;
        tool_call_id?: string;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown }; name?: string }>;
      }>,
      chatState: oaiChatState,
      fileState: oaiFileState,
      latestUserPromptText: latestUserText ? extractTextFromUnknownContent(latestUserText.content) : "",
    });
    const oaiScopedMessages = oaiObjectiveScope.scopedMessages;
    if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
      const preScopeChars = (normalizedOpenAI.messages as Array<{ content?: unknown }>).reduce(
        (s, m) => s + (typeof m.content === "string" ? m.content.length : m.content != null ? JSON.stringify(m.content).length : 0), 0,
      );
      const postScopeChars = (oaiScopedMessages as Array<{ content?: unknown }>).reduce(
        (s, m) => s + (typeof m.content === "string" ? m.content.length : m.content != null ? JSON.stringify(m.content).length : 0), 0,
      );
      app.log.info(
        {
          reqId: oaiTraceReqId,
          preScopeMsgCount: (normalizedOpenAI.messages as unknown[]).length,
          postScopeMsgCount: oaiScopedMessages.length,
          preScopeChars,
          postScopeChars,
          boundaryIndex: oaiObjectiveScope.boundaryIndex,
          droppedPreBoundary: oaiObjectiveScope.droppedPreBoundaryCount,
          retainedEvidence: oaiObjectiveScope.retainedEvidenceCount,
        },
        "objective_scope_diagnostic",
      );
    }
    const oaiRawStateConfidence = assessStateConfidence({
      chatState: oaiChatState,
      fileState: oaiFileState,
      recentReadSatisfied: oaiLatestReadRefresh.hasRecentReadSuccess,
    });
    const oaiSuppressInstructionReground =
      oaiWorkspaceInspection.isEmpty
      && oaiWorkspaceInspection.projectInstructionFiles.length === 0
      && projectInstructionFilePresent(oaiRawStateConfidence.recommendedReadPath);
    const oaiStateConfidence = oaiSuppressInstructionReground
      ? {
          ...oaiRawStateConfidence,
          needsReground: false,
          recommendedReadPath: null,
          reasons: [...new Set([...oaiRawStateConfidence.reasons, "empty_workspace_project_guidance_absent"])],
        }
      : oaiRawStateConfidence;
    persistStateConfidence(session.record.metadata, oaiStateConfidence);
    const oaiStateConfidenceBlock = formatStateConfidenceBlock(oaiStateConfidence);
    if (session.regroundCooldownRemaining > 0) {
      session.regroundCooldownRemaining -= 1;
    }
    const oaiNeedsStateReground =
      oaiStateConfidence.needsReground
      && !oaiEditMissGuard?.active
      && !session.editMissForceReadPending
      && session.regroundCooldownRemaining <= 0;
    if (oaiNeedsStateReground) {
      session.regroundCooldownRemaining = 2;
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "state_confidence_reground_required",
        "state-confidence",
        `overall=${oaiStateConfidence.overallConfidence.toFixed(3)} path=${oaiStateConfidence.recommendedReadPath ?? "<none>"}`,
        oaiTraceReqId,
        {
          chat_confidence: oaiStateConfidence.chatConfidence,
          file_confidence: oaiStateConfidence.fileConfidence,
          overall_confidence: oaiStateConfidence.overallConfidence,
          recommended_read_path: oaiStateConfidence.recommendedReadPath,
          reasons: oaiStateConfidence.reasons,
        },
      );
    }
    const oaiPauseState = prepareProtocolPauseState({
      metadata: session.record.metadata,
      chatState: oaiChatState,
      fileState: oaiFileState,
      taskLedger: session.taskLedger,
    });
    const oaiPauseChatSummary = oaiPauseState.pauseChatSummary;
    const oaiPauseFileSummary = oaiPauseState.pauseFileSummary;
    const oaiPauseTaskContext = oaiPauseState.pauseTaskContext;
    const oaiChatStateBlock = oaiPauseState.chatStateBlock;
    const oaiFileStateBlock = oaiPauseState.fileStateBlock;
    endOaiContextStage();
    const endOaiGovernorStage = oaiOptLedger.startStage("governor");
    const oaiGovernorPauseResumeBlock = buildGovernorPauseResumeBlockForUser(
      session,
      typeof oaiTaskCue === "string" ? oaiTaskCue : "",
    );
    const oaiGovernorPauseSummaryRequested = Boolean(oaiGovernorPauseResumeBlock);
    const oaiGovernorCooldownActive =
      session.lastGovernorCachedResult
      && !session.lastGovernorCachedResult.pause
      && (Date.now() - session.lastGovernorNoPauseAt) < GOVERNOR_COOLDOWN_MS;
    const oaiPipelineContext = {
      requestId: oaiTraceReqId,
      mode: oaiPipelineMode,
      userId: identity.userId,
      orgId: identity.orgId,
      clientKind: identity.clientKind,
      conversationId: identity.conversationId,
      sessionKey,
      startedAt: Date.now(),
      headers: req.headers as Record<string, unknown>,
    };
    let oaiExecutionGovernor = config.SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED
      && !config.SYNESIS_YARN_GOVERNANCE_DISABLED
      && shouldRunGovernorForMode(oaiPipelineMode)
      ? (oaiGovernorCooldownActive
        ? session.lastGovernorCachedResult!
        : await withSpanAsync("yarn.execution_governor.evaluate", {}, async (govSpan) => {
          const governorDecision = await governorService.beforeProviderCall(
            oaiPipelineContext,
            {
              messages: oaiScopedMessages as Array<GovernorInputMessage>,
              options: {
                profile: config.SYNESIS_YARN_GOVERNANCE_PROFILE,
                activePlanStage: oaiPlanGraph?.activeStage ?? null,
                editContextMissActive:
                  oaiEditMissGuard?.active === true
                  || oaiLatestToolProgress.hasRecentEditContextMiss
                  || session.editMissForceReadPending
                  || oaiToolFailures.some((failure) => failure.reason === "edit_context_miss"),
                artifactShadows: oaiArtifactShadows,
                chatState: oaiChatState,
                fileState: oaiFileState,
                orchestratorWorkflowPhase: oaiWorkingPhase,
                taskLedgerOpenCount: session.taskLedger
                  ? session.taskLedger.tasks.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "unknown").length
                  : undefined,
              },
            },
          );
          const decision = governorDecision.execution ?? disabledExecutionGovernorDecision();
          if (!decision.pause) {
            session.lastGovernorNoPauseAt = Date.now();
            session.lastGovernorCachedResult = decision;
          } else {
            session.lastGovernorCachedResult = null;
          }
          if (oaiWorkingPhase) govSpan.setAttribute("governor.orchestrator_workflow_phase", oaiWorkingPhase);
          govSpan.setAttribute("governor.pause", decision.pause);
          govSpan.setAttribute("governor.reason", decision.reason ?? "");
          govSpan.setAttribute("governor.matched_rules", decision.matchedRules.join(","));
          govSpan.setAttribute("governor.phase", decision.telemetry.phase);
          govSpan.setAttribute("governor.trailing_verification_run", decision.telemetry.trailingVerificationRunLength);
          govSpan.setAttribute("governor.no_edit_evidence", decision.telemetry.noEditEvidence);
          return decision;
        }))
      : disabledExecutionGovernorDecision();
    if (
      oaiExecutionGovernor.matchedRules.includes("verification_green_repeat_block")
      || oaiExecutionGovernor.matchedRules.includes("verification_already_green")
    ) {
      session.blockBroadVerificationUntilEdit = true;
    }
    if (
      session.consecutiveRecoveryFires >= 2
      && (
        oaiExecutionGovernor.matchedRules.includes("verification_fail_repeat_block")
        || oaiExecutionGovernor.matchedRules.includes("verification_same_failure_signature_replay")
        || oaiExecutionGovernor.matchedRules.includes("verification_churn_no_edit")
      )
    ) {
      session.blockFailingVerificationUntilEdit = true;
    }
    if (
      (oaiEditMissFailureCount >= 2 || session.consecutiveEditContextMisses >= 2)
      && !oaiExecutionGovernor.matchedRules.includes("edit_failure_replay")
    ) {
      oaiExecutionGovernor = {
        ...oaiExecutionGovernor,
        pause: true,
        reason: "edit_failure_replay",
        matchedRules: ["edit_failure_replay", ...new Set(oaiExecutionGovernor.matchedRules)],
        suggestedNextStep:
          oaiExecutionGovernor.suggestedNextStep
          ?? "Repeated edit anchor failures detected. Read the file once, choose an exact current anchor, and apply one focused edit. If the behavior is already present, verify and move on.",
      };
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "execution_governor_edit_miss_override",
        "execution-governor",
        `Forced edit_failure_replay (turn_misses=${oaiEditMissFailureCount}, consecutive_turn_misses=${session.consecutiveEditContextMisses})`,
        oaiTraceReqId,
        {
          edit_miss_failures: oaiEditMissFailureCount,
          consecutive_turn_edit_miss_failures: session.consecutiveEditContextMisses,
          matched_rules: oaiExecutionGovernor.matchedRules,
        },
      );
    }
    if (oaiGovernorPauseSummaryRequested && oaiExecutionGovernor.pause) {
      const priorRules = oaiExecutionGovernor.matchedRules;
      oaiExecutionGovernor = {
        ...oaiExecutionGovernor,
        pause: false,
        reason: "user_requested_governor_summary",
        matchedRules: ["user_requested_governor_summary"],
        suggestedNextStep: "Summarize current status without tool calls, edits, or command retries.",
      };
      session.lastGovernorCachedResult = null;
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "governor_pause_summary_resume",
        "execution-governor",
        `Allowed explicit summarize/status reply after pause (prior_rules=${priorRules.slice(0, 3).join(",") || "unknown"})`,
        oaiTraceReqId,
        {
          prior_matched_rules: priorRules,
          summary_resume: true,
        },
      );
    }
    const oaiLoopObs = deriveGovernorLoopObservability(
      oaiScopedMessages as Array<{ role: string; tool_calls?: unknown }>,
    );
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "execution_governor_evaluated",
      "execution-governor",
      `phase=${oaiExecutionGovernor.telemetry.phase} rules=${oaiExecutionGovernor.matchedRules.join(",") || "allow"} pause=${oaiExecutionGovernor.pause}`,
      oaiTraceReqId,
      {
        pause: oaiExecutionGovernor.pause,
        reason: oaiExecutionGovernor.reason,
        phase: oaiExecutionGovernor.telemetry.phase,
        matched_rules: oaiExecutionGovernor.matchedRules,
        suggested_next_step: oaiExecutionGovernor.suggestedNextStep?.slice(0, 200),
        has_run_test: oaiLoopObs.hasRunTest,
        last_assistant_tool_calls: oaiLoopObs.lastAssistantToolCalls,
        assistant_tool_calls_since_latest_user: oaiLoopObs.assistantToolCallsSinceLatestUser,
        objective_epoch_id: oaiObjectiveScope.epochId,
        objective_scope_boundary_index: oaiObjectiveScope.boundaryIndex,
        objective_scope_retained_evidence: oaiObjectiveScope.retainedEvidenceCount,
        objective_scope_dropped_pre_boundary: oaiObjectiveScope.droppedPreBoundaryCount,
        state_confidence_chat: oaiStateConfidence.chatConfidence,
        state_confidence_file: oaiStateConfidence.fileConfidence,
        state_confidence_overall: oaiStateConfidence.overallConfidence,
        state_confidence_needs_reground: oaiNeedsStateReground,
        state_confidence_recommended_path: oaiStateConfidence.recommendedReadPath,
        evidence_delta: summarizeEvidenceDelta(session.lastEvidenceDelta),
        artifact_context: oaiArtifactContext,
        chat_state_summary: oaiPauseChatSummary,
        file_state_summary: oaiPauseFileSummary,
        telemetry: oaiExecutionGovernor.telemetry,
      },
    );
    if (oaiExecutionGovernor.matchedRules.includes("discovery_churn_nudge")) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "discovery_churn_guard_nudge",
        "execution-governor",
        `Nudge-only discovery churn detected (explore_trail=${oaiExecutionGovernor.telemetry.trailingExplorationRunLength ?? 0}, repeated_reads=${oaiExecutionGovernor.telemetry.repeatedReadSearchCalls})`,
        oaiTraceReqId,
        {
          phase: oaiExecutionGovernor.telemetry.phase,
          matched_rules: oaiExecutionGovernor.matchedRules,
          trailing_exploration_run_length: oaiExecutionGovernor.telemetry.trailingExplorationRunLength ?? 0,
          repeated_read_search_calls: oaiExecutionGovernor.telemetry.repeatedReadSearchCalls,
          repeated_broad_discovery_calls: oaiExecutionGovernor.telemetry.repeatedBroadDiscoveryCalls,
          total_broad_discovery_calls: oaiExecutionGovernor.telemetry.totalBroadDiscoveryCalls,
          suggested_next_step: oaiExecutionGovernor.suggestedNextStep?.slice(0, 200),
        },
      );
    }

    // Sensemaking governor — primary decision-maker
    let oaiSensemakingDecision: SensemakingDecision | null = null;
    if (
      config.SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED
      && !config.SYNESIS_YARN_GOVERNANCE_DISABLED
      && shouldRunGovernorForMode(oaiPipelineMode)
    ) {
      const oaiGovEvents = extractCommandEvents(
        (oaiScopedMessages as GovernorInputMessage[]).slice(
          Math.max(0, (oaiScopedMessages as GovernorInputMessage[]).length - 50),
        ),
      );
      const oaiGovChangedFiles = extractEditedFileHints(oaiGovEvents);
      const oaiPlanRecoveryGrace = isPlanRecoveryDiscoveryIntent(
        typeof oaiTaskCue === "string" ? oaiTaskCue : "",
      ) && oaiGovChangedFiles.length === 0 && oaiGovEvents.length <= 30;
      // Proportionality assessment
      const oaiProportionality = config.SYNESIS_YARN_PROPORTIONALITY_ENABLED
        ? assessProportionality(session.diffStats, session.scopeEnvelope)
        : null;
      const oaiProportionalitySignal = oaiProportionality
        ? proportionalityToSignal(oaiProportionality.level)
        : null;

      oaiSensemakingDecision = evaluateSensemakingGovernor(
        oaiExecutionGovernor,
        oaiGovEvents,
        countTurnsSinceLastUser(oaiScopedMessages as readonly { role: string }[]),
        oaiGovChangedFiles.length,
        oaiPlanRecoveryGrace,
        null,
        oaiProportionalitySignal,
      );
      const smComparison = compareSensemakingWithLegacy(oaiExecutionGovernor, oaiSensemakingDecision);
      recordSessionEvent(
        sessionKey, identity.userId, identity.orgId,
        "sensemaking_governor_evaluated",
        "sensemaking-governor",
        `domain=${oaiSensemakingDecision.domain} response=${oaiSensemakingDecision.responseLevel} friction=${smComparison.frictionScore} momentum=${smComparison.productiveMomentum} legacy_agreement=${smComparison.agreement}`,
        oaiTraceReqId,
        {
          ...smComparison,
          guidance: oaiSensemakingDecision.guidance?.slice(0, 200),
          shouldPause: oaiSensemakingDecision.shouldPause,
          shouldRestrictDiscovery: oaiSensemakingDecision.shouldRestrictDiscovery,
          planRecoveryGrace: oaiPlanRecoveryGrace,
        },
      );
      if (oaiProportionality && oaiProportionality.level !== "proportional") {
        recordSessionEvent(
          sessionKey, identity.userId, identity.orgId,
          "proportionality_check", "proportionality",
          `level=${oaiProportionality.level} scope=${session.scopeEnvelope} files=${session.diffStats.filesModified} deleted=${session.diffStats.filesDeleted} net_removed=${session.diffStats.netLinesRemoved} breaches=${oaiProportionality.breaches.join(";")}`,
          oaiTraceReqId,
          {
            level: oaiProportionality.level,
            scopeEnvelope: session.scopeEnvelope,
            filesModified: session.diffStats.filesModified,
            filesDeleted: session.diffStats.filesDeleted,
            netLinesRemoved: session.diffStats.netLinesRemoved,
            totalLinesChanged: session.diffStats.totalLinesChanged,
            breaches: oaiProportionality.breaches,
            signal: oaiProportionalitySignal,
          },
        );
      }
    }

    const oaiAggressiveRepeatGuard =
      (oaiCommandLoop.commandRepeatCount >= 2 && Boolean(oaiCommandLoop.failureSignatureHash))
      || oaiCommandLoop.broadDiscoveryRepeatCount >= 4;
    const oaiRepeatAwarePivot = oaiAggressiveRepeatGuard
      ? Math.max(3, Math.min(config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT, 6))
      : config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT;
    const oaiRepeatAwareHardReject = oaiAggressiveRepeatGuard
      ? Math.max(3, Math.min(config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER, 4))
      : config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER;
    const oaiLoopLimits = applyRuntimePreferenceLoopLimits({
      consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
      consecutiveToolCallsPivot: oaiRepeatAwarePivot,
      stagnantToolCyclesLimit: config.SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT,
      toolLoopNoUserAckHardLimit: config.SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT,
      hardRejectAfter: oaiRepeatAwareHardReject,
    }, oaiRuntimePreferences);
    const distToolCalls = await distributedCounters.getConsecutiveToolCalls(sessionKey);
    if (distToolCalls !== null && distToolCalls !== session.consecutiveToolCalls) {
      session.consecutiveToolCalls = distToolCalls;
    }
    const policyPrecheck = withSpan("yarn.policy.evaluate", { "yarn.path": "openai" }, () => policyEngine.evaluate({
      tools: request.tools as unknown[],
      repeatAttempt: {
        action: "chat_completion",
        args: {
          model: request.model,
          lastToolId: oaiLastToolId,
          messageCount: request.messages.length,
          latestUserHash: latestOpenAIUserHash || "none",
          commandSignature: oaiCommandLoop.commandSignatureHash || "none",
          commandRepeatCount: oaiCommandLoop.commandRepeatCount,
          failureSignature: oaiCommandLoop.failureSignatureHash || "none",
        },
        fsFingerprint: oaiCommandLoop.commandSignatureHash
          ? `${oaiCommandLoop.commandSignatureHash}:${oaiCommandLoop.failureSignatureHash || "none"}:${latestOpenAIUserHash || "none"}`
          : `${oaiLastToolId || "none"}:${request.messages.length}:${latestOpenAIUserHash || "none"}`,
      },
      sessionKey,
      sessionTokensIn: session.record.totalTokensIn,
      maxInputTokens: config.SYNESIS_YARN_SESSION_SOFT_MAX_INPUT_TOKENS,
      hardMaxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
      sessionBudgetMode: config.SYNESIS_YARN_SESSION_BUDGET_MODE,
      consecutiveToolCalls: session.consecutiveToolCalls,
      consecutiveToolCallsLimit: oaiLoopLimits.consecutiveToolCallsLimit,
      consecutiveToolCallsPivot: oaiLoopLimits.consecutiveToolCallsPivot,
      toolProgressState: oaiLatestToolProgress.hasRecentWriteSuccess
        ? "progress"
        : (oaiLatestToolProgress.hasRecentFailure ? "stagnant" : oaiToolProgress.state),
      stagnantToolCycles: oaiLatestToolProgress.hasRecentWriteSuccess
        ? 0
        : (oaiLatestToolProgress.hasRecentFailure ? Math.max(session.stagnantToolCycles, 1) : session.stagnantToolCycles),
      stagnantToolCyclesLimit: oaiLoopLimits.stagnantToolCyclesLimit,
      toolLoopNoUserAckCount: session.toolLoopNoUserAckCount,
      toolLoopNoUserAckHardLimit: oaiLoopLimits.toolLoopNoUserAckHardLimit,
      hardRejectAfter: oaiLoopLimits.hardRejectAfter,
      governanceRules: governanceClient?.getRules(),
    }));
    const oaiPolicyAction = handleDeterministicPolicyPrecheck({
      decision: policyPrecheck,
      softFailEnabled: config.SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED,
      session,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      selectedModel: orchestration.selectedModel,
      originalModel: request.model,
      latestUserHash: latestOpenAIUserHash,
      finishReason: "stop",
      logSafetyEvent: logAndPersistSafetyEvent,
      persistSessionAndUsage: sessionPersistenceRunner.persistSessionAndUsage,
      maybeCheckpoint,
      recordSessionEvent,
    });
    if (oaiPolicyAction.kind === "softFail") {
      return sendOpenAISoftFail(reply, oaiTraceReqId, orchestration.selectedModel, oaiPolicyAction.content, !!request.stream);
    }
    if (oaiPolicyAction.kind === "reject") {
      return reply.code(400).send(policyRejectOpenAIBody(oaiPolicyAction.decision));
    }
    const oaiClientToolInventory = Array.isArray(request.tools) ? [...(request.tools as unknown[])] : [];
    if (shouldStripGlobFromTools(sessionKey)) {
      const globStrip = stripGlobFromTools(request.tools as unknown[] | undefined);
      if (globStrip.stripped) {
        request.tools = globStrip.tools as never;
        app.log.warn({ reqId: oaiTraceReqId, sessionKey, sessionBlockedTotal: getBlockedDiscoveryCount(sessionKey) }, "proactive_glob_strip_from_tools");
      }
    }
    const oaiGovernorPhase = oaiExecutionGovernor.telemetry.phase;
    applyGovernorPhaseRouteBookkeeping({
      session,
      sessionKey,
      identity,
      requestId: oaiTraceReqId,
      governorPhase: oaiGovernorPhase,
      workingPhase: oaiWorkingPhase,
      orchestratorPhaseOverride: oaiOrchestratorPhaseOverride,
      messages: normalizedOpenAI.messages as GovernorInputMessage[],
      recordSessionEvent,
    });

    const oaiSensemakingPrimaryEnabled =
      config.SYNESIS_YARN_SENSEMAKING_ENABLED
      && !config.SYNESIS_YARN_SENSEMAKING_HARD_STOP_ONLY;
    if (
      !oaiSensemakingPrimaryEnabled
      && oaiExecutionGovernor.pause
      && config.SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED
    ) {
      const pause = persistGovernorPauseSoftFail({
        session,
        sessionKey,
        identity,
        requestId: oaiTraceReqId,
        selectedModel: orchestration.selectedModel,
        originalModel: request.model,
        finishReason: "stop",
        buildPause: (consecutiveRecoveryFires) => {
          const content = buildExecutionGovernorHardStopUserMessage({
            consecutiveRecoveryFires,
            matchedRules: oaiExecutionGovernor.matchedRules,
            questionToolName: oaiClientToolCapabilities.questionToolName,
            taskContext: oaiPauseTaskContext,
          });
          const envelope = buildExecutionGovernorPauseEnvelope({
            matchedRules: oaiExecutionGovernor.matchedRules,
            consecutiveRecoveryFires,
            hardStopThreshold: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER,
            evidenceDelta: summarizeEvidenceDelta(session.lastEvidenceDelta),
            activeGuards: oaiExecutionGovernor.telemetry.activeGuards,
            artifactContext: oaiArtifactContext,
            chatStateSummary: oaiPauseChatSummary,
            fileStateSummary: oaiPauseFileSummary,
            taskContext: oaiPauseTaskContext,
            questionToolName: oaiClientToolCapabilities.questionToolName,
          });
          return {
            content,
            envelope,
            eventType: "execution_governor_pause",
            eventSource: "execution-governor",
            eventSummary: `Pause: rules=${oaiExecutionGovernor.matchedRules.slice(0, 3).join(",") || "unknown"}`,
            eventMetadata: {
              matchedRules: oaiExecutionGovernor.matchedRules,
              reason: oaiExecutionGovernor.reason,
              consecutiveRecoveryFires,
            },
          };
        },
        persistPauseContext: ({ session: pauseSession, pauseEnvelope, pauseContent }) => persistGovernorPauseContextMetadata({
          session: pauseSession,
          surface: "openai",
          requestId: oaiTraceReqId,
          pauseEnvelope,
          pauseContent,
          clientToolCapabilities: oaiClientToolCapabilities,
        }),
        persistSessionAndUsage: sessionPersistenceRunner.persistSessionAndUsage,
        maybeCheckpoint,
        recordSessionEvent,
      });
      return sendOpenAISoftFail(reply, oaiTraceReqId, orchestration.selectedModel, pause.content, !!request.stream, pause.envelope);
    }

    // Sensemaking-driven response: graduated allow/nudge/guide/intervene
    if (oaiSensemakingPrimaryEnabled && oaiSensemakingDecision && config.SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED) {
      if (oaiSensemakingDecision.shouldPause) {
        // Chaotic domain — hard pause
        const pause = persistGovernorPauseSoftFail({
          session,
          sessionKey,
          identity,
          requestId: oaiTraceReqId,
          selectedModel: orchestration.selectedModel,
          originalModel: request.model,
          finishReason: "stop",
          buildPause: (consecutiveRecoveryFires) => {
            const content = buildSensemakingPauseMessage(oaiSensemakingDecision);
            const envelope = buildExecutionGovernorPauseEnvelope({
              matchedRules: oaiSensemakingDecision.matchedRules,
              consecutiveRecoveryFires,
              hardStopThreshold: 7,
              evidenceDelta: summarizeEvidenceDelta(session.lastEvidenceDelta),
              activeGuards: oaiExecutionGovernor.telemetry.activeGuards,
              artifactContext: oaiArtifactContext,
              chatStateSummary: oaiPauseChatSummary,
              fileStateSummary: oaiPauseFileSummary,
              taskContext: oaiPauseTaskContext,
              questionToolName: oaiClientToolCapabilities.questionToolName,
            });
            return {
              content,
              envelope,
              eventType: "sensemaking_governor_pause",
              eventSource: "sensemaking-governor",
              eventSummary: `Pause: domain=${oaiSensemakingDecision.domain} friction=${(oaiSensemakingDecision.frictionScore * 100).toFixed(0)}% signals=${oaiSensemakingDecision.matchedRules.slice(0, 3).join(",")}`,
              eventMetadata: {
                domain: oaiSensemakingDecision.domain,
                frictionScore: oaiSensemakingDecision.frictionScore,
                matchedRules: oaiSensemakingDecision.matchedRules,
                consecutiveRecoveryFires,
              },
            };
          },
          persistPauseContext: ({ session: pauseSession, pauseEnvelope, pauseContent }) => persistGovernorPauseContextMetadata({
            session: pauseSession,
            surface: "openai",
            requestId: oaiTraceReqId,
            pauseEnvelope,
            pauseContent,
            clientToolCapabilities: oaiClientToolCapabilities,
          }),
          persistSessionAndUsage: sessionPersistenceRunner.persistSessionAndUsage,
          maybeCheckpoint,
          recordSessionEvent,
        });
        return sendOpenAISoftFail(reply, oaiTraceReqId, orchestration.selectedModel, pause.content, !!request.stream, pause.envelope);
      }

      const guidanceInjection = buildSensemakingGuidanceInjection(oaiSensemakingDecision);
      if (guidanceInjection) {
        injectGovernorRecoveryMessage(
          normalizedOpenAI.messages as Array<{ role: string; content: unknown }>,
          guidanceInjection,
        );
        recordSessionEvent(
          sessionKey, identity.userId, identity.orgId,
          "sensemaking_governor_guidance",
          "sensemaking-governor",
          `${oaiSensemakingDecision.responseLevel}: domain=${oaiSensemakingDecision.domain} friction=${(oaiSensemakingDecision.frictionScore * 100).toFixed(0)}%`,
          oaiTraceReqId,
          {
            responseLevel: oaiSensemakingDecision.responseLevel,
            domain: oaiSensemakingDecision.domain,
            frictionScore: oaiSensemakingDecision.frictionScore,
            guidance: guidanceInjection.slice(0, 200),
          },
        );
      }

      // Reset recovery counters on non-pause outcomes
      resetGovernorPauseRecoveryState(session, oaiHasActiveEditMissFailure, clearGovernorPauseContextMetadata);
    } else if (!oaiExecutionGovernor.pause) {
      resetGovernorPauseRecoveryState(session, oaiHasActiveEditMissFailure, clearGovernorPauseContextMetadata);
    }
    endOaiGovernorStage();
    const endOaiEnrichmentStage = oaiOptLedger.startStage("enrichment");
    const oaiRole = TIER_TO_ROLE[orchestration.tier];
    const oaiBackendModel = roleAssignmentRegistry.get(oaiRole)?.backendModel ?? "";
    const oaiPromptContext = {
      tier: orchestration.tier,
      role: oaiRole,
      modelFamily: inferModelFamily(oaiBackendModel),
    };
    const oaiMetadataPrebackfill = applyWorkspaceMetadataPrebackfill({
      pathContext: effectiveOaiPathCtx,
      adapterBlock: effectiveOaiAdapterBlock,
      messages: normalizedOpenAI.messages as never,
      session,
      requestId: oaiTraceReqId,
      extractMetadataFromMessages: (messages) => extractMetadataFromMessages(messages as never),
      buildAdapterBlock: buildEffectiveOaiAdapterBlock,
      setWorkspaceContext: setSessionWorkspaceContext,
      logInfo: (record, message) => app.log.info(record, message),
      logSessionKey: sessionKey,
    });
    effectiveOaiPathCtx = oaiMetadataPrebackfill.pathContext;
    effectiveOaiAdapterBlock = oaiMetadataPrebackfill.adapterBlock;
    const oaiSeedDirs = await getCachedTopLevelDirs(effectiveOaiPathCtx.projectRoot ?? effectiveOaiPathCtx.shellCwd);
    const oaiGovernanceBlocks = buildRouteGovernanceBlocks({
      memoryTracker: getMemoryGovernor(sessionKey),
      structuralIndex: getStructuralIndex(sessionKey),
      sessionMemoryCount: getSessionMemoryCount(sessionKey),
      clientToolCapabilities: oaiClientToolCapabilities,
      taskIntake: oaiTaskIntake,
      planGraph: oaiPlanGraph,
      relevantEvidenceBlock: oaiObjectiveScope.relevantEvidenceBlock,
      artifactBridgeBlock: oaiObjectiveScope.artifactBridgeBlock,
      stateConfidenceBlock: oaiStateConfidenceBlock,
      freshImplicitSessionNotice: oaiFreshImplicitSessionNotice,
      governorPauseResumeBlock: oaiGovernorPauseResumeBlock,
      plannerTodoPacketBlock: oaiPlannerTodoPacketBlock,
      taskLedger: session.taskLedger,
      taskCapabilities: session.taskCapabilities,
    });
    const oaiEnriched = await enrichWithFrameAndManifest(
      oaiScopedMessages as never,
      sessionKey,
      effectiveOaiAdapterBlock,
      oaiPromptContext,
      { projectRoot: effectiveOaiPathCtx.projectRoot, shellCwd: effectiveOaiPathCtx.shellCwd },
      oaiGovernanceBlocks.blocks,
      oaiSeedDirs,
      session,
      { chatStateBlock: oaiChatStateBlock, fileStateBlock: oaiFileStateBlock },
    );
    const oaiFinalizedEnrichment = finalizePostEnrichmentMessages({
      messages: oaiEnriched.messages,
      config,
      requirementChecklist: oaiRequirementChecklist,
      trustContext: {
        requestId: oaiTraceReqId,
        sessionKey,
        userId: identity.userId,
        orgId: identity.orgId,
      },
      securityIngestConfig,
      logger: app.log as never,
    });
    if (!oaiFinalizedEnrichment.ok) {
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, "trust_block", "transcript-trust", oaiFinalizedEnrichment.blockDetail, oaiTraceReqId);
      return reply.code(400).send({ error: { type: "invalid_request_error", message: `Request blocked by content safety policy (${oaiFinalizedEnrichment.trustCategory}). Rephrase and retry.` } });
    }
    const oaiEnrichedMsgs = oaiFinalizedEnrichment.messages;

    const reqId = oaiTraceReqId;
    endOaiEnrichmentStage();
    const endOaiProviderRequestStage = oaiOptLedger.startStage("provider_request");
    const oaiProviderFinalization = await finalizeOpenAIProviderRequestForRoute({
      request,
      selectedModel: orchestration.selectedModel,
      enrichedMessages: oaiEnrichedMsgs,
      toolResultCount,
      session,
      sessionKey,
      requestId: reqId,
      identity,
      pathContext: effectiveOaiPathCtx,
      governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      volatileSystemBlocks: [
        oaiPrefetchResult ? formatEvidenceBlock(oaiPrefetchResult) ?? "" : "",
        oaiPatternResult ? formatPatternBlock(oaiPatternResult) ?? "" : "",
        oaiSensemakingBlock ?? "",
      ],
      policyPivotPrompt: policyPrecheck.pivotPrompt,
      latestUserContent: latestUserText?.content,
      runtimePreferences: oaiRuntimePreferences,
      configuredCompactionMode: config.SYNESIS_YARN_CONTEXT_BUDGET_COMPACTION_MODE,
      defaultTier: config.SYNESIS_YARN_DEFAULT_TIER,
      prefixHash: oaiEnriched.prefixHash,
      prefixChangeReasons: oaiEnriched.prefixChangeReasons,
      prefixOptimizer,
      optimizationLedger: oaiOptLedger,
      logger: app.log,
      injectSessionContext: (messages, state) => injectSessionContext(
        messages as Array<{ role: string; content: unknown }>,
        state,
      ) as typeof messages,
      injectArtifactTool: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED
        ? (tools) => artifactRetrieval.injectToolOpenAI(tools) ?? tools
        : undefined,
      injectKnowledgeTool: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED
        ? (tools) => knowledgeSearch.injectToolOpenAI(tools) ?? tools
        : undefined,
      injectWebSearchTool: config.SYNESIS_YARN_WEB_SEARCH_ENABLED
        ? (tools) => webSearch.injectToolOpenAI(tools) ?? tools
        : undefined,
      getTierConfig: (modelId) => tierRegistry.getTierConfig(modelId),
      resolveEndpointCapabilityId,
      loadProviderCachePolicyWindow,
      evaluateCachePolicy: evaluateCachePolicyForSession,
      markerBackendForRequest,
      setCurrentRequestContext: (context) => tierRegistry.setCurrentRequestContext(context),
      setWorkspaceContext: setSessionWorkspaceContext,
      recordSessionEvent,
      runOpenAIRequest,
      clientRequestedModel: request.model,
      transcriptTransformLogSampleRate: config.SYNESIS_YARN_TRANSCRIPT_TRANSFORM_LOG_SAMPLE_RATE,
      shouldSampleBySeed,
      persistDecisionTelemetry: sessionPersistenceRunner.persistAndEmitDecisionTelemetry,
    });
    effectiveOaiPathCtx = oaiProviderFinalization.pathContext;
    if (!oaiProviderFinalization.ok) {
      return sendOpenAIChatPipelineResult(reply, oaiProviderFinalization.result);
    }
    const normalizedRequest = oaiProviderFinalization.normalizedRequest;
    const oaiCachePolicy = oaiProviderFinalization.cachePolicy;
    const { resolved, messages } = oaiProviderFinalization.resolveResult;
    const oaiRoutePersistence = oaiProviderFinalization.routePersistence;
    const oaiProviderPreparation = prepareOpenAIChatProviderRuntime({
      config,
      logger: app.log,
      request,
      normalizedRequest,
      normalizedOpenAI,
      resolved,
      messages,
      session,
      sessionKey,
      identity,
      requestId: reqId,
      routePersistence: oaiRoutePersistence,
      cachePolicy: oaiCachePolicy,
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
      latestUserText,
      policyPrecheck,
      latestReadRefresh: oaiLatestReadRefresh,
      promptIntake: oaiPromptIntake,
      sensemakingDecision: oaiSensemakingDecision,
      taskCue: oaiTaskCue,
      tierRegistry,
      resolveEndpointCapabilityId,
      chatState: oaiChatState,
      fileState: oaiFileState,
      artifactStore,
      contextAdmissionStats,
      compactionOptions: oaiCompactionOpts,
      transcriptPruning,
      forceCheckpoint: () => { void forceCheckpoint(session); },
      recordUpperHarnessDecision: (label, decision, options) =>
        recordUpperHarnessDecision(sessionKey, identity.userId, identity.orgId, reqId, label, decision as never, options as never),
      optimizationLedger: oaiOptLedger,
      reductions: {
        toolResultReduction,
        validationNormalization,
      },
      reducedToolResults: reducedOpenAI.reducedCount,
      evidence: {
        prefetched: oaiEvidencePrefetched,
        confidence: combinedEvidenceConfidence || undefined,
        prefetchResult: oaiPrefetchResult,
        patternResult: oaiPatternResult,
      },
      sensemakingResult: oaiSensemakingResult,
      governorSummaries: {
        chat: oaiPauseChatSummary,
        file: oaiPauseFileSummary,
      },
      inferVerificationSteps,
      trajectoryDiagnostics: oaiTrajectoryDiagnostics,
      enriched: oaiEnriched,
      requirementChecklist: oaiRequirementChecklist,
      pushDiagnostic: (diagnostic) => pushDiagnostic(diagnostic as never),
      getMetadataString,
      verificationAssessment: oaiVerificationAssessment,
      planGraph: oaiPlanGraph,
      effectivePathContext: effectiveOaiPathCtx,
      artifactShadows: oaiArtifactShadows,
      toolArgHardeningStats,
      applyMarkdownGuardrail,
      finalizeCompletionText,
      isOpenClawProfile,
      adapterUsesToolLoopSteering,
      isWriteCapableToolName,
      applyEditContextMissReadGate,
      findPreferredReadToolName,
      ensureReadToolAvailabilityForEditMissGuard,
      buildEditContextMissGuardPrompt,
      buildEditContextMissForcedReadPrompt,
      buildStateRegroundReadPrompt,
      shouldRestrictDiscoveryForPlanWork,
      deserializeShadow,
      buildDefaultPolicy,
      buildEvidenceTraceSummary,
    });
    if (!oaiProviderPreparation.ok) {
      return sendOpenAIChatPipelineResult(reply, oaiProviderPreparation.result);
    }
    endOaiProviderRequestStage();

    const providerExecution = await openAiChatPipeline.executePreparedProviderCall({
      scope: {
        sessionKey,
        userId: identity.userId,
        orgId: identity.orgId,
        requestId: reqId,
      },
      authUser,
      req: { headers: req.headers as Record<string, string | string[] | undefined> },
      rawReply: reply.raw,
      session,
      identity,
      config,
      logger: app.log,
      normalizedRequest: normalizedRequest as never,
      request,
      resolved,
      adapter: oaiProviderPreparation.adapter,
      modelMessages: oaiProviderPreparation.modelMessages,
      effectiveTools: oaiProviderPreparation.effectiveTools,
      sdkTools: oaiProviderPreparation.sdkTools,
      effectiveToolChoice: oaiProviderPreparation.effectiveToolChoice,
      providerOptions: oaiProviderPreparation.providerOptions,
      structuredOutput: oaiProviderPreparation.structuredOutput,
      samplingOptions: oaiProviderPreparation.samplingOptions,
      phasePolicy: oaiProviderPreparation.phasePolicy,
      governorPhase: oaiGovernorPhase,
      forensicsPhasePolicy: oaiProviderPreparation.forensicsPhasePolicy,
      forensicsCapabilityMatrix: oaiForensicsCapabilityMatrix,
      orchestration,
      toolHandlingRouteBase: oaiProviderPreparation.toolHandlingRouteBase as never,
      finalizerRouteBase: oaiProviderPreparation.finalizerRouteBase as never,
      telemetryRouteBase: oaiProviderPreparation.telemetryRouteBase as never,
      optimizationLedger: oaiOptLedger,
      pathContext: effectiveOaiPathCtx,
      bodyMetadata: oaiBodyMeta,
      prefetchResult: oaiPrefetchResult,
      clientKind: oaiClientKind,
      openClawProfileStats,
      circuitBreakers,
      streamAdmission,
      toolArgHardeningStats,
      yarnDedupeLayer,
      yarnToolPrefixCache,
      tierRegistry,
      getTracer,
      extractUpstreamErrorDiagnostics,
      clampMaxOutputTokensForSafety,
      generateText: (options) => generateText(options as never),
      streamText: (options) => streamText(options as never),
      readUsage,
      recordSessionEvent,
      persistDecisionTelemetry: oaiProviderPreparation.persistDecisionTelemetry,
      captureRequestForensics,
      finalizeRequestForensics: (state, requestId, forensics, usage) =>
        finalizeRequestForensics(state as never, requestId, forensics as never, usage as never),
      getCachedTopLevelDirs,
      applyDiscoveryToolGuardrail,
      buildBlockedDiscoveryRecoverySnapshot,
      recordBlockedDiscovery,
      getBlockedDiscoveryCount,
      updateDiffAccumulator,
      maybeUpdateTaskLedgerFromToolCall,
      emitPlanWriteAuditEvent,
      maybeLogEnvelopeUnwrapSample,
      recordUpperHarnessDecision,
      artifactToolName: ARTIFACT_TOOL_NAME,
      knowledgeToolName: KNOWLEDGE_TOOL_NAME,
      devDocsToolName: DEV_DOCS_TOOL_NAME,
      webSearchToolName: WEB_SEARCH_TOOL_NAME,
      webSearchToolAlias: WEB_SEARCH_TOOL_ALIAS,
      artifactRetrieval,
      knowledgeSearch,
      webSearch,
      knowledgeResolveContext,
      webSearchResolveContext,
      safeWrite,
      safeEnd,
      computePrefixFingerprint,
      startSseHeartbeat,
      sseHeadersWithClarification,
      finalizePostStreamText,
      responseHeadersNeedClarification: true,
    });
    if (providerExecution.applyClarificationHeader) {
      applyClarificationRoundResponseHeader(reply, session.record.metadata);
    }
    return sendOpenAIChatPipelineResult(reply, providerExecution.result);
  });
}
