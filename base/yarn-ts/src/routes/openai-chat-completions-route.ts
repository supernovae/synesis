import type { OpenAIChatCompletionsRouteDependencies } from "../index.js";
import { OptimizationLedger } from "../telemetry/optimization-ledger.js";
import { reconstructMissingToolCalls, openAIToolsToSDK } from "../tool-mapping.js";
import {
  appendSystemMessageAndNormalize,
  normalizeSystemMessageOrdering,
} from "../transcript/system-message-ordering.js";
import { sortToolSchemas } from "../compat/sorted-tools.js";
import { prepareOpenAIRouteTranscript } from "../pipeline/openai-route-transcript-prep.js";
import { stabilizeOpenAITranscript } from "../pipeline/openai-route-transcript-stabilization.js";
import {
  createOpenAIChatNonStreamRoutePipelineInput,
  runOpenAIChatNonStreamPipeline,
} from "../pipeline/openai-chat-nonstream-pipeline.js";
import { runOpenAIChatStreamPipeline } from "../pipeline/openai-chat-stream-pipeline.js";
import {
  createOpenAIChatRouteFinalizerBase,
  createOpenAIChatRouteTelemetryBase,
  createOpenAIChatRouteToolHandlingBase,
  createOpenAINonStreamCollapseRouteInput,
  createOpenAINonStreamDiscoveryRouteInput,
} from "../pipeline/openai-route-inputs.js";
import {
  createOpenAINonStreamProviderForensics,
  createOpenAINonStreamServerSideToolResolvers,
} from "../pipeline/openai-nonstream-provider-executor.js";
import { createOpenAINonStreamRouteScope } from "../pipeline/openai-nonstream-route-scope.js";
import {
  buildOpenAIChatProviderRequestOptions,
  suppressThinkingWhenRequiredToolChoice,
} from "../pipeline/provider-options.js";
import { sendOpenAIChatPipelineResult } from "../pipeline/openai-chat-pipeline.js";
import { shouldRunGovernorForMode } from "../pipeline/modes.js";
import {
  admissionErrorMessage,
  countMessageRoles,
} from "../pipeline/context-admission.js";
import { runRouteContextAdmission } from "../pipeline/route-context-admission.js";
import {
  buildCacheShapeDiagnostics,
} from "../telemetry/cache-shape-diagnostics.js";
import { createRoutePersistenceScope } from "../state/route-persistence-scope.js";
import { prepareProtocolPauseState } from "../session/protocol-pause-state.js";

