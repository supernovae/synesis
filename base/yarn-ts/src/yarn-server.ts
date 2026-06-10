import crypto from "node:crypto";
import { readdir } from "node:fs/promises";
import Fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { Registry } from "prom-client";
import { generateText, streamText } from "ai";
import {
  createServiceMetrics,
  recordUsageMetrics,
  emitTrace,
} from "@synesis/telemetry";
import { loadConfig } from "./config.js";
import {
  TIER_TO_ROLE,
  type PromptSnapshot,
  type RoleAssignmentConfig,
} from "./providers/admin-tier-registry.js";
import { SynesisProviderRegistry } from "./providers/synesis-provider.js";
import { PrefixOptimizer, extractMetadataFromMessages } from "./providers/prefix-optimizer/index.js";
import { resolveEndpointCapabilityId } from "./providers/endpoint-capabilities/resolve.js";
import { SawtoothContextManager } from "./context/sawtooth-manager.js";
import { SessionStore } from "./state/session-store.js";
import type { SessionState } from "./state/session-state.js";
import {
  shouldResetImplicitSessionForFreshTranscript,
} from "./session/session-key.js";
import {
  applySessionTaskCapabilities,
  runProtocolSessionBootstrap,
} from "./session/protocol-session.js";
import { UsageWriter } from "./state/usage-writer.js";
import { createSessionEventRecorder } from "./state/session-event-recorder.js";
import { AuthResolver } from "./auth.js";
import { ValidationNormalizationService } from "./validation/service.js";
import { deserializeShadow, serializeShadow } from "./planning/plan-content-shadow.js";
import {
  mergeSynesisClarificationFromRequestMetadata,
} from "./validation/clarification-schema.js";
import { parseOrchestratorPhaseHeader } from "./validation/orchestrator-phase.js";
import { ArtifactStore } from "./state/artifact-store.js";
import { ArtifactRetrievalService, ARTIFACT_TOOL_NAME } from "./state/artifact-retrieval.js";
import { createToolBlobTier } from "./state/tool-blob-tier.js";
import {
  KnowledgeSearchService,
  KNOWLEDGE_TOOL_NAME,
  DEV_DOCS_TOOL_NAME,
} from "./state/knowledge-search.js";
import {
  WebSearchService,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_ALIAS,
} from "./state/web-search.js";
import {
  runEvidencePrefetch,
  formatEvidenceBlock,
  getEvidencePrefetchStats,
  runPatternPrefetch,
  formatPatternBlock,
  getPatternPrefetchStats,
  buildEvidenceTraceSummary,
} from "./evidence/fast-path.js";
import { initPatternFeedback, getPatternFeedbackStats } from "./evidence/pattern-feedback.js";
import { ToolResultReductionService } from "./reduction/tool-result-reducer.js";
import { TranscriptPruningService } from "./reduction/transcript-pruning.js";
import { applyIngressCapToToolMessages } from "./reduction/ingress-cap.js";
import { BlockStore } from "./store/block-store.js";
import {
  RequestDiagnosticRegistry,
} from "./telemetry/request-diagnostics.js";
import {
  cachePolicyLogRecord,
} from "./telemetry/cache-policy-controller.js";
import {
  detectClientToolCapabilities,
} from "./adapters/client-tool-capabilities.js";
import { clearSessionMemory, getSessionMemoryCount, initMemoryToolStore } from "./mcp/handlers/memory-tools.js";
import { MemoryStore } from "./memory/memory-store.js";
import { Redis as IORedis } from "ioredis";
import { WorkingFrameService } from "./frame/working-frame-service.js";
import { ProjectManifestService } from "./project/project-manifest-service.js";
import { createPlanningStateHelpers } from "./planning/planning-state-helpers.js";
import {
  assessVerificationFromMessages as assessVerificationSignals,
} from "./verification/staff-completion.js";
import { createCompletionFinalizers } from "./verification/completion-finalization.js";
import { DedupeLayer } from "./dedupe/DedupeLayer.js";
import { ToolPrefixCache } from "./tool-prefix-cache/ToolPrefixCache.js";
import { registerNonChatRoutes } from "./server/non-chat-routes.js";
import { DeterministicPolicyEngine } from "./policy/deterministic-policy-engine.js";
import { handleDeterministicPolicyPrecheck } from "./policy/deterministic-policy-route.js";
import {
  analyzeRecentCommandLoop,
  hashTextSignal,
  looksLikeFailureSignal,
  normalizedToolOutputSignal,
} from "./policy/command-loop-analysis.js";
import { classifyLatestToolProgress } from "./governance/recovery-progress.js";
import {
  PhaseModelOrchestrator,
} from "./orchestration/phase-model-orchestrator.js";
import {
  appendPathContextToAdapterBlock,
  ClientAdapterPacks,
  parseSessionExecutionContext,
} from "./adapters/client-adapter-packs.js";
import { toSessionExecutionContextSystemBlock } from "./adapters/session-execution-context.js";
import { inferModelFamily } from "./prompt/infer-model-family.js";
import { StablePrefixService } from "./context/stable-prefix.js";
import { computePrefixFingerprint } from "./context/provider-cache-hints.js";
import { AttentionPositioningService } from "./context/attention-positioning.js";
import {
  createRouteEnrichmentService,
  detectLanguagesFromMessages,
  phaseFromFrame,
} from "./context/route-enrichment.js";
import { SessionContinuityService } from "./context/session-continuity.js";
import { applyMarkdownGuardrail } from "./response-style.js";
import {
  evaluateYarnPromptIntakeSteer,
} from "./upper-harness/bridge.js";
import { createUpperHarnessDecisionRecorder } from "./upper-harness/decision-recorder.js";
import { detectToolProgress } from "./policy/tool-progress-detector.js";
import { CircuitBreakerRegistry } from "./providers/circuit-breaker.js";
import { UserRateLimiter } from "./middleware/user-rate-limit.js";
import { initOtel, getTracer, withSpan, withSpanAsync } from "./telemetry/otel.js";
import { startEventLoopMonitor, getEventLoopStats } from "./telemetry/event-loop-monitor.js";
import { createRequestForensicsRecorder } from "./telemetry/request-forensics-recorder.js";
import { inferTrajectoryDiagnosticsFromMessages } from "./telemetry/trajectory-diagnostics.js";
import { createRouteEventEmitters } from "./telemetry/route-event-emitters.js";
import {
  applySensemakingStats,
  createEmptySensemakingStats,
  runSensemaking,
  type SensemakingStats,
} from "./sensemaking/index.js";
import { DistributedCounterService } from "./state/distributed-counters.js";
import { StreamAdmissionController } from "./middleware/stream-admission.js";
import { createSessionPersistenceRunner } from "./state/session-persistence-runner.js";
import { createRoutePersistenceScope } from "./state/route-persistence-scope.js";
import { createSessionResourceRegistry } from "./state/session-resource-registry.js";
import { createSessionLifecycleHelpers } from "./state/session-lifecycle.js";
import { createProviderRequestSupport } from "./providers/provider-request-support.js";
import { createMaxOutputTokenSafetyClamp } from "./providers/output-token-safety.js";
import {
  createDiagnosticPusher,
  createProviderUsageReader,
} from "./telemetry/route-telemetry-helpers.js";
import {
  readPersistedChatStateSnapshot,
} from "./state/persistence-state-channels.js";
import { prepareProtocolPauseState } from "./session/protocol-pause-state.js";
import { EnrichmentPool } from "./workers/pool.js";
import { createValidationTierCFallbackRunner } from "./validation/tier-c-fallback-runner.js";
import {
  buildExecutionGovernorHardStopUserMessage,
  buildExecutionGovernorPauseEnvelope,
  inferGovernorPhaseFromMessages,
  extractCommandEvents,
  extractEditedFileHints,
  isPlanRecoveryDiscoveryIntent,
} from "./governance/execution-governor.js";
import {
  persistGovernorPauseSoftFail,
  resetGovernorPauseRecoveryState,
} from "./governance/governor-pause-route.js";
import { GovernorService } from "./governance/governor-service.js";
import { OpenAIChatPipeline } from "./pipeline/openai-chat-pipeline.js";
import { buildRouteGovernanceBlocks } from "./pipeline/route-governance-blocks.js";
import { finalizePostEnrichmentMessages } from "./pipeline/post-enrichment-finalization.js";
import { applyWorkspaceMetadataPrebackfill } from "./pipeline/workspace-metadata-prebackfill.js";
import {
  injectGovernorRecoveryMessage,
} from "./pipeline/route-tool-preparation.js";
import {
  resetQwenInterventionOnUserTurn,
} from "./pipeline/route-adapter-pivot.js";
import { createRouteGovernanceStateHelpers } from "./governance/route-governance-state.js";
import {
  buildSensemakingPauseMessage,
  buildSensemakingGuidanceInjection,
} from "./governance/sensemaking-governor.js";
import { buildArtifactShadows, summarizeArtifactContext } from "./governance/artifact-shadow.js";
import {
  applyEditContextMissReadGate,
  buildEditContextMissForcedReadPrompt,
  buildEditContextMissGuardPrompt,
  buildStateRegroundReadPrompt,
  classifyLatestReadRefresh,
  collectToolExecutionFailureObservations,
  deriveEditContextMissGuardState,
  ensureReadToolAvailabilityForEditMissGuard,
  findLastUserPromptIdx,
  findPreferredReadToolName,
  isGenuineUserPromptMessage,
  isWriteCapableToolName,
  sliceMessagesSinceLastUserPrompt,
} from "./tools/tool-execution-recovery.js";
import {
  annotatePlanFileReads,
  annotateVerificationGaps,
  applyDiscoveryToolGuardrail,
  buildBlockedDiscoveryRecoverySnapshot,
  extractPlanContentShadow,
  getCachedTopLevelDirs,
  injectPlanModeRecoveryHint,
  remediatePlanFileStubs,
} from "./planning/plan-file-guardrails.js";
import { summarizeEvidenceDelta } from "./governance/evidence-delta.js";
import {
  deriveChatState,
} from "./governance/chat-state.js";
import { deriveFileState } from "./governance/file-state.js";
import {
  assessStateConfidence,
  formatStateConfidenceBlock,
} from "./governance/state-confidence.js";
import {
  projectInstructionFilePresent,
} from "./governance/workspace-boundary.js";
import {
  applyWorkspaceBoundary,
  buildFreshImplicitSessionNotice,
  hasPersistedWorkspaceState,
  mergeSessionPathHints,
  setSessionWorkspaceContext,
} from "./state/workspace-session-boundary.js";
import { createWorkspaceSessionStateHelpers } from "./state/workspace-session-state-helpers.js";
import {
  applyAuthKeyAttribution,
  createSessionContextInjector,
} from "./state/route-session-helpers.js";
import { StateTransitionGlobalCalibrator } from "./governance/state-transition-global-calibrator.js";
import { resetRecoveryCounters } from "./path-governance/tool-call-governance.js";
import {
  chatPhaseFromWorkflowPhase,
  countTurnsSinceLastUser,
  inferVerificationSteps,
  isMatrixCapabilityEnabled,
  isOpenClawProfile,
  resolveWorkingPhase,
  shouldRestrictDiscoveryForPlanWork,
} from "./server/route-governance-helpers.js";
import { detectClientTaskCapabilities } from "./task-ledger/index.js";
import {
  classifyToolResultAsEvidence,
  maybeUpdateTaskLedgerFromEvidence,
  maybeUpdateTaskLedgerFromToolCall,
} from "./task-ledger/route-task-ledger-helpers.js";

