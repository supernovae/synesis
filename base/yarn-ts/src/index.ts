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
  type OpenAIChatCompletionRequest
} from "./schemas.js";
import {
  fetchTierRegistrySnapshot,
  fetchPublicOfferingsForYarn,
  mergeYarnPublicOfferingsIntoTiers,
  resolveOfferingTierId,
  TIER_TO_ROLE,
  type PromptSnapshot,
  type RoleAssignmentConfig,
} from "./providers/admin-tier-registry.js";
import { SynesisProviderRegistry, type DashScopeCacheOpts } from "./providers/synesis-provider.js";
import { PrefixOptimizer, extractMetadataFromMessages, type MarkerBackend } from "./providers/prefix-optimizer/index.js";
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
  parseSynesisClarificationRound,
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
  type RequestDiagnostic,
} from "./telemetry/request-diagnostics.js";
import {
  cachePolicyLogRecord,
  evaluateCachePolicyController,
  type CachePolicyControllerDecision,
  type ProviderCachePolicyWindow,
} from "./telemetry/cache-policy-controller.js";
import {
  DEFAULT_USER_RUNTIME_PREFERENCES,
  normalizeUserRuntimePreferences,
  type UserRuntimePreferences,
} from "./runtime/user-preferences.js";
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
  type EffortTier,
  type WorkflowPhase,
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
  formatUpperHarnessDecisionSummary,
  type UpperHarnessDecision,
} from "./upper-harness/bridge.js";
import {
  openAIMessagesToModelMessages,
  ensureSystemMessagesAtBeginning,
  coalesceLeadingSystemMessages,
  sanitizeToolCalls,
} from "./tool-mapping.js";
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
import { normalizeProviderUsage } from "./telemetry/usage-normalization.js";
import {
  readPersistedChatStateSnapshot,
} from "./state/persistence-state-channels.js";
import { prepareProtocolPauseState } from "./session/protocol-pause-state.js";
import { EnrichmentPool } from "./workers/pool.js";
import type { TierCFallbackContext, TierCFallbackResult } from "./validation/normalizer.js";
import {
  buildExecutionGovernorHardStopUserMessage,
  buildExecutionGovernorPauseEnvelope,
  inferGovernorPhaseFromMessages,
  governorPhaseToWorkflowPhase,
  extractCommandEvents,
  extractEditedFileHints,
  type SessionPhase,
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
  type ChatPhase,
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
import type { CompactionMode } from "./governance/context-budget-manager.js";
import { StateTransitionGlobalCalibrator } from "./governance/state-transition-global-calibrator.js";
import { resetRecoveryCounters } from "./path-governance/tool-call-governance.js";
import {
  detectClientTaskCapabilities,
  isTaskToolCall,
  normalizeTaskToolCall,
  reconcileFromToolCall,
  reconcileFromEvidence,
  createEmptyLedger,
  type EvidenceSignal,
} from "./task-ledger/index.js";

function extractTextFromUnknownContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.text === "string" && row.text.trim()) parts.push(row.text.trim());
      if (typeof row.content === "string" && row.content.trim()) parts.push(row.content.trim());
    }
    return parts.join("\n").trim();
  }
  if (content && typeof content === "object") {
    const row = content as Record<string, unknown>;
    if (typeof row.text === "string") return row.text;
    if (typeof row.content === "string") return row.content;
  }
  return "";
}

function extractLatestUserPromptFromMessages(
  messages: Array<{ role: string; content: unknown }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const text = extractTextFromUnknownContent(messages[i].content).trim();
    if (text) return text.slice(0, 4000);
  }
  return "";
}

function inferVerificationSteps(sequence: string[]): string[] {
  const steps: string[] = [];
  for (const name of sequence) {
    if (name === "run_lint" && !steps.includes("run_lint")) steps.push("run_lint");
    else if (name === "run_build" && !steps.includes("run_build")) steps.push("run_build");
    else if (name === "run_test" && !steps.includes("run_test_targeted")) steps.push("run_test_targeted");
  }
  return steps;
}

function getMetadataString(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  return typeof value === "string" ? value : "";
}

function trimSnippet(text: string, max = 2000): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function updateTracePromptMetadata(state: SessionState, latestUserText: string): void {
  const latest = trimSnippet(latestUserText);
  if (!latest) return;
  state.record.metadata.latest_user_prompt = latest;
  if (!getMetadataString(state.record.metadata, "trace_root_prompt")) {
    state.record.metadata.trace_root_prompt = latest;
  }
}

