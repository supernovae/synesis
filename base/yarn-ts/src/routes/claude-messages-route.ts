import type { ClaudeMessagesRouteDependencies } from "../server/route-dependencies.js";
import { parseOrchestratorPhaseHeader } from "../validation/orchestrator-phase.js";
import { prepareClaudeProviderRuntimeForRoute } from "../pipeline/claude-provider-runtime-preparation.js";
import { runClaudeMessagesDispatchForRoute } from "../pipeline/claude-messages-dispatch.js";
import {
  policyRejectClaudeBody,
  sendClaudeSoftFail,
  sendClaudeWorkspaceHandshake,
} from "../protocol/route-response-senders.js";
import {
  mergeSessionPathHints,
} from "../state/workspace-session-boundary.js";
import { toSessionExecutionContextSystemBlock } from "../adapters/session-execution-context.js";
import { prepareClaudeContext } from "../pipeline/claude-context-preparation.js";
import { prepareClaudeGovernance } from "../pipeline/claude-governance-preparation.js";
import { runClaudePolicyPrecheck } from "../pipeline/claude-policy-precheck.js";
import { prepareClaudeMessagesRoute } from "../pipeline/claude-messages-route-preparation.js";
import {
  injectGovernorRecoveryMessage,
} from "../pipeline/route-tool-preparation.js";
import {
  resetQwenInterventionOnUserTurn,
} from "../pipeline/route-adapter-pivot.js";
import {
  runEvidencePrefetch,
  runPatternPrefetch,
} from "../evidence/fast-path.js";
import { detectToolProgress } from "../policy/tool-progress-detector.js";
import {
  evaluateYarnPromptIntakeSteer,
} from "../upper-harness/bridge.js";
import {
  evaluateExecutionGovernor,
  buildExecutionGovernorHardStopUserMessage,
  buildExecutionGovernorPauseEnvelope,
  inferGovernorPhaseFromMessages,
  extractCommandEvents,
  extractEditedFileHints,
  isPlanRecoveryDiscoveryIntent,
} from "../governance/execution-governor.js";
import {
  persistGovernorPauseSoftFail,
  resetGovernorPauseRecoveryState,
} from "../governance/governor-pause-route.js";
import {
  evaluateSensemakingGovernor,
  compareSensemakingWithLegacy,
  buildSensemakingPauseMessage,
  buildSensemakingGuidanceInjection,
} from "../governance/sensemaking-governor.js";
import { buildArtifactShadows, summarizeArtifactContext } from "../governance/artifact-shadow.js";
import { summarizeEvidenceDelta } from "../governance/evidence-delta.js";
import { deriveChatState } from "../governance/chat-state.js";
import { deriveFileState } from "../governance/file-state.js";
import {
  assessStateConfidence,
  formatStateConfidenceBlock,
} from "../governance/state-confidence.js";
import { projectInstructionFilePresent } from "../governance/workspace-boundary.js";
import { createDiffStats } from "../governance/diff-accumulator.js";
import { OptimizationLedger } from "../telemetry/optimization-ledger.js";

type AuthUser = import("../auth.js").AuthUser;
type FastPathResult = import("../evidence/fast-path.js").FastPathResult;
type PatternPrefetchResult = import("../evidence/fast-path.js").PatternPrefetchResult;
type GovernorInputMessage = import("../governance/execution-governor.js").GovernorInputMessage;
type SensemakingResult = import("../sensemaking/index.js").SensemakingResult;
type SessionPathHints = import("../state/workspace-session-boundary.js").SessionPathHints;
type WorkflowPhase = import("../orchestration/phase-model-orchestrator.js").WorkflowPhase;