const GOVERNOR_COOLDOWN_MS = 3_000;

const toolArgHardeningStats = {
  normalizedPathCount: 0,
  projectRootConstrainedCount: 0,
  envelopeUnwrappedCount: 0,
  envelopeUnwrappedArgsObjectCount: 0,
  envelopeUnwrappedArgsJsonStringCount: 0,
  envelopeUnwrappedArgumentsObjectCount: 0,
  envelopeUnwrappedArgumentsJsonStringCount: 0,
  envelopeUnwrappedInputObjectCount: 0,
  envelopeUnwrappedInputJsonStringCount: 0,
  blockedBashPathDriftCount: 0,
  blockedUnsafeShellCount: 0,
  blockedWriteCapableToolCount: 0,
  remappedArgsCount: 0,
  repairedWriteContentCount: 0,
  repairedWriteCount: 0,
  repairedBashCount: 0,
  validationFailedCount: 0,
  qwenParserMismatchSuspectCount: 0,
};
const toolSchemaPruningStats = {
  requestsConsidered: 0,
  requestsPruned: 0,
  toolsPrunedTotal: 0,
};
const openClawProfileStats = {
  requestsObserved: 0,
  strictGovernanceRewrites: 0,
};
const contextAdmissionStats = {
  checked: 0,
  warned: 0,
  rejected: 0,
  byPath: {
    openai: 0,
    claude: 0,
  },
};