function applyClarificationRoundResponseHeader(
  reply: { header: (k: string, v: string) => unknown },
  recordMetadata: Record<string, unknown>,
): void {
  const parsed = parseSynesisClarificationRound(recordMetadata.synesis_clarification_round);
  if (parsed) {
    reply.header("X-Synesis-Clarification-Round", JSON.stringify(parsed));
  }
}

function sseHeadersWithClarification(recordMetadata: Record<string, unknown>): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  const parsed = parseSynesisClarificationRound(recordMetadata.synesis_clarification_round);
  if (parsed) {
    h["X-Synesis-Clarification-Round"] = JSON.stringify(parsed);
  }
  return h;
}

const GOVERNOR_COOLDOWN_MS = 3_000;

function isOpenClawProfile(profile: { family?: string }): boolean {
  return profile.family === "openclaw";
}

function parseTierCFallbackJson(raw: string, maxFindings: number): TierCFallbackResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const findingsRaw = (parsed as Record<string, unknown>).findings;
  if (!Array.isArray(findingsRaw) || findingsRaw.length === 0) return null;
  const findings = findingsRaw
    .slice(0, maxFindings)
    .map((f) => {
      if (!f || typeof f !== "object") return null;
      const row = f as Record<string, unknown>;
      const message = String(row.message ?? "").trim();
      if (!message) return null;
      const severityRaw = String(row.severity ?? "error").toLowerCase();
      const severity: "error" | "warning" | "info" =
        severityRaw === "warning" || severityRaw === "info" ? severityRaw : "error";
      return {
        family: "generic" as const,
        severity,
        file: typeof row.file === "string" ? row.file : undefined,
        line: typeof row.line === "number" ? row.line : undefined,
        column: typeof row.column === "number" ? row.column : undefined,
        ruleId: typeof row.ruleId === "string" ? row.ruleId : undefined,
        excerpt: typeof row.excerpt === "string" ? row.excerpt : undefined,
        message,
      };
    })
    .filter((f): f is NonNullable<typeof f> => Boolean(f));
  if (findings.length === 0) return null;
  return { findings };
}

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

function pushDiagnostic(d: RequestDiagnostic): void {
  diagnosticRegistry.push(d);
}

import { initFgaClient, fgaCheck } from "./openfga-client.js";
import { registerOpenAIChatCompletionsRoute } from "./routes/openai-chat-completions-route.js";
import { registerClaudeMessagesRoute } from "./routes/claude-messages-route.js";
import { registerPlatformRoutes } from "./routes/platform-routes.js";
import {
  buildClaudeMessagesRouteDependencies,
  buildOpenAIChatCompletionsRouteDependencies,
  buildPlatformRouteDependencies,
} from "./server/route-dependencies.js";
import {
  createGracefulShutdown,
  registerShutdownSignals,
  startSessionTtlEviction,
  startTierPolling,
} from "./server/lifecycle.js";
import {
  debugProtocolLog as debugProtocolLogWithFlag,
  formatValidationError,
  resolveRequestId,
  safeEnd,
  safeSse,
  safeWrite,
  selectedOpenAiCompatHeaders,
  startSseHeartbeat,
} from "./server/http-utils.js";
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

function clampMaxOutputTokensForSafety(n: number): number {
  const c = config.SYNESIS_YARN_MAX_OUTPUT_TOKENS_SAFETY_CEILING;
  if (!c || c <= 0) return n;
  return Math.min(n, c);
}

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
      markerBackend: "none" as MarkerBackend,
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

import { GovernanceClient } from "./policy/governance-client.js";
import { resolveCapabilityMatrix, type CapabilityKey } from "./policy/capability-matrix.js";
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

function isMatrixCapabilityEnabled(
  governanceDisabled: boolean,
  mode: "enforced" | "shadow",
  resolvedCapabilities: Record<string, boolean>,
  key: CapabilityKey,
): boolean {
  if (governanceDisabled) return true;
  if (mode !== "enforced") return true;
  return resolvedCapabilities[key] === true;
}

function chatPhaseFromWorkflowPhase(phase?: WorkflowPhase): ChatPhase | undefined {
  if (!phase) return undefined;
  if (phase === "explore") return "inspect";
  if (phase === "planning") return "interpret";
  if (phase === "validation") return "verify";
  return "edit";
}

