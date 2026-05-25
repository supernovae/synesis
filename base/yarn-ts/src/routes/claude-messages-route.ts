import type { ClaudeMessagesRouteDependencies } from "../index.js";

type AuthUser = import("../auth.js").AuthUser;
type FastPathResult = import("../evidence/fast-path.js").FastPathResult;
type PatternPrefetchResult = import("../evidence/fast-path.js").PatternPrefetchResult;
type GovernorInputMessage = import("../governance/execution-governor.js").GovernorInputMessage;
type PhaseAwareToolChoice = import("../governance/phase-execution-policy.js").PhaseAwareToolChoice;
type SensemakingDecision = import("../governance/sensemaking-governor.js").SensemakingDecision;
type SensemakingResult = import("../sensemaking/index.js").SensemakingResult;
type OpenAIChatCompletionRequest = import("../schemas.js").OpenAIChatCompletionRequest;
type ClaudeMessagesRequest = import("../schemas.js").ClaudeMessagesRequest;
type ReduceMessagesOpts = import("../reduction/tool-result-reducer.js").ReduceMessagesOpts;
type RequestDiagnostic = import("../telemetry/request-diagnostics.js").RequestDiagnostic;
type RequestForensicsRecord = import("../telemetry/request-forensics.js").RequestForensicsRecord;
type SessionPathHints = import("../state/workspace-session-boundary.js").SessionPathHints;
type WorkflowPhase = import("../orchestration/phase-model-orchestrator.js").WorkflowPhase;

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