import { initFgaClient, fgaCheck } from "./openfga-client.js";
import {
  registerConfiguredRoutes,
} from "./server/route-registration.js";
import { buildRouteDependencyGroups } from "./server/route-dependency-groups.js";
import {
  createGracefulShutdown,
  registerShutdownSignals,
  startSessionTtlEviction,
  startTierPolling,
} from "./server/lifecycle.js";
import { createTierRegistryRefresher } from "./server/tier-registry-refresh.js";
import {
  formatValidationError,
  resolveRequestId,
  safeEnd,
  safeSse,
  safeWrite,
  selectedOpenAiCompatHeaders,
  startSseHeartbeat,
} from "./server/http-utils.js";
import { createProtocolDebugLogger } from "./server/route-debug-log.js";
import {
  applyClarificationRoundResponseHeader,
  extractLatestUserPromptFromMessages,
  extractTextFromUnknownContent,
  getMetadataString,
  sseHeadersWithClarification,
  updateTracePromptMetadata,
} from "./server/route-protocol-helpers.js";
import { createInternalTokenRequirement } from "./server/internal-auth.js";
import { extractUpstreamErrorDiagnostics } from "./server/upstream-errors.js";
import {
  knowledgeResolveContext,
  webSearchResolveContext,
} from "./server/tool-resolve-contexts.js";

const config = loadConfig();
const requireInternalToken = createInternalTokenRequirement(config.SYNESIS_INTERNAL_SERVICE_TOKEN);
const governorService = new GovernorService({
  enabled: config.SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED,
  governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
  defaultProfile: config.SYNESIS_YARN_GOVERNANCE_PROFILE,
});
const openAiChatPipeline = new OpenAIChatPipeline({ governorService });

const clampMaxOutputTokensForSafety = createMaxOutputTokenSafetyClamp(config);

initFgaClient(config);
const app = Fastify({
  logger: { level: config.LOG_LEVEL },
  forceCloseConnections: "idle",
  bodyLimit: 50 * 1024 * 1024 // 50MB to support massive conversation histories from subagents
});
await app.register(fastifyRateLimit, {
  global: true,
  max: config.SYNESIS_YARN_GLOBAL_RATE_LIMIT_MAX,
  timeWindow: config.SYNESIS_YARN_GLOBAL_RATE_LIMIT_WINDOW,
});

const yarnDedupeLayer =
  config.SYNESIS_YARN_DEDUPE_ENABLED
    ? new DedupeLayer({
        maxCacheEntries: config.SYNESIS_YARN_DEDUPE_CACHE_MAX,
        maxSearchQueryChars: config.SYNESIS_YARN_DEDUPE_MAX_SEARCH_QUERY_CHARS,
        log: (e) =>
          app.log.info(
            { kind: e.kind, msg: e.message, toolCallIds: e.toolCallIds, detail: e.detail },
            "yarn_dedupe",
          ),
      })
    : null;

const blockStore = new BlockStore();