function resolveWorkingPhase(args: {
  orchestratorOverride?: WorkflowPhase;
  framePhase?: WorkflowPhase;
  governorPreviewPhase?: SessionPhase;
}): WorkflowPhase | undefined {
  if (args.orchestratorOverride) return args.orchestratorOverride;
  const governorPhase = args.governorPreviewPhase
    ? governorPhaseToWorkflowPhase(args.governorPreviewPhase)
    : undefined;
  const framePhase = args.framePhase;
  if (!framePhase) return governorPhase;
  if (!governorPhase || governorPhase === framePhase) return framePhase;
  // If the frame lags behind observed execution behavior, trust governor phase
  // to avoid planning-vs-implementation drift that can cause pause churn.
  if (
    (framePhase === "explore" || framePhase === "planning")
    && (governorPhase === "implementation" || governorPhase === "validation")
  ) {
    return governorPhase;
  }
  return framePhase;
}

function applyAuthKeyAttribution(
  state: SessionState,
  authUser: Pick<import("./auth.js").AuthUser, "authMethod" | "authKeyId" | "authKeyName" | "authKeyPrefix">,
): void {
  state.record.metadata.auth_method = authUser.authMethod;
  state.record.metadata.auth_key_id = authUser.authKeyId ?? "";
  state.record.metadata.auth_key_name = authUser.authKeyName ?? "";
  state.record.metadata.auth_key_prefix = authUser.authKeyPrefix ?? "";
}


/**
 * Update the task ledger when a tool call is detected as a todo/task tool.
 * Call after governToolCall for every tool call in the pipeline.
 */
function maybeUpdateTaskLedgerFromToolCall(
  session: SessionState,
  toolName: string,
  args: Record<string, unknown>,
  turn: number,
): void {
  if (!isTaskToolCall(toolName)) return;
  if (!session.taskCapabilities) return;

  const normalized = normalizeTaskToolCall(
    { toolName, args, turn },
    session.taskCapabilities,
  );
  if (normalized.length === 0) return;

  if (!session.taskLedger) {
    session.taskLedger = createEmptyLedger(
      session.record.sessionKey,
      session.taskCapabilities.hasExplicitTodoTool,
      session.taskCapabilities.hasExplicitPlanMode,
    );
  }
  session.taskLedger = reconcileFromToolCall(session.taskLedger, normalized, turn);
}

/**
 * Update the task ledger with evidence signals from tool results.
 */
function maybeUpdateTaskLedgerFromEvidence(
  session: SessionState,
  signals: EvidenceSignal[],
): void {
  if (!session.taskLedger || session.taskLedger.tasks.length === 0) return;
  if (signals.length === 0) return;
  session.taskLedger = reconcileFromEvidence(session.taskLedger, signals);
}

/**
 * Classify a tool result into evidence signals for the task ledger.
 */
function classifyToolResultAsEvidence(
  toolName: string,
  resultText: string,
  turn: number,
): EvidenceSignal[] {
  const signals: EvidenceSignal[] = [];
  const lower = toolName.toLowerCase().replace(/-/g, "_");
  const resultLower = resultText.toLowerCase();

  if (lower.includes("write") || lower.includes("edit") || lower.includes("patch") || lower.includes("replace") || lower.includes("str_replace")) {
    if (!resultLower.includes("error") && !resultLower.includes("failed")) {
      signals.push({ kind: "file_edit", detail: resultText.slice(0, 200), turn });
    }
  }

  if (lower.includes("test") || lower.includes("bash") || lower.includes("shell") || lower.includes("terminal") || lower.includes("command")) {
    if (/\b(pass|ok|passed|success)\b/i.test(resultText) && !/\b(fail|error|FAIL)\b/.test(resultText)) {
      signals.push({ kind: "test_pass", detail: resultText.slice(0, 200), turn });
    } else if (/\b(fail|FAIL|error|Error)\b/.test(resultText)) {
      signals.push({ kind: "test_fail", detail: resultText.slice(0, 200), turn });
    } else if (!resultLower.includes("error") && !resultLower.includes("failed") && resultText.length > 5) {
      signals.push({ kind: "command_success", detail: resultText.slice(0, 200), turn });
    }
  }

  return signals;
}

/**
 * Count assistant turns since the last user message in a scoped message window.
 * Used for sensemaking friction decay — prevents exponential decay from using
 * total event count (which grows unboundedly in client-driven tool loops).
 */