export function registerClaudeMessagesRoute(deps: ClaudeMessagesRouteDependencies): void {
  const {
    runtime: {
      app,
      config,
      withSpan,
    },
    auth: {
      authResolver,
      fgaCheck,
      userRateLimiter,
    },
    protocol: {
      extractTextFromUnknownContent,
      resolveRequestId,
    },
    session: {
      maybeCheckpoint,
      casSessionSave,
      clearGovernorPauseContextMetadata,
      distributedCounters,
      persistGovernorPauseContextMetadata,
      persistPromptIntakeSnapshot,
      persistStateConfidence,
      prepareProtocolPauseState,
      readPersistedChatStateSnapshot,
      recordPromptIntakeEvent,
      recordSessionEvent,
      sessionPersistenceRunner,
    },
    workspace: {
      lastToolUseIdFromClaudeMessages,
      pinchCompactionBackendModelMetadata,
      processWorkspaceHandshakeRoute,
      workingFrameService,
    },
    reduction: {
      getFileSnapshotRegistry,
      sliceMessagesSinceLastUserPrompt,
      toolResultReduction,
    },
    tools: {
      getBlockedDiscoveryCount,
      shouldStripGlobFromTools,
      stripGlobFromTools,
    },
    governance: {
      analyzeRecentCommandLoop,
      applySensemakingStats,
      assessProportionality,
      chatPhaseFromWorkflowPhase,
      classifyIntentScope,
      classifyLatestReadRefresh,
      classifyLatestToolProgress,
      collectToolExecutionFailureObservations,
      countTurnsSinceLastUser,
      deriveEditContextMissGuardState,
      governanceClient,
      GOVERNOR_COOLDOWN_MS,
      hashTextSignal,
      isGenuineUserPromptMessage,
      logAndPersistSafetyEvent,
      looksLikeFailureSignal,
      normalizedToolOutputSignal,
      phaseFromFrame,
      phaseOrchestrator,
      policyEngine,
      proportionalityToSignal,
      resolveWorkingPhase,
      runSensemaking,
      sensemakingStats,
    },
    planning: {
      applyObjectiveScopeAndPersist,
      buildGovernorPauseResumeBlockForUser,
      classifyToolResultAsEvidence,
      detectLanguagesFromMessages,
      getChecklistSourceHash,
      maybeBuildPlannerTodoPacketBlock,
      maybeUpdateTaskLedgerFromEvidence,
      refreshRequirementChecklist,
      refreshTaskIntake,
      updatePlanGraph,
    },
    evidence: {
      knowledgeResolveContext,
      knowledgeSearch,
    },
    adapter: {
      clientAdapterPacks,
    },
  } = deps;

  // --- Claude Messages API ---
  app.post("/v1/messages", async (req, reply) => {
    const claudeOptLedger = new OptimizationLedger();
    const endClaudeIngressStage = claudeOptLedger.startStage("ingress");
    let claudeAuthUser: AuthUser;
    try {
      claudeAuthUser = await authResolver.resolve(req.headers.authorization);
    } catch {
      endClaudeIngressStage();
      return reply.code(401).send({
        type: "error",
        error: { type: "authentication_error", message: "Authentication required" }
      });
    }
    try {
      authResolver.requireCoderScope(claudeAuthUser);
    } catch {
      endClaudeIngressStage();
      return reply.code(403).send({ type: "error", error: { type: "permission_error", message: "Insufficient scope" } });
    }
    const claudeFgaResult = await fgaCheck(`user:${claudeAuthUser.userId}`, "can_invoke", "yarn_endpoint", "messages");
    if (!claudeFgaResult.allowed) {
      endClaudeIngressStage();
      return reply.code(403).send({ type: "error", error: { type: "permission_error", message: "Authorization denied by policy" } });
    }

    const claudeRateResult = await userRateLimiter.check(claudeAuthUser.userId);
    if (!claudeRateResult.allowed) {
      endClaudeIngressStage();
      app.log.warn({ userId: claudeAuthUser.userId, count: claudeRateResult.currentCount, limit: claudeRateResult.limit }, "rate_limit_rejected_claude");
      recordSessionEvent("", claudeAuthUser.userId, claudeAuthUser.orgId, "rate_limit_reject", "user-rate-limiter",
        `${claudeRateResult.currentCount}/${claudeRateResult.limit} in window — retry after ${claudeRateResult.retryAfterSeconds}s`);
      reply.header("Retry-After", String(claudeRateResult.retryAfterSeconds));
      return reply.code(429).send({ type: "error", error: { type: "rate_limit_error", message: `Rate limit exceeded. Retry after ${claudeRateResult.retryAfterSeconds} seconds.` } });
    }

    const anthropicVersion = req.headers["anthropic-version"];
    if (!anthropicVersion || typeof anthropicVersion !== "string") {
      endClaudeIngressStage();
      return reply.code(400).send({
        type: "error",
        error: { type: "invalid_request_error", message: "Missing required header: anthropic-version" }
      });
    }
    const traceReqId = resolveRequestId(req.headers as Record<string, unknown>);
    endClaudeIngressStage();
    const endClaudeNormalizationStage = claudeOptLedger.startStage("normalization");
    const claudeRoutePreparation = await prepareClaudeMessagesRoute({
      deps,
      request: req,
      authUser: claudeAuthUser,
      requestId: traceReqId,
      anthropicVersion,
    });
    endClaudeNormalizationStage();
    if (!claudeRoutePreparation.ok) {
      return reply.code(claudeRoutePreparation.statusCode).send(claudeRoutePreparation.body);
    }
    const {
      body,
      taskCue: claudeTaskCue,
      clientKind: claudeClientKind,
      compactionOptions: claudeCompactionOpts,
      phasePolicyEnabledByMatrix: claudePhasePolicyEnabledByMatrix,
      forensicsCapabilityMatrix: claudeForensicsCapabilityMatrix,
      processedTools,
      normalizedFromClaude,
      toolResultCount: claudeToolResultCount,
      trajectoryDiagnostics: claudeTrajectoryDiagnostics,
      verificationAssessment: claudeVerificationAssessment,
      adapterProfile: claudeAdapterProfile,
      openClawStrictGovernance: claudeOpenClawStrictGovernance,
      pathContext: claudePathCtx,
      adapterBlock: claudeAdapterBlock,
      latestUser: latestClaudeUser,
      manifest: claudeManifest,
      identity: claudeIdentity,
      sessionKey: claudeSessionKey,
      session,
      runtimePreferences: claudeRuntimePreferences,
      clientToolCapabilities: claudeClientToolCapabilities,
      workspaceInspection: claudeWorkspaceInspection,
    } = claudeRoutePreparation;
    claudeOptLedger.recordOriginal(normalizedFromClaude.messages as Array<{ content?: unknown }>);
    claudeOptLedger.recordAfterNormalization(normalizedFromClaude.messages as Array<{ content?: unknown }>);

    const endClaudePruningStage = claudeOptLedger.startStage("pruning");
    const priorClaudeChecklistHash = getChecklistSourceHash(session.record.metadata);
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
    endClaudePruningStage();
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
    const effectiveClaudePathCtx = mergeSessionPathHints(claudePathCtx, session);
    const buildEffectiveClaudeAdapterBlock = (pathCtx: SessionPathHints): string | undefined => {
      const ctxBlock = toSessionExecutionContextSystemBlock(pathCtx);
      if (!ctxBlock) return claudeAdapterBlock;
      return `${clientAdapterPacks.toSystemBlock(claudeAdapterProfile)}\n\n${ctxBlock}`;
    };
    const effectiveClaudeAdapterBlock = buildEffectiveClaudeAdapterBlock(effectiveClaudePathCtx);

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

    const claudeLastToolUseId = lastToolUseIdFromClaudeMessages(
      body.messages as Array<{ role: string; content: unknown }>,
    );
    const claudeUserIsRealAck = isGenuineUserPromptMessage(latestClaudeUser);
    const endClaudeContextStage = claudeOptLedger.startStage("context");
    const claudeContext = await prepareClaudeContext({
      config,
      logger: app.log,
      session,
      sessionKey: claudeSessionKey,
      identity: claudeIdentity,
      requestId: traceReqId,
      requestedModel: body.model,
      latestUser: latestClaudeUser,
      latestUserIsRealAck: claudeUserIsRealAck,
      taskCue: claudeTaskCue,
      normalizedMessages: normalizedFromClaude.messages as never,
      manifest: claudeManifest,
      recallDecision: claudeRecallDecision,
      verificationState: claudeVerifState,
      workingPhase: claudeWorkingPhase,
      workingFrameGoal: claudeWorkingFrameGoal,
      workspaceInspection: claudeWorkspaceInspection,
      latestReadRefresh: claudeLatestReadRefresh,
      editMissGuard: claudeEditMissGuard,
      knowledgeSearch,
      knowledgeContext: knowledgeResolveContext(claudeAuthUser, req),
      phaseOrchestrator,
      pinchCompactionBackendModelMetadata,
      runEvidencePrefetch,
      runPatternPrefetch,
      runSensemaking: (sensemakingInput) => runSensemaking(sensemakingInput as never),
      detectLanguagesFromMessages,
      applySensemakingStats,
      sensemakingStats,
      hashTextSignal,
      resetQwenInterventionOnUserTurn,
      detectToolProgress: (progressSession, messages, options) => detectToolProgress(
        progressSession as typeof session,
        messages as never,
        options,
      ),
      normalizedToolOutputSignal,
      looksLikeFailureSignal,
      analyzeRecentCommandLoop: (messages) => analyzeRecentCommandLoop(messages as never),
      buildArtifactShadows,
      getFileSnapshotRegistry,
      summarizeArtifactContext,
      deriveFileState: (fileStateInput) => deriveFileState(fileStateInput as never),
      readPersistedChatStateSnapshot,
      deriveChatState: (messages, options) => deriveChatState(messages, options as never),
      chatPhaseFromWorkflowPhase,
      classifyIntentScope,
      createDiffStats,
      applyObjectiveScopeAndPersist: (scopeInput) => applyObjectiveScopeAndPersist(scopeInput as never),
      extractTextFromUnknownContent,
      assessStateConfidence: (confidenceInput) => assessStateConfidence(confidenceInput as never),
      projectInstructionFilePresent,
      persistStateConfidence,
      formatStateConfidenceBlock,
      prepareProtocolPauseState,
      recordSessionEvent,
    });
    endClaudeContextStage();
    const claudePrefetchResult = claudeContext.prefetchResult as FastPathResult | undefined;
    const claudePatternResult = claudeContext.patternResult as PatternPrefetchResult | undefined;
    const claudeCombinedConfidence = claudeContext.combinedConfidence;
    const claudeOrchestration = claudeContext.orchestration as ReturnType<typeof phaseOrchestrator.decide>;
    const claudeEvidencePrefetched = claudeContext.evidencePrefetched;
    const claudeSensemakingResult = claudeContext.sensemakingResult as SensemakingResult | undefined;
    const claudeSensemakingBlock = claudeContext.sensemakingBlock;
    const latestClaudeUserHash = claudeContext.latestUserHash;
    const claudeToolProgress = claudeContext.toolProgress as ReturnType<typeof detectToolProgress>;
    const claudeCommandLoop = claudeContext.commandLoop as ReturnType<typeof analyzeRecentCommandLoop>;
    const claudeArtifactShadows = claudeContext.artifactShadows as ReturnType<typeof buildArtifactShadows>;
    const claudeArtifactContext = claudeContext.artifactContext as ReturnType<typeof summarizeArtifactContext>;
    const claudeFileState = claudeContext.fileState as ReturnType<typeof deriveFileState>;
    const claudeChatState = claudeContext.chatState as ReturnType<typeof deriveChatState>;
    const claudeObjectiveScope = claudeContext.objectiveScope as ReturnType<typeof applyObjectiveScopeAndPersist>;
    const claudeScopedMessages = claudeContext.scopedMessages as ReturnType<typeof applyObjectiveScopeAndPersist>["scopedMessages"];
    const claudeStateConfidence = claudeContext.stateConfidence as ReturnType<typeof assessStateConfidence>;
    const claudeStateConfidenceBlock = claudeContext.stateConfidenceBlock;
    const claudeNeedsStateReground = claudeContext.needsStateReground;
    const claudePauseChatSummary = claudeContext.pauseChatSummary as ReturnType<typeof prepareProtocolPauseState>["pauseChatSummary"];
    const claudePauseFileSummary = claudeContext.pauseFileSummary as ReturnType<typeof prepareProtocolPauseState>["pauseFileSummary"];
    const claudePauseTaskContext = claudeContext.pauseTaskContext as ReturnType<typeof prepareProtocolPauseState>["pauseTaskContext"];
    const claudeChatStateBlock = claudeContext.chatStateBlock;
    const claudeFileStateBlock = claudeContext.fileStateBlock;
    const endClaudeGovernorStage = claudeOptLedger.startStage("governor");
    const claudeGovernance = await prepareClaudeGovernance({
      config,
      session,
      sessionKey: claudeSessionKey,
      identity: claudeIdentity,
      requestId: traceReqId,
      taskCue: claudeTaskCue,
      scopedMessages: claudeScopedMessages,
      planGraph: claudePlanGraph,
      editMissGuard: claudeEditMissGuard,
      latestToolProgress: claudeLatestToolProgress,
      toolFailures: claudeToolFailures,
      artifactShadows: claudeArtifactShadows,
      chatState: claudeChatState,
      fileState: claudeFileState,
      workingPhase: claudeWorkingPhase,
      editMissFailureCount: claudeEditMissFailureCount,
      stateConfidence: claudeStateConfidence,
      needsStateReground: claudeNeedsStateReground,
      objectiveScope: claudeObjectiveScope,
      artifactContext: claudeArtifactContext,
      pauseSummaries: {
        chat: claudePauseChatSummary,
        file: claudePauseFileSummary,
      },
      governorCooldownMs: GOVERNOR_COOLDOWN_MS,
      buildGovernorPauseResumeBlockForUser,
      evaluateExecutionGovernor,
      withSpan,
      extractCommandEvents,
      extractEditedFileHints,
      isPlanRecoveryDiscoveryIntent,
      assessProportionality,
      proportionalityToSignal,
      evaluateSensemakingGovernor: (executionGovernor, events, turnsSinceLastUser, changedFileCount, planRecoveryGrace, reserved, proportionalitySignal) =>
        evaluateSensemakingGovernor(
          executionGovernor,
          events as never,
          turnsSinceLastUser,
          changedFileCount,
          planRecoveryGrace,
          reserved as never,
          proportionalitySignal as never,
        ),
      compareSensemakingWithLegacy,
      countTurnsSinceLastUser,
      summarizeEvidenceDelta,
      recordSessionEvent,
    });
    const claudeExecutionGovernor = claudeGovernance.executionGovernor;
    const claudeGovernorPauseResumeBlock = claudeGovernance.governorPauseResumeBlock;
    const claudeSensemakingDecision = claudeGovernance.sensemakingDecision;

    const claudePolicy = await runClaudePolicyPrecheck({
      config,
      session,
      sessionKey: claudeSessionKey,
      identity: claudeIdentity,
      requestId: traceReqId,
      request: body,
      runtimePreferences: claudeRuntimePreferences,
      executionGovernor: claudeExecutionGovernor,
      commandLoop: claudeCommandLoop,
      lastToolUseId: claudeLastToolUseId,
      latestUserHash: latestClaudeUserHash,
      latestToolProgress: claudeLatestToolProgress,
      toolProgress: claudeToolProgress,
      orchestration: claudeOrchestration,
      workingPhase: claudeWorkingPhase,
      orchestratorPhaseOverride: claudeOrchestratorPhaseOverride,
      normalizedMessages: normalizedFromClaude.messages as GovernorInputMessage[],
      distributedCounters,
      policyEngine,
      governanceClient,
      shouldStripGlobFromTools,
      stripGlobFromTools,
      getBlockedDiscoveryCount,
      logWarn: (record, message) => app.log.warn(record, message),
      withSpan,
      logAndPersistSafetyEvent,
      persistSessionAndUsage: sessionPersistenceRunner.persistSessionAndUsage,
      maybeCheckpoint,
      recordSessionEvent,
    });
    const claudePolicyPrecheck = claudePolicy.policyPrecheck;
    const claudePolicyAction = claudePolicy.policyAction;
    if (claudePolicyAction.kind === "softFail") {
      endClaudeGovernorStage();
      return sendClaudeSoftFail(reply, claudeOrchestration.selectedModel, claudePolicyAction.content, !!body.stream);
    }
    if (claudePolicyAction.kind === "reject") {
      endClaudeGovernorStage();
      return reply.code(400).send(policyRejectClaudeBody(claudePolicyAction.decision as never));
    }
    const claudeClientToolInventory = claudePolicy.clientToolInventory;
    const claudeGovernorPhase = claudePolicy.governorPhase;

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
      endClaudeGovernorStage();
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
        endClaudeGovernorStage();
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
    endClaudeGovernorStage();

    const endClaudeProviderRequestStage = claudeOptLedger.startStage("provider_request");
    const claudeProviderRuntime = await prepareClaudeProviderRuntimeForRoute({
      deps,
      body,
      processedTools,
      normalizedMessages: normalizedFromClaude.messages as never,
      scopedMessages: claudeScopedMessages as never,
      session,
      sessionKey: claudeSessionKey,
      requestId: traceReqId,
      logRequestId: req.id,
      identity: claudeIdentity,
      pathContext: effectiveClaudePathCtx,
      adapterBlock: effectiveClaudeAdapterBlock,
      buildAdapterBlock: buildEffectiveClaudeAdapterBlock,
      orchestration: claudeOrchestration,
      toolResultCount: claudeToolResultCount,
      clientToolCapabilities: claudeClientToolCapabilities,
      clientKind: claudeClientKind,
      taskIntake: claudeTaskIntake,
      planGraph: claudePlanGraph,
      prefetchResult: claudePrefetchResult,
      patternResult: claudePatternResult,
      objectiveScope: claudeObjectiveScope,
      stateConfidenceBlock: claudeStateConfidenceBlock,
      governorPauseResumeBlock: claudeGovernorPauseResumeBlock,
      plannerTodoPacketBlock: claudePlannerTodoPacketBlock,
      chatStateBlock: claudeChatStateBlock,
      fileStateBlock: claudeFileStateBlock,
      requirementChecklist: claudeRequirementChecklist,
      sensemakingBlock: claudeSensemakingBlock,
      policyPrecheck: claudePolicyPrecheck,
      latestUser: latestClaudeUser,
      runtimePreferences: claudeRuntimePreferences,
      adapterProfile: claudeAdapterProfile,
      phasePolicyEnabledByMatrix: claudePhasePolicyEnabledByMatrix,
      governorPhase: claudeGovernorPhase,
      executionGovernor: claudeExecutionGovernor,
      editMissGuard: claudeEditMissGuard,
      needsStateReground: claudeNeedsStateReground,
      stateConfidence: claudeStateConfidence,
      clientToolInventory: claudeClientToolInventory,
      workspaceInspection: claudeWorkspaceInspection,
      latestReadRefresh: claudeLatestReadRefresh,
      promptIntake: claudePromptIntake,
      sensemakingDecision: claudeSensemakingDecision,
      taskCue: claudeTaskCue,
      chatState: claudeChatState,
      fileState: claudeFileState,
      compactionOptions: claudeCompactionOpts,
    });
    endClaudeProviderRequestStage();
    if (!claudeProviderRuntime.ok) {
      return reply.code(claudeProviderRuntime.statusCode).send(claudeProviderRuntime.body);
    }
    claudeOptLedger.recordFinal(
      claudeProviderRuntime.providerPreparation.modelMessages as Array<{ content?: unknown }>,
    );
    claudeOptLedger.recordCacheDiagnostics(claudeProviderRuntime.providerPreparation.cacheShapeDiagnostics);
    const endClaudeProviderStage = claudeOptLedger.startStage(body.stream ? "stream" : "provider");
    const claudeDispatchResult = await runClaudeMessagesDispatchForRoute({
      deps,
      request: req,
      reply,
      authUser: claudeAuthUser,
      body,
      session,
      sessionKey: claudeSessionKey,
      userId: claudeIdentity.userId,
      orgId: claudeIdentity.orgId,
      traceRequestId: traceReqId,
      clientKind: claudeClientKind,
      providerRuntime: claudeProviderRuntime,
      normalizedMessages: normalizedFromClaude.messages as Array<{ role: string; content: unknown }>,
      toolResultCount: claudeToolResultCount,
      policyMatchedRules: claudePolicyPrecheck.matchedRules,
      evidencePrefetched: claudeEvidencePrefetched,
      evidenceConfidence: claudeCombinedConfidence || undefined,
      prefetchResult: claudePrefetchResult,
      patternResult: claudePatternResult,
      sensemakingTriggered: claudeSensemakingResult?.triggered,
      sensemakingReason: claudeSensemakingResult?.reason,
      governorDecision: claudeExecutionGovernor,
      governorPhase: claudeGovernorPhase,
      governorChatStateSummary: claudePauseChatSummary,
      governorFileStateSummary: claudePauseFileSummary,
      trajectoryDiagnostics: claudeTrajectoryDiagnostics,
      artifactShadows: claudeArtifactShadows,
      requirementChecklist: claudeRequirementChecklist,
      verificationAssessment: claudeVerificationAssessment,
      planGraph: claudePlanGraph,
      strictGovernance: claudeOpenClawStrictGovernance,
      clientPlanModeRequested: claudeClientToolCapabilities.planModeRequested,
      restrictDiscoveryForPlanWork: claudeSensemakingDecision?.shouldRestrictDiscovery,
      taskCue: claudeTaskCue,
      orchestration: claudeOrchestration,
      forensicsCapabilityMatrix: claudeForensicsCapabilityMatrix,
    });
    endClaudeProviderStage();
    app.log.info({ reqId: traceReqId, ...claudeOptLedger.toLogRecord() }, "optimization_ledger");
    return claudeDispatchResult;
  });
}