const yarnToolPrefixCache =
  config.SYNESIS_YARN_TOOL_COLLAPSE_ENABLED && config.SYNESIS_YARN_TOOL_PREFIX_CACHE_ENABLED
    ? new ToolPrefixCache({
        maxEntries: config.SYNESIS_YARN_TOOL_PREFIX_CACHE_MAX_ENTRIES,
        maxEntryBytes: config.SYNESIS_YARN_TOOL_PREFIX_CACHE_MAX_ENTRY_BYTES,
      })
    : null;
const promRegistry = new Registry();
const svcMetrics = createServiceMetrics("yarn", promRegistry);
const traceEmitterConfig = {
  adminUrl: config.SYNESIS_YARN_ADMIN_API_URL,
  adminToken: config.SYNESIS_INTERNAL_SERVICE_TOKEN ?? "",
};
const securityIngestConfig = {
  adminUrl: config.SYNESIS_YARN_ADMIN_API_URL,
  adminToken: config.SYNESIS_INTERNAL_SERVICE_TOKEN ?? "",
};
const tierRegistry = new SynesisProviderRegistry({
  upstreamRetryPolicy: {
    enabled: config.SYNESIS_YARN_UPSTREAM_RETRY_ENABLED,
    maxAttempts: Math.max(1, config.SYNESIS_YARN_UPSTREAM_RETRY_MAX_ATTEMPTS),
    baseDelayMs: Math.max(0, config.SYNESIS_YARN_UPSTREAM_RETRY_BASE_DELAY_MS),
    maxDelayMs: Math.max(0, config.SYNESIS_YARN_UPSTREAM_RETRY_MAX_DELAY_MS),
    jitterMs: Math.max(0, config.SYNESIS_YARN_UPSTREAM_RETRY_JITTER_MS),
  },
  dashscopeOptions: {
    mode: config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MODE,
    canaryPct: config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_CANARY_PCT,
    maxMarkers: config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MAX_MARKERS,
  },
  cacheDebugTraceMode: config.SYNESIS_YARN_CACHE_DEBUG_TRACE,
});

// Prefix optimizer always builds stable-first layouts. Explicit markers are selected per request
// for provider endpoints that support them (currently gated DashScope); vLLM/OpenRouter/etc. keep
// markerBackend="none" and rely on implicit prefix reuse.
const prefixOptimizer = config.SYNESIS_YARN_PREFIX_OPTIMIZER_ENABLED
  ? new PrefixOptimizer({
      markerBackend: "none",
      maxMarkers: Math.max(0, config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MAX_MARKERS),
      enableReduction: true,
      enableDiagnosticLogging: true,
    })
  : null;
if (prefixOptimizer) {
  tierRegistry.setPrefixOptimizer(prefixOptimizer);
}

const roleAssignmentRegistry = new Map<string, RoleAssignmentConfig>();
let promptSnapshotRegistry: PromptSnapshot | null = null;
const sawtooth = new SawtoothContextManager(config.SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS, config.SYNESIS_YARN_COMPACTION_FALLBACK_MAX_CHARS);
const sessions = new Map<string, SessionState>();
const rotatedSessionByBaseKey = new Map<string, string>();
const sessionStore = new SessionStore(config);
const diagnosticRegistry = new RequestDiagnosticRegistry(config);
const pushDiagnostic = createDiagnosticPusher(diagnosticRegistry);
const memoryStoreRedis = config.SYNESIS_YARN_SESSION_REDIS_URL
  ? new IORedis(config.SYNESIS_YARN_SESSION_REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 1000,
    })
  : null;
const memoryStore = new MemoryStore(
  memoryStoreRedis,
  config.SYNESIS_YARN_MEMORY_STORE_MAX_ENTRIES,
);
initMemoryToolStore(memoryStore);
const usageWriter = new UsageWriter(config);
const {
  captureRequestForensics,
  finalizeRequestForensics,
} = createRequestForensicsRecorder({
  mode: config.SYNESIS_YARN_REQUEST_FORENSICS_MODE,
  maxPreviewChars: config.SYNESIS_YARN_REQUEST_FORENSICS_MAX_PREVIEW_CHARS,
  usageWriter,
});
const recordSessionEvent = createSessionEventRecorder({
  writer: usageWriter,
  logger: app.log,
});
const {
  getChecklistSourceHash,
  maybeBuildPlannerTodoPacketBlock,
  persistPromptIntakeSnapshot,
  recordPromptIntakeEvent,
  refreshRequirementChecklist,
  refreshTaskIntake,
  updatePlanGraph,
} = createPlanningStateHelpers({
  config,
  tierRegistry,
  generateText,
  clampMaxOutputTokensForSafety,
  hashTextSignal,
  getMetadataString,
  recordSessionEvent,
  logger: app.log,
});
const {
  persistGovernorPauseContextMetadata,
  clearGovernorPauseContextMetadata,
  buildGovernorPauseResumeBlockForUser,
  applyObjectiveScopeAndPersist,
  persistStateConfidence,
} = createRouteGovernanceStateHelpers({
  config,
  recordSessionEvent,
});
const {
  finalizeCompletionText,
  finalizePostStreamText,
} = createCompletionFinalizers({
  config,
  recordSessionEvent,
});
const usagePersistenceEnabled =
  config.SYNESIS_YARN_PERSIST_USAGE_TO_DB && Boolean(String(config.SYNESIS_YARN_ADMIN_DB_URL ?? "").trim());