function countTurnsSinceLastUser(messages: readonly { role: string }[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") break;
    if (messages[i].role === "assistant") count++;
  }
  return Math.max(1, count);
}

function injectSessionContext(
  messages: Array<{ role: string; content: unknown }>,
  state: SessionState
): Array<{ role: string; content: unknown }> {
  // In minimal compaction mode, skip injecting server-side architectural
  // state.  Clients that manage their own context window (Cursor, Claude
  // Code, OpenCode) already compact; prepending a stale server summary
  // over their compacted transcript can cause the model to lose turns.
  if (config.SYNESIS_YARN_CONTEXT_BUDGET_COMPACTION_MODE === "minimal") {
    return messages;
  }
  const compacted = state.history.find(
    (m) => m.role === "system" && m.content.includes("<ARCHITECTURAL_STATE>")
  );
  if (!compacted) return messages;
  const alreadyPresent = messages.some(
    (m) => m.role === "system" && m.content === compacted.content,
  );
  if (alreadyPresent) return messages;
  return [{ role: "system", content: compacted.content }, ...messages];
}

async function refreshTierRegistry(): Promise<void> {
  try {
    const snapshot = await fetchTierRegistrySnapshot(config);
    const publicOfferings = await fetchPublicOfferingsForYarn(config);
    const mergedTiers = mergeYarnPublicOfferingsIntoTiers(snapshot.tiers, publicOfferings);
    tierRegistry.updateTiers(mergedTiers);
    const offeringOrchestratorEntries: Array<{ clientId: string; tier: EffortTier }> = [];
    for (const o of publicOfferings) {
      const tier = resolveOfferingTierId(o);
      if (tier === "synesis-pulse" || tier === "synesis-core" || tier === "synesis-horizon") {
        offeringOrchestratorEntries.push({ clientId: o.client_model_id.trim().toLowerCase(), tier });
      }
    }
    phaseOrchestrator.setPublicOfferingTiers(offeringOrchestratorEntries);
    roleAssignmentRegistry.clear();
    for (const role of snapshot.roleAssignments) {
      roleAssignmentRegistry.set(role.role, role);
    }
    if (snapshot.promptSnapshot) {
      promptSnapshotRegistry = snapshot.promptSnapshot;
    }
    if (snapshot.tiers.length > 0) {
      app.log.info({ tiers: snapshot.tiers.map((t) => t.id), auxiliaryRoles: snapshot.roleAssignments.length }, "tier_registry_refreshed");
      for (const t of snapshot.tiers) {
        if (!t.apiKey?.trim()) {
          app.log.warn(
            { tier: t.id, baseUrl: t.baseUrl, backendModel: t.backendModel },
            "tier_missing_api_key_env — set the key in provider-api-keys secret (same namespace as yarn) or SYNESIS_YARN_OPENAI_COMPAT_API_KEY",
          );
        }
      }
    } else {
      app.log.warn(
        {},
        "tier_registry_empty — no assigned coder-pulse / coder-core / coder-horizon / coder-compaction roles in admin, or role fetch returned none",
      );
    }
    const compactionTier = tierRegistry.getTierConfig("synesis-compaction");
    if (compactionTier) {
      sawtooth.setCompactFn(async (system: string, userPrompt: string) => {
        const { model } = tierRegistry.resolve("synesis-compaction", config.SYNESIS_YARN_DEFAULT_TIER);
        const result = await generateText({
          model: model as never,
          system,
          messages: [{ role: "user" as const, content: userPrompt }],
          maxOutputTokens: 2048
        });
        return result.text;
      });
    } else {
      sawtooth.setCompactFn(null);
    }
  } catch (error) {
    app.log.warn({ error }, "tier_registry_refresh_failed");
  }
}

