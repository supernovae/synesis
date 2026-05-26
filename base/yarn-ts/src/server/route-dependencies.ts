import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModelMessage } from "ai";

import type { AuthResolver, AuthUser } from "../auth.js";
import type { AppConfig } from "../config.js";
import type { OpenAIChatPipeline } from "../pipeline/openai-chat-pipeline.js";
import type { ModelAdapter } from "../providers/model-adapter.js";
import type { PlatformRouteDependencies } from "../routes/platform-route-support.js";
import type { OpenAIChatCompletionRequest } from "../schemas.js";
import type { SessionIdentity } from "../session/session-key.js";
import type { SessionState } from "../state/session-state.js";

// Transitional route dependency bags still bridge index.ts-owned services into
// route/pipeline modules. Keep this explicit until those services move behind
// typed facades instead of pretending the source bag is precise.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TransitionalRouteFn = (...args: any[]) => any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TransitionalRouteDependencyBag = Record<string, any>;

export interface RateLimiterLike {
  check(userId: string): Promise<{
    allowed: boolean;
    currentCount?: number;
    limit?: number;
    retryAfterSeconds?: number;
  }>;
}

export interface OpenAIChatCompletionsRouteDependencies extends TransitionalRouteDependencyBag {
  app: FastifyInstance;
  config: AppConfig;
  authResolver: AuthResolver;
  fgaCheck: TransitionalRouteFn;
  userRateLimiter: RateLimiterLike;
  openAiChatPipeline: OpenAIChatPipeline;
  resolveRequestId(headers: Record<string, unknown>): string;
  recordSessionEvent: TransitionalRouteFn;
  applyClarificationRoundResponseHeader: TransitionalRouteFn;
  policyRejectOpenAIBody: TransitionalRouteFn;
  sendOpenAISoftFail: TransitionalRouteFn;
  sendOpenAIWorkspaceHandshake: TransitionalRouteFn;
  getSessionKey(identity: SessionIdentity): Promise<string>;
  getSessionState(sessionKey: string, identity: SessionIdentity): Promise<SessionState>;
  casSessionSave(state: SessionState): Promise<unknown>;
  runOpenAIRequest(request: OpenAIChatCompletionRequest): {
    ok: true;
    resolved: {
      resolvedModelId: string;
      model: unknown;
      adapter: ModelAdapter;
    };
    messages: ModelMessage[];
    transforms: {
      systemMessagesReordered: boolean;
      toolCallsSanitized: boolean;
      messageCountDelta: number;
    };
    [key: string]: unknown;
  } | {
    ok: false;
    error: string;
    [key: string]: unknown;
  };
}

export interface ClaudeRuntimeDependencies extends TransitionalRouteDependencyBag {
  app: FastifyInstance;
  config: AppConfig;
}

export interface ClaudeAuthDependencies extends TransitionalRouteDependencyBag {
  authResolver: AuthResolver;
  fgaCheck: TransitionalRouteFn;
  userRateLimiter: RateLimiterLike;
}

export interface ClaudeProtocolDependencies extends TransitionalRouteDependencyBag {
  resolveRequestId(headers: Record<string, unknown>): string;
}

export interface ClaudeSessionDependencies extends TransitionalRouteDependencyBag {
  applyAuthKeyAttribution(
    session: SessionState,
    authUser: Pick<AuthUser, "authMethod" | "authKeyId" | "authKeyName" | "authKeyPrefix">,
  ): void;
  getSessionKey(identity: SessionIdentity): Promise<string>;
  getSessionState(sessionKey: string, identity: SessionIdentity): Promise<SessionState>;
  loadUserRuntimePreferences(userId: string): Promise<unknown>;
  casSessionSave(state: SessionState): Promise<unknown>;
  sessions: Map<string, SessionState>;
  recordSessionEvent: TransitionalRouteFn;
}

export interface ClaudeProviderResolveOk {
  ok: true;
  resolved: TransitionalRouteDependencyBag;
  messages: Array<{ role: string; content?: unknown }>;
  providerOptions?: TransitionalRouteDependencyBag;
  [key: string]: unknown;
}