if (!usagePersistenceEnabled) {
  app.log.warn(
    {
      persistFlag: config.SYNESIS_YARN_PERSIST_USAGE_TO_DB,
      hasAdminDbUrl: Boolean(String(config.SYNESIS_YARN_ADMIN_DB_URL ?? "").trim()),
    },
    "yarn_usage_persistence_disabled: set SYNESIS_YARN_ADMIN_DB_URL to the same Postgres URL admin uses, or admin Yarn pages stay stale/empty",
  );
} else {
  app.log.info("yarn_usage_persistence_enabled");
  if (config.SYNESIS_YARN_CONVERSATION_MEMORY_ENABLED) {
    void usageWriter.ensureContinuityTable().catch((err) =>
      app.log.warn({ err }, "Failed to ensure yarn_session_continuity table (non-fatal)")
    );
  }
}
const authResolver = new AuthResolver(config);
const artifactStore = new ArtifactStore({
  maxCount: config.SYNESIS_YARN_ARTIFACT_MAX_COUNT,
  ttlMs: config.SYNESIS_YARN_ARTIFACT_TTL_MS,
  maxPayloadBytes: config.SYNESIS_YARN_ARTIFACT_MAX_PAYLOAD_BYTES,
  replicaRedis: memoryStoreRedis,
  replicaEnabled: config.SYNESIS_YARN_ARTIFACT_REDIS_REPLICA_ENABLED,
});
const toolBlobTier = createToolBlobTier(config, memoryStoreRedis);
const artifactRetrieval = new ArtifactRetrievalService(artifactStore, {
  redis: memoryStoreRedis,
  enabled: config.SYNESIS_YARN_ARTIFACT_REDIS_REPLICA_ENABLED,
});
const knowledgeSearch = new KnowledgeSearchService({
  plannerBaseUrl: config.SYNESIS_YARN_PLANNER_URL,
  internalServiceToken: config.SYNESIS_INTERNAL_SERVICE_TOKEN,
});
const webSearch = new WebSearchService({
  plannerBaseUrl: config.SYNESIS_YARN_PLANNER_URL,
  internalServiceToken: config.SYNESIS_INTERNAL_SERVICE_TOKEN,
});

const validationNormalization = new ValidationNormalizationService(config, artifactStore);
const toolResultReduction = new ToolResultReductionService(config, artifactStore);
const transcriptPruning = new TranscriptPruningService(
  {
    enabled: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED,
    keepTurns: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TURNS,
    keepToolResults: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TOOL_RESULTS,
    budgetChars: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_BUDGET_CHARS,
    stubMaxChars: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_STUB_MAX_CHARS,
    assistantCondenseChars: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_ASSISTANT_CONDENSE_CHARS,
    artifactRetentionEnabled: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_ARTIFACT_RETENTION_ENABLED,
  },
  artifactStore,
);
const {
  contentDedupBySession,
  fileSnapshotBySession,
  structuralIndexBySession,
  memoryGovernorBySession,
  blockedDiscoveryBySession,
  getContentDedup,
  getFileSnapshotRegistry,
  getStructuralIndex,
  getMemoryGovernor,
  recordBlockedDiscovery,
  getBlockedDiscoveryCount,
  shouldStripGlobFromTools,
  stripGlobFromTools,
} = createSessionResourceRegistry(config);
const enrichmentPool = new EnrichmentPool(config);
if (enrichmentPool.isAvailable()) {
  app.log.info({ poolSize: config.SYNESIS_YARN_WORKER_POOL_SIZE || "auto" }, "worker_pool_enabled");
}
const workingFrameService = new WorkingFrameService(config.SYNESIS_YARN_FRAME_MAX_FILES);
const projectManifestService = new ProjectManifestService();
const policyEngine = new DeterministicPolicyEngine({
  maxRepeatEntries: config.SYNESIS_YARN_POLICY_REPEAT_MAP_MAX,
  repeatEntryTtlMs: config.SYNESIS_YARN_POLICY_REPEAT_ENTRY_TTL_MS,
});
const {
  logAndPersistSafetyEvent,
  emitPlanWriteAuditEvent,
  emitDecisionEvents,
} = createRouteEventEmitters({
  config,
  policyEvents: policyEngine,
  usageWriter,
  logger: app.log,
  recordSessionEvent,
});
const sessionContinuity = new SessionContinuityService();
const {
  getSessionKey,
  getSessionState,
  buildSessionStateSnapshot,
  casSessionSave,
  resolveCompactionBackendModelHintFromRequestModel,
  pinchCompactionBackendModelMetadata,
  maybeCheckpoint,
  forceCheckpoint,
} = createSessionLifecycleHelpers({
  config,
  logger: app.log,
  sessions,
  rotatedSessionByBaseKey,
  sessionStore,
  sessionContinuity,
  usageWriter,
  tierRegistry,
  sawtooth,
  metrics: {
    compactionTotal: svcMetrics.compactionTotal,
    sessionCheckpointTotal: svcMetrics.sessionCheckpointTotal,
    compactionCharsSaved: svcMetrics.compactionCharsSaved,
  },
  createDiffStats,
  resetRecoveryCounters,
  clearImplicitSessionResources: (baseKey) => {
    sessions.delete(baseKey);
    contentDedupBySession.delete(baseKey);
    fileSnapshotBySession.delete(baseKey);
    structuralIndexBySession.delete(baseKey);
    memoryGovernorBySession.delete(baseKey);
    clearSessionMemory(baseKey);
    blockedDiscoveryBySession.delete(baseKey);
  },
  getFileSnapshotRegistry,
  getContentDedup,
  recordSessionEvent,
});
const {
  loadUserRuntimePreferences,
  loadProviderCachePolicyWindow,
  evaluateCachePolicyForSession,
  markerBackendForRequest,
  runOpenAIRequest,
  shouldSampleBySeed,
  maybeLogEnvelopeUnwrapSample,
} = createProviderRequestSupport({
  config,
  logger: app.log,
  tierRegistry,
  sessionStore,
});