async function runValidationTierCFallback(ctx: TierCFallbackContext): Promise<TierCFallbackResult | null> {
  if (!config.SYNESIS_YARN_VALIDATION_TIER_C_ENABLED) return null;
  const role = config.SYNESIS_YARN_VALIDATION_TIER_C_ROLE;
  const assigned = roleAssignmentRegistry.get(role);
  if (!assigned?.assigned || !assigned.backendModel) return null;

  const rawOutput = ctx.rawOutput.slice(0, Math.max(1000, config.SYNESIS_YARN_VALIDATION_TIER_C_MAX_INPUT_CHARS));
  const findingsTarget = Math.max(1, Math.min(ctx.maxFindings, config.SYNESIS_YARN_VALIDATION_TIER_C_MAX_FINDINGS));
  try {
    const { model } = tierRegistry.resolveAdHoc(
      `synesis-tierc-${role}`,
      assigned.backendModel,
      assigned.baseUrl,
      assigned.apiKey,
    );
    const result = await generateText({
      model: model as never,
      maxOutputTokens: 700,
      messages: [
        {
          role: "system",
          content: [
            "You extract validation findings from noisy tool output.",
            "Return strict JSON only with this shape:",
            '{"findings":[{"severity":"error|warning|info","file":"optional","line":0,"column":0,"ruleId":"optional","message":"required","excerpt":"optional"}]}',
            `Return at most ${findingsTarget} findings.`,
            "Do not include markdown, prose, or code fences.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Tool: ${ctx.toolName ?? "unknown"}`,
            `Family hint: ${ctx.family}`,
            "Output:",
            rawOutput,
          ].join("\n\n"),
        },
      ] as never,
      abortSignal: AbortSignal.timeout(Math.max(300, config.SYNESIS_YARN_VALIDATION_TIER_C_TIMEOUT_MS)),
    });
    return parseTierCFallbackJson(result.text, findingsTarget);
  } catch {
    return null;
  }
}

import type { ModelAdapter } from "./providers/model-adapter.js";
import {
  adapterUsesToolLoopSteering,
} from "./providers/model-adapter.js";
import type { GovernedToolCall } from "./path-governance/tool-call-governance.js";
import { buildDefaultPolicy } from "./path-governance/path-sandbox.js";
import { classifyIntentScope } from "./governance/intent-scope-classifier.js";
import {
  createDiffStats,
  recordEditOperation,
  recordFileDeletion,
  isFileDeletion,
  assessProportionality,
  proportionalityToSignal,
} from "./governance/diff-accumulator.js";
import { lastToolUseIdFromClaudeMessages } from "./session/workspace-context-handshake.js";
import { processWorkspaceHandshakeRoute } from "./session/workspace-handshake-route.js";
import {
  policyRejectOpenAIBody,
  sendOpenAISoftFail,
  sendOpenAIWorkspaceHandshake,
} from "./protocol/route-response-senders.js";

type ResolveResult =
  | {
      ok: true;
      resolved: { model: unknown; resolvedModelId: string; adapter: ModelAdapter };
      messages: ReturnType<typeof openAIMessagesToModelMessages>;
      transforms: {
        systemMessagesReordered: boolean;
        toolCallsSanitized: boolean;
        messageCountDelta: number;
      };
    }
  | { ok: false; error: string };

const dashScopeCacheOpts: DashScopeCacheOpts = {
  enabled: false,
  maxMarkers: 0,
};
/** Intentional no-op: keeps `resolve()` call-site shape; DashScope markers now live in endpoint-capabilities. */

function dashscopeCanaryEnabledForSession(sessionKey: string): boolean {
  const pct = Math.max(0, Math.min(100, Math.floor(config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_CANARY_PCT)));
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  const hash = crypto.createHash("sha256").update(sessionKey || "anon").digest();
  return hash.readUInt32BE(0) % 100 < pct;
}

function markerBackendForRequest(
  modelId: string,
  fallbackModelId: string,
  sessionKey: string,
  cachePolicy?: CachePolicyControllerDecision,
): MarkerBackend {
  if (cachePolicy && !cachePolicy.allowExplicitCacheMarkers) return "none";
  const mode = config.SYNESIS_YARN_DASHSCOPE_EXPLICIT_CACHE_MODE;
  if (mode === "off") return "none";
  if (mode === "canary" && !dashscopeCanaryEnabledForSession(sessionKey)) return "none";
  const primary = tierRegistry.getTierConfig(modelId);
  const fallback = tierRegistry.getTierConfig(fallbackModelId);
  const tier = primary ?? fallback;
  if (!tier || resolveEndpointCapabilityId(tier.baseUrl) !== "dashscope") return "none";
  return "dashscope";
}