export interface ClaudeProviderResolveError {
  ok: false;
  statusCode: number;
  body: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ClaudeProviderDependencies extends TransitionalRouteDependencyBag {
  runOpenAIRequest: OpenAIChatCompletionsRouteDependencies["runOpenAIRequest"];
}

export interface ClaudeMessagesRouteDependencies {
  runtime: ClaudeRuntimeDependencies;
  auth: ClaudeAuthDependencies;
  protocol: ClaudeProtocolDependencies;
  session: ClaudeSessionDependencies;
  workspace: TransitionalRouteDependencyBag;
  reduction: TransitionalRouteDependencyBag;
  tools: TransitionalRouteDependencyBag;
  governance: TransitionalRouteDependencyBag;
  planning: TransitionalRouteDependencyBag;
  provider: ClaudeProviderDependencies;
  evidence: TransitionalRouteDependencyBag;
  telemetry: TransitionalRouteDependencyBag;
  adapter: TransitionalRouteDependencyBag;
}

export type RouteRequest = FastifyRequest;
export type RouteReply = FastifyReply;

export function buildPlatformRouteDependencies(source: TransitionalRouteDependencyBag): PlatformRouteDependencies {
  return {
    app: source.app,
    config: source.config,
    authResolver: source.authResolver,
    fgaCheck: source.fgaCheck,
    userRateLimiter: source.userRateLimiter,
    requireInternalToken: source.requireInternalToken,
    promRegistry: source.promRegistry,
    usagePersistenceEnabled: source.usagePersistenceEnabled,
    usageWriter: source.usageWriter,
    sessionStore: source.sessionStore,
    sessions: source.sessions,
    validationNormalization: source.validationNormalization,
    toolResultReduction: source.toolResultReduction,
    transcriptPruning: source.transcriptPruning,
    contentDedupBySession: source.contentDedupBySession,
    toolArgHardeningStats: source.toolArgHardeningStats,
    toolSchemaPruningStats: source.toolSchemaPruningStats,
    toolBlobRedisEnabled: source.toolBlobRedisEnabled,
    openClawProfileStats: source.openClawProfileStats,
    contextAdmissionStats: source.contextAdmissionStats,
    workingFrameService: source.workingFrameService,
    projectManifestService: source.projectManifestService,
    policyEngine: source.policyEngine,
    governanceClient: source.governanceClient,
    phaseOrchestrator: source.phaseOrchestrator,
    clientAdapterPacks: source.clientAdapterPacks,
    stablePrefixService: source.stablePrefixService,
    yarnToolPrefixCache: source.yarnToolPrefixCache,
    artifactRetrieval: source.artifactRetrieval,
    knowledgeSearch: source.knowledgeSearch,
    getEvidencePrefetchStats: source.getEvidencePrefetchStats,
    getPatternPrefetchStats: source.getPatternPrefetchStats,
    getPatternFeedbackStats: source.getPatternFeedbackStats,
    artifactStore: source.artifactStore,
    circuitBreakers: source.circuitBreakers,
    distributedCounters: source.distributedCounters,
    streamAdmission: source.streamAdmission,
    attentionPositioning: source.attentionPositioning,
    languagePacksConformance: source.languagePacksConformance,
    sessionContinuity: source.sessionContinuity,
    enrichmentPool: source.enrichmentPool,
    sensemakingStats: source.sensemakingStats,
    getEventLoopStats: source.getEventLoopStats,
    promptSnapshotRegistry: source.promptSnapshotRegistry,
    diagnosticRegistry: source.diagnosticRegistry,
    resolveRequestId: source.resolveRequestId,
    formatValidationError: source.formatValidationError,
    selectedOpenAiCompatHeaders: source.selectedOpenAiCompatHeaders,
    safeWrite: source.safeWrite,
    safeEnd: source.safeEnd,
    tierRegistry: source.tierRegistry,
    loadUserRuntimePreferences: source.loadUserRuntimePreferences,
    getSessionKey: source.getSessionKey,
    getSessionState: source.getSessionState,
    forceCheckpoint: source.forceCheckpoint,
    casSessionSave: source.casSessionSave,
    recordSessionEvent: source.recordSessionEvent,
  };
}

export function buildOpenAIChatCompletionsRouteDependencies(
  source: OpenAIChatCompletionsRouteDependencies,
): OpenAIChatCompletionsRouteDependencies {
  return source;
}

export interface ClaudeMessagesRouteDependencySource extends TransitionalRouteDependencyBag {
  app: FastifyInstance;
  config: AppConfig;
  authResolver: AuthResolver;
  fgaCheck: TransitionalRouteFn;
  userRateLimiter: RateLimiterLike;
  getSessionKey(identity: SessionIdentity): Promise<string>;
  getSessionState(sessionKey: string, identity: SessionIdentity): Promise<SessionState>;
  casSessionSave(state: SessionState): Promise<unknown>;
  sessions: Map<string, SessionState>;
  runOpenAIRequest: OpenAIChatCompletionsRouteDependencies["runOpenAIRequest"];
}

export function buildClaudeMessagesRouteDependencies(
  source: ClaudeMessagesRouteDependencySource,
): ClaudeMessagesRouteDependencies {
  return {
    runtime: {
      app: source.app,
      config: source.config,
      crypto: source.crypto,
      getTracer: source.getTracer,
      readdir: source.readdir,
      safeEnd: source.safeEnd,
      safeSse: source.safeSse,
      startSseHeartbeat: source.startSseHeartbeat,
      withSpan: source.withSpan,
      withSpanAsync: source.withSpanAsync,
    },
    auth: {
      authResolver: source.authResolver,
      fgaCheck: source.fgaCheck,
      userRateLimiter: source.userRateLimiter,
    },
    protocol: {
      applyClarificationRoundResponseHeader: source.applyClarificationRoundResponseHeader,
      debugProtocolLog: source.debugProtocolLog,
      extractLatestUserPromptFromMessages: source.extractLatestUserPromptFromMessages,
      extractTextFromUnknownContent: source.extractTextFromUnknownContent,
      formatValidationError: source.formatValidationError,
      resolveRequestId: source.resolveRequestId,
      sseHeadersWithClarification: source.sseHeadersWithClarification,
    },
    session: {
      applyAuthKeyAttribution: source.applyAuthKeyAttribution,
      getSessionKey: source.getSessionKey,
      getSessionState: source.getSessionState,
      loadProviderCachePolicyWindow: source.loadProviderCachePolicyWindow,
      maybeCheckpoint: source.maybeCheckpoint,
      readUsage: source.readUsage,
      securityIngestConfig: source.securityIngestConfig,
      cachePolicyLogRecord: source.cachePolicyLogRecord,
      casSessionSave: source.casSessionSave,
      clearGovernorPauseContextMetadata: source.clearGovernorPauseContextMetadata,
      createRoutePersistenceScope: source.createRoutePersistenceScope,
      distributedCounters: source.distributedCounters,
      evaluateCachePolicyForSession: source.evaluateCachePolicyForSession,
      forceCheckpoint: source.forceCheckpoint,
      getMetadataString: source.getMetadataString,
      loadUserRuntimePreferences: source.loadUserRuntimePreferences,
      persistGovernorPauseContextMetadata: source.persistGovernorPauseContextMetadata,
      persistPromptIntakeSnapshot: source.persistPromptIntakeSnapshot,
      persistStateConfidence: source.persistStateConfidence,
      prepareProtocolPauseState: source.prepareProtocolPauseState,
      readPersistedChatStateSnapshot: source.readPersistedChatStateSnapshot,
      recordPromptIntakeEvent: source.recordPromptIntakeEvent,
      recordSessionEvent: source.recordSessionEvent,
      sessionPersistenceRunner: source.sessionPersistenceRunner,
      sessions: source.sessions,
      updateTracePromptMetadata: source.updateTracePromptMetadata,
    },
    workspace: {
      enrichWithFrameAndManifest: source.enrichWithFrameAndManifest,
      injectSessionContext: source.injectSessionContext,
      lastToolUseIdFromClaudeMessages: source.lastToolUseIdFromClaudeMessages,
      pinchCompactionBackendModelMetadata: source.pinchCompactionBackendModelMetadata,
      processWorkspaceHandshakeRoute: source.processWorkspaceHandshakeRoute,
      projectManifestService: source.projectManifestService,
      resetWorkspaceScopedSessionState: source.resetWorkspaceScopedSessionState,
      workingFrameService: source.workingFrameService,
      workspaceStatePresence: source.workspaceStatePresence,
    },
    reduction: {
      annotatePlanFileReads: source.annotatePlanFileReads,
      annotateVerificationGaps: source.annotateVerificationGaps,
      applyIngressCapToToolMessages: source.applyIngressCapToToolMessages,
      deserializeShadow: source.deserializeShadow,
      enrichmentPool: source.enrichmentPool,
      extractPlanContentShadow: source.extractPlanContentShadow,
      findLastUserPromptIdx: source.findLastUserPromptIdx,
      getContentDedup: source.getContentDedup,
      getFileSnapshotRegistry: source.getFileSnapshotRegistry,
      getMemoryGovernor: source.getMemoryGovernor,
      getStructuralIndex: source.getStructuralIndex,
      remediatePlanFileStubs: source.remediatePlanFileStubs,
      resolveCompactionBackendModelHintFromRequestModel: source.resolveCompactionBackendModelHintFromRequestModel,
      runValidationTierCFallback: source.runValidationTierCFallback,
      serializeShadow: source.serializeShadow,
      sliceMessagesSinceLastUserPrompt: source.sliceMessagesSinceLastUserPrompt,
      toolResultReduction: source.toolResultReduction,
      transcriptPruning: source.transcriptPruning,
      validationNormalization: source.validationNormalization,
      yarnDedupeLayer: source.yarnDedupeLayer,
    },
    tools: {
      applyEditContextMissReadGate: source.applyEditContextMissReadGate,
      buildEditContextMissForcedReadPrompt: source.buildEditContextMissForcedReadPrompt,
      buildEditContextMissGuardPrompt: source.buildEditContextMissGuardPrompt,
      buildStateRegroundReadPrompt: source.buildStateRegroundReadPrompt,
      emitPlanWriteAuditEvent: source.emitPlanWriteAuditEvent,
      findPreferredReadToolName: source.findPreferredReadToolName,
      isWriteCapableToolName: source.isWriteCapableToolName,
      maybeLogEnvelopeUnwrapSample: source.maybeLogEnvelopeUnwrapSample,
      maybeUpdateTaskLedgerFromToolCall: source.maybeUpdateTaskLedgerFromToolCall,
      recordBlockedDiscovery: source.recordBlockedDiscovery,
      updateDiffAccumulator: source.updateDiffAccumulator,
      applyDiscoveryToolGuardrail: source.applyDiscoveryToolGuardrail,
      buildBlockedDiscoveryRecoverySnapshot: source.buildBlockedDiscoveryRecoverySnapshot,
      ensureReadToolAvailabilityForEditMissGuard: source.ensureReadToolAvailabilityForEditMissGuard,
      getBlockedDiscoveryCount: source.getBlockedDiscoveryCount,
      getCachedTopLevelDirs: source.getCachedTopLevelDirs,
      shouldStripGlobFromTools: source.shouldStripGlobFromTools,
      stripGlobFromTools: source.stripGlobFromTools,
      toolArgHardeningStats: source.toolArgHardeningStats,
      toolSchemaPruningStats: source.toolSchemaPruningStats,
    },
    governance: {
      shouldRestrictDiscoveryForPlanWork: source.shouldRestrictDiscoveryForPlanWork,
      adapterUsesToolLoopSteering: source.adapterUsesToolLoopSteering,
      analyzeRecentCommandLoop: source.analyzeRecentCommandLoop,
      applySensemakingStats: source.applySensemakingStats,
      assessProportionality: source.assessProportionality,
      chatPhaseFromWorkflowPhase: source.chatPhaseFromWorkflowPhase,
      classifyIntentScope: source.classifyIntentScope,
      classifyLatestReadRefresh: source.classifyLatestReadRefresh,
      classifyLatestToolProgress: source.classifyLatestToolProgress,
      collectToolExecutionFailureObservations: source.collectToolExecutionFailureObservations,
      countTurnsSinceLastUser: source.countTurnsSinceLastUser,
      deriveEditContextMissGuardState: source.deriveEditContextMissGuardState,
      governanceClient: source.governanceClient,
      GOVERNOR_COOLDOWN_MS: source.GOVERNOR_COOLDOWN_MS,
      handleDeterministicPolicyPrecheck: source.handleDeterministicPolicyPrecheck,
      hashTextSignal: source.hashTextSignal,
      inferModelFamily: source.inferModelFamily,
      isGenuineUserPromptMessage: source.isGenuineUserPromptMessage,
      isMatrixCapabilityEnabled: source.isMatrixCapabilityEnabled,
      isOpenClawProfile: source.isOpenClawProfile,
      logAndPersistSafetyEvent: source.logAndPersistSafetyEvent,
      looksLikeFailureSignal: source.looksLikeFailureSignal,
      normalizedToolOutputSignal: source.normalizedToolOutputSignal,
      openClawProfileStats: source.openClawProfileStats,
      phaseFromFrame: source.phaseFromFrame,
      phaseOrchestrator: source.phaseOrchestrator,
      policyEngine: source.policyEngine,
      proportionalityToSignal: source.proportionalityToSignal,
      resolveCapabilityMatrix: source.resolveCapabilityMatrix,
      resolveWorkingPhase: source.resolveWorkingPhase,
      runSensemaking: source.runSensemaking,
      sensemakingStats: source.sensemakingStats,
    },
    planning: {
      applyMarkdownGuardrail: source.applyMarkdownGuardrail,
      finalizeCompletionText: source.finalizeCompletionText,
      finalizePostStreamText: source.finalizePostStreamText,
      applyObjectiveScopeAndPersist: source.applyObjectiveScopeAndPersist,
      buildGovernorPauseResumeBlockForUser: source.buildGovernorPauseResumeBlockForUser,
      classifyToolResultAsEvidence: source.classifyToolResultAsEvidence,
      detectLanguagesFromMessages: source.detectLanguagesFromMessages,
      getChecklistSourceHash: source.getChecklistSourceHash,
      inferTrajectoryDiagnosticsFromMessages: source.inferTrajectoryDiagnosticsFromMessages,
      inferVerificationSteps: source.inferVerificationSteps,
      injectPlanModeRecoveryHint: source.injectPlanModeRecoveryHint,
      maybeBuildPlannerTodoPacketBlock: source.maybeBuildPlannerTodoPacketBlock,
      maybeUpdateTaskLedgerFromEvidence: source.maybeUpdateTaskLedgerFromEvidence,
      recordUpperHarnessDecision: source.recordUpperHarnessDecision,
      refreshRequirementChecklist: source.refreshRequirementChecklist,
      refreshTaskIntake: source.refreshTaskIntake,
      updatePlanGraph: source.updatePlanGraph,
    },
    provider: {
      circuitBreakers: source.circuitBreakers,
      computePrefixFingerprint: source.computePrefixFingerprint,
      extractUpstreamErrorDiagnostics: source.extractUpstreamErrorDiagnostics,
      markerBackendForRequest: source.markerBackendForRequest,
      prefixOptimizer: source.prefixOptimizer,
      runOpenAIRequest: source.runOpenAIRequest,
      streamAdmission: source.streamAdmission,
      captureRequestForensics: source.captureRequestForensics,
      clampMaxOutputTokensForSafety: source.clampMaxOutputTokensForSafety,
      extractMetadataFromMessages: source.extractMetadataFromMessages,
      finalizeRequestForensics: source.finalizeRequestForensics,
      generateText: source.generateText,
      resolveEndpointCapabilityId: source.resolveEndpointCapabilityId,
      roleAssignmentRegistry: source.roleAssignmentRegistry,
      shouldSampleBySeed: source.shouldSampleBySeed,
      streamText: source.streamText,
      TIER_TO_ROLE: source.TIER_TO_ROLE,
      tierRegistry: source.tierRegistry,
    },
    evidence: {
      artifactStore: source.artifactStore,
      getSessionMemoryCount: source.getSessionMemoryCount,
      knowledgeResolveContext: source.knowledgeResolveContext,
      knowledgeSearch: source.knowledgeSearch,
      webSearch: source.webSearch,
      webSearchResolveContext: source.webSearchResolveContext,
    },
    telemetry: {
      contextAdmissionStats: source.contextAdmissionStats,
      pushDiagnostic: source.pushDiagnostic,
    },
    adapter: {
      clientAdapterPacks: source.clientAdapterPacks,
    },
  };
}
