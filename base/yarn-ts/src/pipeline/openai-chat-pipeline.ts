import type { OpenAIChatCompletionRequest } from "../schemas.js";
import { OpenAIChatCompletionRequestSchema } from "../schemas.js";
import type { AppConfig } from "../config.js";
import type { AuthUser } from "../auth.js";
import type { GovernorService } from "../governance/governor-service.js";
import type { GovernorInputMessage } from "../governance/execution-governor.js";
import type { CanonicalChatRequest, PipelineContext, PipelineResult } from "./types.js";
import { normalizeToolDescriptions, type ToolDescriptionTruncation } from "../compat/tool-description-normalizer.js";
import { type SessionIdentity } from "../session/session-key.js";
import { buildProtocolSessionIdentity } from "../session/protocol-session.js";
import { resolvePipelineMode, shouldRunGovernorForMode, type PipelineModeResolution } from "./modes.js";
import type { OpenAIChatCompletionsRouteDependencies } from "../server/route-dependencies.js";
import type { OptimizationLedger } from "../telemetry/optimization-ledger.js";
import {
  runPreparedOpenAIChatProviderExecution,
  type PreparedOpenAIChatProviderExecutionInput,
  type PreparedOpenAIChatProviderExecutionResult,
} from "./openai-chat-provider-execution.js";
import { prepareOpenAIRouteNormalization } from "./openai-route-normalization.js";
import { prepareOpenAISessionWorkspace } from "./openai-session-workspace-preparation.js";
import { prepareOpenAIGovernedStage } from "./openai-governed-stage.js";
import { runOpenAIPostGovernanceProviderStage } from "./openai-post-governance-provider-stage.js";
export type { OpenAIChatPipelineResult, OpenAIChatReplyAdapter } from "./openai-chat-results.js";
export { sendOpenAIChatPipelineResult } from "./openai-chat-results.js";
import type { OpenAIChatPipelineResult } from "./openai-chat-results.js";

export interface OpenAIChatPipelineDeps {
  governorService?: Pick<GovernorService, "beforeProviderCall">;
}

export type OpenAIChatPipelineEnvironment = OpenAIChatPipelineDeps;

export interface OpenAIChatIngressSuccess {
  ok: true;
  request: OpenAIChatCompletionRequest;
  canonicalRequest: CanonicalChatRequest;
  modeResolution: PipelineModeResolution;
  bodyMetadata: Record<string, unknown> | null;
  clientKind: string;
  conversationId: string;
  requestUser: unknown;
  truncations: ToolDescriptionTruncation[];
}

export interface OpenAIChatIngressFailure {
  ok: false;
  statusCode: 400;
  body: { error: { type: "invalid_request_error"; message: string } };
  truncations: ToolDescriptionTruncation[];
}

export type OpenAIChatIngressResult = OpenAIChatIngressSuccess | OpenAIChatIngressFailure;

export interface OpenAIChatIdentityResolution {
  identity: SessionIdentity;
  identityUserId: string;
  displayName?: string;
}

export type OpenAIAuthenticatedRouteResult =
  | {
      kind: "pipeline";
      result: OpenAIChatPipelineResult;
      clarificationMetadata?: Record<string, unknown>;
    }
  | {
      kind: "workspaceHandshake";
      requestId: string;
      model: string;
      stream: boolean;
      toolCallId: string;
    }
  | {
      kind: "softFail";
      requestId: string;
      selectedModel: string;
      content: string;
      stream: boolean;
      envelope?: unknown;
    }
  | {
      kind: "policyReject";
      decision: unknown;
    };

function formatValidationError(error: { issues?: Array<{ path?: PropertyKey[]; message?: string }>; message: string }): string {
  const issue = error.issues?.[0];
  if (issue) {
    const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.map(String).join(".") : "request";
    const message = typeof issue.message === "string" && issue.message.trim() ? issue.message.trim() : "invalid value";
    return `Invalid request: ${path}: ${message}`;
  }
  return `Invalid request: ${error.message.slice(0, 500)}`;
}

function headerOne(headers: Record<string, unknown>, key: string): string | null {
  const raw = headers[key];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string" && entry.trim()) return entry.trim();
    }
  }
  return null;
}