import { GovernanceClient } from "./policy/governance-client.js";
import { resolveCapabilityMatrix } from "./policy/capability-matrix.js";
const governanceClient = config.SYNESIS_YARN_GOVERNANCE_ENABLED
  ? new GovernanceClient(config)
  : null;
if (governanceClient) governanceClient.start();
initPatternFeedback(config);

import { loadAllPacks, getLanguagePackRegistry } from "./language-packs/index.js";
loadAllPacks();
app.log.info({ packs: getLanguagePackRegistry().size }, "language_packs_loaded");
const circuitBreakers = new CircuitBreakerRegistry({
  failureThreshold: config.SYNESIS_YARN_BREAKER_FAILURE_THRESHOLD,
  recoveryTimeoutMs: config.SYNESIS_YARN_BREAKER_RECOVERY_TIMEOUT_MS,
  halfOpenMax: config.SYNESIS_YARN_BREAKER_HALF_OPEN_MAX,
});
const userRateLimiter = new UserRateLimiter({
  windowMs: config.SYNESIS_YARN_RATE_LIMIT_WINDOW_MS,
  maxRequests: config.SYNESIS_YARN_RATE_LIMIT_MAX_REQUESTS,
  redis: memoryStoreRedis ?? undefined,
});
const distributedCounters = new DistributedCounterService(config);
const stateTransitionGlobalCalibrator = new StateTransitionGlobalCalibrator({
  maxBuckets: 512,
  maxSamplesPerBucket: 128,
  minSamples: 16,
  minPositive: 4,
  minNegative: 4,
  smoothing: 0.4,
  activationSampleCount: 16,
  backingStoreRefreshMs: 12_000,
  backingStorePersistMs: 4_000,
  backingStore: {
    readScope: async (scopeKey) => distributedCounters.getStateTransitionGlobalCalibrationScope(scopeKey),
    writeScope: async (scopeKey, payload) => distributedCounters.setStateTransitionGlobalCalibrationScope(scopeKey, payload),
  },
});
const sessionPersistenceRunner = createSessionPersistenceRunner<SessionState>({
  config: {
    cachePolicyProviderWindowHours: config.SYNESIS_YARN_CACHE_POLICY_PROVIDER_WINDOW_HOURS,
    conversationMemoryEnabled: config.SYNESIS_YARN_CONVERSATION_MEMORY_ENABLED,
    hourlyTokenThrottleEnabled: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_ENABLED,
    hourlyTokenThrottleWindowMs: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_WINDOW_MS,
    hourlyTokenThrottleSessionLimit: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_SESSION_LIMIT,
    hourlyTokenThrottleUserLimit: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_USER_LIMIT,
  },
  tierRegistry,
  sessionStore,
  writer: usageWriter,
  saveSession: (state) => casSessionSave(state),
  counter: distributedCounters,
  globalCalibrator: stateTransitionGlobalCalibrator,
  recordSessionEvent,
  maybeCheckpoint,
  emitDecisionEvents,
  recordUsageMetrics: (
    metricsTraceModel,
    metricsResolvedModelId,
    telemetryUsage,
    latencySeconds,
  ) => {
    recordUsageMetrics(
      svcMetrics,
      metricsTraceModel,
      metricsResolvedModelId,
      telemetryUsage,
      latencySeconds,
    );
  },
  emitTrace: (trace) => {
    emitTrace(trace, traceEmitterConfig, app.log);
  },
  logger: app.log,
});
const streamAdmission = new StreamAdmissionController({
  maxConcurrentStreams: config.SYNESIS_YARN_MAX_CONCURRENT_STREAMS,
  maxQueueDepth: config.SYNESIS_YARN_STREAM_QUEUE_MAX_DEPTH,
  queueWaitTimeoutMs: config.SYNESIS_YARN_STREAM_QUEUE_WAIT_TIMEOUT_MS,
});
await initOtel(config);
startEventLoopMonitor();
const phaseOrchestrator = new PhaseModelOrchestrator(config.SYNESIS_YARN_CLAUDE_TIER_MAP);
const sensemakingStats: SensemakingStats = createEmptySensemakingStats();
const clientAdapterPacks = new ClientAdapterPacks();
const stablePrefixService = new StablePrefixService();
const {
  resetWorkspaceScopedSessionState,
  workspaceStatePresence,
} = createWorkspaceSessionStateHelpers({
  contentDedupBySession,
  fileSnapshotBySession,
  structuralIndexBySession,
  memoryGovernorBySession,
  blockedDiscoveryBySession,
  stablePrefixService,
  clearSessionMemory,
  getSessionMemoryCount,
});
const attentionPositioning = new AttentionPositioningService();
const { enrichWithFrameAndManifest } = createRouteEnrichmentService({
  config,
  blockStore,
  workingFrameService,
  projectManifestService,
  stablePrefixService,
  attentionPositioning,
  getPromptSnapshot: () => promptSnapshotRegistry,
  getStructuralIndex,
  getContentDedup,
  getMemoryGovernor,
});

