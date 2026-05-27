import { computeEfficiencyIndex, type PlatformRouteDependencies } from "./platform-route-support.js";

function telemetryUnavailable(name: string, reason = "missing_dependency"): { available: false; name: string; reason: string } {
  return { available: false, name, reason };
}

function telemetryValue(name: string, producer: () => unknown): unknown {
  try {
    const value = producer();
    return value ?? telemetryUnavailable(name, "empty_value");
  } catch (error) {
    return {
      available: false,
      name,
      reason: "stats_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function statsValue(name: string, provider: unknown): unknown {
  return telemetryValue(name, () => {
    if (!provider || typeof provider !== "object" || typeof (provider as { getStats?: unknown }).getStats !== "function") {
      return telemetryUnavailable(name);
    }
    return (provider as { getStats(): unknown }).getStats();
  });
}

function methodValue(name: string, target: unknown, methodName: string): unknown {
  return telemetryValue(name, () => {
    if (!target || typeof target !== "object" || typeof (target as Record<string, unknown>)[methodName] !== "function") {
      return telemetryUnavailable(name);
    }
    return ((target as Record<string, () => unknown>)[methodName])();
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function registerTelemetryRoutes(deps: PlatformRouteDependencies): void {
  const {
    app,
    config,
    authResolver,
    userRateLimiter,
    requireInternalToken,
    usageWriter,
    sessions,
    validationNormalization,
    toolResultReduction,
    transcriptPruning,
    contentDedupBySession,
    toolArgHardeningStats,
    toolSchemaPruningStats,
    toolBlobRedisEnabled,
    openClawProfileStats,
    contextAdmissionStats,
    workingFrameService,
    projectManifestService,
    policyEngine,
    governanceClient,
    phaseOrchestrator,
    clientAdapterPacks,
    stablePrefixService,
    yarnToolPrefixCache,
    artifactRetrieval,
    knowledgeSearch,
    getEvidencePrefetchStats,
    getPatternPrefetchStats,
    getPatternFeedbackStats,
    artifactStore,
    circuitBreakers,
    distributedCounters,
    streamAdmission,
    attentionPositioning,
    languagePacksConformance,
    sessionContinuity,
    enrichmentPool,
    sensemakingStats,
    getEventLoopStats,
    promptSnapshotRegistry,
    diagnosticRegistry,
  } = deps;

  app.get("/health/telemetry", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
    }
    let activeSessionCount = 0;
    let totalHistoryEntries = 0;
    let checkpointedSessions = 0;
    for (const [, state] of sessions ?? []) {
      activeSessionCount++;
      const history = Array.isArray(state?.history) ? state.history : [];
      totalHistoryEntries += history.length;
      if (history.some((m) => typeof m.content === "string" && m.content.includes("<ARCHITECTURAL_STATE>"))) {
        checkpointedSessions++;
      }
    }
    const diagnosticRing = recordValue(telemetryValue("diagnosticRegistry.ring", () => diagnosticRegistry.getRingStats()));
    const contextAdmission = recordValue(contextAdmissionStats);
    return {
      timestamp: Date.now(),
      writeQueue: statsValue("usageWriter", usageWriter),
      validationNormalization: statsValue("validationNormalization", validationNormalization),
      toolResultReduction: statsValue("toolResultReduction", toolResultReduction),
      transcriptPruning: statsValue("transcriptPruning", transcriptPruning),
      contentAddressedDedup: {
        activeSessions: contentDedupBySession?.size ?? 0,
        aggregate: Array.from(contentDedupBySession?.values() ?? []).reduce(
          (acc, d) => {
            const s = d?.getStats?.() ?? { totalReads: 0, deduplicatedReads: 0, charsSaved: 0 };
            return {
              totalReads: acc.totalReads + s.totalReads,
              deduplicatedReads: acc.deduplicatedReads + s.deduplicatedReads,
              charsSaved: acc.charsSaved + s.charsSaved,
            };
          },
          { totalReads: 0, deduplicatedReads: 0, charsSaved: 0 },
        ),
      },
      toolArgHardening: { ...recordValue(toolArgHardeningStats) },
      toolSchemaPruning: { ...recordValue(toolSchemaPruningStats) },
      openClawProfile: { ...recordValue(openClawProfileStats) },
      contextAdmission: { ...contextAdmission, byPath: { ...recordValue(contextAdmission.byPath) } },
      workingFrame: statsValue("workingFrameService", workingFrameService),
      projectManifest: statsValue("projectManifestService", projectManifestService),
      deterministicPolicy: statsValue("policyEngine", policyEngine),
      governance: governanceClient ? statsValue("governanceClient", governanceClient) : { enabled: false },
      phaseOrchestrator: statsValue("phaseOrchestrator", phaseOrchestrator),
      clientAdapterPacks: statsValue("clientAdapterPacks", clientAdapterPacks),
      sawtoothContext: {
        activeSessionCount,
        totalHistoryEntries,
        checkpointedSessions,
        checkpointThreshold: config.SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS,
      },
      stablePrefix: statsValue("stablePrefixService", stablePrefixService),
      toolPrefixCache: yarnToolPrefixCache ? statsValue("yarnToolPrefixCache", yarnToolPrefixCache) : { enabled: false },
      artifactRetrieval: statsValue("artifactRetrieval", artifactRetrieval),
      knowledgeSearch: statsValue("knowledgeSearch", knowledgeSearch),
      evidencePrefetch: telemetryValue("evidencePrefetch", getEvidencePrefetchStats),
      patternPrefetch: telemetryValue("patternPrefetch", getPatternPrefetchStats),
      patternFeedback: telemetryValue("patternFeedback", getPatternFeedbackStats),
      artifactStore: statsValue("artifactStore", artifactStore),
      circuitBreakers: statsValue("circuitBreakers", circuitBreakers),
      userRateLimiter: statsValue("userRateLimiter", userRateLimiter),
      distributedCounters: statsValue("distributedCounters", distributedCounters),
      streamAdmission: statsValue("streamAdmission", streamAdmission),
      attentionPositioning: statsValue("attentionPositioning", attentionPositioning),
      compressionEfficiencyIndex: telemetryValue("compressionEfficiencyIndex", () => computeEfficiencyIndex(toolResultReduction)),
      recall: methodValue("toolResultReduction.recall", toolResultReduction, "getRecallStats"),
      verification: methodValue("toolResultReduction.verification", toolResultReduction, "getVerificationStats"),
      languagePacks: telemetryValue("languagePacks", languagePacksConformance),
      sessionContinuity: statsValue("sessionContinuity", sessionContinuity),
      conversationMemory: methodValue("usageWriter.conversationMemory", usageWriter, "getConversationMemoryStats"),
      workerPool: statsValue("enrichmentPool", enrichmentPool),
      sensemaking: sensemakingStats,
      eventLoopLag: telemetryValue("eventLoopLag", getEventLoopStats),
      promptLibrary: {
        loaded: Boolean(promptSnapshotRegistry),
        service: promptSnapshotRegistry?.service ?? "yarn",
        profiles: promptSnapshotRegistry?.profiles.length ?? 0,
        assignments: promptSnapshotRegistry?.assignments.length ?? 0,
        profileHashes: (promptSnapshotRegistry?.profiles ?? []).map((p) => p.content_hash).slice(0, 12),
        updatedAt: promptSnapshotRegistry?.updated_at ?? null,
      },
      connectionPools: {
        auth: methodValue("authResolver.pool", authResolver, "getPoolStats"),
        usageWriter: methodValue("usageWriter.pool", usageWriter, "getPoolStats"),
      },
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      diagnosticRingMax: diagnosticRing.max ?? null,
      diagnosticRingCurrent: diagnosticRing.current ?? null,
      featureFlags: {
        toolBlobRedis: toolBlobRedisEnabled,
        artifactRedisReplica: config.SYNESIS_YARN_ARTIFACT_REDIS_REPLICA_ENABLED,
        sensemakingPromptBlocks: config.SYNESIS_YARN_SENSEMAKING_PROMPT_BLOCK_ENABLED,
        stablePrefix: config.SYNESIS_YARN_STABLE_PREFIX_ENABLED,
        jsonCompaction: config.SYNESIS_YARN_JSON_COMPACTION_ENABLED,
        attentionPositioning: config.SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED,
        artifactRetrieval: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
        knowledgeSearch: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
        evidencePrefetch: config.SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED,
        governance: config.SYNESIS_YARN_GOVERNANCE_ENABLED,
        governanceBypass: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
        sessionContinuity: config.SYNESIS_YARN_SESSION_CONTINUITY_ENABLED,
        conversationMemory: config.SYNESIS_YARN_CONVERSATION_MEMORY_ENABLED,
        crossConversationRecall: config.SYNESIS_YARN_CROSS_CONVERSATION_RECALL_ENABLED,
        workerPool: config.SYNESIS_YARN_WORKER_POOL_ENABLED,
        contentDispatch: config.SYNESIS_YARN_CONTENT_DISPATCH_ENABLED,
        transcriptPruning: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED,
        promptIntakeSteer: config.SYNESIS_YARN_PROMPT_INTAKE_STEER_ENABLED,
        patternRecall: config.SYNESIS_YARN_PATTERN_RECALL_ENABLED,
        recallBypass: config.SYNESIS_YARN_RECALL_BYPASS_ENABLED,
        verificationPlan: config.SYNESIS_YARN_VERIFICATION_PLAN_ENABLED,
        completionGate: config.SYNESIS_YARN_COMPLETION_GATE_ENABLED,
        completionGateHardFail: config.SYNESIS_YARN_COMPLETION_GATE_HARD_FAIL,
        completionGateSkipClarification: config.SYNESIS_YARN_COMPLETION_GATE_SKIP_CLARIFICATION,
        planningUseHorizon: config.SYNESIS_YARN_PLANNING_USE_HORIZON,
        plannerTodoPacket: config.SYNESIS_YARN_PLANNER_TODO_PACKET_ENABLED,
        plannerTodoRequireNativeTool: config.SYNESIS_YARN_PLANNER_TODO_REQUIRE_NATIVE_TOOL,
        decisionMatrix: config.SYNESIS_YARN_DECISION_MATRIX_ENABLED,
        sensemaking: config.SYNESIS_YARN_SENSEMAKING_ENABLED,
        diagnosticPersistence: config.SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED,
        claudeToolSearchMode: config.SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE,
        jitterBuffer: config.SYNESIS_YARN_JITTER_BUFFER_ENABLED,
        sortedTools: config.SYNESIS_YARN_SORTED_TOOLS_ENABLED,
        debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
        otelEnabled: config.SYNESIS_YARN_OTEL_ENABLED,
      },
      safetyLimits: {
        hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER,
        sessionSoftMaxInputTokens: config.SYNESIS_YARN_SESSION_SOFT_MAX_INPUT_TOKENS,
        sessionMaxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
        sessionBudgetMode: config.SYNESIS_YARN_SESSION_BUDGET_MODE,
        contextAdmissionMode: config.SYNESIS_YARN_CONTEXT_ADMISSION_MODE,
        contextAdmissionWarnTokens: config.SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS,
        contextAdmissionHardTokens: config.SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS,
        hourlyTokenThrottleEnabled: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_ENABLED,
        hourlyTokenThrottleWindowMs: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_WINDOW_MS,
        hourlyTokenThrottleSessionLimit: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_SESSION_LIMIT,
        hourlyTokenThrottleUserLimit: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_USER_LIMIT,
        maxOutputTokensSafetyCeiling: config.SYNESIS_YARN_MAX_OUTPUT_TOKENS_SAFETY_CEILING,
        consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
        consecutiveToolCallsPivot: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT,
        stagnantToolCyclesLimit: config.SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT,
        toolLoopNoUserAckLimit: config.SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT,
        toolLoopSoftFailEnabled: config.SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED,
        maxConcurrentStreams: config.SYNESIS_YARN_MAX_CONCURRENT_STREAMS,
        streamQueueMaxDepth: config.SYNESIS_YARN_STREAM_QUEUE_MAX_DEPTH,
        streamQueueWaitTimeoutMs: config.SYNESIS_YARN_STREAM_QUEUE_WAIT_TIMEOUT_MS,
      },
    };
  });
}