function inferOpenAiClientKindFromUserAgent(ua: string): string | null {
  const normalized = ua.toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("opencode")) return "opencode";
  if (normalized.includes("roo") && normalized.includes("opencode")) return "roo-opencode";
  if (normalized.includes("claude-code") || normalized.includes("anthropic")) return "claude-code";
  if (normalized.includes("cursor")) return "cursor";
  if (normalized.includes("codex")) return "codex-cli";
  if (normalized.includes("goose")) return "goose";
  return null;
}

function resolveOpenAiClientKind(
  headers: Record<string, unknown>,
  metadata: Record<string, unknown> | null,
): string {
  const explicit = headerOne(headers, "x-synesis-client");
  if (explicit) return explicit;

  const candidates: unknown[] = metadata
    ? [
        metadata.synesis_client,
        metadata.client,
        metadata.client_name,
        metadata.synesis_acp_client_name,
      ]
    : [];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().toLowerCase().replace(/\s+/g, "-");
    }
  }

  const userAgent = headerOne(headers, "user-agent");
  if (userAgent) {
    const inferred = inferOpenAiClientKindFromUserAgent(userAgent);
    if (inferred) return inferred;
  }
  return "unknown";
}

function resolveOpenAiConversationId(
  bodyConversationId: unknown,
  metadata: Record<string, unknown> | null,
  headers: Record<string, unknown>,
): string {
  if (typeof bodyConversationId === "string" && bodyConversationId.trim()) return bodyConversationId.trim();

  if (metadata) {
    for (const key of ["synesis_conversation_id", "conversation_id", "session_id", "thread_id", "chat_id"]) {
      const val = metadata[key];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
    const rawUserId = metadata.user_id;
    if (typeof rawUserId === "string" && rawUserId.startsWith("{")) {
      try {
        const parsed = JSON.parse(rawUserId) as Record<string, unknown>;
        const nested = parsed.session_id;
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      } catch { /* ignore malformed nested metadata */ }
    }
  }

  for (const key of ["x-synesis-conversation-id", "x-opencode-session-id"]) {
    const val = headerOne(headers, key);
    if (val) return val;
  }
  return "";
}

function resolveOpenAiIdentityUserId(
  requestUser: unknown,
  authUser: { userId: string; authMethod: "pat" | "bearer" },
): string {
  // Always use the authenticated identity for session keying so turns
  // from the same token converge to a single session even when
  // request.user varies per-turn (common with opencode and other clients).
  if (authUser.authMethod === "pat") return authUser.userId;
  return authUser.userId;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function resolveOpenAiDisplayName(
  requestUser: unknown,
  authUser: { displayName?: string },
): string | undefined {
  if (authUser.displayName) return authUser.displayName;
  if (typeof requestUser === "string") {
    const trimmed = requestUser.trim();
    if (trimmed && EMAIL_RE.test(trimmed) && trimmed.length <= 200) {
      return trimmed.toLowerCase();
    }
  }
  return undefined;
}

function metadataFromRequest(request: OpenAIChatCompletionRequest): Record<string, unknown> | null {
  const raw = (request as Record<string, unknown>).metadata;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

export class OpenAIChatPipeline {
  constructor(private readonly env: OpenAIChatPipelineEnvironment = {}) {}

  canonicalize(request: OpenAIChatCompletionRequest): CanonicalChatRequest {
    return {
      protocol: "openai",
      model: request.model,
      messages: request.messages as unknown[],
      stream: request.stream ?? false,
      tools: request.tools as unknown[] | undefined,
      metadata: request.metadata ?? null,
      raw: request,
    };
  }

  resolveMode(input: Parameters<typeof resolvePipelineMode>[0]) {
    return resolvePipelineMode(input);
  }

  prepareIngress(input: {
    body: unknown;
    headers: Record<string, unknown>;
    config: Partial<AppConfig> & { SYNESIS_YARN_PIPELINE_MODE?: string };
  }): OpenAIChatIngressResult {
    const normalizedIngress = normalizeToolDescriptions(input.body, "openai", "/v1/chat/completions");
    const parsed = OpenAIChatCompletionRequestSchema.safeParse(normalizedIngress.body);
    if (!parsed.success) {
      return {
        ok: false,
        statusCode: 400,
        body: { error: { type: "invalid_request_error", message: formatValidationError(parsed.error) } },
        truncations: normalizedIngress.truncations,
      };
    }

    const request = parsed.data;
    const modeResolution = this.resolveMode({
      headers: input.headers,
      body: request as unknown as Record<string, unknown>,
      config: input.config,
    });
    const bodyMetadata = metadataFromRequest(request);
    return {
      ok: true,
      request,
      canonicalRequest: this.canonicalize(request),
      modeResolution,
      bodyMetadata,
      clientKind: resolveOpenAiClientKind(input.headers, bodyMetadata),
      conversationId: resolveOpenAiConversationId(
        (request as Record<string, unknown>).conversation_id,
        bodyMetadata,
        input.headers,
      ),
      requestUser: (request as Record<string, unknown>).user,
      truncations: normalizedIngress.truncations,
    };
  }

  resolveIdentity(
    ingress: OpenAIChatIngressSuccess,
    authUser: AuthUser,
  ): OpenAIChatIdentityResolution {
    const identityUserId = resolveOpenAiIdentityUserId(ingress.requestUser, authUser);
    const displayName = resolveOpenAiDisplayName(ingress.requestUser, authUser);
    return {
      identityUserId,
      displayName,
      identity: buildProtocolSessionIdentity({
        authUser,
        userId: identityUserId,
        conversationId: ingress.conversationId,
        clientKind: ingress.clientKind,
        displayName,
      }),
    };
  }

  async beforeProviderCall(
    ctx: PipelineContext,
    request: { messages: GovernorInputMessage[]; governorOptions?: Parameters<GovernorService["beforeProviderCall"]>[1]["options"] },
  ): Promise<PipelineResult["governor"]> {
    if (!shouldRunGovernorForMode(ctx.mode) || !this.env.governorService) {
      return null;
    }
    return this.env.governorService.beforeProviderCall(ctx, {
      messages: request.messages,
      options: request.governorOptions,
    });
  }

  executePreparedProviderCall(
    input: PreparedOpenAIChatProviderExecutionInput,
  ): Promise<PreparedOpenAIChatProviderExecutionResult> {
    return runPreparedOpenAIChatProviderExecution(input);
  }

  async executeAuthenticatedRoute(input: {
    deps: OpenAIChatCompletionsRouteDependencies;
    ingress: OpenAIChatIngressSuccess;
    authUser: AuthUser;
    requestHeaders: Record<string, string | string[] | undefined>;
    rawReply: unknown;
    requestId: string;
    optimizationLedger: OptimizationLedger;
  }): Promise<OpenAIAuthenticatedRouteResult> {
    const {
      deps,
      ingress,
      authUser,
      requestHeaders,
      rawReply,
      requestId,
      optimizationLedger,
    } = input;
    const {
      ARTIFACT_TOOL_NAME,
      DEV_DOCS_TOOL_NAME,
      GOVERNOR_COOLDOWN_MS,
      KNOWLEDGE_TOOL_NAME,
      TIER_TO_ROLE,
      WEB_SEARCH_TOOL_ALIAS,
      WEB_SEARCH_TOOL_NAME,
      adapterUsesToolLoopSteering,
      analyzeRecentCommandLoop,
      annotatePlanFileReads,
      annotateVerificationGaps,
      app,
      appendPathContextToAdapterBlock,
      applyAuthKeyAttribution,
      applyDiscoveryToolGuardrail,
      applyEditContextMissReadGate,
      applyIngressCapToToolMessages,
      applyMarkdownGuardrail,
      applyObjectiveScopeAndPersist,
      applySensemakingStats,
      applySessionTaskCapabilities,
      applyWorkspaceBoundary,
      applyWorkspaceMetadataPrebackfill,
      artifactRetrieval,
      artifactStore,
      assessStateConfidence,
      assessVerificationSignals,
      buildArtifactShadows,
      buildBlockedDiscoveryRecoverySnapshot,
      buildDefaultPolicy,
      buildEditContextMissForcedReadPrompt,
      buildEditContextMissGuardPrompt,
      buildEvidenceTraceSummary,
      buildExecutionGovernorHardStopUserMessage,
      buildExecutionGovernorPauseEnvelope,
      buildFreshImplicitSessionNotice,
      buildGovernorPauseResumeBlockForUser,
      buildRouteGovernanceBlocks,
      buildSensemakingGuidanceInjection,
      buildSensemakingPauseMessage,
      buildStateRegroundReadPrompt,
      captureRequestForensics,
      casSessionSave,
      chatPhaseFromWorkflowPhase,
      clampMaxOutputTokensForSafety,
      classifyIntentScope,
      classifyLatestReadRefresh,
      classifyLatestToolProgress,
      classifyToolResultAsEvidence,
      clearGovernorPauseContextMetadata,
      circuitBreakers,
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
      distributedCounters,
      emitPlanWriteAuditEvent,
      enrichWithFrameAndManifest,
      enrichmentPool,
      ensureReadToolAvailabilityForEditMissGuard,
      evaluateCachePolicyForSession,
      evaluateYarnPromptIntakeSteer,
      extractCommandEvents,
      extractEditedFileHints,
      extractLatestUserPromptFromMessages,
      extractMetadataFromMessages,
      extractPlanContentShadow,
      extractTextFromUnknownContent,
      extractUpstreamErrorDiagnostics,
      finalizeCompletionText,
      finalizePostEnrichmentMessages,
      finalizePostStreamText,
      finalizeRequestForensics,
      findPreferredReadToolName,
      forceCheckpoint,
      formatEvidenceBlock,
      formatPatternBlock,
      formatStateConfidenceBlock,
      generateText,
      getBlockedDiscoveryCount,
      getCachedTopLevelDirs,
      getChecklistSourceHash,
      getContentDedup,
      getFileSnapshotRegistry,
      getMemoryGovernor,
      getMetadataString,
      getSessionKey,
      getSessionMemoryCount,
      getSessionState,
      getStructuralIndex,
      getTracer,
      governanceClient,
      governorService,
      hasPersistedWorkspaceState,
      inferGovernorPhaseFromMessages,
      inferModelFamily,
      inferTrajectoryDiagnosticsFromMessages,
      inferVerificationSteps,
      injectGovernorRecoveryMessage,
      injectPlanModeRecoveryHint,
      injectSessionContext,
      isGenuineUserPromptMessage,
      isOpenClawProfile,
      isPlanRecoveryDiscoveryIntent,
      isWriteCapableToolName,
      knowledgeResolveContext,
      knowledgeSearch,
      loadProviderCachePolicyWindow,
      loadUserRuntimePreferences,
      logAndPersistSafetyEvent,
      looksLikeFailureSignal,
      markerBackendForRequest,
      maybeBuildPlannerTodoPacketBlock,
      maybeCheckpoint,
      maybeLogEnvelopeUnwrapSample,
      maybeUpdateTaskLedgerFromEvidence,
      maybeUpdateTaskLedgerFromToolCall,
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
      processWorkspaceHandshakeRoute,
      projectInstructionFilePresent,
      projectManifestService,
      pushDiagnostic,
      readdir,
      readPersistedChatStateSnapshot,
      readUsage,
      recordBlockedDiscovery,
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
      resolveWorkingPhase,
      roleAssignmentRegistry,
      runEvidencePrefetch,
      runOpenAIRequest,
      runPatternPrefetch,
      runProtocolSessionBootstrap,
      runSensemaking,
      runValidationTierCFallback,
      safeEnd,
      safeWrite,
      securityIngestConfig,
      sensemakingStats,
      sessionPersistenceRunner,
      sessions,
      setSessionWorkspaceContext,
      shouldResetImplicitSessionForFreshTranscript,
      shouldRestrictDiscoveryForPlanWork,
      shouldSampleBySeed,
      shouldStripGlobFromTools,
      sliceMessagesSinceLastUserPrompt,
      sseHeadersWithClarification,
      startSseHeartbeat,
      streamAdmission,
      streamText,
      stripGlobFromTools,
      summarizeArtifactContext,
      summarizeEvidenceDelta,
      tierRegistry,
      toolArgHardeningStats,
      toolResultReduction,
      toSessionExecutionContextSystemBlock,
      transcriptPruning,
      updateDiffAccumulator,
      updatePlanGraph,
      updateTracePromptMetadata,
      validationNormalization,
      webSearch,
      webSearchResolveContext,
      withSpan,
      withSpanAsync,
      workingFrameService,
      workspaceStatePresence,
      yarnDedupeLayer,
      yarnToolPrefixCache,
    } = deps;

    const request = ingress.request;
    const pipelineModeResolution = ingress.modeResolution;
    const pipelineMode = pipelineModeResolution.mode;
    if (!pipelineModeResolution.valid) {
      app.log.warn(
        {
          reqId: requestId,
          requestedMode: pipelineModeResolution.requested,
          source: pipelineModeResolution.source,
          fallbackMode: pipelineMode,
        },
        "invalid_pipeline_mode",
      );
    }

    const identityResolution = this.resolveIdentity(ingress, authUser);
    const identity = identityResolution.identity;
    const normalization = await prepareOpenAIRouteNormalization({
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
      requestId,
      authUser,
      identity: {
        userId: identityResolution.identityUserId,
        orgId: authUser.orgId,
        conversationId: ingress.conversationId,
        clientKind: ingress.clientKind,
        displayName: identityResolution.displayName,
      },
      canonicalRequest: ingress.canonicalRequest,
      pipelineMode,
      bodyMetadata: ingress.bodyMetadata,
      headers: requestHeaders,
      optimizationLedger,
    });

    const sessionWorkspace = await prepareOpenAISessionWorkspace({
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
        serializeShadow: deps.serializeShadow,
        shouldResetImplicitSessionForFreshTranscript,
        transcriptPruning,
        workspaceStatePresence,
        yarnDedupeLayer,
      },
      authUser,
      identity,
      request,
      normalizedOpenAI: normalization.normalizedOpenAI,
      requestId,
      clientKind: ingress.clientKind,
      conversationId: ingress.conversationId,
      taskCue: normalization.taskCue,
      pathContext: normalization.pathContext,
      capabilityResolution: normalization.capabilityResolution,
      matrixModelId: normalization.matrixModelId,
      matrixModelPath: normalization.matrixModelPath,
      matrixFamily: normalization.matrixFamily,
      compactionBackendModelHint: normalization.compactionOpts.backendModelHint,
      contentDedupeEnabled: normalization.contentDedupeEnabled,
      responseDedupeEnabled: normalization.responseDedupeEnabled,
      historicalNormalizeEnabled: normalization.historicalNormalizeEnabled,
      optimizationLedger,
    });

    normalization.endPruningStage?.();
    const endContextStage = optimizationLedger.startStage("context");
    const governedStage = await prepareOpenAIGovernedStage({
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
        hashTextSignal: deps.hashTextSignal,
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
      req: { headers: requestHeaders },
      session: sessionWorkspace.session,
      sessionKey: sessionWorkspace.sessionKey,
      identity,
      requestId,
      request,
      normalizedOpenAI: normalization.normalizedOpenAI,
      bodyMetadata: ingress.bodyMetadata,
      latestUserText: normalization.latestUserText,
      taskCue: normalization.taskCue,
      clientToolCapabilities: sessionWorkspace.clientToolCapabilities,
      pathContext: normalization.pathContext,
      adapterProfile: normalization.adapterProfile,
      adapterBlock: normalization.adapterBlock,
      verificationAssessment: normalization.verificationAssessment,
      preManifest: normalization.preManifest,
      workspaceInspection: sessionWorkspace.workspaceInspection,
      pipelineMode,
      governorCooldownMs: GOVERNOR_COOLDOWN_MS,
      runtimePreferences: sessionWorkspace.runtimePreferences,
      endContextStage,
      startGovernorStage: () => optimizationLedger.startStage("governor"),
    });

    if (governedStage.kind === "workspaceHandshake") {
      return {
        kind: "workspaceHandshake",
        requestId,
        model: request.model,
        stream: !!request.stream,
        toolCallId: governedStage.toolCallId,
      };
    }
    if (governedStage.kind === "softFail") {
      return {
        kind: "softFail",
        requestId,
        selectedModel: governedStage.selectedModel,
        content: governedStage.content,
        stream: !!request.stream,
        envelope: governedStage.envelope,
      };
    }
    if (governedStage.kind === "reject") {
      return { kind: "policyReject", decision: governedStage.decision };
    }

    const providerExecution = await runOpenAIPostGovernanceProviderStage({
      deps: {
        ARTIFACT_TOOL_NAME,
        DEV_DOCS_TOOL_NAME,
        KNOWLEDGE_TOOL_NAME,
        TIER_TO_ROLE,
        WEB_SEARCH_TOOL_ALIAS,
        WEB_SEARCH_TOOL_NAME,
        adapterUsesToolLoopSteering,
        app,
        applyDiscoveryToolGuardrail,
        applyEditContextMissReadGate,
        applyMarkdownGuardrail,
        applyWorkspaceMetadataPrebackfill,
        artifactRetrieval,
        artifactStore,
        buildBlockedDiscoveryRecoverySnapshot,
        buildDefaultPolicy,
        buildEditContextMissForcedReadPrompt,
        buildEditContextMissGuardPrompt,
        buildEvidenceTraceSummary,
        buildRouteGovernanceBlocks,
        buildStateRegroundReadPrompt,
        captureRequestForensics,
        circuitBreakers,
        clampMaxOutputTokensForSafety,
        computePrefixFingerprint: deps.computePrefixFingerprint,
        config,
        contextAdmissionStats,
        deserializeShadow,
        emitPlanWriteAuditEvent,
        ensureReadToolAvailabilityForEditMissGuard,
        enrichWithFrameAndManifest,
        evaluateCachePolicyForSession,
        extractMetadataFromMessages,
        extractUpstreamErrorDiagnostics,
        finalizeCompletionText,
        finalizePostEnrichmentMessages,
        finalizePostStreamText,
        finalizeRequestForensics,
        findPreferredReadToolName,
        forceCheckpoint,
        formatEvidenceBlock,
        formatPatternBlock,
        generateText,
        getBlockedDiscoveryCount,
        getCachedTopLevelDirs,
        getMemoryGovernor,
        getMetadataString,
        getSessionMemoryCount,
        getStructuralIndex,
        getTracer,
        inferModelFamily,
        inferVerificationSteps,
        injectSessionContext,
        isOpenClawProfile,
        isWriteCapableToolName,
        knowledgeResolveContext,
        knowledgeSearch,
        loadProviderCachePolicyWindow,
        markerBackendForRequest,
        maybeLogEnvelopeUnwrapSample,
        maybeUpdateTaskLedgerFromToolCall,
        openAiChatPipeline,
        openClawProfileStats,
        prefixOptimizer: deps.prefixOptimizer,
        pushDiagnostic,
        readUsage,
        recordBlockedDiscovery,
        recordSessionEvent,
        recordUpperHarnessDecision,
        resolveEndpointCapabilityId,
        roleAssignmentRegistry,
        runOpenAIRequest,
        safeEnd,
        safeWrite,
        securityIngestConfig,
        sessionPersistenceRunner,
        setSessionWorkspaceContext,
        shouldRestrictDiscoveryForPlanWork,
        shouldSampleBySeed,
        sseHeadersWithClarification,
        startSseHeartbeat,
        streamAdmission,
        streamText,
        tierRegistry,
        toolArgHardeningStats,
        toolResultReduction,
        transcriptPruning,
        updateDiffAccumulator,
        validationNormalization,
        webSearch,
        webSearchResolveContext,
        yarnDedupeLayer,
        yarnToolPrefixCache,
      },
      authUser,
      requestHeaders,
      rawReply,
      session: sessionWorkspace.session,
      sessionKey: sessionWorkspace.sessionKey,
      identity,
      requestId,
      request,
      normalizedOpenAI: normalization.normalizedOpenAI,
      governedStage,
      clientToolCapabilities: sessionWorkspace.clientToolCapabilities,
      clientTaskCue: normalization.taskCue,
      clientKind: ingress.clientKind,
      adapterProfile: normalization.adapterProfile,
      openClawStrictGovernance: normalization.openClawStrictGovernance,
      phasePolicyEnabledByMatrix: normalization.phasePolicyEnabledByMatrix,
      workspaceInspection: sessionWorkspace.workspaceInspection,
      compactionOptions: normalization.compactionOpts,
      reducedOpenAI: normalization.reducedOpenAI,
      toolResultCount: normalization.toolResultCount,
      runtimePreferences: sessionWorkspace.runtimePreferences,
      latestUserText: normalization.latestUserText,
      freshImplicitSessionNotice: sessionWorkspace.freshImplicitSessionNotice,
      trajectoryDiagnostics: normalization.trajectoryDiagnostics,
      verificationAssessment: normalization.verificationAssessment,
      forensicsCapabilityMatrix: sessionWorkspace.forensicsCapabilityMatrix,
      bodyMetadata: ingress.bodyMetadata,
      optimizationLedger,
    });

    return {
      kind: "pipeline",
      result: providerExecution.result,
      clarificationMetadata: providerExecution.applyClarificationHeader
        ? sessionWorkspace.session.record.metadata
        : undefined,
    };
  }
}