async function loadUserRuntimePreferences(userId: string): Promise<UserRuntimePreferences> {
  if (!config.SYNESIS_YARN_USER_RUNTIME_PREFERENCES_ENABLED || !userId || userId === "anon") {
    return DEFAULT_USER_RUNTIME_PREFERENCES;
  }
  try {
    const raw = await sessionStore.loadUserRuntimePreferences(userId);
    return normalizeUserRuntimePreferences(raw);
  } catch (err) {
    app.log.warn({ err, userId }, "user_runtime_preferences_load_failed");
    return DEFAULT_USER_RUNTIME_PREFERENCES;
  }
}

async function loadProviderCachePolicyWindow(
  orgId: string,
  provider: string,
  clientKind: string,
): Promise<ProviderCachePolicyWindow | null> {
  if (!config.SYNESIS_YARN_CACHE_POLICY_CONTROLLER_ENABLED) return null;
  try {
    return await sessionStore.loadProviderCacheWindow(
      orgId || "no-org",
      provider || "unknown",
      config.SYNESIS_YARN_CACHE_POLICY_PROVIDER_WINDOW_HOURS,
      clientKind || "unknown-client",
    );
  } catch (err) {
    app.log.warn({ err, orgId, provider, clientKind }, "provider_cache_policy_window_load_failed");
    return null;
  }
}

function evaluateCachePolicyForSession(
  session: SessionState,
  provider: string,
  configuredCompactionMode: CompactionMode,
  providerWindow?: ProviderCachePolicyWindow | null,
  runtimePreferences?: UserRuntimePreferences | null,
): CachePolicyControllerDecision {
  return evaluateCachePolicyController({
    enabled: config.SYNESIS_YARN_CACHE_POLICY_CONTROLLER_ENABLED,
    metadata: session.record.metadata,
    provider,
    configuredCompactionMode,
    missStreakThreshold: config.SYNESIS_YARN_CACHE_POLICY_MISS_STREAK_THRESHOLD,
    telemetryMissingThreshold: config.SYNESIS_YARN_CACHE_POLICY_TELEMETRY_MISSING_THRESHOLD,
    premiumWriteWithoutReadThreshold: config.SYNESIS_YARN_CACHE_POLICY_PREMIUM_WRITE_STREAK_THRESHOLD,
    retryRiskStagnantCycles: config.SYNESIS_YARN_CACHE_POLICY_RETRY_RISK_STAGNANT_CYCLES,
    stagnantToolCycles: session.stagnantToolCycles,
    awaitingToolLoopUserAck: session.awaitingToolLoopUserAck,
    toolLoopNoUserAckCount: session.toolLoopNoUserAckCount,
    consecutiveRecoveryFires: session.consecutiveRecoveryFires,
    consecutiveEditContextMisses: session.consecutiveEditContextMisses,
    providerWindow,
    providerWindowMinRequests: config.SYNESIS_YARN_CACHE_POLICY_PROVIDER_WINDOW_MIN_REQUESTS,
    runtimePreferences,
  });
}

function runOpenAIRequest(request: OpenAIChatCompletionRequest): ResolveResult {
  try {
    const resolved = tierRegistry.resolve(request.model, config.SYNESIS_YARN_DEFAULT_TIER, dashScopeCacheOpts);
    const systemOrdered = ensureSystemMessagesAtBeginning(request.messages as never);
    const systemCoalesced = coalesceLeadingSystemMessages(systemOrdered as never);
    const sanitized = sanitizeToolCalls(systemCoalesced as never);
    let toolCallsSanitized = false;
    try {
      toolCallsSanitized = JSON.stringify(systemCoalesced) !== JSON.stringify(sanitized);
    } catch {
      toolCallsSanitized = systemCoalesced.length !== sanitized.length;
    }
    const messages = openAIMessagesToModelMessages(sanitized);
    return {
      ok: true,
      resolved,
      messages,
      transforms: {
        systemMessagesReordered: systemOrdered !== (request.messages as never),
        toolCallsSanitized,
        messageCountDelta: sanitized.length - ((request.messages as unknown[])?.length ?? 0),
      },
    };
  } catch {
    return { ok: false, error: "No model configuration available — the service may still be initializing" };
  }
}

/**
 * Update the session's diff accumulator from a governed tool call.
 * Called from all 4 governance call sites.
 */