type AuthUser = import("../auth.js").AuthUser;
type SessionIdentity = import("../session/session-key.js").SessionIdentity;
type RequestForensicsRecord = import("../telemetry/request-forensics.js").RequestForensicsRecord;
type RequestDiagnostic = import("../telemetry/request-diagnostics.js").RequestDiagnostic;
type GovernorInputMessage = import("../governance/execution-governor.js").GovernorInputMessage;
type PhaseAwareToolChoice = import("../governance/phase-execution-policy.js").PhaseAwareToolChoice;
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
    applyRouteAdapterPivot,
    applyRoutePhasePolicy,
    applyRuntimePreferenceLoopLimits,
    applySensemakingStats,
    applySessionTaskCapabilities,
    applyWorkspaceBoundary,
    applyWorkspaceMetadataPrebackfill,
    ARTIFACT_TOOL_NAME,
    artifactRetrieval,
    assembleRouteModelMessages,
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
    buildYarnUpperHarnessContext,
    cachePolicyLogRecord,
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
    extractRecentToolNames,
    extractTextFromUnknownContent,
    fgaCheck,
    finalizeOpenAIProviderRequest,
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
    prepareRouteTools,
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
    toolSchemaPruningStats,
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
    const oaiProviderFinalization = await finalizeOpenAIProviderRequest({
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
    });
    const normalizedRequest = oaiProviderFinalization.normalizedRequest;
    effectiveOaiPathCtx = oaiProviderFinalization.pathContext;
    const oaiCachePolicy = oaiProviderFinalization.cachePolicy;
    const resolveResult = oaiProviderFinalization.resolveResult;
    if (!resolveResult.ok) {
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, "resolve_failure", "tier-registry", resolveResult.error, reqId);
      return reply.code(503).send({ error: { type: "service_unavailable", message: resolveResult.error } });
    }
    const { resolved, messages, transforms: oaiTranscriptTransforms } = resolveResult;
    const oaiRoutePersistence = createRoutePersistenceScope({
      state: session,
      requestId: reqId,
      resolvedModelId: resolved.resolvedModelId,
      sessionKey,
      userId: identity.userId,
      orgId: identity.orgId,
      clientRequestedModel: request.model,
      recordSessionEvent,
      persistDecisionTelemetry: sessionPersistenceRunner.persistAndEmitDecisionTelemetry,
    });
    if (
      (oaiTranscriptTransforms.systemMessagesReordered || oaiTranscriptTransforms.toolCallsSanitized)
      && shouldSampleBySeed(
        `${sessionKey}:${reqId}:openai-transform`,
        config.SYNESIS_YARN_TRANSCRIPT_TRANSFORM_LOG_SAMPLE_RATE,
      )
    ) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "transcript_transform_applied",
        "request-normalizer",
        `system_reordered=${oaiTranscriptTransforms.systemMessagesReordered} tool_sanitized=${oaiTranscriptTransforms.toolCallsSanitized} delta=${oaiTranscriptTransforms.messageCountDelta}`,
        reqId,
        {
          path: "openai",
          system_messages_reordered: oaiTranscriptTransforms.systemMessagesReordered,
          tool_calls_sanitized: oaiTranscriptTransforms.toolCallsSanitized,
          message_count_delta: oaiTranscriptTransforms.messageCountDelta,
        },
      );
    }
    const { adapter } = resolved;
    const oaiResolvedTierForHarness = tierRegistry.getTierConfig(resolved.resolvedModelId);
    const oaiUpperHarness = buildYarnUpperHarnessContext({
      surface: "openai",
      modelId: oaiResolvedTierForHarness?.backendModel ?? resolved.resolvedModelId,
      requestedModel: request.model,
      baseUrl: oaiResolvedTierForHarness?.baseUrl,
      provider: oaiResolvedTierForHarness
        ? resolveEndpointCapabilityId(oaiResolvedTierForHarness.baseUrl)
        : undefined,
    });
    const rawTools = ((normalizedRequest.tools as unknown[]) ?? []);
    const oaiToolPreparation = prepareRouteTools({
      rawTools,
      adapter,
      clientCapabilities: oaiClientToolCapabilities,
      clientKind: oaiClientKind,
      phase: orchestration.phase,
      profileToolBudgetCap: config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED && isOpenClawProfile(adapterProfile)
        ? Math.max(1, config.SYNESIS_YARN_OPENCLAW_TOOL_SCHEMA_CAP)
        : adapterProfile.features.toolSchemaBudgetCap,
      pruningEnabled: config.SYNESIS_YARN_TOOL_SCHEMA_PRUNING_ENABLED,
      pruningMaxOverride: config.SYNESIS_YARN_TOOL_SCHEMA_PRUNING_MAX_OVERRIDE,
      toolChoice: normalizedRequest.tool_choice,
      latestUserContent: latestUserText?.content,
      recentCallMessages: normalizedRequest.messages as Array<{ role: string; content: unknown }>,
      recoveryMessages: normalizedOpenAI.messages as Array<{ role: string; content: unknown }>,
      governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      toolLoopSteeringEnabled: adapterUsesToolLoopSteering(adapter.family),
      harnessTelemetryEnabled: config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED,
      requestId: oaiTraceReqId,
      stats: toolSchemaPruningStats,
      logger: app.log,
      isWriteCapableToolName,
      recordSessionEvent: oaiRoutePersistence.recordSessionEvent,
    });
    const oaiRecentCallsForSteering = oaiToolPreparation.recentCallsForSteering;
    let effectiveTools = oaiToolPreparation.effectiveTools;
    const clientToolChoice = oaiToolPreparation.clientToolChoice;
    if (oaiToolPreparation.invalidToolChoice) {
      return reply.code(400).send({
        error: {
          type: "invalid_request_error",
          message: "Invalid tool_choice. Expected auto|none|required|any or object form {type:\"tool\",name:\"...\"}.",
        },
      });
    }
    const oaiForceReadRecovery =
      session.editMissForceReadPending
      && oaiExecutionGovernor.matchedRules.includes("edit_failure_replay");
    const oaiPhaseApplication = applyRoutePhasePolicy({
      adapterFamily: adapter.family,
      basePolicyEnabled: config.SYNESIS_YARN_PHASE_EXECUTION_POLICY_ENABLED && oaiPhasePolicyEnabledByMatrix,
      policyEnabledByMatrix: oaiPhasePolicyEnabledByMatrix,
      enabledFamilies: config.SYNESIS_YARN_PHASE_EXECUTION_POLICY_FAMILIES,
      phase: oaiGovernorPhase,
      matchedRules: oaiExecutionGovernor.matchedRules,
      stream: !!normalizedRequest.stream,
      effectiveTools,
      clientToolChoice: clientToolChoice as PhaseAwareToolChoice | undefined,
      editMissGuard: oaiEditMissGuard,
      editMissForceReadPending: session.editMissForceReadPending,
      forceReadRecovery: oaiForceReadRecovery,
      consecutiveEditContextMisses: session.consecutiveEditContextMisses,
      stateRegroundRequired: oaiNeedsStateReground,
      stateRegroundReadPath: oaiStateConfidence.recommendedReadPath,
      clientToolInventory: oaiClientToolInventory,
      recordSessionEvent: oaiRoutePersistence.recordSessionEvent,
      applyEditContextMissReadGate,
      findPreferredReadToolName,
      ensureReadToolAvailability: ensureReadToolAvailabilityForEditMissGuard,
    });
    const oaiPhasePolicy = oaiPhaseApplication.phasePolicy;
    const oaiPhaseFiltered = oaiPhaseApplication.phaseFiltered;
    effectiveTools = oaiPhaseApplication.effectiveTools;
    const effectiveToolChoice = oaiPhaseApplication.effectiveToolChoice;
    const sdkTools = openAIToolsToSDK(effectiveTools as never);
    const oaiForensicsPhasePolicy: RequestForensicsRecord["phasePolicy"] = {
      enabled: oaiPhasePolicy.active,
      source: clientToolChoice !== undefined ? "client" : (effectiveToolChoice !== undefined ? "phase_policy" : "none"),
      phase: oaiGovernorPhase,
      effectiveToolChoice: typeof effectiveToolChoice === "string" ? effectiveToolChoice : effectiveToolChoice ? "tool" : undefined,
      filteredToolCount: oaiPhaseFiltered.removed.length,
    };
    if (oaiPhasePolicy.active && (oaiPhaseFiltered.filtered || clientToolChoice === undefined)) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "phase_execution_policy_applied",
        "execution-governor",
        `phase=${oaiGovernorPhase} reason=${oaiPhasePolicy.reason ?? "none"} tool_choice=${typeof effectiveToolChoice === "string" ? effectiveToolChoice : "tool"} filtered=${oaiPhaseFiltered.removed.length}`,
        reqId,
        {
          matched_rules: oaiExecutionGovernor.matchedRules,
          removed_tools: oaiPhaseFiltered.removed,
          state_confidence_reground: oaiNeedsStateReground,
          state_confidence_recommended_path: oaiStateConfidence.recommendedReadPath,
        },
      );
    }

    let modelMessages = assembleRouteModelMessages({
      adapter,
      effectiveTools: effectiveTools as unknown[],
      messages,
      workspaceInspection: oaiWorkspaceInspection,
      policyPivotPrompt: policyPrecheck.pivotPrompt,
      editMissGuard: oaiEditMissGuard,
      forceReadRecovery: oaiForceReadRecovery,
      latestReadRefreshFilePath: oaiLatestReadRefresh.filePath,
      consecutiveEditContextMisses: session.consecutiveEditContextMisses,
      stateReground: {
        required: oaiNeedsStateReground,
        recommendedReadPath: oaiStateConfidence.recommendedReadPath,
        reasons: oaiStateConfidence.reasons,
      },
      promptIntakeSystemBlock: oaiPromptIntake.systemBlock,
      buildEditContextMissGuardPrompt,
      buildEditContextMissForcedReadPrompt,
      buildStateRegroundReadPrompt,
    }).messages as typeof messages;

    const oaiGovernanceRecoveryActive = Boolean(
      policyPrecheck.pivotPrompt
      || oaiEditMissGuard?.active
      || oaiForceReadRecovery
      || oaiNeedsStateReground
      || (oaiSensemakingDecision && oaiSensemakingDecision.responseLevel !== "allow"),
    );
    modelMessages = applyRouteAdapterPivot({
      surface: "openai",
      adapter,
      sessionKey,
      requestId: oaiTraceReqId,
      modelMessages: modelMessages as Array<{ role: string; content?: unknown }>,
      normalizedMessages: normalizedRequest.messages as Array<{ role: string; content: unknown }>,
      recentCalls: oaiRecentCallsForSteering,
      recentUserPrompt: oaiTaskCue,
      governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      toolLoopSteeringEnabled: adapterUsesToolLoopSteering(adapter.family),
      governanceRecoveryActive: oaiGovernanceRecoveryActive,
      harnessTelemetryEnabled: config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED,
      skipTelemetry: {
          policy_pivot: Boolean(policyPrecheck.pivotPrompt),
          edit_miss_guard: Boolean(oaiEditMissGuard?.active),
          force_read_recovery: oaiForceReadRecovery,
          state_confidence_reground: oaiNeedsStateReground,
          governor_soft_fail_pause: Boolean(oaiSensemakingDecision?.shouldPause),
      },
      cooldownTurns: config.SYNESIS_YARN_QWEN_RESUME_NUDGE_COOLDOWN_TURNS,
      stagnationWindow: config.SYNESIS_YARN_QWEN_STAGNATION_WINDOW,
      stagnationThreshold: config.SYNESIS_YARN_QWEN_STAGNATION_THRESHOLD,
      planNoActionLimit: config.SYNESIS_YARN_QWEN_PLAN_NO_ACTION_LIMIT,
      editRetryLimit: config.SYNESIS_YARN_QWEN_EDIT_RETRY_LIMIT,
      dampeningLogEvent: "adapter_dampening_oai",
      logger: app.log,
      appendSystemMessageAndNormalize: (messagesToAppend, content) => appendSystemMessageAndNormalize(
        messagesToAppend,
        content,
      ) as typeof messagesToAppend,
      recordSessionEvent: oaiRoutePersistence.recordSessionEvent,
    }).modelMessages as typeof modelMessages;

    modelMessages = normalizeSystemMessageOrdering(modelMessages as Array<{ role: string }>) as typeof modelMessages;

    const resolvedTierConfig = tierRegistry.getTierConfig(resolved.resolvedModelId);
    const oaiProviderRequestOptions = buildOpenAIChatProviderRequestOptions({
      request,
      tierSamplingDefaults: resolvedTierConfig?.samplingDefaults,
      adapterProviderOptions: adapter.providerOptions?.() as Record<string, Record<string, unknown>> | undefined,
      adapterSampling: adapter.defaultSamplingParams?.(),
      supportsTopK: adapter.family !== "minimax",
    });
    const oaiSamplingOptions = oaiProviderRequestOptions.samplingOptions;
    const oaiStructuredOutput = oaiProviderRequestOptions.structuredOutput;
    let oaiProviderOptions = oaiProviderRequestOptions.providerOptions;
    const oaiThinkingToolChoiceGuard = suppressThinkingWhenRequiredToolChoice(
      oaiProviderOptions,
      effectiveToolChoice as PhaseAwareToolChoice | undefined,
    );
    oaiProviderOptions = oaiThinkingToolChoiceGuard.providerOptions;
    if (oaiThinkingToolChoiceGuard.suppressed) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "phase_required_tool_choice_thinking_guard",
        "execution-governor",
        "Suppressed thinking because tool_choice=required is incompatible with provider thinking mode.",
        reqId,
        {
          path: "openai",
          phase: oaiGovernorPhase,
          phase_reason: oaiPhasePolicy.reason ?? null,
        },
      );
    }
    const oaiAdmissionResult = runRouteContextAdmission({
      surface: "openai",
      messages: modelMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>,
      tools: effectiveTools as unknown[],
      sessionKey,
      logRequestId: reqId,
      metadata: session.record.metadata,
      chatState: oaiChatState,
      fileState: oaiFileState,
      artifactStore,
      contextBudgetEnabled: config.SYNESIS_YARN_CONTEXT_BUDGET_ENABLED,
      modelContextCeilingTokens: resolvedTierConfig?.contextCeilingTokens,
      budgetCeilingTokens: config.SYNESIS_YARN_CONTEXT_BUDGET_CEILING_TOKENS,
      outputReserveTokens: config.SYNESIS_YARN_CONTEXT_BUDGET_OUTPUT_RESERVE,
      admissionMode: config.SYNESIS_YARN_CONTEXT_ADMISSION_MODE,
      admissionWarnTokens: config.SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS,
      admissionHardTokens: config.SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS,
      compactionMode: oaiCachePolicy.compactionMode,
      cachePolicyRecord: cachePolicyLogRecord(oaiCachePolicy),
      upperHarnessContext: oaiUpperHarness,
      upperHarnessCeilingTokens: oaiResolvedTierForHarness?.contextCeilingTokens,
      stats: contextAdmissionStats,
      backendModelHint: oaiCompactionOpts.backendModelHint,
      transcriptPruning,
      logger: app.log,
      recordSessionEvent: oaiRoutePersistence.recordSessionEvent,
      recordUpperHarnessDecision: (label, decision, options) =>
        recordUpperHarnessDecision(sessionKey, identity.userId, identity.orgId, reqId, label, decision, options),
      forceCheckpoint: () => { void forceCheckpoint(session); },
    });
    modelMessages = oaiAdmissionResult.messages as typeof modelMessages;
    const oaiContextAdmission = oaiAdmissionResult.contextAdmission;
    if (oaiAdmissionResult.rejected) {
      return sendOpenAIChatPipelineResult(reply, {
        kind: "error",
        statusCode: 400,
        body: {
          error: {
            type: "invalid_request_error",
            message: admissionErrorMessage(oaiContextAdmission),
          },
          context_admission: {
            decision: oaiContextAdmission.decision,
            estimated_tokens: oaiContextAdmission.estimatedTokens,
            estimated_chars: oaiContextAdmission.estimatedChars,
            reason: oaiContextAdmission.reason,
          },
        },
      });
    }
    const oaiCacheShapeDiagnostics = buildCacheShapeDiagnostics({
      messages: modelMessages as Array<{ role?: string; content?: unknown }>,
      tools: effectiveTools as unknown[],
      providerOptions: oaiProviderOptions,
    });
    oaiOptLedger.recordCacheDiagnostics(oaiCacheShapeDiagnostics);

    const oaiTelemetryRouteBase = createOpenAIChatRouteTelemetryBase({
      clientRequestedModel: request.model,
      reductions: {
        toolResultReduction,
        validationNormalization,
      },
      reducedToolResults: reducedOpenAI.reducedCount,
      orchestration,
      policyMatchedRules: policyPrecheck.matchedRules,
      evidencePrefetched: oaiEvidencePrefetched,
      evidenceConfidence: combinedEvidenceConfidence || undefined,
      evidenceAuthoritative: oaiPrefetchResult?.authoritative,
      evidencePrefetchLatencyMs: oaiPrefetchResult ? Math.round(oaiPrefetchResult.latencyMs) : undefined,
      evidenceQuality: buildEvidenceTraceSummary(oaiPrefetchResult, oaiPatternResult),
      sensemakingTriggered: oaiSensemakingResult?.triggered,
      sensemakingReason: oaiSensemakingResult?.reason,
      governorDecision: oaiExecutionGovernor,
      governorChatStateSummary: oaiPauseChatSummary,
      governorFileStateSummary: oaiPauseFileSummary,
      normalizedMessages: normalizedRequest.messages as Array<{ role: string; content: unknown }>,
      inferVerificationSteps,
      trajectoryDiagnostics: oaiTrajectoryDiagnostics,
      toolDefinitionCount: effectiveTools.length,
      artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
      knowledgeToolInjected: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
      promptProfileIds: oaiEnriched.promptProfileIds,
      promptProfileHashes: oaiEnriched.promptProfileHashes,
      prefixHash: oaiEnriched.prefixHash,
      prefixChangeReasons: oaiEnriched.prefixChangeReasons,
      requirementChecklistMust: oaiRequirementChecklist?.must.length || undefined,
      requirementChecklistShould: oaiRequirementChecklist?.should.length || undefined,
      contextAdmission: {
        decision: oaiContextAdmission.decision,
        reason: oaiContextAdmission.reason,
        estimatedTokens: oaiContextAdmission.estimatedTokens,
        estimatedChars: oaiContextAdmission.estimatedChars,
      },
      cacheShapeDiagnostics: oaiCacheShapeDiagnostics,
      countMessageRoles,
      pushDiagnostic: (diagnostic) => pushDiagnostic(diagnostic as unknown as RequestDiagnostic),
    });
    const oaiFinalizerRouteBase = createOpenAIChatRouteFinalizerBase({
      session,
      checklist: oaiRequirementChecklist,
      traceRootPrompt: getMetadataString(session.record.metadata, "trace_root_prompt"),
      latestUserPrompt: getMetadataString(session.record.metadata, "latest_user_prompt"),
      verification: oaiVerificationAssessment,
      recentToolNames: extractRecentToolNames(normalizedRequest.messages as Array<{ role: string; content: unknown }>),
      planGraph: oaiPlanGraph,
      responseStyleMode: config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
      applyMarkdownGuardrail,
      finalizeCompletionText,
    });
    const persistOaiDecisionTelemetry = oaiRoutePersistence.persistDecisionTelemetry;
    const oaiToolHandlingRouteBase = createOpenAIChatRouteToolHandlingBase({
      adapter,
      clientKind: oaiClientKind,
      effectiveTools: effectiveTools as unknown[],
      strictGovernance: openClawStrictGovernance,
      upperHarness: oaiUpperHarness,
      recentToolNames: oaiRecentCallsForSteering.map((call) => call.toolName),
      taskCue: oaiTaskCue,
      planModeRequested: oaiClientToolCapabilities.planModeRequested,
      sensemakingRestrictDiscovery: oaiSensemakingDecision?.shouldRestrictDiscovery,
      pathContext: effectiveOaiPathCtx,
      enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
      blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
      pathSandboxEnabled: config.SYNESIS_YARN_PATH_SANDBOX_ENABLED,
      artifactShadows: oaiArtifactShadows,
      normalizedMessageCount: (normalizedOpenAI.messages as Array<{ role: string }>).length,
      session,
      stats: toolArgHardeningStats,
      logger: app.log,
      isWriteCapableToolName,
      shouldRestrictDiscoveryForPlanWork,
      deserializePlanShadow: deserializeShadow,
      buildPathSandboxPolicy: buildDefaultPolicy,
    });
    endOaiProviderRequestStage();

    if (!normalizedRequest.stream) {
      const started = Date.now();
      const oaiNonStreamScope = createOpenAINonStreamRouteScope({
        sessionKey,
        userId: identity.userId,
        orgId: identity.orgId,
        requestId: reqId,
        recordSessionEvent,
        persistDecisionTelemetry: persistOaiDecisionTelemetry,
      });
      const nonStreamResult = await runOpenAIChatNonStreamPipeline(createOpenAIChatNonStreamRoutePipelineInput({
        scope: oaiNonStreamScope,
        resolvedModelId: resolved.resolvedModelId,
        circuitBreakers,
        logger: app.log,
        startSpan: () => getTracer().startSpan("yarn.openai.generate", { model: resolved.resolvedModelId, sessionKey }),
        extractUpstreamErrorDiagnostics,
        onMissingToolResults: () => {
          session.skipToolIdStabilization = true;
        },
        stageTelemetry: oaiOptLedger,
        providerRouteInput: {
          scope: oaiNonStreamScope,
          resolvedModelId: resolved.resolvedModelId,
          initialMessages: modelMessages,
          model: resolved.model,
          orchestrationMaxOutputTokens: orchestration.maxOutputTokens,
          requestMaxTokens: request.max_tokens ?? request.max_completion_tokens ?? 0,
          output: oaiStructuredOutput,
          samplingOptions: oaiSamplingOptions,
          tools: sdkTools,
          initialToolChoice: effectiveToolChoice as PhaseAwareToolChoice | undefined,
          providerOptions: oaiProviderOptions,
          phasePolicy: oaiPhasePolicy,
          governorPhase: oaiGovernorPhase,
          clampMaxOutputTokens: clampMaxOutputTokensForSafety,
          generateText: (options) => generateText(options as never),
          readUsage,
          forensics: createOpenAINonStreamProviderForensics({
            path: "/v1/chat/completions",
            stream: false,
            tools: effectiveTools as unknown[],
            phasePolicy: oaiForensicsPhasePolicy,
            capabilityMatrix: oaiForensicsCapabilityMatrix,
            captureRequestForensics,
            finalizeRequestForensics: (forensics, usage) => finalizeRequestForensics(session, reqId, forensics, usage),
          }),
          serverSideToolResolvers: createOpenAINonStreamServerSideToolResolvers({
            artifactToolName: ARTIFACT_TOOL_NAME,
            knowledgeToolName: KNOWLEDGE_TOOL_NAME,
            devDocsToolName: DEV_DOCS_TOOL_NAME,
            webSearchToolName: WEB_SEARCH_TOOL_NAME,
            webSearchToolAlias: WEB_SEARCH_TOOL_ALIAS,
            retrieveArtifact: (handle, query) => artifactRetrieval.retrieve(handle, query),
            resolveKnowledge: (input) => knowledgeSearch.resolve(input, knowledgeResolveContext(authUser, req)),
            resolveDevDocs: (input) => knowledgeSearch.resolveDevDocs(input, knowledgeResolveContext(authUser, req)),
            resolveWebSearch: (input) => webSearch.resolve(
              input,
              webSearchResolveContext(authUser, req, {
                requestId: reqId,
                sessionKey,
                conversationId: session.record.conversationId || undefined,
                traceId: reqId,
                sourceSurface: "yarn_chat",
                toolName: WEB_SEARCH_TOOL_NAME,
              }),
            ),
          }),
        },
        getTopLevelDirs: () => getCachedTopLevelDirs(effectiveOaiPathCtx.projectRoot ?? effectiveOaiPathCtx.shellCwd),
        postprocessRouteInput: {
          scope: oaiNonStreamScope,
          responseModel: resolved.resolvedModelId,
          readUsage,
          applyDiscoveryGuardrail: applyDiscoveryToolGuardrail,
          toolCallInput: {
            artifactToolName: ARTIFACT_TOOL_NAME,
            ...oaiToolHandlingRouteBase,
            strictGovernanceStats: openClawProfileStats,
            recordUpperHarnessDecision,
            updateDiffAccumulator,
            maybeUpdateTaskLedgerFromToolCall,
            emitPlanWriteAuditEvent,
            maybeLogEnvelopeUnwrapSample,
          },
          discoveryInput: createOpenAINonStreamDiscoveryRouteInput({
            projectRoot: effectiveOaiPathCtx.projectRoot,
            buildBlockedDiscoveryRecovery: buildBlockedDiscoveryRecoverySnapshot,
            recordBlockedDiscovery,
            getBlockedDiscoveryCount,
          }),
          collapseInput: createOpenAINonStreamCollapseRouteInput({
            enabled: config.SYNESIS_YARN_TOOL_COLLAPSE_ENABLED,
            rewriteNonStream: config.SYNESIS_YARN_TOOL_COLLAPSE_REWRITE_NON_STREAM,
            collapseHeader: req.headers["x-synesis-tool-collapse"],
            headers: req.headers as Record<string, string | string[] | undefined>,
            bodyMetadata: oaiBodyMeta,
            shellAllowlistEnv: config.SYNESIS_YARN_TOOL_COLLAPSE_SHELL_ALLOWLIST,
            dedupeLayer: yarnDedupeLayer,
            toolPrefixCache: yarnToolPrefixCache,
            logger: app.log,
            requestId: reqId,
          }),
          finalizerInput: oaiFinalizerRouteBase,
          telemetryInput: {
            startedAtMs: started,
            ...oaiTelemetryRouteBase,
            escalated: orchestration.escalated,
            diagnosticEvidencePrefetchHit: oaiPrefetchResult?.matched && (oaiPrefetchResult?.confidence ?? 0) > 0 || undefined,
            optimizationLedger: oaiOptLedger,
            logOptimizationLedger: (record) => app.log.info({ reqId, ...record }, "optimization_ledger"),
          },
          responseInput: {
            effectiveTools: effectiveTools as unknown[],
            clientKind: oaiClientKind,
          },
        },
      }));
      applyClarificationRoundResponseHeader(reply, session.record.metadata);
      return sendOpenAIChatPipelineResult(reply, nonStreamResult);
    }

    const oaiStreamGateScope = {
      sessionKey,
      userId: identity.userId,
      orgId: identity.orgId,
      requestId: reqId,
    };
    const {
      planModeRequested: oaiStreamPlanModeRequested,
      ...oaiStreamToolHandlingRouteBase
    } = oaiToolHandlingRouteBase;
    const streamResult = await runOpenAIChatStreamPipeline({
      scope: oaiStreamGateScope,
      resolvedModelId: resolved.resolvedModelId,
      recordSessionEvent,
      stageTelemetry: oaiOptLedger,
      start: {
        logger: app.log,
        streamAdmission,
        circuitBreakers,
        startSpan: (name, attributes) => getTracer().startSpan(name, attributes),
      },
      provider: {
        path: "/v1/chat/completions (stream)",
        providerModel: resolved.model,
        messages: modelMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }>,
        effectiveTools: effectiveTools as unknown[],
        sdkTools,
        toolChoice: effectiveToolChoice,
        providerOptions: oaiProviderOptions,
        output: oaiStructuredOutput,
        samplingOptions: oaiSamplingOptions,
        orchestrationMaxOutputTokens: orchestration.maxOutputTokens,
        requestMaxTokens: request.max_tokens,
        requestMaxCompletionTokens: request.max_completion_tokens,
        adapter,
        debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
        longWaitEventMs: config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS,
        hardTimeoutMs: config.SYNESIS_YARN_SSE_STREAM_HARD_TIMEOUT_MS,
        phasePolicy: oaiForensicsPhasePolicy,
        capabilityMatrix: oaiForensicsCapabilityMatrix,
        logger: app.log,
        clampMaxOutputTokens: clampMaxOutputTokensForSafety,
        captureForensics: captureRequestForensics,
        streamText: (options) => streamText(options as never),
      },
      runtime: {
        raw: reply.raw,
        headers: sseHeadersWithClarification(session.record.metadata),
        tierConfig: tierRegistry.getTierConfig(resolved.resolvedModelId),
        write: safeWrite,
        computePrefixFingerprint,
        heartbeatIntervalMs: config.SYNESIS_YARN_SSE_HEARTBEAT_INTERVAL_MS,
        longWaitEventMs: config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS,
        startHeartbeat: startSseHeartbeat,
        session,
        circuitBreakers,
        logger: app.log,
        extractUpstreamErrorDiagnostics,
        adapter,
        stats: toolArgHardeningStats,
        recordBlockedDiscovery,
        getBlockedDiscoveryCount,
      },
      eventHandlers: {
        ...oaiStreamToolHandlingRouteBase,
        debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
        clientPlanModeRequested: oaiStreamPlanModeRequested,
        sideEffects: {
          updateDiffAccumulator,
          maybeUpdateTaskLedgerFromToolCall,
          emitPlanWriteAuditEvent,
          maybeLogEnvelopeUnwrapSample,
          recordUpperHarnessDecision,
        },
        strictGovernanceStats: openClawProfileStats,
        recordBlockedDiscovery,
        getTopLevelDirs: getCachedTopLevelDirs,
        applyDiscoveryGuardrail: applyDiscoveryToolGuardrail,
        buildBlockedDiscoveryRecovery: (blockedDetails) => buildBlockedDiscoveryRecoverySnapshot(
          resolved.resolvedModelId,
          blockedDetails,
          effectiveOaiPathCtx.projectRoot,
        ),
      },
      finalizer: {
        streamOptions: request.stream_options,
        readUsage,
        ...oaiFinalizerRouteBase,
        finalizePostStreamText,
        endStream: () => safeEnd(reply.raw),
      },
      telemetry: {
        routeBase: oaiTelemetryRouteBase,
        optimizationLedger: oaiOptLedger,
        finalizeRequestForensics: (usage, forensics) => finalizeRequestForensics(session, reqId, forensics, usage),
        persistDecisionTelemetry: ({ finishReason, telemetry }) => persistOaiDecisionTelemetry({
          ...telemetry,
          finishReason,
          escalated: orchestration.escalated,
        }),
        logOptimizationLedger: (record) => app.log.info({ reqId, ...record }, "optimization_ledger"),
      },
    });
    return sendOpenAIChatPipelineResult(reply, streamResult);
  });
}