const injectSessionContext = createSessionContextInjector(config);

const refreshTierRegistry = createTierRegistryRefresher({
  config,
  generateText,
  logger: app.log,
  phaseOrchestrator,
  promptSnapshot: {
    set: (snapshot) => {
      promptSnapshotRegistry = snapshot;
    },
  },
  roleAssignmentRegistry,
  sawtooth,
  tierRegistry,
});

const runValidationTierCFallback = createValidationTierCFallbackRunner({
  config,
  generateText,
  roleAssignmentRegistry,
  tierRegistry,
});

import {
  adapterUsesToolLoopSteering,
} from "./providers/model-adapter.js";
import { buildDefaultPolicy } from "./path-governance/path-sandbox.js";
import { classifyIntentScope } from "./governance/intent-scope-classifier.js";
import {
  createDiffStats,
  assessProportionality,
  proportionalityToSignal,
} from "./governance/diff-accumulator.js";
import { createRouteDiffAccumulatorUpdater } from "./governance/route-diff-accumulator.js";
import { lastToolUseIdFromClaudeMessages } from "./session/workspace-context-handshake.js";
import { processWorkspaceHandshakeRoute } from "./session/workspace-handshake-route.js";
import {
  policyRejectOpenAIBody,
  sendOpenAISoftFail,
  sendOpenAIWorkspaceHandshake,
} from "./protocol/route-response-senders.js";

const updateDiffAccumulator = createRouteDiffAccumulatorUpdater({
  proportionalityEnabled: config.SYNESIS_YARN_PROPORTIONALITY_ENABLED,
});

const recordUpperHarnessDecision = createUpperHarnessDecisionRecorder({
  recordSessionEvent,
});

const readUsage = createProviderUsageReader({
  debug: config.SYNESIS_YARN_DEBUG_PROTOCOL,
  logger: app.log,
});

const debugProtocolLog = createProtocolDebugLogger(config.SYNESIS_YARN_DEBUG_PROTOCOL);

const sessionEvictionTimer = startSessionTtlEviction({
  ttlMs: config.SYNESIS_YARN_SESSION_TTL_MS,
  sessions,
  saveSession: casSessionSave,
  contentDedupBySession,
  fileSnapshotBySession,
  structuralIndexBySession,
  memoryGovernorBySession,
  clearSessionMemory,
  blockedDiscoveryBySession,
  stablePrefixService,
});
let tierPollTimer: ReturnType<typeof setInterval> | null = null;
const shutdown = createGracefulShutdown({
  app,
  sessions,
  sessionStore,
  buildSessionStateSnapshot,
  sessionEvictionTimer,
  getTierPollTimer: () => tierPollTimer,
  streamAdmission,
  userRateLimiter,
  policyEngine,
  governanceClient,
  artifactStore,
  usageWriter,
  authResolver,
  distributedCounters,
  diagnosticRegistry,
  enrichmentPool,
  memoryStoreRedis,
});
registerShutdownSignals(shutdown);

await registerNonChatRoutes({
  app,
  config,
  authResolver,
  dedupeLayer: yarnDedupeLayer,
  toolPrefixCache: yarnToolPrefixCache,
  requireInternalToken,
  userRateLimiter,
});