function updateDiffAccumulator(session: SessionState, governed: GovernedToolCall): void {
  if (!config.SYNESIS_YARN_PROPORTIONALITY_ENABLED) return;
  if (session.scopeEnvelope === "unconstrained" || session.scopeEnvelope === "removal_ok") return;

  const logicalName = governed.toolName;
  const input = governed.input;

  // Skip blocked/error tool calls
  if (logicalName.startsWith("Synesis_Error")) return;

  const WRITE_TOOLS = new Set(["Write", "Edit", "Update", "MultiEdit", "FileWrite", "ApplyPatch", "StrReplace"]);
  if (!WRITE_TOOLS.has(logicalName) && logicalName !== "Bash") return;

  const filePath = typeof input.file_path === "string" ? input.file_path.trim()
    : typeof input.path === "string" ? input.path.trim() : "";

  if (WRITE_TOOLS.has(logicalName) && filePath) {
    const content = typeof input.content === "string" ? input.content : undefined;
    if (logicalName === "Write" || logicalName === "FileWrite") {
      if (isFileDeletion(content)) {
        recordFileDeletion(session.diffStats, filePath, 50);
      } else {
        const lines = (content ?? "").split("\n").length;
        recordEditOperation(session.diffStats, filePath, lines, 0);
      }
    } else {
      // Edit/Update/StrReplace: estimate from old_string vs new_string
      const oldStr = typeof input.old_string === "string" ? input.old_string : "";
      const newStr = typeof input.new_string === "string" ? input.new_string : "";
      const oldLines = oldStr ? oldStr.split("\n").length : 0;
      const newLines = newStr ? newStr.split("\n").length : 0;
      recordEditOperation(session.diffStats, filePath, newLines, oldLines);
    }
  }
}

function shouldSampleBySeed(seed: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const normalized = (hash >>> 0) / 0xffffffff;
  return normalized < rate;
}

function maybeLogEnvelopeUnwrapSample(
  logger: { info: (obj: Record<string, unknown>, msg?: string) => void },
  reqId: string,
  toolName: string,
  clientKind: string,
  governed: GovernedToolCall,
  toolCallId?: string,
): void {
  if (!governed.envelopeUnwrapped) return;
  const source = governed.envelopeSource ?? "unknown";
  const seed = `${reqId}:${toolCallId ?? "_"}:${toolName}:${source}:${clientKind}`;
  if (!shouldSampleBySeed(seed, config.SYNESIS_YARN_ENVELOPE_UNWRAP_LOG_SAMPLE_RATE)) return;
  logger.info(
    {
      reqId,
      toolName,
      toolCallId: toolCallId ?? null,
      clientKind,
      envelopeSource: source,
      sampled: true,
    },
    "tool_args_envelope_unwrapped",
  );
}

function recordUpperHarnessDecision(
  sessionKey: string,
  userId: string,
  orgId: string,
  requestId: string,
  source: string,
  decision: UpperHarnessDecision | undefined,
  options?: { recordAllow?: boolean },
): void {
  if (!decision || (decision.action === "allow" && !options?.recordAllow)) return;
  recordSessionEvent(
    sessionKey,
    userId,
    orgId,
    "upper_harness_decision_v1",
    source,
    formatUpperHarnessDecisionSummary(decision),
    requestId,
    decision as unknown as Record<string, unknown>,
  );
}

const readUsage = (input: unknown) => normalizeProviderUsage(input, {
  debug: config.SYNESIS_YARN_DEBUG_PROTOCOL,
  logger: app.log,
});

function shouldRestrictDiscoveryForPlanWork(userPrompt: unknown): boolean {
  const text = typeof userPrompt === "string" ? userPrompt.toLowerCase() : "";
  if (!text) return false;
  if (!text.includes("plan")) return false;
  // "continue with plan" is a strong resume signal on its own — the model
  // needs full tool access to orient after a crash or session break.
  const strongResumeCue = /\b(continue with (?:completing |the )?plan|resume (?:the )?plan|pick up (?:the |where )?plan)\b/.test(text);
  if (strongResumeCue) return false;
  const resumeRecoveryIntent =
    /\b(continue|resume|pick up|pick-up|where we left off|continue with plan|last stuck session|please continue)\b/.test(text)
    && /\b(crash|crashed|stuck|stalled|unknown|not sure|unsure|left off|prior run|previous run|incomplete|remaining)\b/.test(text);
  if (resumeRecoveryIntent) return false;
  return /\b(continue|resume|update|mark|check off|complete|remaining|next|phase|load)\b/.test(text);
}

