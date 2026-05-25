import type { OpenAIChatCompletionsRouteDependencies } from "../index.js";
import { OptimizationLedger } from "../telemetry/optimization-ledger.js";
import { reconstructMissingToolCalls } from "../tool-mapping.js";
import { sortToolSchemas } from "../compat/sorted-tools.js";
import { prepareOpenAIRouteTranscript } from "../pipeline/openai-route-transcript-prep.js";
import { stabilizeOpenAITranscript } from "../pipeline/openai-route-transcript-stabilization.js";
import { finalizeOpenAIProviderRequestForRoute } from "../pipeline/openai-route-provider-finalization.js";
import { prepareOpenAIChatProviderRuntime } from "../pipeline/openai-chat-provider-preparation.js";
import { runOpenAIGovernancePrecheck } from "../pipeline/openai-governance-precheck.js";
import { prepareOpenAIExecutionGovernor } from "../pipeline/openai-execution-governor-preparation.js";
import { prepareOpenAIContext } from "../pipeline/openai-context-preparation.js";
import { prepareOpenAITurn } from "../pipeline/openai-turn-preparation.js";
import { prepareOpenAIEnrichment } from "../pipeline/openai-enrichment-preparation.js";
import { sendOpenAIChatPipelineResult } from "../pipeline/openai-chat-pipeline.js";
import { shouldRunGovernorForMode } from "../pipeline/modes.js";

type AuthUser = import("../auth.js").AuthUser;
type SessionIdentity = import("../session/session-key.js").SessionIdentity;
type RequestForensicsRecord = import("../telemetry/request-forensics.js").RequestForensicsRecord;
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
    crypto,
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