const routeDependencyGroups = buildRouteDependencyGroups({
    app,
    adapterUsesToolLoopSteering,
    analyzeRecentCommandLoop,
    annotatePlanFileReads,
    annotateVerificationGaps,
    applyClarificationRoundResponseHeader,
    applyAuthKeyAttribution,
    applyIngressCapToToolMessages,
    applySessionTaskCapabilities,
    applyWorkspaceBoundary,
    applyWorkspaceMetadataPrebackfill,
    appendPathContextToAdapterBlock,
    applyDiscoveryToolGuardrail,
    applyEditContextMissReadGate,
    applyMarkdownGuardrail,
    applyObjectiveScopeAndPersist,
    applySensemakingStats,
    artifactRetrieval,
    artifactStore,
    ARTIFACT_TOOL_NAME,
    assessProportionality,
    assessStateConfidence,
    assessVerificationSignals,
    authResolver,
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
    cachePolicyLogRecord,
    casSessionSave,
    captureRequestForensics,
    chatPhaseFromWorkflowPhase,
    circuitBreakers,
    classifyIntentScope,
    classifyLatestReadRefresh,
    classifyLatestToolProgress,
    classifyToolResultAsEvidence,
    clampMaxOutputTokensForSafety,
    clearGovernorPauseContextMetadata,
    clientAdapterPacks,
    collectToolExecutionFailureObservations,
    computePrefixFingerprint,
    config,
    contentDedupBySession,
    contextAdmissionStats,
    countTurnsSinceLastUser,
    createDiffStats,
    createRoutePersistenceScope,
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
    diagnosticRegistry,
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
    fgaCheck,
    finalizeCompletionText,
    finalizePostEnrichmentMessages,
    finalizePostStreamText,
    finalizeRequestForensics,
    findLastUserPromptIdx,
    findPreferredReadToolName,
    formatEvidenceBlock,
    formatPatternBlock,
    formatStateConfidenceBlock,
    formatValidationError,
    forceCheckpoint,
    generateText,
    getBlockedDiscoveryCount,
    getCachedTopLevelDirs,
    getChecklistSourceHash,
    getContentDedup,
    getEventLoopStats,
    getEvidencePrefetchStats,
    getFileSnapshotRegistry,
    getMemoryGovernor,
    getMetadataString,
    getPatternFeedbackStats,
    getPatternPrefetchStats,
    getSessionMemoryCount,
    getSessionKey,
    getSessionState,
    getStructuralIndex,
    getTracer,
    governanceClient,
    GOVERNOR_COOLDOWN_MS,
    governorService,
    stepGovernor: governorService,
    handleDeterministicPolicyPrecheck,
    hasPersistedWorkspaceState,
    hashTextSignal,
    inferGovernorPhaseFromMessages,
    inferModelFamily,
    inferTrajectoryDiagnosticsFromMessages,
    inferVerificationSteps,
    injectGovernorRecoveryMessage,
    injectPlanModeRecoveryHint,
    injectSessionContext,
    isGenuineUserPromptMessage,
    isMatrixCapabilityEnabled,
    isOpenClawProfile,
    isPlanRecoveryDiscoveryIntent,
    isWriteCapableToolName,
    KNOWLEDGE_TOOL_NAME,
    knowledgeResolveContext,
    knowledgeSearch,
    languagePacksConformance: () => getLanguagePackRegistry().getConformanceMatrix(),
    lastToolUseIdFromClaudeMessages,
    loadProviderCachePolicyWindow,
    loadUserRuntimePreferences,
    logAndPersistSafetyEvent,
    looksLikeFailureSignal,
    markerBackendForRequest,
    maybeCheckpoint,
    maybeBuildPlannerTodoPacketBlock,
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
    phaseFromFrame,
    phaseOrchestrator,
    pinchCompactionBackendModelMetadata,
    persistGovernorPauseContextMetadata,
    persistGovernorPauseSoftFail,
    persistPromptIntakeSnapshot,
    persistStateConfidence,
    policyEngine,
    policyRejectOpenAIBody,
    prefixOptimizer,
    prepareProtocolPauseState,
    processWorkspaceHandshakeRoute,
    projectInstructionFilePresent,
    projectManifestService,
    promRegistry,
    promptSnapshotRegistry,
    proportionalityToSignal,
    pushDiagnostic,
    readPersistedChatStateSnapshot,
    readUsage,
    readdir,
    recordBlockedDiscovery,
    recordPromptIntakeEvent,
    recordSessionEvent,
    recordUpperHarnessDecision,
    refreshRequirementChecklist,
    refreshTaskIntake,
    remediatePlanFileStubs,
    requireInternalToken,
    resetGovernorPauseRecoveryState,
    resetQwenInterventionOnUserTurn,
    resetWorkspaceScopedSessionState,
    resolveCapabilityMatrix,
    resolveCompactionBackendModelHintFromRequestModel,
    resolveEndpointCapabilityId,
    resolveRequestId,
    resolveWorkingPhase,
    roleAssignmentRegistry,
    runEvidencePrefetch,
    runOpenAIRequest,
    runPatternPrefetch,
    runProtocolSessionBootstrap,
    runSensemaking,
    runValidationTierCFallback,
    safeEnd,
    safeSse,
    safeWrite,
    securityIngestConfig,
    selectedOpenAiCompatHeaders,
    sendOpenAISoftFail,
    sendOpenAIWorkspaceHandshake,
    sensemakingStats,
    serializeShadow,
    sessionContinuity,
    sessionPersistenceRunner,
    sessions,
    sessionStore,
    setSessionWorkspaceContext,
    shouldResetImplicitSessionForFreshTranscript,
    shouldSampleBySeed,
    shouldStripGlobFromTools,
    shouldRestrictDiscoveryForPlanWork,
    sliceMessagesSinceLastUserPrompt,
    stablePrefixService,
    startSseHeartbeat,
    streamAdmission,
    streamText,
    stripGlobFromTools,
    summarizeArtifactContext,
    summarizeEvidenceDelta,
    sseHeadersWithClarification,
    TIER_TO_ROLE,
    tierRegistry,
    toSessionExecutionContextSystemBlock,
    toolArgHardeningStats,
    toolBlobRedisEnabled: Boolean(toolBlobTier),
    toolResultReduction,
    toolSchemaPruningStats,
    transcriptPruning,
    updateDiffAccumulator,
    updatePlanGraph,
    updateTracePromptMetadata,
    userRateLimiter,
    usagePersistenceEnabled,
    usageWriter,
    validationNormalization,
    webSearch,
    webSearchResolveContext,
    WEB_SEARCH_TOOL_ALIAS,
    WEB_SEARCH_TOOL_NAME,
    withSpan,
    withSpanAsync,
    workingFrameService,
    workspaceStatePresence,
    yarnDedupeLayer,
});
registerConfiguredRoutes(routeDependencyGroups);

tierPollTimer = await startTierPolling({
  refreshTierRegistry,
  intervalSeconds: config.SYNESIS_YARN_TIER_POLL_INTERVAL,
});

await app.listen({ port: config.PORT, host: config.HOST });