function debugProtocolLog(
  logger: { info(obj: Record<string, unknown>, msg: string): void },
  reqId: string,
  path: string,
  extra: Record<string, unknown>
): void {
  debugProtocolLogWithFlag(logger, reqId, path, extra, config.SYNESIS_YARN_DEBUG_PROTOCOL);
}

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
});

const routeDependencySource = {
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
  config,
  contentDedupBySession,
  contextAdmissionStats,
  countTurnsSinceLastUser,
  createRoutePersistenceScope,
  createDiffStats,
  crypto,
  debugProtocolLog,
  deriveChatState,
  deriveEditContextMissGuardState,
  deriveFileState,
  deserializeShadow,
  diagnosticRegistry,
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
  formatValidationError,
  formatEvidenceBlock,
  formatPatternBlock,
  formatStateConfidenceBlock,
  generateText,
  getBlockedDiscoveryCount,
  getCachedTopLevelDirs,
  getChecklistSourceHash,
  getEventLoopStats,
  getEvidencePrefetchStats,
  getFileSnapshotRegistry,
  getMemoryGovernor,
  getMetadataString,
  getPatternFeedbackStats,
  getPatternPrefetchStats,
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
  isMatrixCapabilityEnabled,
  isOpenClawProfile,
  isPlanRecoveryDiscoveryIntent,
  KNOWLEDGE_TOOL_NAME,
  knowledgeResolveContext,
  knowledgeSearch,
  loadUserRuntimePreferences,
  logAndPersistSafetyEvent,
  looksLikeFailureSignal,
  lastToolUseIdFromClaudeMessages,
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
  prepareProtocolPauseState,
  phaseFromFrame,
  phaseOrchestrator,
  pinchCompactionBackendModelMetadata,
  policyEngine,
  policyRejectOpenAIBody,
  processWorkspaceHandshakeRoute,
  projectInstructionFilePresent,
  projectManifestService,
  promptSnapshotRegistry,
  promRegistry,
  pushDiagnostic,
  readdir,
  readPersistedChatStateSnapshot,
  recordPromptIntakeEvent,
  recordSessionEvent,
  recordUpperHarnessDecision,
  refreshRequirementChecklist,
  refreshTaskIntake,
  remediatePlanFileStubs,
  requireInternalToken,
  resolveCapabilityMatrix,
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
  safeSse,
  safeWrite,
  selectedOpenAiCompatHeaders,
  sendOpenAISoftFail,
  sendOpenAIWorkspaceHandshake,
  sensemakingStats,
  sessionContinuity,
  serializeShadow,
  sessionPersistenceRunner,
  sessionStore,
  sessions,
  setSessionWorkspaceContext,
  shouldResetImplicitSessionForFreshTranscript,
  shouldSampleBySeed,
  shouldStripGlobFromTools,
  sliceMessagesSinceLastUserPrompt,
  sseHeadersWithClarification,
  startSseHeartbeat,
  stablePrefixService,
  streamText,
  stripGlobFromTools,
  summarizeArtifactContext,
  summarizeEvidenceDelta,
  TIER_TO_ROLE,
  tierRegistry,
  toolBlobRedisEnabled: Boolean(toolBlobTier),
  toolArgHardeningStats,
  toolSchemaPruningStats,
  toolResultReduction,
  toSessionExecutionContextSystemBlock,
  updatePlanGraph,
  updateTracePromptMetadata,
  userRateLimiter,
  usagePersistenceEnabled,
  usageWriter,
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
  assessProportionality,
  findLastUserPromptIdx,
  languagePacksConformance: () => getLanguagePackRegistry().getConformanceMatrix(),
  proportionalityToSignal,
};
registerPlatformRoutes(buildPlatformRouteDependencies(routeDependencySource));
// --- OpenAI chat completions ---
const openAIChatCompletionsRouteDependencies = buildOpenAIChatCompletionsRouteDependencies(routeDependencySource);
registerOpenAIChatCompletionsRoute(openAIChatCompletionsRouteDependencies);

// --- Claude Messages API ---
const claudeMessagesRouteDependencies = buildClaudeMessagesRouteDependencies(routeDependencySource);
registerClaudeMessagesRoute(claudeMessagesRouteDependencies);

tierPollTimer = await startTierPolling({
  refreshTierRegistry,
  intervalSeconds: config.SYNESIS_YARN_TIER_POLL_INTERVAL,
});

await app.listen({ port: config.PORT, host: config.HOST });