export function registerClaudeMessagesRoute(deps: ClaudeMessagesRouteDependencies): void {
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
    extractUpstreamErrorDiagnostics,
    finalizeCompletionText,
    finalizePostStreamText,
    findPreferredReadToolName,
    getSessionKey,
    getSessionState,
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
    updateDiffAccumulator,
    adapterUsesToolLoopSteering,
    admissionErrorMessage,
    analyzeRecentCommandLoop,
    annotatePlanFileReads,
    annotateVerificationGaps,
    app,
    appendPathContextToAdapterBlock,
    appendSystemMessageAndNormalize,
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
    applyToolSearchPolicy,
    applyWorkspaceBoundary,
    applyWorkspaceMetadataPrebackfill,
    assembleRouteModelMessages,
    assessProportionality,
    assessStateConfidence,
    assessVerificationSignals,
    authResolver,
    buildArtifactShadows,
    buildBlockedDiscoveryRecoverySnapshot,
    buildCacheShapeDiagnostics,
    buildClaudeMessagesProviderRequestOptions,
    buildClaudeNonStreamMessageResponse,
    buildDecisionSnapshot,
    buildDefaultPolicy,
    buildEvidenceTraceSummary,
    buildExecutionGovernorHardStopUserMessage,
    buildExecutionGovernorPauseEnvelope,
    buildGovernorPauseResumeBlockForUser,
    buildProtocolSessionIdentity,
    buildRouteGovernanceBlocks,
    buildSensemakingGuidanceInjection,
    buildSensemakingPauseMessage,
    buildYarnUpperHarnessContext,
    cachePolicyLogRecord,
    cacheShapeDiagnosticFields,
    captureRequestForensics,
    casSessionSave,
    chatPhaseFromWorkflowPhase,
    clampMaxOutputTokensForSafety,
    classifyIntentScope,
    classifyLatestReadRefresh,
    classifyLatestToolProgress,
    classifyToolResultAsEvidence,
    ClaudeMessagesRequestSchema,
    claudeMessagesToOpenAI,
    claudeSystemToMessage,
    claudeToolsToSDK,
    clearGovernorPauseContextMetadata,
    clientAdapterPacks,
    collectToolExecutionFailureObservations,
    compareSensemakingWithLegacy,
    config,
    contextAdmissionStats,
    countMessageRoles,
    countTurnsSinceLastUser,
    createClaudeNonStreamRoutePipelineInput,
    createClaudeNonStreamRouteScope,
    createClaudeStreamRouteContext,
    createDiffStats,
    createRoutePersistenceScope,
    createRouteToolCallSideEffects,
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
    distributedCounters,
    enrichmentPool,
    enrichWithFrameAndManifest,
    ensureReadToolAvailabilityForEditMissGuard,
    evaluateCachePolicyForSession,
    evaluateExecutionGovernor,
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
    findLastUserPromptIdx,
    forceCheckpoint,
    formatEvidenceBlock,
    formatPatternBlock,
    formatStateConfidenceBlock,
    formatValidationError,
    generateText,
    getBlockedDiscoveryCount,
    getCachedTopLevelDirs,
    getChecklistSourceHash,
    getContentDedup,
    getFileSnapshotRegistry,
    getMemoryGovernor,
    getMetadataString,
    getSessionMemoryCount,
    getStructuralIndex,
    getTracer,
    governanceClient,
    GOVERNOR_COOLDOWN_MS,
    handleDeterministicPolicyPrecheck,
    hasClaudeNativeWebSearchTool,
    hashTextSignal,
    hasPersistedWorkspaceState,
    inferGovernorPhaseFromMessages,
    inferModelFamily,
    inferTrajectoryDiagnosticsFromMessages,
    inferVerificationSteps,
    injectGovernorRecoveryMessage,
    injectPlanModeRecoveryHint,
    injectSessionContext,
    isClaudeWebSearchToolName,
    isGenuineUserPromptMessage,
    isMatrixCapabilityEnabled,
    isOpenClawProfile,
    isPlanRecoveryDiscoveryIntent,
    knowledgeResolveContext,
    knowledgeSearch,
    lastToolUseIdFromClaudeMessages,
    loadUserRuntimePreferences,
    logAndPersistSafetyEvent,
    looksLikeFailureSignal,
    maybeBuildPlannerTodoPacketBlock,
    maybeUpdateTaskLedgerFromEvidence,
    mergeSessionPathHints,
    mergeSynesisClarificationFromRequestMetadata,
    normalizedToolOutputSignal,
    normalizeHistoricalContent,
    normalizeReadSnapshotMessages,
    normalizeSystemMessageOrdering,
    normalizeToolDescriptions,
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
    policyRejectClaudeBody,
    prepareClaudeStreamRoute,
    prepareProtocolPauseState,
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
    resolveCapabilityMatrix,
    resolveClaudeConversationId,
    resolveCompactionBackendModelHintFromRequestModel,
    resolveEndpointCapabilityId,
    resolveRequestId,
    resolveWorkingPhase,
    roleAssignmentRegistry,
    runClaudeNonStreamPipeline,
    runClaudeStreamKickoffPipeline,
    runClaudeStreamRouteFromInput,
    runEvidencePrefetch,
    runPatternPrefetch,
    runProtocolSessionBootstrap,
    runRouteContextAdmission,
    runSensemaking,
    runValidationTierCFallback,
    safeEnd,
    safeSse,
    sanitizeToolCalls,
    sendClaudeSoftFail,
    sendClaudeWorkspaceHandshake,
    sensemakingStats,
    serializeShadow,
    sessionPersistenceRunner,
    sessions,
    setSessionWorkspaceContext,
    shouldSampleBySeed,
    shouldStripGlobFromTools,
    sliceMessagesSinceLastUserPrompt,
    sortToolSchemas,
    sseHeadersWithClarification,
    stabilizeToolCallIds,
    startSseHeartbeat,
    streamText,
    stripGlobFromTools,
    summarizeArtifactContext,
    summarizeEvidenceDelta,
    suppressThinkingWhenRequiredToolChoice,
    TIER_TO_ROLE,
    tierRegistry,
    toClaudeServerWebSearchEvent,
    toolArgHardeningStats,
    toolResultReduction,
    toolSchemaPruningStats,
    toSessionExecutionContextSystemBlock,
    transcriptPruning,
    updatePlanGraph,
    updateTracePromptMetadata,
    userRateLimiter,
    validationNormalization,
    webSearch,
    webSearchResolveContext,
    withSpan,
    withSpanAsync,
    workingFrameService,
    workspaceStatePresence,
    yarnDedupeLayer,
  } = deps;

  // --- Claude Messages API ---
  app.post("/v1/messages", async (req, reply) => {
    let claudeAuthUser: AuthUser;
    try {
      claudeAuthUser = await authResolver.resolve(req.headers.authorization);
    } catch {
      return reply.code(401).send({
        type: "error",
        error: { type: "authentication_error", message: "Authentication required" }
      });
    }
    try {
      authResolver.requireCoderScope(claudeAuthUser);
    } catch {
      return reply.code(403).send({ type: "error", error: { type: "permission_error", message: "Insufficient scope" } });
    }
    const claudeFgaResult = await fgaCheck(`user:${claudeAuthUser.userId}`, "can_invoke", "yarn_endpoint", "messages");
    if (!claudeFgaResult.allowed) {
      return reply.code(403).send({ type: "error", error: { type: "permission_error", message: "Authorization denied by policy" } });
    }

    const claudeRateResult = await userRateLimiter.check(claudeAuthUser.userId);
    if (!claudeRateResult.allowed) {
      app.log.warn({ userId: claudeAuthUser.userId, count: claudeRateResult.currentCount, limit: claudeRateResult.limit }, "rate_limit_rejected_claude");
      recordSessionEvent("", claudeAuthUser.userId, claudeAuthUser.orgId, "rate_limit_reject", "user-rate-limiter",
        `${claudeRateResult.currentCount}/${claudeRateResult.limit} in window — retry after ${claudeRateResult.retryAfterSeconds}s`);
      reply.header("Retry-After", String(claudeRateResult.retryAfterSeconds));
      return reply.code(429).send({ type: "error", error: { type: "rate_limit_error", message: `Rate limit exceeded. Retry after ${claudeRateResult.retryAfterSeconds} seconds.` } });
    }

    const anthropicVersion = req.headers["anthropic-version"];
    if (!anthropicVersion || typeof anthropicVersion !== "string") {
      return reply.code(400).send({
        type: "error",
        error: { type: "invalid_request_error", message: "Missing required header: anthropic-version" }
      });
    }
    const traceReqId = resolveRequestId(req.headers as Record<string, unknown>);
    const normalizedIngress = normalizeToolDescriptions(req.body, "claude", "/v1/messages");
    for (const truncation of normalizedIngress.truncations) {
      app.log.warn({ reqId: traceReqId, ...truncation }, "tool_description_truncated");
    }
    const parsed = ClaudeMessagesRequestSchema.safeParse(normalizedIngress.body);
    if (!parsed.success) {
      return reply.code(400).send({
        type: "error",
        error: { type: "invalid_request_error", message: formatValidationError(parsed.error) }
      });
    }
    const body: ClaudeMessagesRequest = parsed.data;
    const claudeTaskCue = extractLatestUserPromptFromMessages(body.messages as Array<{ role: string; content: unknown }>);

    const claudeClientKind = String((req.headers["x-synesis-client"] as string | undefined) ?? "claude-code");
    const claudeConversationId = resolveClaudeConversationId(body.metadata, req.headers as Record<string, unknown>);
    const claudePeekWatermark = (() => {
      const existingKey = `${claudeAuthUser.userId}:${claudeConversationId}:${claudeClientKind}`;
      for (const [k, v] of sessions) {
        if (k.includes(existingKey) || (claudeConversationId && k.includes(claudeConversationId))) return v.pruningWatermark;
      }
      return undefined;
    })();
    const claudeCompactionOpts: ReduceMessagesOpts = {
      backendModelHint: resolveCompactionBackendModelHintFromRequestModel(body.model),
    };
    const claudeMatrixModelPath = String(claudeCompactionOpts.backendModelHint ?? body.model ?? "");
    const claudeMatrixModelId = String(body.model ?? claudeCompactionOpts.backendModelHint ?? "");
    const claudeMatrixFamily = inferModelFamily(claudeMatrixModelPath || claudeMatrixModelId);
    const claudeCapabilityResolution = resolveCapabilityMatrix(
      governanceClient?.getCapabilityMatrix() ?? null,
      {
        model_id: claudeMatrixModelId,
        model_path: claudeMatrixModelPath,
        family: claudeMatrixFamily,
      },
    );
    const claudeReducersEnabled = config.SYNESIS_YARN_REDUCERS_ENABLED && isMatrixCapabilityEnabled(
      config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      claudeCapabilityResolution.mode,
      claudeCapabilityResolution.resolved_capabilities,
      "yarn.reducers_enabled",
    );
    const claudeTranscriptPruneEnabled = isMatrixCapabilityEnabled(
      config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      claudeCapabilityResolution.mode,
      claudeCapabilityResolution.resolved_capabilities,
      "yarn.transcript_prune_enabled",
    );
    const claudePhasePolicyEnabledByMatrix = isMatrixCapabilityEnabled(
      config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      claudeCapabilityResolution.mode,
      claudeCapabilityResolution.resolved_capabilities,
      "yarn.phase_execution_policy_enabled",
    );
    const claudeJsonCompactionEnabled = isMatrixCapabilityEnabled(
      config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      claudeCapabilityResolution.mode,
      claudeCapabilityResolution.resolved_capabilities,
      "yarn.json_compaction_enabled",
    );
    const claudeContentDedupeEnabled = config.SYNESIS_YARN_DEDUPE_ENABLED && isMatrixCapabilityEnabled(
      config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      claudeCapabilityResolution.mode,
      claudeCapabilityResolution.resolved_capabilities,
      "yarn.content_dedupe_enabled",
    );
    const claudeResponseDedupeEnabled = config.SYNESIS_YARN_RESPONSE_DEDUPE_ENABLED && isMatrixCapabilityEnabled(
      config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      claudeCapabilityResolution.mode,
      claudeCapabilityResolution.resolved_capabilities,
      "yarn.response_dedupe_enabled",
    );
    const claudeHistoricalNormalizeEnabled = config.SYNESIS_YARN_HISTORICAL_NORMALIZE_ENABLED && isMatrixCapabilityEnabled(
      config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      claudeCapabilityResolution.mode,
      claudeCapabilityResolution.resolved_capabilities,
      "yarn.historical_normalize_enabled",
    );
    claudeCompactionOpts.jsonCompactionEnabled = claudeJsonCompactionEnabled;
    // Merge top-level `system` into the message list (parity with Anthropic SDK)
    const claudeSystemMsg = claudeSystemToMessage(body.system);
    const rawOpenAIMessages = withSpan("yarn.enrichment", { "yarn.path": "claude" }, () =>
      claudeMessagesToOpenAI(body.messages as never),
    );
    // Enforce Vercel tool protocol invariants (assistant tool_call -> tool_result adjacency/order)
    // on Claude-converted histories to prevent resume-time MissingToolResultsError class failures.
    const sanitizedOpenAIMessages = sanitizeToolCalls(rawOpenAIMessages as never);
    let openAIMessages = claudeSystemMsg ? [claudeSystemMsg, ...sanitizedOpenAIMessages] : sanitizedOpenAIMessages;
    if (config.SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES > 0 && !config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
      const claudeIngress = applyIngressCapToToolMessages(
        openAIMessages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>,
        config.SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES,
      );
      if (claudeIngress.cappedToolResults > 0) {
        openAIMessages = claudeIngress.messages as typeof openAIMessages;
        if (config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED) {
          app.log.info(
            {
              reqId: traceReqId,
              capped_tool_results: claudeIngress.cappedToolResults,
              bytes_reclaimed: claudeIngress.bytesReclaimed,
              max_bytes: config.SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES,
            },
            "yarn_harness_ingress_cap",
          );
        }
      }
    }

    // Tool-search policy: strip defer_loading / tool_reference in disable mode
    const toolSearchResult = applyToolSearchPolicy(
      body.tools as Array<Record<string, unknown>> | undefined,
      config.SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE
    );
    const processedTools = config.SYNESIS_YARN_SORTED_TOOLS_ENABLED
      ? sortToolSchemas(toolSearchResult.tools)
      : toolSearchResult.tools;

    const reducedClaude = config.SYNESIS_YARN_GOVERNANCE_DISABLED || !claudeReducersEnabled
      ? { messages: openAIMessages as never, reducedCount: 0 }
      : enrichmentPool.isAvailable()
        ? await withSpanAsync("yarn.enrichment", { "yarn.path": "claude" }, () =>
            toolResultReduction.reduceMessagesAsync(openAIMessages as never, enrichmentPool, claudeTaskCue, claudePeekWatermark, claudeCompactionOpts),
          )
        : withSpan("yarn.enrichment", { "yarn.path": "claude" }, () =>
            toolResultReduction.reduceMessages(openAIMessages as never, claudeTaskCue, claudePeekWatermark, claudeCompactionOpts),
          );
    const claudeToolResultCount = (openAIMessages as Array<{ role: string }>).filter((m) => m.role === "tool").length;
    if (config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED && reducedClaude.reducedCount > 0) {
      app.log.info(
        { reqId: traceReqId, tool_result_reduced: reducedClaude.reducedCount },
        "yarn_harness_tool_result_reduction",
      );
    }
    const normalizedFromClaude = await validationNormalization.normalizeMessagesAsync(
      reducedClaude.messages as never,
      runValidationTierCFallback,
    );
    if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED && claudeTranscriptPruneEnabled) {
      const prunedClaude = transcriptPruning.prune(
        normalizedFromClaude.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>,
        undefined,
        claudeCompactionOpts.backendModelHint,
      );
      if (prunedClaude.pruned) {
        normalizedFromClaude.messages = prunedClaude.messages as never;
      }
      if (config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED) {
        const cd = prunedClaude.invocationDelta;
        if (
          prunedClaude.pruned
          || cd.commandsDeduped > 0
          || cd.fileDeduped > 0
          || cd.toolResultsEvicted > 0
          || cd.assistantCondensed > 0
          || cd.nearDuplicatesCollapsed > 0
          || cd.artifactsStored > 0
        ) {
          app.log.info(
            { reqId: traceReqId, pruned: prunedClaude.pruned, transcript_prune: cd },
            "yarn_harness_transcript_prune",
          );
        }
      }
    }
    const claudeTrajectoryDiagnostics = inferTrajectoryDiagnosticsFromMessages(
      openAIMessages as Array<{ role: string; content: unknown }>,
    );
    const claudeVerificationAssessment = assessVerificationSignals(
      openAIMessages as Array<{ role: string; content: unknown; name?: string }>,
    );

    debugProtocolLog(app.log as never, traceReqId, "/v1/messages", {
      model: body.model,
      anthropicVersion: anthropicVersion,
      anthropicBeta: req.headers["anthropic-beta"] ?? null,
      messageCount: body.messages.length,
      hasSystem: !!body.system,
      hasTools: !!(body.tools as unknown[])?.length,
      hasThinking: !!body.thinking,
      stream: body.stream,
      toolSearchMode: config.SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE,
      toolSearchStripped: toolSearchResult.strippedDeferredCount,
    });

    const claudeAdapterProfile = clientAdapterPacks.resolve(
      String((req.headers["x-synesis-client"] as string | undefined) ?? "claude-code"),
      String((req.headers["x-synesis-mode"] as string | undefined) ?? "")
    );
    const claudeOpenClawStrictGovernance =
      config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED
      && config.SYNESIS_YARN_OPENCLAW_STRICT_GOVERNANCE_ENABLED
      && isOpenClawProfile(claudeAdapterProfile);
    if (isOpenClawProfile(claudeAdapterProfile)) {
      openClawProfileStats.requestsObserved += 1;
    }
    const claudePathCtx = parseSessionExecutionContext(
      req.headers as Record<string, string | string[] | undefined>,
      body.metadata ?? null,
    );
    const claudeAdapterBlock = appendPathContextToAdapterBlock(
      clientAdapterPacks.toSystemBlock(claudeAdapterProfile),
      req.headers as Record<string, string | string[] | undefined>,
      body.metadata ?? null,
      String((req.headers["x-synesis-client"] as string | undefined) ?? "claude-code"),
      { gitPolicyMode: config.SYNESIS_YARN_GIT_POLICY_MODE },
    );
    const latestClaudeUser = [...(normalizedFromClaude.messages as Array<{ role: string; content: unknown }>)].reverse().find((m) => m.role === "user");
    const claudeManifest = projectManifestService.build(normalizedFromClaude.messages as never);
    const claudeIdentity = buildProtocolSessionIdentity({
      authUser: claudeAuthUser,
      conversationId: claudeConversationId,
      clientKind: claudeClientKind,
    });
    const claudeBootstrap = await runProtocolSessionBootstrap({
      identity: claudeIdentity,
      authUser: claudeAuthUser,
      getSessionKey,
      getSessionState,
      applyAuthKeyAttribution,
      loadRuntimePreferences: loadUserRuntimePreferences,
      debugEnabled: config.SYNESIS_YARN_DEBUG_PROTOCOL,
      debugConversationSource: "metadata",
      debugFallbackSource: "fallback",
      debugLog: (record) => app.log.debug(record, "session_resolution"),
    });
    const claudeSessionKey = claudeBootstrap.sessionKey;
    const session = claudeBootstrap.session;
    const claudeRuntimePreferences = claudeBootstrap.runtimePreferences;
    const claudeClientToolCapabilities = detectClientToolCapabilities(
      processedTools as Array<{ name?: string; function?: { name?: string } }> | undefined,
      claudeClientKind,
      claudeTaskCue,
    );
    const detectedClaudeTaskCapabilities = detectClientTaskCapabilities(
      processedTools as Array<{ name?: string; function?: { name?: string } }> | undefined,
      claudeClientKind,
    );
    applySessionTaskCapabilities(session, detectedClaudeTaskCapabilities);
    const claudeCapabilityHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(claudeCapabilityResolution.resolved_capabilities)
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
      .digest("hex")
      .slice(0, 16);
    const claudeForensicsCapabilityMatrix: RequestForensicsRecord["capabilityMatrix"] = {
      mode: claudeCapabilityResolution.mode,
      globalOptimizationsEnabled: claudeCapabilityResolution.global_optimizations_enabled,
      modelId: claudeMatrixModelId,
      modelPath: claudeMatrixModelPath,
      family: claudeMatrixFamily,
      matchedOverrideIds: claudeCapabilityResolution.matched_override_ids,
      capabilityHash: claudeCapabilityHash,
    };
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "capability_matrix_resolution_v1",
      "capability-matrix",
      `mode=${claudeCapabilityResolution.mode} global=${claudeCapabilityResolution.global_optimizations_enabled ? "on" : "off"} matched=${claudeCapabilityResolution.matched_override_ids.join(",") || "none"}`,
      traceReqId,
      {
        mode: claudeCapabilityResolution.mode,
        global_optimizations_enabled: claudeCapabilityResolution.global_optimizations_enabled,
        model_id: claudeMatrixModelId,
        model_path: claudeMatrixModelPath,
        family: claudeMatrixFamily,
        matched_override_ids: claudeCapabilityResolution.matched_override_ids,
        matched_selectors: claudeCapabilityResolution.matched_selectors,
        capability_hash: claudeCapabilityHash,
        resolved_capabilities: claudeCapabilityResolution.resolved_capabilities,
      },
    );
    const claudeMsgCount = (body.messages as unknown[]).length;
    const claudeRecentExempt = Number(config.SYNESIS_YARN_TASK_PRUNING_RECENT_EXEMPT) || 0;
    session.pruningWatermark = Math.max(session.pruningWatermark, claudeMsgCount - claudeRecentExempt);
    // Claude protocol sends tool results as role:"user"/tool_result blocks.
    // Reset only on genuine user prompts that include text.
    const claudeLastMsg = Array.isArray(body.messages) && body.messages.length > 0
      ? (body.messages as Array<{ role?: string; content?: unknown }>)[body.messages.length - 1]
      : undefined;
    const claudeIsNewUserPrompt = isGenuineUserPromptMessage(claudeLastMsg);
    if (claudeIsNewUserPrompt) {
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
      session.blockBroadVerificationUntilEdit = false;
      session.blockFailingVerificationUntilEdit = false;
      session.governorPrePauseAttemptsByRule.clear();
      session.implementationSoftStallNudgeStrikes = 0;
      void distributedCounters.setConsecutiveToolCalls(claudeSessionKey, 0).catch((err) => { console.warn("[session] counter reset failed:", (err as Error).message ?? err); });
    }
    const claudeWorkspaceInspection = await applyWorkspaceBoundary({
      state: session,
      sessionKey: claudeSessionKey,
      identity: claudeIdentity,
      requestId: traceReqId,
      pathHints: claudePathCtx,
      readDir: async (root) => readdir(root, { withFileTypes: true }),
      hasPersistedState: hasPersistedWorkspaceState(session, workspaceStatePresence(claudeSessionKey)),
      resetWorkspaceState: resetWorkspaceScopedSessionState,
      recordSessionEvent,
    });
    {
      const readSnapshotRegistry = getFileSnapshotRegistry(claudeSessionKey);
      const readSnapshotNormalization = await normalizeReadSnapshotMessages(
        normalizedFromClaude.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown; tool_calls?: unknown }>,
        readSnapshotRegistry,
        {
          projectRoot: claudePathCtx.projectRoot ?? claudePathCtx.shellCwd ?? null,
          anchorDir: claudePathCtx.shellCwd ?? claudePathCtx.projectRoot ?? null,
          lastUserPromptIdx: findLastUserPromptIdx(normalizedFromClaude.messages as Array<{ role?: string; content?: unknown }>),
        },
      );
      if (readSnapshotNormalization.normalizedCount > 0) {
        normalizedFromClaude.messages = readSnapshotNormalization.messages as never;
        if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
          app.log.debug({
            reqId: traceReqId,
            normalized: readSnapshotNormalization.normalizedCount,
            replayed: readSnapshotNormalization.replayedCount,
            fallback: readSnapshotNormalization.fallbackCount,
          }, "read_snapshot_normalization_applied");
        }
      }
    }
    if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
      const claudeDedup = getContentDedup(claudeSessionKey);
      // Detect external (client-side) compaction: message count dropped significantly
      if (claudeContentDedupeEnabled && session.lastIncomingMessageCount > 0 && claudeMsgCount < session.lastIncomingMessageCount * 0.6) {
        claudeDedup.reset();
        getFileSnapshotRegistry(claudeSessionKey).markCompaction("SUMMARY_ONLY");
        recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "external_compaction_detected", "dedup_reset", `msgs ${session.lastIncomingMessageCount} -> ${claudeMsgCount}`);
      }
      session.lastIncomingMessageCount = claudeMsgCount;
      if (claudeContentDedupeEnabled) {
        const claudeDedupResult = claudeDedup.processMessages(
          normalizedFromClaude.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>,
        );
        if (claudeDedupResult.dedupCount > 0) {
          normalizedFromClaude.messages = claudeDedupResult.messages as never;
          const claudeMemTracker = getMemoryGovernor(claudeSessionKey);
          for (const p of claudeDedupResult.dedupPaths) {
            claudeMemTracker.trackFileRead(p);
            if (claudeDedup.getStructuralIndex()?.getFileSummary(p)) {
              claudeMemTracker.trackSummaryGenerated(p);
            }
          }
          if (claudeDedupResult.dedupPaths.length > 0 && config.SYNESIS_YARN_DEBUG_PROTOCOL) {
            app.log.debug({ reqId: traceReqId, dedupCount: claudeDedupResult.dedupCount, paths: claudeDedupResult.dedupPaths }, "content_dedup_applied");
          }
        }
      }
      if (claudeResponseDedupeEnabled && yarnDedupeLayer) {
        const claudeMsgs = normalizedFromClaude.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }>;
        let responseDedupHits = 0;
        for (let mi = 0; mi < claudeMsgs.length; mi++) {
          const m = claudeMsgs[mi];
          if (m.role !== "tool" || typeof m.content !== "string") continue;
          const toolName = m.name ?? "";
          let toolInput: unknown;
          if (m.tool_call_id) {
            for (let ai = mi - 1; ai >= 0; ai--) {
              const am = claudeMsgs[ai];
              if (am.role === "assistant" && am.tool_calls) {
                const match = am.tool_calls.find((tc) => tc.id === m.tool_call_id);
                if (match?.function?.arguments) {
                  try { toolInput = JSON.parse(match.function.arguments); } catch { toolInput = match.function.arguments; }
                  break;
                }
              }
            }
          }
          try {
            const wrapped = yarnDedupeLayer.responseDedupe.wrapToolResult(toolName, toolInput, m.content);
            if (wrapped !== m.content) {
              claudeMsgs[mi] = { ...m, content: wrapped };
              responseDedupHits += 1;
            }
          } catch (e) {
            app.log.warn({ reqId: traceReqId, err: (e as Error).message }, "response_dedupe_bypass");
          }
        }
        if (responseDedupHits > 0) {
          normalizedFromClaude.messages = claudeMsgs as never;
          if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
            app.log.debug({ reqId: traceReqId, hits: responseDedupHits }, "response_dedupe_applied");
          }
        }
      }
      if (claudeHistoricalNormalizeEnabled) {
        const histMsgs = normalizedFromClaude.messages as Array<{ role: string; tool_call_id?: string; content: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }>;
        const keepFromIdx = transcriptPruning.computeKeepFromIndex?.(histMsgs as never, claudeCompactionOpts.backendModelHint) ?? histMsgs.length;
        const histResult = normalizeHistoricalContent(histMsgs as never, keepFromIdx);
        if (histResult.stats.messagesNormalized > 0) {
          normalizedFromClaude.messages = histResult.messages as never;
        }
        if (!session.skipToolIdStabilization) {
          const idResult = stabilizeToolCallIds(normalizedFromClaude.messages as never, keepFromIdx);
          if (idResult.rewriteCount > 0) {
            normalizedFromClaude.messages = idResult.messages as never;
            if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
              app.log.debug({ reqId: traceReqId, rewrites: idResult.rewriteCount }, "tool_id_stabilization_applied");
            }
          }
        } else {
          app.log.warn({ reqId: traceReqId }, "tool_id_stabilization_skipped_after_missing_tool_results");
          session.skipToolIdStabilization = false;
        }
      }
      const claudePlanRemediation = remediatePlanFileStubs(normalizedFromClaude.messages as Array<{ role: string; content: unknown }>);
      if (claudePlanRemediation.remediatedCount > 0) {
        normalizedFromClaude.messages = claudePlanRemediation.messages as never;
        app.log.warn({ reqId: traceReqId, count: claudePlanRemediation.remediatedCount }, "plan_file_dedup_remediated");
      }
      const claudePlanAnnotation = annotatePlanFileReads(normalizedFromClaude.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>);
      if (claudePlanAnnotation.annotatedCount > 0) {
        normalizedFromClaude.messages = claudePlanAnnotation.messages as never;
        if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
          app.log.debug({ reqId: traceReqId, count: claudePlanAnnotation.annotatedCount }, "plan_file_read_annotated");
        }
      }
      if (claudePlanAnnotation.planFilePaths.length > 0) {
        session.record.metadata.plan_file_path = claudePlanAnnotation.planFilePaths[claudePlanAnnotation.planFilePaths.length - 1];
        const freshShadow = extractPlanContentShadow(
          normalizedFromClaude.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>,
          claudePlanAnnotation.planFilePaths,
        );
        if (freshShadow) {
          session.record.metadata.plan_content_shadow = serializeShadow(freshShadow) as unknown as Record<string, unknown>;
        }
      }
      const claudeVerifGaps = annotateVerificationGaps(normalizedFromClaude.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>);
      if (claudeVerifGaps.annotatedCount > 0) {
        normalizedFromClaude.messages = claudeVerifGaps.messages as never;
      }
      if (injectPlanModeRecoveryHint(normalizedFromClaude.messages as Array<{ role: string; content: unknown }>)) {
        app.log.info({ reqId: traceReqId }, "plan_mode_recovery_hint_injected");
      }
    }
    mergeSynesisClarificationFromRequestMetadata(session.record.metadata, body.metadata ?? undefined);
    const priorClaudeChecklistHash = getChecklistSourceHash(session.record.metadata);
    if (latestClaudeUser && typeof latestClaudeUser.content === "string") {
      updateTracePromptMetadata(session, latestClaudeUser.content);
    }
    const claudeRequirementChecklist = refreshRequirementChecklist(session);
    const claudeTaskIntake = refreshTaskIntake(session);
    const claudePlanGraph = updatePlanGraph(
      session,
      claudeTaskIntake,
      normalizedFromClaude.messages as Array<{ role: string; content: unknown }>,
      claudeVerificationAssessment.failingSignals,
    );
    const claudePromptIntake = evaluateYarnPromptIntakeSteer({
      enabled: config.SYNESIS_YARN_PROMPT_INTAKE_STEER_ENABLED && !config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      latestUserPrompt: claudeTaskCue,
      metadata: body.metadata ?? null,
      clientToolCapabilities: claudeClientToolCapabilities,
    });
    persistPromptIntakeSnapshot(session, claudePromptIntake);
    recordPromptIntakeEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      traceReqId,
      "claude",
      claudePromptIntake,
    );
    const claudePlannerTodoPacketBlock = await maybeBuildPlannerTodoPacketBlock({
      session,
      sessionKey: claudeSessionKey,
      identity: claudeIdentity,
      requestId: traceReqId,
      surface: "claude",
      latestUserPrompt: claudeTaskCue,
      promptIntake: claudePromptIntake,
      clientToolCapabilities: claudeClientToolCapabilities,
    });
    if (claudeRequirementChecklist && claudeRequirementChecklist.sourceHash !== priorClaudeChecklistHash) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "requirements_checklist",
        "completion-gate",
        `Checklist initialized (must=${claudeRequirementChecklist.must.length}, should=${claudeRequirementChecklist.should.length})`,
        traceReqId,
      );
    }
    const claudeTurnMessages = sliceMessagesSinceLastUserPrompt(
      normalizedFromClaude.messages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>,
    );
    const claudeToolFailures = collectToolExecutionFailureObservations(
      claudeTurnMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>,
    );
    const claudeEditMissGuard = deriveEditContextMissGuardState(
      claudeTurnMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>,
    );
    const claudeLatestToolProgress = classifyLatestToolProgress(
      claudeTurnMessages,
    );
    if (claudeLatestToolProgress.toolName && claudeLatestToolProgress.snippet) {
      const claudeEvidenceSignals = classifyToolResultAsEvidence(
        claudeLatestToolProgress.toolName,
        claudeLatestToolProgress.snippet,
        session.record.requestCount,
      );
      maybeUpdateTaskLedgerFromEvidence(session, claudeEvidenceSignals);
    }
    const claudeLatestReadRefresh = classifyLatestReadRefresh(
      claudeTurnMessages,
    );
    const claudeHadForceReadPending = session.editMissForceReadPending;
    if (claudeHadForceReadPending && claudeLatestReadRefresh.hasRecentReadSuccess) {
      session.editMissForceReadPending = false;
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "edit_context_miss_forced_read_satisfied",
        "execution-governor",
        `Forced read recovery satisfied via ${claudeLatestReadRefresh.toolName || "read"} ${claudeLatestReadRefresh.filePath || "<unknown file>"}`,
        traceReqId,
        {
          toolName: claudeLatestReadRefresh.toolName || null,
          toolCallId: claudeLatestReadRefresh.toolCallId || null,
          filePath: claudeLatestReadRefresh.filePath || null,
          snippet: claudeLatestReadRefresh.snippet || null,
        },
      );
    }
    for (const failure of claudeToolFailures) {
      const claudeFailureEventKind = failure.reason === "edit_already_applied"
        ? "client_tool_idempotent_observed"
        : "client_tool_error_observed";
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        claudeFailureEventKind,
        "tool-result-monitor",
        `tool=${failure.toolName} reason=${failure.reason} ${failure.snippet}`,
        traceReqId,
        {
          toolName: failure.toolName,
          toolCallId: failure.toolCallId || null,
          filePath: failure.filePath || null,
          reason: failure.reason,
          snippet: failure.snippet,
        },
      );
    }
    if (claudeEditMissGuard?.active) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "edit_context_miss_guard_active",
        "tool-result-monitor",
        `forcing_read_before_edit file=${claudeEditMissGuard.filePath} misses=${claudeEditMissGuard.missCount}`,
        traceReqId,
        {
          filePath: claudeEditMissGuard.filePath,
          missCount: claudeEditMissGuard.missCount,
        },
      );
    }
    const claudeEditMissFailureCount = claudeToolFailures.filter((failure) => failure.reason === "edit_context_miss").length;
    const claudeAnyWriteToolEditFailure = claudeToolFailures.some(
      (f) => f.reason === "edit_error"
        || f.reason === "edit_context_miss"
        || f.reason === "write_tool_error"
        || f.reason === "patch_apply_failed",
    );
    const claudeHasActiveEditMissFailure =
      claudeEditMissFailureCount > 0
      || claudeAnyWriteToolEditFailure
      || claudeLatestToolProgress.hasRecentEditContextMiss
      || claudeEditMissGuard?.active === true
      || session.editMissForceReadPending;
    if (claudeLatestToolProgress.hasRecentWriteSuccess && !claudeHasActiveEditMissFailure) {
      session.stagnantToolCycles = 0;
      session.lastToolSignalHash = "";
      session.consecutiveEditContextMisses = 0;
      session.editReplayHardStopGraceUsed = false;
      session.editMissForceReadPending = false;
    } else if (claudeEditMissFailureCount > 0) {
      session.consecutiveEditContextMisses += 1;
    } else if (claudeLatestToolProgress.hasRecentFailure) {
      session.consecutiveEditContextMisses = 0;
    }
    const claudeShouldArmForceReadRecovery =
      claudeLatestToolProgress.hasRecentEditContextMiss
      && (claudeEditMissFailureCount >= 1 || session.consecutiveEditContextMisses >= 1);
    if (claudeShouldArmForceReadRecovery) {
      if (!session.editMissForceReadPending) {
        recordSessionEvent(
          claudeSessionKey,
          claudeIdentity.userId,
          claudeIdentity.orgId,
          "edit_context_miss_forced_read_armed",
          "execution-governor",
          `Armed forced read recovery after edit misses (turn=${claudeEditMissFailureCount}, consecutive=${session.consecutiveEditContextMisses})`,
          traceReqId,
          {
            edit_miss_failures: claudeEditMissFailureCount,
            consecutive_turn_edit_miss_failures: session.consecutiveEditContextMisses,
          },
        );
      }
      session.editMissForceReadPending = true;
    }
    if (claudeLatestToolProgress.hasRecentWriteSuccess && !claudeHasActiveEditMissFailure && session.consecutiveRecoveryFires > 0) {
      session.consecutiveRecoveryFires = 0;
      session.governorPrePauseAttemptsByRule.clear();
      session.implementationSoftStallNudgeStrikes = 0;
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "execution_governor_recovery_reset",
        "execution-governor",
        `Recovery streak reset after successful ${claudeLatestToolProgress.toolName || "write"} tool result`,
        traceReqId,
        {
          toolName: claudeLatestToolProgress.toolName || null,
          toolCallId: claudeLatestToolProgress.toolCallId || null,
          snippet: claudeLatestToolProgress.snippet || null,
        },
      );
    }
    const claudeWorkspaceHandshakeAction = await processWorkspaceHandshakeRoute({
      protocol: "claude",
      session,
      sessionKey: claudeSessionKey,
      identity: claudeIdentity,
      requestId: traceReqId,
      pathContext: claudePathCtx,
      messages: body.messages as unknown[],
      tools: body.tools as unknown[] | undefined,
      saveSession: casSessionSave,
      recordSessionEvent,
    });
    if (claudeWorkspaceHandshakeAction.kind === "send") {
      return sendClaudeWorkspaceHandshake(reply, body.model, !!body.stream, claudeWorkspaceHandshakeAction.toolCallId);
    }
    let effectiveClaudePathCtx = mergeSessionPathHints(claudePathCtx, session);
    const buildEffectiveClaudeAdapterBlock = (pathCtx: SessionPathHints): string | undefined => {
      const ctxBlock = toSessionExecutionContextSystemBlock(pathCtx);
      if (!ctxBlock) return claudeAdapterBlock;
      return `${clientAdapterPacks.toSystemBlock(claudeAdapterProfile)}\n\n${ctxBlock}`;
    };
    let effectiveClaudeAdapterBlock = buildEffectiveClaudeAdapterBlock(effectiveClaudePathCtx);

    const claudeRecallDecision = toolResultReduction.getLastRecallDecision();
    const claudeVerifState = toolResultReduction.getVerificationTracker().getState();

    const claudePreFrame = config.SYNESIS_YARN_WORKING_FRAME_ENABLED
      ? workingFrameService.build(normalizedFromClaude.messages as never)
      : undefined;
    const claudeOrchestratorPhaseOverride = parseOrchestratorPhaseHeader(
      String(req.headers["x-synesis-orchestrator-phase"] ?? ""),
    );
    const claudeGovernorPreviewPhase = inferGovernorPhaseFromMessages(
      normalizedFromClaude.messages as Array<GovernorInputMessage>,
    );
    const claudeFramePhase = claudePreFrame ? phaseFromFrame(claudePreFrame.currentPhase) : undefined;
    const claudeWorkingPhase: WorkflowPhase | undefined = resolveWorkingPhase({
      orchestratorOverride: claudeOrchestratorPhaseOverride,
      framePhase: claudeFramePhase,
      governorPreviewPhase: claudeGovernorPreviewPhase,
    });
    const claudeWorkingFrameGoal: string | undefined = claudePreFrame?.goal;

    let claudePrefetchResult: FastPathResult | undefined;
    if (config.SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED && latestClaudeUser) {
      const claudePrefetchText = typeof latestClaudeUser.content === "string" ? latestClaudeUser.content : "";
      if (claudePrefetchText.length > 0) {
        claudePrefetchResult = await runEvidencePrefetch(
          claudePrefetchText, knowledgeSearch,
          config.SYNESIS_YARN_EVIDENCE_PREFETCH_TIMEOUT_MS,
          config.SYNESIS_YARN_EVIDENCE_CONFIDENCE_MIN,
          { retryEnabled: config.SYNESIS_YARN_EVIDENCE_PREFETCH_RETRY_ENABLED },
          knowledgeResolveContext(claudeAuthUser, req),
        );
        if (claudePrefetchResult.matched) {
          app.log.info({
            pattern: claudePrefetchResult.pattern, hasEvidence: Boolean(claudePrefetchResult.evidence),
            timedOut: claudePrefetchResult.timedOut, latencyMs: Math.round(claudePrefetchResult.latencyMs),
            confidence: claudePrefetchResult.confidence, authoritative: claudePrefetchResult.authoritative,
          }, "evidence_prefetch_result_claude");
        }
      }
    }

    let claudePatternResult: PatternPrefetchResult | undefined;
    if (config.SYNESIS_YARN_PATTERN_RECALL_ENABLED && latestClaudeUser && !claudePrefetchResult?.matched) {
      const claudePatternText = typeof latestClaudeUser.content === "string" ? latestClaudeUser.content : "";
      if (claudePatternText.length > 0) {
        claudePatternResult = await runPatternPrefetch(
          claudePatternText, knowledgeSearch,
          config.SYNESIS_YARN_EVIDENCE_PREFETCH_TIMEOUT_MS,
          claudeWorkingPhase,
          knowledgeResolveContext(claudeAuthUser, req),
        );
      }
    }

    const claudeCombinedConfidence = Math.max(
      claudePrefetchResult?.confidence ?? 0,
      claudePatternResult?.confidence ?? 0,
    );

    const claudeOrchestration = phaseOrchestrator.decide({
      requestedModel: body.model,
      modelSelectionMode: config.SYNESIS_YARN_GOVERNANCE_DISABLED ? "lock" : config.SYNESIS_YARN_MODEL_SELECTION_MODE,
      latestUserText: String(latestClaudeUser?.content ?? ""),
      workingPhase: claudeWorkingPhase,
      planningUseHorizon: config.SYNESIS_YARN_PLANNING_USE_HORIZON,
      riskProfile: claudeManifest.riskProfile,
      decisionMatrixEnabled: config.SYNESIS_YARN_DECISION_MATRIX_ENABLED,
      evidence: {
        recallConfidence: claudeRecallDecision?.resolution?.confidence,
        recallRouting: claudeRecallDecision?.routing,
        evidenceConfidence: claudeCombinedConfidence || undefined,
        evidenceAuthoritative: claudePrefetchResult?.authoritative,
        verificationRound: claudeVerifState.round > 0 ? claudeVerifState.round : undefined,
        verificationStalled: claudeVerifState.stalled || undefined,
        consecutiveFailedVerifications: session.record.consecutiveFailedVerifications,
      },
    }, claudeSessionKey);
    if (claudeOrchestration.escalated) {
      session.record.escalationCount += 1;
    }
    session.record.lastTier = claudeOrchestration.tier;
    pinchCompactionBackendModelMetadata(session, claudeOrchestration.tier, body.model);

    const claudeEvidencePrefetched = Boolean(
      claudePrefetchResult?.matched
      || claudePatternResult?.matched,
    );
    let claudeSensemakingResult: SensemakingResult | undefined;
    let claudeSensemakingBlock: string | null = null;
    if (config.SYNESIS_YARN_SENSEMAKING_ENABLED) {
      const claudeSm = runSensemaking({
        config,
        messages: normalizedFromClaude.messages as Array<{ role: string; content: unknown }>,
        getLanguages: detectLanguagesFromMessages,
        orchestration: claudeOrchestration,
        recallDecision: claudeRecallDecision,
        verificationState: claudeVerifState,
        evidencePrefetched: claudeEvidencePrefetched,
        evidenceConfidence: claudeCombinedConfidence,
        evidenceAuthoritative: claudePrefetchResult?.authoritative,
        userText: String(latestClaudeUser?.content ?? ""),
        workingFrameGoal: claudeWorkingFrameGoal,
        consecutiveFailedVerifications: session.record.consecutiveFailedVerifications,
      });
      claudeSensemakingResult = claudeSm.result;
      claudeSensemakingBlock = config.SYNESIS_YARN_SENSEMAKING_PROMPT_BLOCK_ENABLED
        ? (claudeSm.block || null)
        : null;
      applySensemakingStats(sensemakingStats, claudeSm.result, claudeSm.evaluated);
    }

    const claudeLastToolUseId = lastToolUseIdFromClaudeMessages(
      body.messages as Array<{ role: string; content: unknown }>,
    );
    const latestClaudeUserHash = hashTextSignal(latestClaudeUser?.content ?? "");
    const claudeUserIsRealAck = isGenuineUserPromptMessage(latestClaudeUser);
    if (session.awaitingToolLoopUserAck) {
      if (claudeUserIsRealAck && latestClaudeUserHash !== session.toolLoopAckAnchorUserHash) {
        session.awaitingToolLoopUserAck = false;
        session.toolLoopNoUserAckCount = 0;
        session.toolLoopAckAnchorUserHash = "";
        resetQwenInterventionOnUserTurn(claudeSessionKey);
      } else {
        session.toolLoopNoUserAckCount += 1;
      }
    }
    const claudeToolProgress = detectToolProgress(
      session,
      normalizedFromClaude.messages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string }; name?: string }> }>,
      {
        normalizeSignal: (content) => normalizedToolOutputSignal(content),
        looksLikeFailure: looksLikeFailureSignal,
      },
    );
    const claudeCommandLoop = analyzeRecentCommandLoop(
      normalizedFromClaude.messages as Array<ToolLoopMessage>,
    );
    const claudeArtifactShadows = buildArtifactShadows(
      getFileSnapshotRegistry(claudeSessionKey),
      session.artifactEditTurns,
    );
    const claudeArtifactContext = summarizeArtifactContext(claudeArtifactShadows);
    const claudeFileState = deriveFileState({
      registry: getFileSnapshotRegistry(claudeSessionKey),
      artifactShadows: claudeArtifactShadows,
      messages: normalizedFromClaude.messages as Array<{ role: string; content: unknown; name?: string }>,
    });
    const claudePersistedChatState = readPersistedChatStateSnapshot(session.record.metadata);
    const claudeChatState = deriveChatState(
      normalizedFromClaude.messages as Array<GovernorInputMessage>,
      {
        phaseHint: chatPhaseFromWorkflowPhase(claudeWorkingPhase),
        previousSnapshot: claudePersistedChatState,
      },
    );

    // Proportionality: classify intent scope from the latest user directive
    if (config.SYNESIS_YARN_PROPORTIONALITY_ENABLED && claudeChatState.pendingUserDirective) {
      const scopeClassification = classifyIntentScope(claudeChatState.pendingUserDirective);
      if (scopeClassification.envelope !== "unconstrained") {
        session.scopeEnvelope = scopeClassification.envelope;
        session.diffStats = createDiffStats();
      }
    }

    const claudeObjectiveScope = applyObjectiveScopeAndPersist({
      state: session,
      sessionKey: claudeSessionKey,
      requestId: traceReqId,
      userId: claudeIdentity.userId,
      orgId: claudeIdentity.orgId,
      messages: normalizedFromClaude.messages as Array<{
        role: string;
        content: unknown;
        name?: string;
        tool_call_id?: string;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown }; name?: string }>;
      }>,
      chatState: claudeChatState,
      fileState: claudeFileState,
      latestUserPromptText: latestClaudeUser ? extractTextFromUnknownContent(latestClaudeUser.content) : "",
    });
    const claudeScopedMessages = claudeObjectiveScope.scopedMessages;
    const claudeRawStateConfidence = assessStateConfidence({
      chatState: claudeChatState,
      fileState: claudeFileState,
      recentReadSatisfied: claudeLatestReadRefresh.hasRecentReadSuccess,
    });
    const claudeSuppressInstructionReground =
      claudeWorkspaceInspection.isEmpty
      && claudeWorkspaceInspection.projectInstructionFiles.length === 0
      && projectInstructionFilePresent(claudeRawStateConfidence.recommendedReadPath);
    const claudeStateConfidence = claudeSuppressInstructionReground
      ? {
          ...claudeRawStateConfidence,
          needsReground: false,
          recommendedReadPath: null,
          reasons: [...new Set([...claudeRawStateConfidence.reasons, "empty_workspace_project_guidance_absent"])],
        }
      : claudeRawStateConfidence;
    persistStateConfidence(session.record.metadata, claudeStateConfidence);
    const claudeStateConfidenceBlock = formatStateConfidenceBlock(claudeStateConfidence);
    if (session.regroundCooldownRemaining > 0) {
      session.regroundCooldownRemaining -= 1;
    }
    const claudeNeedsStateReground =
      claudeStateConfidence.needsReground
      && !claudeEditMissGuard?.active
      && !session.editMissForceReadPending
      && session.regroundCooldownRemaining <= 0;
    if (claudeNeedsStateReground) {
      session.regroundCooldownRemaining = 2;
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "state_confidence_reground_required",
        "state-confidence",
        `overall=${claudeStateConfidence.overallConfidence.toFixed(3)} path=${claudeStateConfidence.recommendedReadPath ?? "<none>"}`,
        traceReqId,
        {
          chat_confidence: claudeStateConfidence.chatConfidence,
          file_confidence: claudeStateConfidence.fileConfidence,
          overall_confidence: claudeStateConfidence.overallConfidence,
          recommended_read_path: claudeStateConfidence.recommendedReadPath,
          reasons: claudeStateConfidence.reasons,
        },
      );
    }
    const claudePauseState = prepareProtocolPauseState({
      metadata: session.record.metadata,
      chatState: claudeChatState,
      fileState: claudeFileState,
      taskLedger: session.taskLedger,
    });
    const claudePauseChatSummary = claudePauseState.pauseChatSummary;
    const claudePauseFileSummary = claudePauseState.pauseFileSummary;
    const claudePauseTaskContext = claudePauseState.pauseTaskContext;
    const claudeChatStateBlock = claudePauseState.chatStateBlock;
    const claudeFileStateBlock = claudePauseState.fileStateBlock;
    const claudeGovernorPauseResumeBlock = buildGovernorPauseResumeBlockForUser(
      session,
      typeof claudeTaskCue === "string" ? claudeTaskCue : "",
    );
    const claudeGovernorPauseSummaryRequested = Boolean(claudeGovernorPauseResumeBlock);
    const claudeGovernorCooldownActive =
      session.lastGovernorCachedResult
      && !session.lastGovernorCachedResult.pause
      && (Date.now() - session.lastGovernorNoPauseAt) < GOVERNOR_COOLDOWN_MS;
    let claudeExecutionGovernor = config.SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED && !config.SYNESIS_YARN_GOVERNANCE_DISABLED
      ? (claudeGovernorCooldownActive
        ? session.lastGovernorCachedResult!
        : withSpan("yarn.execution_governor.evaluate", {}, (govSpan) => {
          const decision = evaluateExecutionGovernor(
            claudeScopedMessages as Array<GovernorInputMessage>,
            {
              profile: config.SYNESIS_YARN_GOVERNANCE_PROFILE,
              activePlanStage: claudePlanGraph?.activeStage ?? null,
              editContextMissActive:
                claudeEditMissGuard?.active === true
                || claudeLatestToolProgress.hasRecentEditContextMiss
                || session.editMissForceReadPending
                || claudeToolFailures.some((failure) => failure.reason === "edit_context_miss"),
              artifactShadows: claudeArtifactShadows,
              chatState: claudeChatState,
              fileState: claudeFileState,
              orchestratorWorkflowPhase: claudeWorkingPhase,
              taskLedgerOpenCount: session.taskLedger
                ? session.taskLedger.tasks.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "unknown").length
                : undefined,
            },
          );
          if (!decision.pause) {
            session.lastGovernorNoPauseAt = Date.now();
            session.lastGovernorCachedResult = decision;
          } else {
            session.lastGovernorCachedResult = null;
          }
          if (claudeWorkingPhase) govSpan.setAttribute("governor.orchestrator_workflow_phase", claudeWorkingPhase);
          govSpan.setAttribute("governor.pause", decision.pause);
          govSpan.setAttribute("governor.reason", decision.reason ?? "");
          govSpan.setAttribute("governor.matched_rules", decision.matchedRules.join(","));
          govSpan.setAttribute("governor.phase", decision.telemetry.phase);
          govSpan.setAttribute("governor.trailing_verification_run", decision.telemetry.trailingVerificationRunLength);
          govSpan.setAttribute("governor.no_edit_evidence", decision.telemetry.noEditEvidence);
          return decision;
        }))
      : {
          pause: false,
          reason: "disabled",
          matchedRules: ["disabled"],
          telemetry: {
            phase: "edit" as const,
            repeatedTestCommands: 0,
            repeatedReadSearchCalls: 0,
            repeatedBroadDiscoveryCalls: 0,
            totalBroadDiscoveryCalls: 0,
            broadTestRepeat: false,
            noEditEvidence: false,
            trailingVerificationRunLength: 0,
          },
        };
    if (
      claudeExecutionGovernor.matchedRules.includes("verification_green_repeat_block")
      || claudeExecutionGovernor.matchedRules.includes("verification_already_green")
    ) {
      session.blockBroadVerificationUntilEdit = true;
    }
    if (
      session.consecutiveRecoveryFires >= 2
      && (
        claudeExecutionGovernor.matchedRules.includes("verification_fail_repeat_block")
        || claudeExecutionGovernor.matchedRules.includes("verification_same_failure_signature_replay")
        || claudeExecutionGovernor.matchedRules.includes("verification_churn_no_edit")
      )
    ) {
      session.blockFailingVerificationUntilEdit = true;
    }
    if (
      (claudeEditMissFailureCount >= 2 || session.consecutiveEditContextMisses >= 2)
      && !claudeExecutionGovernor.matchedRules.includes("edit_failure_replay")
    ) {
      claudeExecutionGovernor = {
        ...claudeExecutionGovernor,
        pause: true,
        reason: "edit_failure_replay",
        matchedRules: ["edit_failure_replay", ...new Set(claudeExecutionGovernor.matchedRules)],
        suggestedNextStep:
          claudeExecutionGovernor.suggestedNextStep
          ?? "Repeated edit anchor failures detected. Read the file once, choose an exact current anchor, and apply one focused edit. If the behavior is already present, verify and move on.",
      };
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "execution_governor_edit_miss_override",
        "execution-governor",
        `Forced edit_failure_replay (turn_misses=${claudeEditMissFailureCount}, consecutive_turn_misses=${session.consecutiveEditContextMisses})`,
        traceReqId,
        {
          edit_miss_failures: claudeEditMissFailureCount,
          consecutive_turn_edit_miss_failures: session.consecutiveEditContextMisses,
          matched_rules: claudeExecutionGovernor.matchedRules,
        },
      );
    }
    if (claudeGovernorPauseSummaryRequested && claudeExecutionGovernor.pause) {
      const priorRules = claudeExecutionGovernor.matchedRules;
      claudeExecutionGovernor = {
        ...claudeExecutionGovernor,
        pause: false,
        reason: "user_requested_governor_summary",
        matchedRules: ["user_requested_governor_summary"],
        suggestedNextStep: "Summarize current status without tool calls, edits, or command retries.",
      };
      session.lastGovernorCachedResult = null;
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "governor_pause_summary_resume",
        "execution-governor",
        `Allowed explicit summarize/status reply after pause (prior_rules=${priorRules.slice(0, 3).join(",") || "unknown"})`,
        traceReqId,
        {
          prior_matched_rules: priorRules,
          summary_resume: true,
        },
      );
    }
    const claudeLoopObs = deriveGovernorLoopObservability(
      claudeScopedMessages as Array<{ role: string; tool_calls?: unknown }>,
    );
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "execution_governor_evaluated",
      "execution-governor",
      `phase=${claudeExecutionGovernor.telemetry.phase} rules=${claudeExecutionGovernor.matchedRules.join(",") || "allow"} pause=${claudeExecutionGovernor.pause}`,
      traceReqId,
      {
        pause: claudeExecutionGovernor.pause,
        reason: claudeExecutionGovernor.reason,
        phase: claudeExecutionGovernor.telemetry.phase,
        matched_rules: claudeExecutionGovernor.matchedRules,
        suggested_next_step: claudeExecutionGovernor.suggestedNextStep?.slice(0, 200),
        has_run_test: claudeLoopObs.hasRunTest,
        last_assistant_tool_calls: claudeLoopObs.lastAssistantToolCalls,
        assistant_tool_calls_since_latest_user: claudeLoopObs.assistantToolCallsSinceLatestUser,
        objective_epoch_id: claudeObjectiveScope.epochId,
        objective_scope_boundary_index: claudeObjectiveScope.boundaryIndex,
        objective_scope_retained_evidence: claudeObjectiveScope.retainedEvidenceCount,
        objective_scope_dropped_pre_boundary: claudeObjectiveScope.droppedPreBoundaryCount,
        state_confidence_chat: claudeStateConfidence.chatConfidence,
        state_confidence_file: claudeStateConfidence.fileConfidence,
        state_confidence_overall: claudeStateConfidence.overallConfidence,
        state_confidence_needs_reground: claudeNeedsStateReground,
        state_confidence_recommended_path: claudeStateConfidence.recommendedReadPath,
        evidence_delta: summarizeEvidenceDelta(session.lastEvidenceDelta),
        artifact_context: claudeArtifactContext,
        chat_state_summary: claudePauseChatSummary,
        file_state_summary: claudePauseFileSummary,
        telemetry: claudeExecutionGovernor.telemetry,
      },
    );
    if (claudeExecutionGovernor.matchedRules.includes("discovery_churn_nudge")) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "discovery_churn_guard_nudge",
        "execution-governor",
        `Nudge-only discovery churn detected (explore_trail=${claudeExecutionGovernor.telemetry.trailingExplorationRunLength ?? 0}, repeated_reads=${claudeExecutionGovernor.telemetry.repeatedReadSearchCalls})`,
        traceReqId,
        {
          phase: claudeExecutionGovernor.telemetry.phase,
          matched_rules: claudeExecutionGovernor.matchedRules,
          trailing_exploration_run_length: claudeExecutionGovernor.telemetry.trailingExplorationRunLength ?? 0,
          repeated_read_search_calls: claudeExecutionGovernor.telemetry.repeatedReadSearchCalls,
          repeated_broad_discovery_calls: claudeExecutionGovernor.telemetry.repeatedBroadDiscoveryCalls,
          total_broad_discovery_calls: claudeExecutionGovernor.telemetry.totalBroadDiscoveryCalls,
          suggested_next_step: claudeExecutionGovernor.suggestedNextStep?.slice(0, 200),
        },
      );
    }

    // Sensemaking governor — primary decision-maker
    let claudeSensemakingDecision: SensemakingDecision | null = null;
    if (config.SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED && !config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
      const claudeGovEvents = extractCommandEvents(
        (claudeScopedMessages as GovernorInputMessage[]).slice(
          Math.max(0, (claudeScopedMessages as GovernorInputMessage[]).length - 50),
        ),
      );
      const claudeGovChangedFiles = extractEditedFileHints(claudeGovEvents);
      const claudePlanRecoveryGrace = isPlanRecoveryDiscoveryIntent(
        typeof claudeTaskCue === "string" ? claudeTaskCue : "",
      ) && claudeGovChangedFiles.length === 0 && claudeGovEvents.length <= 30;
      // Proportionality assessment
      const claudeProportionality = config.SYNESIS_YARN_PROPORTIONALITY_ENABLED
        ? assessProportionality(session.diffStats, session.scopeEnvelope)
        : null;
      const claudeProportionalitySignal = claudeProportionality
        ? proportionalityToSignal(claudeProportionality.level)
        : null;

      claudeSensemakingDecision = evaluateSensemakingGovernor(
        claudeExecutionGovernor,
        claudeGovEvents,
        countTurnsSinceLastUser(claudeScopedMessages as readonly { role: string }[]),
        claudeGovChangedFiles.length,
        claudePlanRecoveryGrace,
        null,
        claudeProportionalitySignal,
      );
      const smComparison = compareSensemakingWithLegacy(claudeExecutionGovernor, claudeSensemakingDecision);
      recordSessionEvent(
        claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId,
        "sensemaking_governor_evaluated",
        "sensemaking-governor",
        `domain=${claudeSensemakingDecision.domain} response=${claudeSensemakingDecision.responseLevel} friction=${smComparison.frictionScore} momentum=${smComparison.productiveMomentum} legacy_agreement=${smComparison.agreement}`,
        traceReqId,
        {
          ...smComparison,
          guidance: claudeSensemakingDecision.guidance?.slice(0, 200),
          shouldPause: claudeSensemakingDecision.shouldPause,
          shouldRestrictDiscovery: claudeSensemakingDecision.shouldRestrictDiscovery,
          planRecoveryGrace: claudePlanRecoveryGrace,
        },
      );
      if (claudeProportionality && claudeProportionality.level !== "proportional") {
        recordSessionEvent(
          claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId,
          "proportionality_check", "proportionality",
          `level=${claudeProportionality.level} scope=${session.scopeEnvelope} files=${session.diffStats.filesModified} deleted=${session.diffStats.filesDeleted} net_removed=${session.diffStats.netLinesRemoved} breaches=${claudeProportionality.breaches.join(";")}`,
          traceReqId,
          {
            level: claudeProportionality.level,
            scopeEnvelope: session.scopeEnvelope,
            filesModified: session.diffStats.filesModified,
            filesDeleted: session.diffStats.filesDeleted,
            netLinesRemoved: session.diffStats.netLinesRemoved,
            totalLinesChanged: session.diffStats.totalLinesChanged,
            breaches: claudeProportionality.breaches,
            signal: claudeProportionalitySignal,
          },
        );
      }
    }

    const claudeAggressiveRepeatGuard =
      (claudeCommandLoop.commandRepeatCount >= 2 && Boolean(claudeCommandLoop.failureSignatureHash))
      || claudeCommandLoop.broadDiscoveryRepeatCount >= 4;
    const claudeRepeatAwarePivot = claudeAggressiveRepeatGuard
      ? Math.max(3, Math.min(config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT, 6))
      : config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT;
    const claudeRepeatAwareHardReject = claudeAggressiveRepeatGuard
      ? Math.max(3, Math.min(config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER, 4))
      : config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER;
    const claudeLoopLimits = applyRuntimePreferenceLoopLimits({
      consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
      consecutiveToolCallsPivot: claudeRepeatAwarePivot,
      stagnantToolCyclesLimit: config.SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT,
      toolLoopNoUserAckHardLimit: config.SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT,
      hardRejectAfter: claudeRepeatAwareHardReject,
    }, claudeRuntimePreferences);
    const claudeDistToolCalls = await distributedCounters.getConsecutiveToolCalls(claudeSessionKey);
    if (claudeDistToolCalls !== null && claudeDistToolCalls !== session.consecutiveToolCalls) {
      session.consecutiveToolCalls = claudeDistToolCalls;
    }
    const claudePolicyPrecheck = withSpan("yarn.policy.evaluate", { "yarn.path": "claude" }, () => policyEngine.evaluate({
      tools: (body.tools as unknown[]) ?? [],
      repeatAttempt: {
        action: "claude_messages",
        args: {
          model: body.model,
          lastToolUseId: claudeLastToolUseId,
          messageCount: body.messages.length,
          latestUserHash: latestClaudeUserHash || "none",
          commandSignature: claudeCommandLoop.commandSignatureHash || "none",
          commandRepeatCount: claudeCommandLoop.commandRepeatCount,
          failureSignature: claudeCommandLoop.failureSignatureHash || "none",
        },
        fsFingerprint: claudeCommandLoop.commandSignatureHash
          ? `${claudeCommandLoop.commandSignatureHash}:${claudeCommandLoop.failureSignatureHash || "none"}:${latestClaudeUserHash || "none"}`
          : `${claudeLastToolUseId || "none"}:${body.messages.length}:${latestClaudeUserHash || "none"}`,
      },
      sessionKey: claudeSessionKey,
      sessionTokensIn: session.record.totalTokensIn,
      maxInputTokens: config.SYNESIS_YARN_SESSION_SOFT_MAX_INPUT_TOKENS,
      hardMaxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
      sessionBudgetMode: config.SYNESIS_YARN_SESSION_BUDGET_MODE,
      consecutiveToolCalls: session.consecutiveToolCalls,
      consecutiveToolCallsLimit: claudeLoopLimits.consecutiveToolCallsLimit,
      consecutiveToolCallsPivot: claudeLoopLimits.consecutiveToolCallsPivot,
      toolProgressState: claudeLatestToolProgress.hasRecentWriteSuccess
        ? "progress"
        : (claudeLatestToolProgress.hasRecentFailure ? "stagnant" : claudeToolProgress.state),
      stagnantToolCycles: claudeLatestToolProgress.hasRecentWriteSuccess
        ? 0
        : (claudeLatestToolProgress.hasRecentFailure ? Math.max(session.stagnantToolCycles, 1) : session.stagnantToolCycles),
      stagnantToolCyclesLimit: claudeLoopLimits.stagnantToolCyclesLimit,
      toolLoopNoUserAckCount: session.toolLoopNoUserAckCount,
      toolLoopNoUserAckHardLimit: claudeLoopLimits.toolLoopNoUserAckHardLimit,
      hardRejectAfter: claudeLoopLimits.hardRejectAfter,
      governanceRules: governanceClient?.getRules(),
    }));
    const claudePolicyAction = handleDeterministicPolicyPrecheck({
      decision: claudePolicyPrecheck,
      softFailEnabled: config.SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED,
      session,
      sessionKey: claudeSessionKey,
      identity: claudeIdentity,
      requestId: traceReqId,
      selectedModel: claudeOrchestration.selectedModel,
      originalModel: body.model,
      latestUserHash: latestClaudeUserHash,
      finishReason: "end_turn",
      logSafetyEvent: logAndPersistSafetyEvent,
      persistSessionAndUsage: sessionPersistenceRunner.persistSessionAndUsage,
      maybeCheckpoint,
      recordSessionEvent,
    });
    if (claudePolicyAction.kind === "softFail") {
      return sendClaudeSoftFail(reply, claudeOrchestration.selectedModel, claudePolicyAction.content, !!body.stream);
    }
    if (claudePolicyAction.kind === "reject") {
      return reply.code(400).send(policyRejectClaudeBody(claudePolicyAction.decision));
    }
    const claudeClientToolInventory = Array.isArray(body.tools) ? [...(body.tools as unknown[])] : [];
    if (shouldStripGlobFromTools(claudeSessionKey)) {
      const claudeGlobStrip = stripGlobFromTools(body.tools as unknown[] | undefined);
      if (claudeGlobStrip.stripped) {
        body.tools = claudeGlobStrip.tools as never;
        app.log.warn({ reqId: traceReqId, sessionKey: claudeSessionKey, sessionBlockedTotal: getBlockedDiscoveryCount(claudeSessionKey) }, "proactive_glob_strip_from_tools");
      }
    }
    const claudeGovernorPhase = claudeExecutionGovernor.telemetry.phase;
    applyGovernorPhaseRouteBookkeeping({
      session,
      sessionKey: claudeSessionKey,
      identity: claudeIdentity,
      requestId: traceReqId,
      governorPhase: claudeGovernorPhase,
      workingPhase: claudeWorkingPhase,
      orchestratorPhaseOverride: claudeOrchestratorPhaseOverride,
      messages: normalizedFromClaude.messages as GovernorInputMessage[],
      recordSessionEvent,
    });

    const claudeSensemakingPrimaryEnabled =
      config.SYNESIS_YARN_SENSEMAKING_ENABLED
      && !config.SYNESIS_YARN_SENSEMAKING_HARD_STOP_ONLY;
    if (
      !claudeSensemakingPrimaryEnabled
      && claudeExecutionGovernor.pause
      && config.SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED
    ) {
      const pause = persistGovernorPauseSoftFail({
        session,
        sessionKey: claudeSessionKey,
        identity: claudeIdentity,
        requestId: traceReqId,
        selectedModel: claudeOrchestration.selectedModel,
        originalModel: body.model,
        finishReason: "end_turn",
        buildPause: (consecutiveRecoveryFires) => {
          const content = buildExecutionGovernorHardStopUserMessage({
            consecutiveRecoveryFires,
            matchedRules: claudeExecutionGovernor.matchedRules,
            questionToolName: claudeClientToolCapabilities.questionToolName,
            taskContext: claudePauseTaskContext,
          });
          const envelope = buildExecutionGovernorPauseEnvelope({
            matchedRules: claudeExecutionGovernor.matchedRules,
            consecutiveRecoveryFires,
            hardStopThreshold: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER,
            evidenceDelta: summarizeEvidenceDelta(session.lastEvidenceDelta),
            activeGuards: claudeExecutionGovernor.telemetry.activeGuards,
            artifactContext: claudeArtifactContext,
            chatStateSummary: claudePauseChatSummary,
            fileStateSummary: claudePauseFileSummary,
            taskContext: claudePauseTaskContext,
            questionToolName: claudeClientToolCapabilities.questionToolName,
          });
          return {
            content,
            envelope,
            eventType: "execution_governor_pause",
            eventSource: "execution-governor",
            eventSummary: `Pause: rules=${claudeExecutionGovernor.matchedRules.slice(0, 3).join(",") || "unknown"}`,
            eventMetadata: {
              matchedRules: claudeExecutionGovernor.matchedRules,
              reason: claudeExecutionGovernor.reason,
              consecutiveRecoveryFires,
            },
          };
        },
        persistPauseContext: ({ session: pauseSession, pauseEnvelope, pauseContent }) => persistGovernorPauseContextMetadata({
          session: pauseSession,
          surface: "claude",
          requestId: traceReqId,
          pauseEnvelope,
          pauseContent,
          clientToolCapabilities: claudeClientToolCapabilities,
        }),
        persistSessionAndUsage: sessionPersistenceRunner.persistSessionAndUsage,
        maybeCheckpoint,
        recordSessionEvent,
      });
      return sendClaudeSoftFail(reply, claudeOrchestration.selectedModel, pause.content, !!body.stream, pause.envelope);
    }

    // Sensemaking-driven response: graduated allow/nudge/guide/intervene
    if (claudeSensemakingPrimaryEnabled && claudeSensemakingDecision && config.SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED) {
      if (claudeSensemakingDecision.shouldPause) {
        const pause = persistGovernorPauseSoftFail({
          session,
          sessionKey: claudeSessionKey,
          identity: claudeIdentity,
          requestId: traceReqId,
          selectedModel: claudeOrchestration.selectedModel,
          originalModel: body.model,
          finishReason: "end_turn",
          buildPause: (consecutiveRecoveryFires) => {
            const content = buildSensemakingPauseMessage(claudeSensemakingDecision);
            const envelope = buildExecutionGovernorPauseEnvelope({
              matchedRules: claudeSensemakingDecision.matchedRules,
              consecutiveRecoveryFires,
              hardStopThreshold: 7,
              evidenceDelta: summarizeEvidenceDelta(session.lastEvidenceDelta),
              activeGuards: claudeExecutionGovernor.telemetry.activeGuards,
              artifactContext: claudeArtifactContext,
              chatStateSummary: claudePauseChatSummary,
              fileStateSummary: claudePauseFileSummary,
              taskContext: claudePauseTaskContext,
              questionToolName: claudeClientToolCapabilities.questionToolName,
            });
            return {
              content,
              envelope,
              eventType: "sensemaking_governor_pause",
              eventSource: "sensemaking-governor",
              eventSummary: `Pause: domain=${claudeSensemakingDecision.domain} friction=${(claudeSensemakingDecision.frictionScore * 100).toFixed(0)}% signals=${claudeSensemakingDecision.matchedRules.slice(0, 3).join(",")}`,
              eventMetadata: {
                domain: claudeSensemakingDecision.domain,
                frictionScore: claudeSensemakingDecision.frictionScore,
                matchedRules: claudeSensemakingDecision.matchedRules,
                consecutiveRecoveryFires,
              },
            };
          },
          persistPauseContext: ({ session: pauseSession, pauseEnvelope, pauseContent }) => persistGovernorPauseContextMetadata({
            session: pauseSession,
            surface: "claude",
            requestId: traceReqId,
            pauseEnvelope,
            pauseContent,
            clientToolCapabilities: claudeClientToolCapabilities,
          }),
          persistSessionAndUsage: sessionPersistenceRunner.persistSessionAndUsage,
          maybeCheckpoint,
          recordSessionEvent,
        });
        return sendClaudeSoftFail(reply, claudeOrchestration.selectedModel, pause.content, !!body.stream, pause.envelope);
      }

      const guidanceInjection = buildSensemakingGuidanceInjection(claudeSensemakingDecision);
      if (guidanceInjection) {
        injectGovernorRecoveryMessage(
          normalizedFromClaude.messages as Array<{ role: string; content: unknown }>,
          guidanceInjection,
        );
        recordSessionEvent(
          claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId,
          "sensemaking_governor_guidance",
          "sensemaking-governor",
          `${claudeSensemakingDecision.responseLevel}: domain=${claudeSensemakingDecision.domain} friction=${(claudeSensemakingDecision.frictionScore * 100).toFixed(0)}%`,
          traceReqId,
          {
            responseLevel: claudeSensemakingDecision.responseLevel,
            domain: claudeSensemakingDecision.domain,
            frictionScore: claudeSensemakingDecision.frictionScore,
            guidance: guidanceInjection.slice(0, 200),
          },
        );
      }

      resetGovernorPauseRecoveryState(session, claudeHasActiveEditMissFailure, clearGovernorPauseContextMetadata);
    } else if (!claudeExecutionGovernor.pause) {
      resetGovernorPauseRecoveryState(session, claudeHasActiveEditMissFailure, clearGovernorPauseContextMetadata);
    }

    const claudeRole = TIER_TO_ROLE[claudeOrchestration.tier];
    const claudeBackendModel = roleAssignmentRegistry.get(claudeRole)?.backendModel ?? "";
    const claudePromptContext = {
      tier: claudeOrchestration.tier,
      role: claudeRole,
      modelFamily: inferModelFamily(claudeBackendModel),
    };
    const claudeMetadataPrebackfill = applyWorkspaceMetadataPrebackfill({
      pathContext: effectiveClaudePathCtx,
      adapterBlock: effectiveClaudeAdapterBlock,
      messages: normalizedFromClaude.messages as never,
      session,
      requestId: traceReqId,
      extractMetadataFromMessages: (messages) => extractMetadataFromMessages(messages as never),
      buildAdapterBlock: buildEffectiveClaudeAdapterBlock,
      setWorkspaceContext: setSessionWorkspaceContext,
      logInfo: (record, message) => app.log.info(record, message),
      logSessionKey: claudeSessionKey,
    });
    effectiveClaudePathCtx = claudeMetadataPrebackfill.pathContext;
    effectiveClaudeAdapterBlock = claudeMetadataPrebackfill.adapterBlock;
    const claudeSeedDirs = await getCachedTopLevelDirs(effectiveClaudePathCtx.projectRoot ?? effectiveClaudePathCtx.shellCwd);
    const claudeGovernanceBlocks = buildRouteGovernanceBlocks({
      memoryTracker: getMemoryGovernor(claudeSessionKey),
      structuralIndex: getStructuralIndex(claudeSessionKey),
      sessionMemoryCount: getSessionMemoryCount(claudeSessionKey),
      clientToolCapabilities: claudeClientToolCapabilities,
      taskIntake: claudeTaskIntake,
      planGraph: claudePlanGraph,
      relevantEvidenceBlock: claudeObjectiveScope.relevantEvidenceBlock,
      artifactBridgeBlock: claudeObjectiveScope.artifactBridgeBlock,
      stateConfidenceBlock: claudeStateConfidenceBlock,
      governorPauseResumeBlock: claudeGovernorPauseResumeBlock,
      plannerTodoPacketBlock: claudePlannerTodoPacketBlock,
      taskLedger: session.taskLedger,
      taskCapabilities: session.taskCapabilities,
    });
    const claudeEnriched = await enrichWithFrameAndManifest(
      claudeScopedMessages as never,
      claudeSessionKey,
      effectiveClaudeAdapterBlock,
      claudePromptContext,
      { projectRoot: effectiveClaudePathCtx.projectRoot, shellCwd: effectiveClaudePathCtx.shellCwd },
      claudeGovernanceBlocks.blocks,
      claudeSeedDirs,
      session,
      { chatStateBlock: claudeChatStateBlock, fileStateBlock: claudeFileStateBlock },
    );
    const claudeFinalizedEnrichment = finalizePostEnrichmentMessages({
      messages: claudeEnriched.messages,
      config,
      requirementChecklist: claudeRequirementChecklist,
      trustContext: {
        requestId: traceReqId,
        sessionKey: claudeSessionKey,
        userId: claudeIdentity.userId,
        orgId: claudeIdentity.orgId,
      },
      securityIngestConfig,
      logger: app.log as never,
    });
    if (!claudeFinalizedEnrichment.ok) {
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "trust_block", "transcript-trust", claudeFinalizedEnrichment.blockDetail, traceReqId);
      return reply.code(400).send({
        type: "error",
        error: { type: "invalid_request_error", message: `Request blocked by content safety policy (${claudeFinalizedEnrichment.trustCategory}). Rephrase and retry.` }
      });
    }
    const enrichedClaudeMsgs = claudeFinalizedEnrichment.messages;

    const claudeOpenAIShape: OpenAIChatCompletionRequest = {
      model: claudeOrchestration.selectedModel,
      messages: enrichedClaudeMsgs as never,
      stream: body.stream,
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    };
    const reqId = traceReqId;
    const claudeProviderFinalization = await finalizeOpenAIProviderRequest({
      request: claudeOpenAIShape,
      selectedModel: claudeOrchestration.selectedModel,
      enrichedMessages: enrichedClaudeMsgs,
      toolResultCount: claudeToolResultCount,
      session,
      sessionKey: claudeSessionKey,
      requestId: traceReqId,
      identity: claudeIdentity,
      pathContext: effectiveClaudePathCtx,
      governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      volatileSystemBlocks: [
        claudePrefetchResult ? formatEvidenceBlock(claudePrefetchResult) ?? "" : "",
        claudePatternResult ? formatPatternBlock(claudePatternResult) ?? "" : "",
        claudeSensemakingBlock ?? "",
      ],
      policyPivotPrompt: claudePolicyPrecheck.pivotPrompt,
      latestUserContent: latestClaudeUser?.content,
      runtimePreferences: claudeRuntimePreferences,
      configuredCompactionMode: config.SYNESIS_YARN_CONTEXT_BUDGET_COMPACTION_MODE,
      defaultTier: config.SYNESIS_YARN_DEFAULT_TIER,
      cachePolicyFallbackProvider: "anthropic",
      prefixOptimizer,
      prefixOptimizerErrorEvent: "prefix_optimizer_claude_error",
      logger: app.log,
      injectSessionContext: (messagesToInject, state) => injectSessionContext(
        messagesToInject as Array<{ role: string; content: unknown }>,
        state,
      ) as typeof messagesToInject,
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
    const openAIShape = claudeProviderFinalization.normalizedRequest;
    effectiveClaudePathCtx = claudeProviderFinalization.pathContext;
    const claudeCachePolicy = claudeProviderFinalization.cachePolicy;
    const claudeResolveResult = claudeProviderFinalization.resolveResult;
    if (!claudeResolveResult.ok) {
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "resolve_failure", "tier-registry", claudeResolveResult.error, traceReqId);
      return reply.code(503).send({
        type: "error",
        error: { type: "service_unavailable", message: claudeResolveResult.error }
      });
    }
    const { resolved, messages, transforms: claudeTranscriptTransforms } = claudeResolveResult;
    const claudeRoutePersistence = createRoutePersistenceScope({
      state: session,
      requestId: reqId,
      resolvedModelId: resolved.resolvedModelId,
      sessionKey: claudeSessionKey,
      userId: claudeIdentity.userId,
      orgId: claudeIdentity.orgId,
      clientRequestedModel: body.model,
      recordSessionEvent,
      persistDecisionTelemetry: sessionPersistenceRunner.persistAndEmitDecisionTelemetry,
    });
    if (
      (claudeTranscriptTransforms.systemMessagesReordered || claudeTranscriptTransforms.toolCallsSanitized)
      && shouldSampleBySeed(
        `${claudeSessionKey}:${traceReqId}:claude-transform`,
        config.SYNESIS_YARN_TRANSCRIPT_TRANSFORM_LOG_SAMPLE_RATE,
      )
    ) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "transcript_transform_applied",
        "request-normalizer",
        `system_reordered=${claudeTranscriptTransforms.systemMessagesReordered} tool_sanitized=${claudeTranscriptTransforms.toolCallsSanitized} delta=${claudeTranscriptTransforms.messageCountDelta}`,
        traceReqId,
        {
          path: "claude",
          system_messages_reordered: claudeTranscriptTransforms.systemMessagesReordered,
          tool_calls_sanitized: claudeTranscriptTransforms.toolCallsSanitized,
          message_count_delta: claudeTranscriptTransforms.messageCountDelta,
        },
      );
    }
    const { adapter: claudeAdapter } = resolved;
    const claudeResolvedTierForHarness = tierRegistry.getTierConfig(resolved.resolvedModelId);
    const claudeUpperHarness = buildYarnUpperHarnessContext({
      surface: "claude",
      modelId: claudeResolvedTierForHarness?.backendModel ?? resolved.resolvedModelId,
      requestedModel: body.model,
      adapter: claudeAdapter,
      baseUrl: claudeResolvedTierForHarness?.baseUrl,
      provider: claudeResolvedTierForHarness
        ? resolveEndpointCapabilityId(claudeResolvedTierForHarness.baseUrl)
        : "anthropic",
    });
    const claudeRawTools = (processedTools as unknown[]) ?? [];

    const claudeToolPreparation = prepareRouteTools({
      rawTools: claudeRawTools,
      adapter: claudeAdapter,
      clientCapabilities: claudeClientToolCapabilities,
      clientKind: claudeClientKind,
      phase: claudeOrchestration.phase,
      profileToolBudgetCap: config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED && isOpenClawProfile(claudeAdapterProfile)
        ? Math.max(1, config.SYNESIS_YARN_OPENCLAW_TOOL_SCHEMA_CAP)
        : claudeAdapterProfile.features.toolSchemaBudgetCap,
      pruningEnabled: config.SYNESIS_YARN_TOOL_SCHEMA_PRUNING_ENABLED,
      pruningMaxOverride: config.SYNESIS_YARN_TOOL_SCHEMA_PRUNING_MAX_OVERRIDE,
      toolChoice: body.tool_choice,
      latestUserContent: latestClaudeUser?.content,
      recentCallMessages: normalizedFromClaude.messages as Array<{ role: string; content: unknown }>,
      recoveryMessages: normalizedFromClaude.messages as Array<{ role: string; content: unknown }>,
      governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      toolLoopSteeringEnabled: adapterUsesToolLoopSteering(claudeAdapter.family),
      harnessTelemetryEnabled: config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED,
      requestId: traceReqId,
      stats: toolSchemaPruningStats,
      logger: app.log,
      isWriteCapableToolName,
      recordSessionEvent: claudeRoutePersistence.recordSessionEvent,
    });
    const claudeRecentCallsForSteering = claudeToolPreparation.recentCallsForSteering;
    let effectiveClaudeTools = claudeToolPreparation.effectiveTools;
    const clientClaudeToolChoice = claudeToolPreparation.clientToolChoice;
    if (claudeToolPreparation.invalidToolChoice) {
      return reply.code(400).send({
        error: {
          type: "invalid_request_error",
          message: "Invalid tool_choice. Expected auto|none|required|any or object form {type:\"tool\",name:\"...\"}.",
        },
      });
    }
    const sdkStop = body.stop_sequences && body.stop_sequences.length > 0 ? body.stop_sequences : undefined;
    const claudeForceReadRecovery =
      session.editMissForceReadPending
      && claudeExecutionGovernor.matchedRules.includes("edit_failure_replay");

    let claudeModelMessages = assembleRouteModelMessages({
      adapter: claudeAdapter,
      effectiveTools: effectiveClaudeTools as unknown[],
      messages,
      workspaceInspection: claudeWorkspaceInspection,
      policyPivotPrompt: claudePolicyPrecheck.pivotPrompt,
      editMissGuard: claudeEditMissGuard,
      forceReadRecovery: claudeForceReadRecovery,
      latestReadRefreshFilePath: claudeLatestReadRefresh.filePath,
      consecutiveEditContextMisses: session.consecutiveEditContextMisses,
      stateReground: {
        required: claudeNeedsStateReground,
        recommendedReadPath: claudeStateConfidence.recommendedReadPath,
        reasons: claudeStateConfidence.reasons,
      },
      promptIntakeSystemBlock: claudePromptIntake.systemBlock,
      buildEditContextMissGuardPrompt,
      buildEditContextMissForcedReadPrompt,
      buildStateRegroundReadPrompt,
    }).messages as typeof messages;

    const claudeGovernanceRecoveryActive = Boolean(
      claudePolicyPrecheck.pivotPrompt
      || claudeEditMissGuard?.active
      || claudeForceReadRecovery
      || claudeNeedsStateReground
      || (claudeSensemakingDecision && claudeSensemakingDecision.responseLevel !== "allow"),
    );
    claudeModelMessages = applyRouteAdapterPivot({
      surface: "claude",
      adapter: claudeAdapter,
      sessionKey: claudeSessionKey,
      requestId: traceReqId,
      modelMessages: claudeModelMessages as Array<{ role: string; content?: unknown }>,
      normalizedMessages: normalizedFromClaude.messages as Array<{ role: string; content: unknown }>,
      recentCalls: claudeRecentCallsForSteering,
      recentUserPrompt: claudeTaskCue,
      governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
      toolLoopSteeringEnabled: adapterUsesToolLoopSteering(claudeAdapter.family),
      governanceRecoveryActive: claudeGovernanceRecoveryActive,
      harnessTelemetryEnabled: config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED,
      skipTelemetry: {
          policy_pivot: Boolean(claudePolicyPrecheck.pivotPrompt),
          edit_miss_guard: Boolean(claudeEditMissGuard?.active),
          force_read_recovery: claudeForceReadRecovery,
          state_confidence_reground: claudeNeedsStateReground,
          governor_soft_fail_pause: Boolean(claudeSensemakingDecision?.shouldPause),
      },
      cooldownTurns: config.SYNESIS_YARN_QWEN_RESUME_NUDGE_COOLDOWN_TURNS,
      stagnationWindow: config.SYNESIS_YARN_QWEN_STAGNATION_WINDOW,
      stagnationThreshold: config.SYNESIS_YARN_QWEN_STAGNATION_THRESHOLD,
      planNoActionLimit: config.SYNESIS_YARN_QWEN_PLAN_NO_ACTION_LIMIT,
      editRetryLimit: config.SYNESIS_YARN_QWEN_EDIT_RETRY_LIMIT,
      dampeningLogEvent: "adapter_dampening_claude",
      logger: app.log,
      appendSystemMessageAndNormalize: (messagesToAppend, content) => appendSystemMessageAndNormalize(
        messagesToAppend,
        content,
      ) as typeof messagesToAppend,
      recordSessionEvent: claudeRoutePersistence.recordSessionEvent,
    }).modelMessages as typeof claudeModelMessages;

    claudeModelMessages = normalizeSystemMessageOrdering(claudeModelMessages as Array<{ role: string }>) as typeof claudeModelMessages;

    const resolvedClaudeTierConfig = tierRegistry.getTierConfig(resolved.resolvedModelId);
    const claudeProviderRequestOptions = buildClaudeMessagesProviderRequestOptions({
      request: body,
      tierSamplingDefaults: resolvedClaudeTierConfig?.samplingDefaults,
      adapterSampling: claudeAdapter.defaultSamplingParams?.(),
      adapterProviderOptions: claudeAdapter.providerOptions?.() as
        | Record<string, Record<string, unknown>>
        | undefined,
      supportsTopK: claudeAdapter.family !== "minimax",
    });
    let providerOptions = claudeProviderRequestOptions.providerOptions;
    const claudePhaseApplication = applyRoutePhasePolicy({
      adapterFamily: claudeAdapter.family,
      basePolicyEnabled: config.SYNESIS_YARN_PHASE_EXECUTION_POLICY_ENABLED && claudePhasePolicyEnabledByMatrix,
      policyEnabledByMatrix: claudePhasePolicyEnabledByMatrix,
      enabledFamilies: config.SYNESIS_YARN_PHASE_EXECUTION_POLICY_FAMILIES,
      phase: claudeGovernorPhase,
      matchedRules: claudeExecutionGovernor.matchedRules,
      stream: !!body.stream,
      effectiveTools: effectiveClaudeTools,
      clientToolChoice: clientClaudeToolChoice as PhaseAwareToolChoice | undefined,
      editMissGuard: claudeEditMissGuard,
      editMissForceReadPending: session.editMissForceReadPending,
      forceReadRecovery: claudeForceReadRecovery,
      consecutiveEditContextMisses: session.consecutiveEditContextMisses,
      stateRegroundRequired: claudeNeedsStateReground,
      stateRegroundReadPath: claudeStateConfidence.recommendedReadPath,
      clientToolInventory: claudeClientToolInventory,
      recordSessionEvent: claudeRoutePersistence.recordSessionEvent,
      applyEditContextMissReadGate,
      findPreferredReadToolName,
      ensureReadToolAvailability: ensureReadToolAvailabilityForEditMissGuard,
    });
    const claudePhasePolicy = claudePhaseApplication.phasePolicy;
    const claudePhaseFiltered = claudePhaseApplication.phaseFiltered;
    effectiveClaudeTools = claudePhaseApplication.effectiveTools;
    const effectiveClaudeToolChoice = claudePhaseApplication.effectiveToolChoice;
    const claudeThinkingToolChoiceGuard = suppressThinkingWhenRequiredToolChoice(
      providerOptions as Record<string, Record<string, unknown>> | undefined,
      effectiveClaudeToolChoice as PhaseAwareToolChoice | undefined,
    );
    providerOptions = claudeThinkingToolChoiceGuard.providerOptions;
    if (claudeThinkingToolChoiceGuard.suppressed) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "phase_required_tool_choice_thinking_guard",
        "execution-governor",
        "Suppressed thinking because tool_choice=required is incompatible with provider thinking mode.",
        traceReqId,
        {
          path: "claude",
          phase: claudeGovernorPhase,
          phase_reason: claudePhasePolicy.reason ?? null,
        },
      );
    }
    const sdkTools = claudeToolsToSDK(effectiveClaudeTools as never);
    const claudeForensicsPhasePolicy: RequestForensicsRecord["phasePolicy"] = {
      enabled: claudePhasePolicy.active,
      source: clientClaudeToolChoice !== undefined ? "client" : (effectiveClaudeToolChoice !== undefined ? "phase_policy" : "none"),
      phase: claudeGovernorPhase,
      effectiveToolChoice: typeof effectiveClaudeToolChoice === "string" ? effectiveClaudeToolChoice : effectiveClaudeToolChoice ? "tool" : undefined,
      filteredToolCount: claudePhaseFiltered.removed.length,
    };
    if (claudePhasePolicy.active && (claudePhaseFiltered.filtered || clientClaudeToolChoice === undefined)) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "phase_execution_policy_applied",
        "execution-governor",
        `phase=${claudeGovernorPhase} reason=${claudePhasePolicy.reason ?? "none"} tool_choice=${typeof effectiveClaudeToolChoice === "string" ? effectiveClaudeToolChoice : "tool"} filtered=${claudePhaseFiltered.removed.length}`,
        traceReqId,
        {
          matched_rules: claudeExecutionGovernor.matchedRules,
          removed_tools: claudePhaseFiltered.removed,
          state_confidence_reground: claudeNeedsStateReground,
          state_confidence_recommended_path: claudeStateConfidence.recommendedReadPath,
        },
      );
    }
    const claudeSamplingOptions = claudeProviderRequestOptions.samplingOptions;
    const claudeNativeWebSearchRequested = hasClaudeNativeWebSearchTool(body.tools as unknown[] | undefined);
    const claudeForceNonStreamKickoff =
      !!body.stream && claudePhasePolicy.active && claudePhasePolicy.toolChoice === "required" && !!claudePhasePolicy.enforceNonStreaming;
    const claudeAdmissionResult = runRouteContextAdmission({
      surface: "claude",
      messages: claudeModelMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>,
      tools: effectiveClaudeTools as unknown[],
      sessionKey: claudeSessionKey,
      logRequestId: req.id,
      metadata: session.record.metadata,
      chatState: claudeChatState,
      fileState: claudeFileState,
      artifactStore,
      contextBudgetEnabled: config.SYNESIS_YARN_CONTEXT_BUDGET_ENABLED,
      modelContextCeilingTokens: resolvedClaudeTierConfig?.contextCeilingTokens,
      budgetCeilingTokens: config.SYNESIS_YARN_CONTEXT_BUDGET_CEILING_TOKENS,
      outputReserveTokens: config.SYNESIS_YARN_CONTEXT_BUDGET_OUTPUT_RESERVE,
      admissionMode: config.SYNESIS_YARN_CONTEXT_ADMISSION_MODE,
      admissionWarnTokens: config.SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS,
      admissionHardTokens: config.SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS,
      compactionMode: claudeCachePolicy.compactionMode,
      cachePolicyRecord: cachePolicyLogRecord(claudeCachePolicy),
      upperHarnessContext: claudeUpperHarness,
      upperHarnessCeilingTokens: claudeResolvedTierForHarness?.contextCeilingTokens,
      stats: contextAdmissionStats,
      backendModelHint: claudeCompactionOpts.backendModelHint,
      transcriptPruning,
      logger: app.log,
      recordSessionEvent: claudeRoutePersistence.recordSessionEvent,
      recordUpperHarnessDecision: (label, decision, options) =>
        recordUpperHarnessDecision(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, traceReqId, label, decision, options),
      forceCheckpoint: () => { void forceCheckpoint(session); },
    });
    claudeModelMessages = claudeAdmissionResult.messages as typeof claudeModelMessages;
    const claudeContextAdmission = claudeAdmissionResult.contextAdmission;
    if (claudeAdmissionResult.rejected) {
      return reply.code(400).send({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: admissionErrorMessage(claudeContextAdmission),
        },
        context_admission: {
          decision: claudeContextAdmission.decision,
          estimated_tokens: claudeContextAdmission.estimatedTokens,
          estimated_chars: claudeContextAdmission.estimatedChars,
          reason: claudeContextAdmission.reason,
        },
      });
    }
    const claudeCacheShapeDiagnostics = buildCacheShapeDiagnostics({
      messages: claudeModelMessages as Array<{ role?: string; content?: unknown }>,
      tools: effectiveClaudeTools as unknown[],
      providerOptions,
    });

    const persistClaudeDecisionTelemetry = claudeRoutePersistence.persistDecisionTelemetry;

    if (body.stream) {
      if (claudeNativeWebSearchRequested || claudeForceNonStreamKickoff) {
        const started = Date.now();
        if (claudeForceNonStreamKickoff) {
          recordSessionEvent(
            claudeSessionKey,
            claudeIdentity.userId,
            claudeIdentity.orgId,
            "phase_non_stream_kickoff",
            "execution-governor",
            `Forcing non-stream kickoff turn in phase=${claudeGovernorPhase} with tool_choice=required`,
            traceReqId,
          );
        }
        const claudeKickoffResult = await runClaudeStreamKickoffPipeline({
          model: resolved.resolvedModelId,
          headers: sseHeadersWithClarification(session.record.metadata),
          providerInput: {
            initialMessages: claudeModelMessages as Array<{ role: string; content?: unknown }>,
            model: resolved.model,
            resolvedModelId: resolved.resolvedModelId,
            orchestrationMaxOutputTokens: claudeOrchestration.maxOutputTokens,
            requestMaxTokens: body.max_tokens,
            samplingOptions: claudeSamplingOptions,
            stopSequences: sdkStop,
            tools: sdkTools,
            initialToolChoice: effectiveClaudeToolChoice,
            providerOptions,
            phasePolicy: claudePhasePolicy,
            governorPhase: claudeGovernorPhase,
            nativeWebSearchRequested: claudeNativeWebSearchRequested,
            clampMaxOutputTokens: clampMaxOutputTokensForSafety,
            generateText: (options) => generateText(options as never),
            readUsage,
            captureForensics: (messages, toolChoice) => captureRequestForensics(
              claudeSessionKey,
              reqId,
              "/v1/messages",
              resolved.resolvedModelId,
              false,
              messages as Array<{ role: string; content: unknown }>,
              effectiveClaudeTools as unknown[],
              toolChoice,
              providerOptions,
              claudeForensicsPhasePolicy,
              claudeForensicsCapabilityMatrix,
            ),
            finalizeForensics: (forensics, usage) => finalizeRequestForensics(
              session,
              reqId,
              forensics as { record: RequestForensicsRecord; serialized: string } | null,
              usage,
            ),
            recordSessionEvent: (event) => recordSessionEvent(
              claudeSessionKey,
              claudeIdentity.userId,
              claudeIdentity.orgId,
              event.eventKind,
              event.component,
              event.detail,
              traceReqId,
              event.metadataJson,
            ),
            isServerWebSearchTool: isClaudeWebSearchToolName,
            resolveServerWebSearch: (input) => webSearch.resolve(
              input,
              webSearchResolveContext(claudeAuthUser, req, {
                requestId: reqId,
                sessionKey: claudeSessionKey,
                conversationId: session.record.conversationId || undefined,
                traceId: reqId,
                sourceSurface: "yarn_chat",
                toolName: "web_search",
              }),
            ),
            toServerWebSearchEvent: toClaudeServerWebSearchEvent,
          },
          response: {
            writeHead: (statusCode, headers) => reply.raw.writeHead(statusCode, headers),
            sendSse: (event, data) => safeSse(reply, event, data),
            end: () => safeEnd(reply.raw),
            createMessageId: () => `msg_${crypto.randomUUID()}`,
          },
          onAssistantText: (text) => {
            session.history.push({ role: "assistant", content: text });
          },
        });
        const usage = claudeKickoffResult.usage;
        const stopReason = claudeKickoffResult.stopReason;
        const externalCalls = claudeKickoffResult.externalToolCalls;
        const claudeNonStreamForensicsDone = claudeKickoffResult.requestForensicsDone;

        const reduced = toolResultReduction.getPerRequestDelta() + validationNormalization.getPerRequestDelta();
        const verificationState = toolResultReduction.getVerificationTracker().getState();
        const recallDecision = toolResultReduction.getLastRecallDecision();
        const snapshot = buildDecisionSnapshot({
          orchestration: claudeOrchestration,
          recallDecision,
          verificationState,
          policyMatchedRules: claudePolicyPrecheck.matchedRules,
          reducedToolResults: claudeToolResultCount,
          tokensSavedByReduction: reduced,
          evidencePrefetched: claudeEvidencePrefetched,
          evidenceConfidence: claudeCombinedConfidence || undefined,
          evidenceAuthoritative: claudePrefetchResult?.authoritative,
          evidencePrefetchLatencyMs: claudePrefetchResult ? Math.round(claudePrefetchResult.latencyMs) : undefined,
          evidenceQuality: buildEvidenceTraceSummary(claudePrefetchResult, claudePatternResult),
          isStreaming: true,
          sensemakingTriggered: claudeSensemakingResult?.triggered,
          sensemakingReason: claudeSensemakingResult?.reason,
          governorDecision: claudeExecutionGovernor,
          governorChatStateSummary: claudePauseChatSummary,
          governorFileStateSummary: claudePauseFileSummary,
        });
        persistClaudeDecisionTelemetry({
          usage,
          latencyMs: Date.now() - started,
          finishReason: stopReason,
          tokensSavedByReduction: reduced,
          escalated: claudeOrchestration.escalated,
          snapshot,
          trajectory: {
            toolSequence: externalCalls.map((c) => c.toolName),
            verificationSteps: inferVerificationSteps(externalCalls.map((c) => c.toolName)),
            diagnostics: claudeTrajectoryDiagnostics,
          },
        });

        pushDiagnostic({
          timestamp: Date.now(),
          sessionKey: claudeSessionKey,
          path: "/v1/messages",
          requestId: reqId,
          ...countMessageRoles(normalizedFromClaude.messages as Array<{ role: string; content: unknown }>),
          toolDefinitionCount: effectiveClaudeTools.length,
          artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
          knowledgeToolInjected: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
          reducedToolResults: claudeToolResultCount,
          finishReason: stopReason,
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          policyDecision: claudePolicyPrecheck.matchedRules.join(","),
          latencyMs: Date.now() - started,
          decisionPath: claudeOrchestration.decisionPath,
          decisionEscalated: claudeOrchestration.escalated || undefined,
          requestForensicsSummary: claudeNonStreamForensicsDone?.summary,
          requestForensicsLcpRatio: claudeNonStreamForensicsDone?.lcpRatio,
          requestForensicsFirstChangedSection: claudeNonStreamForensicsDone?.firstChangedSection,
          requestForensicsTokenEstimate: claudeNonStreamForensicsDone?.tokenEstimate,
          ...cacheShapeDiagnosticFields(claudeCacheShapeDiagnostics),
        });
        return reply;
      }

      const claudeStreamContext = createClaudeStreamRouteContext({
        sessionKey: claudeSessionKey,
        userId: claudeIdentity.userId,
        orgId: claudeIdentity.orgId,
        traceRequestId: traceReqId,
        responseRequestId: reqId,
        resolvedModelId: resolved.resolvedModelId,
        projectRoot: effectiveClaudePathCtx.projectRoot,
      });
      const claudeStreamPrepared = await prepareClaudeStreamRoute({
        gates: {
          scope: claudeStreamContext.streamScope,
          resolvedModelId: claudeStreamContext.resolvedModelId,
          logger: app.log,
          streamAdmission,
          circuitBreakers,
          recordSessionEvent,
          startSpan: (name, attributes) => getTracer().startSpan(name, attributes),
        },
        runtime: {
          requestIds: claudeStreamContext.requestIds,
          resolvedModelId: claudeStreamContext.resolvedModelId,
          messages: claudeModelMessages as Array<{ role: string; content: unknown }>,
          tools: effectiveClaudeTools as unknown[],
          toolChoice: effectiveClaudeToolChoice,
          providerOptions,
          phasePolicy: claudeForensicsPhasePolicy,
          capabilityMatrix: claudeForensicsCapabilityMatrix,
          captureRequestForensics,
          sideEffects: {
            session,
            clientKind: claudeClientKind,
            logger: app.log as never,
            strictGovernanceStats: openClawProfileStats,
            updateDiffAccumulator,
            maybeUpdateTaskLedgerFromToolCall,
            emitPlanWriteAuditEvent,
            maybeLogEnvelopeUnwrapSample,
            recordUpperHarnessDecision,
          },
          abort: {
            longWaitEventMs: config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS,
            hardTimeoutMs: config.SYNESIS_YARN_SSE_STREAM_HARD_TIMEOUT_MS,
          },
        },
      });
      if (!claudeStreamPrepared.ok) {
        reply.header("Retry-After", claudeStreamPrepared.rejection.retryAfter);
        return reply.code(claudeStreamPrepared.rejection.statusCode).send(claudeStreamPrepared.rejection.payload);
      }
      const claudeStreamRuntime = claudeStreamPrepared.runtime;
      const claudeStreamForensics = claudeStreamRuntime.streamForensics;
      const recordClaudeStreamEvent = claudeStreamRuntime.recordStreamEvent;
      const claudeStreamToolSideEffects = claudeStreamRuntime.streamToolSideEffects;
      const resolvedTier = tierRegistry.getTierConfig(claudeStreamContext.resolvedModelId);
      await runClaudeStreamRouteFromInput({
        runtime: claudeStreamRuntime,
        start: {
          recordSessionEvent,
          transport: {
            raw: reply.raw,
            headers: sseHeadersWithClarification(session.record.metadata),
            heartbeatIntervalMs: config.SYNESIS_YARN_SSE_HEARTBEAT_INTERVAL_MS,
            longWaitEventMs: config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS,
            startHeartbeat: startSseHeartbeat,
            createMessageId: () => `msg_${crypto.randomUUID()}`,
            sendSse: (event, data) => safeSse(reply, event, data),
            streamText: (options) => streamText(options as never),
          },
          provider: {
            requestId: claudeStreamContext.requestIds.traceRequestId,
            model: resolved.model,
            messages: claudeModelMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }>,
            adapter: claudeAdapter,
            orchestrationMaxOutputTokens: claudeOrchestration.maxOutputTokens,
            requestMaxTokens: body.max_tokens,
            samplingOptions: claudeSamplingOptions,
            stopSequences: sdkStop,
            tools: sdkTools,
            toolChoice: effectiveClaudeToolChoice,
            providerOptions,
            clampMaxOutputTokens: clampMaxOutputTokensForSafety,
            logger: app.log,
          },
          components: {
            tierConfig: resolvedTier,
            resolvedModelId: claudeStreamContext.resolvedModelId,
            tools: effectiveClaudeTools as unknown[],
            computePrefixFingerprint,
          },
        },
        eventHandlers: {
          base: {
            adapter: claudeAdapter,
            requestId: claudeStreamContext.requestIds.traceRequestId,
            clientKind: claudeClientKind,
            debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
            strictGovernance: claudeOpenClawStrictGovernance,
            upperHarness: claudeUpperHarness,
            taskCue: claudeTaskCue,
            clientPlanModeRequested: claudeClientToolCapabilities.planModeRequested,
            sensemakingRestrictDiscovery: claudeSensemakingDecision?.shouldRestrictDiscovery,
            pathContext: effectiveClaudePathCtx,
            enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
            blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
            pathSandboxEnabled: config.SYNESIS_YARN_PATH_SANDBOX_ENABLED,
            artifactShadows: claudeArtifactShadows,
            session,
            stats: toolArgHardeningStats,
            logger: app.log,
            isWriteCapableToolName,
            shouldRestrictDiscoveryForPlanWork,
            deserializePlanShadow: deserializeShadow,
            buildPathSandboxPolicy: buildDefaultPolicy,
            getTopLevelDirs: getCachedTopLevelDirs,
            applyDiscoveryGuardrail: applyDiscoveryToolGuardrail,
          },
          toolSideEffects: claudeStreamToolSideEffects,
          recentCalls: claudeRecentCallsForSteering,
          normalizedMessages: normalizedFromClaude.messages as Array<{ role: string }>,
          route: claudeStreamContext.eventRoute,
          recordBlockedDiscovery,
          buildBlockedDiscoveryRecoverySnapshot,
        },
        pipelineSupport: {
          lifecycle: {
            session,
            circuitBreakers,
            logger: app.log,
            extractUpstreamErrorDiagnostics,
            recordSessionEvent: recordClaudeStreamEvent,
          },
          afterEvents: {
            adapter: claudeAdapter,
            stats: toolArgHardeningStats,
            logger: app.log,
            recordBlockedDiscovery,
            getBlockedDiscoveryCount,
            recordSessionEvent,
          },
        },
        completion: {
          scope: claudeStreamContext.completionScope,
          metadata: {
            source: session.record.metadata,
            getString: getMetadataString,
          },
          recentMessages: openAIShape.messages as Array<{ role: string; content: unknown }>,
          extractRecentToolNames,
          checklist: claudeRequirementChecklist,
          finalizer: {
            session,
            readUsage,
            finalizeRequestForensics: (usage) => finalizeRequestForensics(
              session,
              claudeStreamContext.requestIds.responseRequestId,
              claudeStreamForensics,
              usage,
            ),
            handlerInput: {
              session,
              verification: claudeVerificationAssessment,
              planGraph: claudePlanGraph,
              responseStyleMode: config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
              applyMarkdownGuardrail,
              finalizeCompletionText,
              finalizePostStreamText,
            },
            endStream: () => safeEnd(reply.raw),
            recordSessionEvent,
          },
          telemetry: {
            clientRequestedModel: body.model,
            reductions: {
              toolResultReduction,
              validationNormalization,
            },
            reducedToolResults: claudeToolResultCount,
            orchestration: claudeOrchestration,
            policyMatchedRules: claudePolicyPrecheck.matchedRules,
            evidencePrefetched: claudeEvidencePrefetched,
            evidenceConfidence: claudeCombinedConfidence || undefined,
            evidenceAuthoritative: claudePrefetchResult?.authoritative,
            evidencePrefetchLatencyMs: claudePrefetchResult ? Math.round(claudePrefetchResult.latencyMs) : undefined,
            evidenceQuality: buildEvidenceTraceSummary(claudePrefetchResult, claudePatternResult),
            sensemakingTriggered: claudeSensemakingResult?.triggered,
            sensemakingReason: claudeSensemakingResult?.reason,
            governorDecision: claudeExecutionGovernor,
            governorChatStateSummary: claudePauseChatSummary,
            governorFileStateSummary: claudePauseFileSummary,
            normalizedMessages: openAIShape.messages as Array<{ role: string; content: unknown }>,
            inferVerificationSteps,
            trajectoryDiagnostics: claudeTrajectoryDiagnostics,
            toolDefinitionCount: effectiveClaudeTools.length,
            artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
            knowledgeToolInjected: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
            promptProfileIds: claudeEnriched.promptProfileIds,
            promptProfileHashes: claudeEnriched.promptProfileHashes,
            prefixHash: claudeEnriched.prefixHash,
            prefixChangeReasons: claudeEnriched.prefixChangeReasons,
            contextAdmission: claudeContextAdmission,
            countMessageRoles,
            pushDiagnostic: (diagnostic) => pushDiagnostic(diagnostic as unknown as RequestDiagnostic),
            recordSessionEvent,
            persistDecisionTelemetry: persistClaudeDecisionTelemetry,
          },
        },
      });
      return reply;
    }

    // Non-streaming
    const started = Date.now();
    const claudeNonStreamScope = createClaudeNonStreamRouteScope({
      sessionKey: claudeSessionKey,
      userId: claudeIdentity.userId,
      orgId: claudeIdentity.orgId,
      requestId: reqId,
      recordSessionEvent,
      persistDecisionTelemetry: persistClaudeDecisionTelemetry,
    });
    const claudeNonStreamToolSideEffects = createRouteToolCallSideEffects({
      session,
      sessionKey: claudeSessionKey,
      userId: claudeIdentity.userId,
      orgId: claudeIdentity.orgId,
      requestId: reqId,
      clientKind: claudeClientKind,
      upperHarnessComponent: "upper-harness:claude",
      logger: app.log as never,
      strictGovernanceStats: openClawProfileStats,
      updateDiffAccumulator,
      maybeUpdateTaskLedgerFromToolCall,
      emitPlanWriteAuditEvent,
      maybeLogEnvelopeUnwrapSample,
      recordUpperHarnessDecision,
    });
    const claudeNonStreamResult = await runClaudeNonStreamPipeline(createClaudeNonStreamRoutePipelineInput({
      scope: claudeNonStreamScope,
      resolvedModelId: resolved.resolvedModelId,
      circuitBreakers,
      logger: app.log,
      startSpan: () => getTracer().startSpan("yarn.claude.generate", {
        model: resolved.resolvedModelId,
        sessionKey: claudeSessionKey,
      }),
      extractUpstreamErrorDiagnostics,
      providerRouteInput: {
        initialMessages: claudeModelMessages as Array<{ role: string; content?: unknown }>,
        model: resolved.model,
        resolvedModelId: resolved.resolvedModelId,
        orchestrationMaxOutputTokens: claudeOrchestration.maxOutputTokens,
        requestMaxTokens: body.max_tokens,
        samplingOptions: claudeSamplingOptions,
        stopSequences: sdkStop,
        tools: sdkTools,
        initialToolChoice: effectiveClaudeToolChoice,
        providerOptions,
        phasePolicy: claudePhasePolicy,
        governorPhase: claudeGovernorPhase,
        nativeWebSearchRequested: claudeNativeWebSearchRequested,
        clampMaxOutputTokens: clampMaxOutputTokensForSafety,
        generateText: (options) => generateText(options as never),
        readUsage,
        scope: claudeNonStreamScope,
        forensics: {
          path: "/v1/messages",
          stream: false,
          tools: effectiveClaudeTools as unknown[],
          phasePolicy: claudeForensicsPhasePolicy,
          capabilityMatrix: claudeForensicsCapabilityMatrix,
          capture: (context) => captureRequestForensics(
            context.sessionKey,
            context.requestId,
            context.path,
            context.resolvedModelId,
            context.stream,
            context.messages as Array<{ role: string; content: unknown }>,
            context.tools as unknown[],
            context.toolChoice,
            context.providerOptions,
            context.phasePolicy,
            context.capabilityMatrix,
          ),
          finalize: (forensics, forensicUsage, context) => finalizeRequestForensics(
            session,
            context.requestId,
            forensics as { record: RequestForensicsRecord; serialized: string } | null,
            forensicUsage,
          ),
        },
        isServerWebSearchTool: isClaudeWebSearchToolName,
        serverWebSearch: {
          conversationId: session.record.conversationId || undefined,
          sourceSurface: "yarn_chat",
          toolName: "web_search",
          resolve: (input, context) => webSearch.resolve(
            input,
            webSearchResolveContext(claudeAuthUser, req, context),
          ),
        },
        toServerWebSearchEvent: toClaudeServerWebSearchEvent,
      },
      postprocessRouteInput: {
        readUsage,
        scope: claudeNonStreamScope,
        resolvedModelId: resolved.resolvedModelId,
        clientRequestedModel: body.model,
        toolCallInput: {
          adapter: claudeAdapter,
          clientKind: claudeClientKind,
          strictGovernance: claudeOpenClawStrictGovernance,
          upperHarness: claudeUpperHarness,
          recentToolNames: claudeRecentCallsForSteering.map((call) => call.toolName),
          pathContext: effectiveClaudePathCtx,
          enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
          blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
          pathSandboxEnabled: config.SYNESIS_YARN_PATH_SANDBOX_ENABLED,
          planModeRequested: claudeClientToolCapabilities.planModeRequested,
          session,
          restrictDiscoveryForPlanWork: claudeSensemakingDecision?.shouldRestrictDiscovery,
          taskCue: claudeTaskCue,
          normalizedMessageCount: (normalizedFromClaude.messages as Array<{ role: string }>).length,
          artifactShadows: claudeArtifactShadows,
          stats: toolArgHardeningStats,
          logger: app.log,
          isWriteCapableToolName,
          shouldRestrictDiscoveryForPlanWork,
          deserializePlanShadow: deserializeShadow,
          buildPathSandboxPolicy: buildDefaultPolicy,
          ...claudeNonStreamToolSideEffects,
        },
        discoveryInput: {
          projectRoot: effectiveClaudePathCtx.projectRoot ?? effectiveClaudePathCtx.shellCwd,
          getTopLevelDirs: getCachedTopLevelDirs,
          applyDiscoveryGuardrail: applyDiscoveryToolGuardrail,
          buildBlockedDiscoveryRecovery: buildBlockedDiscoveryRecoverySnapshot,
          recordBlockedDiscovery,
          getBlockedDiscoveryCount,
          recordSessionEvent,
        },
        finalizerInput: {
          session,
          checklist: claudeRequirementChecklist,
          traceRootPrompt: getMetadataString(session.record.metadata, "trace_root_prompt"),
          latestUserPrompt: getMetadataString(session.record.metadata, "latest_user_prompt"),
          verification: claudeVerificationAssessment,
          recentToolNames: extractRecentToolNames(openAIShape.messages as Array<{ role: string; content: unknown }>),
          planGraph: claudePlanGraph,
          responseStyleMode: config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
          applyMarkdownGuardrail,
          finalizeCompletionText,
          recordSessionEvent,
        },
        telemetryInput: {
          startedAtMs: started,
          reductions: { toolResultReduction, validationNormalization },
          reducedToolResults: claudeToolResultCount,
          orchestration: claudeOrchestration,
          policyMatchedRules: claudePolicyPrecheck.matchedRules,
          evidencePrefetched: claudeEvidencePrefetched,
          evidencePrefetchHit: claudePrefetchResult?.matched && (claudePrefetchResult?.confidence ?? 0) > 0,
          evidenceConfidence: claudeCombinedConfidence || undefined,
          evidenceAuthoritative: claudePrefetchResult?.authoritative,
          evidencePrefetchLatencyMs: claudePrefetchResult ? Math.round(claudePrefetchResult.latencyMs) : undefined,
          evidenceQuality: buildEvidenceTraceSummary(claudePrefetchResult, claudePatternResult),
          sensemakingTriggered: claudeSensemakingResult?.triggered,
          sensemakingReason: claudeSensemakingResult?.reason,
          governorDecision: claudeExecutionGovernor,
          governorChatStateSummary: claudePauseChatSummary,
          governorFileStateSummary: claudePauseFileSummary,
          normalizedMessages: openAIShape.messages as Array<{ role: string; content: unknown }>,
          inferVerificationSteps,
          trajectoryDiagnostics: claudeTrajectoryDiagnostics,
          toolDefinitionCount: effectiveClaudeTools.length,
          artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
          knowledgeToolInjected: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
          promptProfileIds: claudeEnriched.promptProfileIds,
          promptProfileHashes: claudeEnriched.promptProfileHashes,
          prefixHash: claudeEnriched.prefixHash,
          prefixChangeReasons: claudeEnriched.prefixChangeReasons,
          requirementChecklistMust: claudeRequirementChecklist?.must.length || undefined,
          requirementChecklistShould: claudeRequirementChecklist?.should.length || undefined,
          contextAdmission: {
            decision: claudeContextAdmission.decision,
            reason: claudeContextAdmission.reason,
            estimatedTokens: claudeContextAdmission.estimatedTokens,
            estimatedChars: claudeContextAdmission.estimatedChars,
          },
          cacheShapeDiagnostics: claudeCacheShapeDiagnostics,
          countMessageRoles,
          pushDiagnostic,
        },
      },
    }));
    if (claudeNonStreamResult.kind === "error") {
      for (const [header, value] of Object.entries(claudeNonStreamResult.headers ?? {})) {
        reply.header(header, value);
      }
      return reply.code(claudeNonStreamResult.statusCode).send(claudeNonStreamResult.body);
    }
    const claudePostProvider = claudeNonStreamResult.processed;

    applyClarificationRoundResponseHeader(reply, session.record.metadata);
    return reply.send(buildClaudeNonStreamMessageResponse({
      id: `msg_${crypto.randomUUID()}`,
      model: resolved.resolvedModelId,
      content: claudePostProvider.content,
      stopReason: claudePostProvider.stopReason,
      usage: claudePostProvider.usage,
    }));
  });
}
