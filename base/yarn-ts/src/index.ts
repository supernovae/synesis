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
import {
  effectiveSawtoothCheckpointToolCalls,
  effectiveSawtoothHistoryLengthThreshold,
  inferCompactionSensitivity,
  type CompactionSensitivity,
} from "./context/compaction-sensitivity.js";
import { SessionStore, type SessionRecord, type SessionStateSnapshot } from "./state/session-store.js";
import type { SessionState } from "./state/session-state.js";
import {
  resolveSessionKey,
  shouldResetImplicitSessionForFreshTranscript,
  type SessionIdentity,
} from "./session/session-key.js";
import {
  applySessionTaskCapabilities,
  runProtocolSessionBootstrap,
} from "./session/protocol-session.js";
import { UsageWriter } from "./state/usage-writer.js";
import { createSessionEventRecorder } from "./state/session-event-recorder.js";
import { AuthResolver } from "./auth.js";
import { ValidationNormalizationService } from "./validation/service.js";
import {
  type RequirementChecklist,
} from "./validation/requirement-coverage.js";
import { formatPlanProgressBlock, serializePlanGraph, deserializePlanGraph, type PlanGraph } from "./planning/plan-graph.js";
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
import { ContentAddressedDedup } from "./reduction/content-addressed-dedup.js";
import { FileSnapshotRegistry } from "./reduction/file-snapshot-registry.js";
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
import { type PromptFrame, computeVolatileFingerprint } from "./context/prompt-frame.js";
import { generateExtendedMemoryContext } from "./memory/context-injector.js";
import { runGoDoc } from "./memory/go-doc-index.js";
import { IncrementalStructuralIndex } from "./memory/incremental-index.js";
import { MemoryGovernorTracker } from "./memory/governor-integration.js";
import { clearSessionMemory, getSessionMemoryCount, initMemoryToolStore } from "./mcp/handlers/memory-tools.js";
import { MemoryStore } from "./memory/memory-store.js";
import { Redis as IORedis } from "ioredis";
import { normalizeCommandOutputForComparison } from "./reduction/output-normalization.js";
import { WorkingFrameService, type ManifestContext } from "./frame/working-frame-service.js";
import { ProjectManifestService } from "./project/project-manifest-service.js";
import { getTemplate as manifestGetTemplate } from "@synesis/manifest";
import { classify as manifestClassify } from "./manifest/classifier.js";
import { scanForManifest as manifestScan } from "./manifest/repo-scanner.js";
import { compareManifests as manifestCompare } from "./manifest/comparator.js";
import { critiquStructure as manifestCritique } from "./manifest/structural-critic.js";
import { buildVerificationPlan, formatVerificationPlanBlock } from "./verification/planner.js";
import {
  createPlanningStateHelpers,
  parsePlanGraph,
} from "./planning/planning-state-helpers.js";
import {
  assessVerificationFromMessages as assessVerificationSignals,
  evaluateDeterministicPreFinalize,
  type CriticAssessment,
  type VerificationAssessment,
} from "./verification/staff-completion.js";
import { applyCompletionGate } from "./validation/completion-gate.js";
import { enforceNonSilentFinalizeText } from "./verification/non-silent-finalize.js";
import { DedupeLayer } from "./dedupe/DedupeLayer.js";
import { ToolPrefixCache } from "./tool-prefix-cache/ToolPrefixCache.js";
import { registerNonChatRoutes } from "./server/non-chat-routes.js";
import { DeterministicPolicyEngine, type PolicyDecision } from "./policy/deterministic-policy-engine.js";
import { handleDeterministicPolicyPrecheck } from "./policy/deterministic-policy-route.js";
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
import { SessionContinuityService } from "./context/session-continuity.js";
import { applyMarkdownGuardrail, buildResponseStyleBlock } from "./response-style.js";
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
import { type DecisionSnapshot } from "./telemetry/decision-snapshot.js";
import { createRequestForensicsRecorder } from "./telemetry/request-forensics-recorder.js";
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
  clearWorkspaceScopedMetadata,
  hasPersistedWorkspaceState,
  mergeSessionPathHints,
  setSessionWorkspaceContext,
} from "./state/workspace-session-boundary.js";
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
  serializeTaskLedger,
  deserializeTaskLedger,
  evaluateTaskCompletionGate,
  incrementReconciliationAttempts,
  scrubTaskLedgerOutput,
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
const contentDedupBySession = new Map<string, ContentAddressedDedup>();
const fileSnapshotBySession = new Map<string, FileSnapshotRegistry>();
const structuralIndexBySession = new Map<string, IncrementalStructuralIndex>();
const memoryGovernorBySession = new Map<string, MemoryGovernorTracker>();
function getContentDedup(sessionKey: string): ContentAddressedDedup {
  let dedup = contentDedupBySession.get(sessionKey);
  if (!dedup) {
    dedup = new ContentAddressedDedup();
    if (config.SYNESIS_YARN_STRUCTURAL_INDEX_ENABLED) {
      let idx = structuralIndexBySession.get(sessionKey);
      if (!idx) {
        idx = new IncrementalStructuralIndex();
        structuralIndexBySession.set(sessionKey, idx);
      }
      dedup.attachStructuralIndex(idx);
    }
    contentDedupBySession.set(sessionKey, dedup);
  }
  return dedup;
}
function getFileSnapshotRegistry(sessionKey: string): FileSnapshotRegistry {
  let registry = fileSnapshotBySession.get(sessionKey);
  if (!registry) {
    registry = new FileSnapshotRegistry();
    fileSnapshotBySession.set(sessionKey, registry);
  }
  return registry;
}
function getStructuralIndex(sessionKey: string): IncrementalStructuralIndex | null {
  return structuralIndexBySession.get(sessionKey) ?? null;
}
function getMemoryGovernor(sessionKey: string): MemoryGovernorTracker {
  let tracker = memoryGovernorBySession.get(sessionKey);
  if (!tracker) {
    tracker = new MemoryGovernorTracker();
    memoryGovernorBySession.set(sessionKey, tracker);
  }
  return tracker;
}

const blockedDiscoveryBySession = new Map<string, number>();
function recordBlockedDiscovery(sessionKey: string, count: number): number {
  const prev = blockedDiscoveryBySession.get(sessionKey) ?? 0;
  const next = prev + count;
  blockedDiscoveryBySession.set(sessionKey, next);
  return next;
}
function getBlockedDiscoveryCount(sessionKey: string): number {
  return blockedDiscoveryBySession.get(sessionKey) ?? 0;
}
function shouldStripGlobFromTools(sessionKey: string): boolean {
  return getBlockedDiscoveryCount(sessionKey) >= 2;
}
function stripGlobFromTools(tools: unknown[] | undefined): { tools: unknown[] | undefined; stripped: boolean } {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, stripped: false };
  const deny = new Set(["glob", "glob_file_search"]);
  let stripped = false;
  const filtered = tools.filter((tool) => {
    if (!tool || typeof tool !== "object") return true;
    const row = tool as Record<string, unknown>;
    const nested = row.function && typeof row.function === "object" ? (row.function as Record<string, unknown>) : null;
    const rawName = (typeof row.name === "string" ? row.name : "")
      || (nested && typeof nested.name === "string" ? nested.name : "");
    const name = rawName.trim().toLowerCase();
    if (!deny.has(name)) return true;
    stripped = true;
    return false;
  });
  return { tools: filtered, stripped };
}
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
const attentionPositioning = new AttentionPositioningService();
const sessionContinuity = new SessionContinuityService();

interface EnrichResult {
  messages: Array<{ role: string; content: unknown }>;
  workingPhase?: WorkflowPhase;
  workingFrameGoal?: string;
  promptProfileIds?: number[];
  promptProfileHashes?: string[];
  prefixHash?: string;
  prefixChangeReasons?: string[];
}

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

function isQwenModelName(modelName: string | undefined): boolean {
  return /qwen/i.test((modelName ?? "").toLowerCase());
}

async function enrichWithFrameAndManifest(
  messages: Array<{ role: string; content: unknown }>,
  sessionKey: string,
  adapterBlock?: string,
  promptContext?: { tier?: string; role?: string; modelFamily?: string; node?: string },
  pathHints?: { projectRoot: string | null; shellCwd: string | null } | null,
  governanceBlocks?: string[],
  topLevelDirs?: string[],
  sessionState?: SessionState | null,
  stateChannels?: { chatStateBlock?: string | null; fileStateBlock?: string | null },
): Promise<EnrichResult> {
  const out = [...messages];
  let detectedPhase: WorkflowPhase | undefined;
  let detectedGoal: string | undefined;
  const { stable: stableAdapterBlock, volatile: volatileAdapterBlock } = splitAdapterBlockForStability(adapterBlock);

  const partition = config.SYNESIS_YARN_STABLE_PREFIX_ENABLED
    ? stablePrefixService.partition(sessionKey, stableAdapterBlock, promptSnapshotRegistry, promptContext)
    : {
      stablePrefix: "You are an AI coding assistant provided by Synesis.",
      prefixHash: "",
      prefixChangeReasons: ["stable_prefix_disabled"],
      promptProfileIds: [],
      promptProfileHashes: [],
    };

  // Intern stable prefix via BlockStore — identical logical content across
  // turns produces the exact same string reference for upstream KV reuse.
  const stablePrefix = blockStore.intern(partition.stablePrefix);

  const effectiveRoot = pathHints?.projectRoot ?? pathHints?.shellCwd;
  let projectContext: string | null = null;
  if (topLevelDirs && topLevelDirs.length > 0 && effectiveRoot) {
    projectContext = blockStore.intern(`<PROJECT_ROOT path="${effectiveRoot}" dirs="${topLevelDirs.join(",")}" />`);
  }

  if (config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    let prefixContent = stablePrefix;
    if (projectContext) prefixContent += "\n" + projectContext;
    const enriched: Array<{ role: string; content: unknown }> = [
      { role: "system", content: prefixContent },
      ...out,
    ];
    return {
      messages: enriched,
      prefixHash: partition.prefixHash,
      prefixChangeReasons: partition.prefixChangeReasons,
      promptProfileIds: partition.promptProfileIds,
      promptProfileHashes: partition.promptProfileHashes,
    };
  }

  // Build PromptFrame: each block interned individually for byte stability.
  let workingFrameBlock: string | null = null;
  let structuralCriticBlock: string | null = null;

  const wfPathHints =
    config.SYNESIS_YARN_SESSION_PATH_HINTS_IN_WORKING_FRAME && pathHints
      ? { projectRoot: pathHints.projectRoot, shellCwd: pathHints.shellCwd }
      : null;

  if (config.SYNESIS_YARN_WORKING_FRAME_ENABLED) {
    if (config.SYNESIS_YARN_MANIFEST_TEMPLATES_ENABLED) {
      const latestUser = [...out].reverse().find((m) => m.role === "user");
      const userText = typeof latestUser?.content === "string" ? latestUser.content : "";
      const allText = out.map((m) => typeof m.content === "string" ? m.content : "").join("\n");
      const { classification, complexity: complexityResult } = manifestClassify(userText);

      if (complexityResult.complexity === "tiny" || complexityResult.complexity === "small") {
        const frame = workingFrameService.build(out);
        detectedPhase = phaseFromFrame(frame.currentPhase);
        detectedGoal = frame.goal;
        workingFrameBlock = workingFrameService.toSystemBlock(frame, wfPathHints);
      } else {
        const template = manifestGetTemplate(classification.projectKind);
        const filePaths = (allText.match(FILE_RE_GLOBAL) ?? []).map((f: string) => f.trim());
        const observed = manifestScan({ filePaths, conversationText: allText });
        const manifestCtx: ManifestContext = { complexity: complexityResult.complexity };

        if (template) {
          const comparison = manifestCompare(template.manifest, observed);
          manifestCtx.manifest = template.manifest;
          manifestCtx.comparison = comparison;

          if (config.SYNESIS_YARN_STRUCTURAL_CRITIC_ENABLED) {
            const critique = manifestCritique(comparison);
            if (!critique.passed && critique.requiredMissing > 0) {
              structuralCriticBlock = `<STRUCTURAL_CRITIC>\n${critique.summary}\n</STRUCTURAL_CRITIC>`;
            }
          }
        } else {
          manifestCtx.manifest = observed;
        }

        const richFrame = workingFrameService.buildRich(out, manifestCtx);
        detectedPhase = richFrame.phase === "plan" ? "planning"
          : richFrame.phase === "validate" ? "validation"
          : richFrame.phase === "explore" ? "explore"
          : "implementation";
        detectedGoal = richFrame.currentGoal;
        workingFrameBlock = workingFrameService.toRichSystemBlock(richFrame, wfPathHints);
      }
    } else {
      const frame = workingFrameService.build(out);
      detectedPhase = phaseFromFrame(frame.currentPhase);
      detectedGoal = frame.goal;
      workingFrameBlock = workingFrameService.toSystemBlock(frame, wfPathHints);
    }
  }

  let projectManifestBlock: string | null = null;
  if (config.SYNESIS_YARN_PROJECT_MANIFEST_ENABLED) {
    const manifest = projectManifestService.build(out);
    projectManifestBlock = projectManifestService.toSystemBlock(manifest);
  }

  let structuralIndexBlock: string | null = null;
  if (config.SYNESIS_YARN_STRUCTURAL_INDEX_ENABLED) {
    const sessionIdx = getStructuralIndex(sessionKey);
    if (sessionIdx) {
      const stats = sessionIdx.getStats();
      if (stats.fileCount > 0) {
        structuralIndexBlock = sessionIdx.renderMap(config.SYNESIS_YARN_STRUCTURAL_INDEX_TOKEN_BUDGET) ?? null;
      }
    }
  }

  let fileSummaryBlock: string | null = null;
  const enrichDedup = getContentDedup(sessionKey);
  if (enrichDedup.getTrackedFileCount() > 0) {
    fileSummaryBlock = enrichDedup.generateFilesSummaryBlock() ?? null;
  }

  let verificationPlanBlock: string | null = null;
  if (config.SYNESIS_YARN_VERIFICATION_PLAN_ENABLED) {
    const detectedLangs = detectLanguagesFromMessages(out);
    if (detectedLangs.length > 0) {
      const vPlan = buildVerificationPlan(
        detectedLangs,
        getLanguagePackRegistry(),
        config.SYNESIS_YARN_VERIFICATION_MAX_ROUNDS,
        config.SYNESIS_YARN_VERIFICATION_BUDGET_MS,
      );
      verificationPlanBlock = formatVerificationPlanBlock(vPlan) ?? null;
    }
  }

  const sessionIdxForExtMem = getStructuralIndex(sessionKey);
  const structuralMapFromIncremental = Boolean(structuralIndexBlock);
  const detectedLangsForExt = detectLanguagesFromMessages(out);
  const projectLanguageForExt = sessionIdxForExtMem?.getIndex().language ?? detectedLangsForExt[0] ?? "unknown";
  const recentFilesForExt = sessionIdxForExtMem ? sessionIdxForExtMem.getIndex().files.map((f) => f.path) : [];
  let goDocOutputForExt: string | null = null;
  if (
    config.SYNESIS_YARN_GO_DOC_REPOMAP_ENABLED
    && !structuralMapFromIncremental
    && pathHints?.projectRoot
    && projectLanguageForExt === "go"
  ) {
    goDocOutputForExt = await runGoDoc(pathHints.projectRoot);
  }
  const extendedMemoryInjected = generateExtendedMemoryContext(config, {
    structuralIndex: null,
    structuralMapFromIncremental,
    goDocOutput: goDocOutputForExt,
    evalPlan: null,
    recentFiles: recentFilesForExt,
    projectLanguage: projectLanguageForExt,
    memorySignals: getMemoryGovernor(sessionKey).getSignals(),
  });

  const responseStyleOverride = stablePrefixService.resolveNodePromptBlock(
    promptSnapshotRegistry,
    "response_style",
  ).block ?? undefined;
  const responseStyleBlock = buildResponseStyleBlock({
    mode: config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
    allowMermaid: config.SYNESIS_YARN_RESPONSE_STYLE_ALLOW_MERMAID,
    adminOverride: responseStyleOverride,
  });

  const intentGateBlock = buildIntentGateBlock(out);

  // Assemble the PromptFrame. Each semi-stable block is interned via BlockStore
  // so identical content across turns produces identical byte sequences.
  const frame: PromptFrame = {
    stablePrefix,
    projectContext,
    volatileAdapter: volatileAdapterBlock ?? null,
    chatState: stateChannels?.chatStateBlock ?? null,
    fileState: stateChannels?.fileStateBlock ?? null,
    workingFrame: workingFrameBlock,
    structuralCritic: structuralCriticBlock,
    projectManifest: projectManifestBlock ? blockStore.intern(projectManifestBlock) : null,
    structuralIndex: structuralIndexBlock ? blockStore.intern(structuralIndexBlock) : null,
    fileSummary: fileSummaryBlock,
    verificationPlan: verificationPlanBlock ? blockStore.intern(verificationPlanBlock) : null,
    extendedMemoryBlocks: extendedMemoryInjected.blocks,
    responseStyle: responseStyleBlock ? blockStore.intern(responseStyleBlock) : null,
    governanceBlocks: (governanceBlocks ?? []).filter((b) => b && b.trim()),
    intentGate: intentGateBlock,
    toolEfficiency: blockStore.intern(TOOL_EFFICIENCY_GUIDANCE),
  };

  // Volatile hash memoization: if the volatile portion is identical to
  // last turn, reuse the prior string reference (avoids allocation and
  // produces byte-identical upstream prefix).
  const volatileFingerprint = computeVolatileFingerprint(frame);
  const volatileHash = crypto.createHash("sha256").update(volatileFingerprint).digest("hex").slice(0, 16);

  if (sessionState?.lastVolatileHash === volatileHash && sessionState.lastVolatileContent) {
    // Reuse last turn's content string — same reference, same bytes
  } else if (sessionState) {
    sessionState.lastVolatileHash = volatileHash;
    sessionState.lastVolatileContent = volatileFingerprint;
  }

  const resolvedVolatile = sessionState?.lastVolatileContent ?? volatileFingerprint;

  let prefixContent = frame.stablePrefix;
  if (frame.projectContext) prefixContent += "\n" + frame.projectContext;

  const enriched: Array<{ role: string; content: unknown }> = [
    { role: "system", content: prefixContent },
    ...(resolvedVolatile ? [{ role: "system", content: resolvedVolatile }] : []),
    ...out,
  ];

  const finalMessages = config.SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED
    ? attentionPositioning.position(enriched).messages
    : enriched;
  return {
    messages: finalMessages,
    workingPhase: detectedPhase,
    workingFrameGoal: detectedGoal,
    promptProfileIds: partition.promptProfileIds,
    promptProfileHashes: partition.promptProfileHashes,
    prefixHash: partition.prefixHash,
    prefixChangeReasons: partition.prefixChangeReasons,
  };
}

function phaseFromFrame(currentPhase: "explore" | "planning" | "implementation" | "validation"): WorkflowPhase {
  if (currentPhase === "explore") return "explore";
  if (currentPhase === "planning") return "planning";
  if (currentPhase === "validation") return "validation";
  return "implementation";
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

function splitAdapterBlockForStability(adapterBlock?: string): { stable?: string; volatile?: string } {
  if (!adapterBlock || !adapterBlock.trim()) return {};
  const volatileLine = /^(git_|runtime=|session_id=|request_id=|project_root=|shell_cwd=|cwd=|pwd=|temp_|tmp_)/i;
  const lines = adapterBlock.split("\n");
  const stable: string[] = [];
  const volatile: string[] = [];
  for (const line of lines) {
    if (volatileLine.test(line.trim())) volatile.push(line);
    else stable.push(line);
  }
  return {
    stable: stable.join("\n").trim() || undefined,
    volatile: volatile.join("\n").trim() || undefined,
  };
}

const TOOL_EFFICIENCY_GUIDANCE = `<TOOL_EFFICIENCY>
When a build or test command fails, read the error output carefully and fix the root cause before re-running. Do not re-run the same command hoping for a different result.
- Identify the specific file and line from the error, fix it, then verify.
- Avoid running broader commands (e.g. \`go test ./...\`) repeatedly when you can target the failing package directly.
- After fixing an error, run the narrowest possible verification first.
- Remove unused imports and fix vet warnings before re-running the full suite.
</TOOL_EFFICIENCY>`;

function buildIntentGateBlock(messages: Array<{ role: string; content: unknown }>): string | null {
  const latestUser = [...messages].reverse().find((m) => m.role === "user" && typeof m.content === "string");
  const text = String(latestUser?.content ?? "").toLowerCase();
  if (!text) return null;
  const lines: string[] = [];
  if (/\b(add|write|create|build).{0,30}\btests?\b/.test(text) || /\bcomprehensive test suite\b/.test(text)) {
    lines.push("- Test-entry contract: inspect existing test configs/patterns first (jest.config/vitest/pytest.ini/pyproject/package.json), then create or modify tests.");
  }
  if (/\b(clean ?up|refactor|harden|polish)\b/.test(text)) {
    lines.push("- Cleanup-entry contract: run a targeted TODO/FIXME/DEBUG harvest before editing; prioritize highest-impact findings.");
  }
  if (/\b(update|implement|build|create|refactor|migrate)\b/.test(text)) {
    lines.push("- Multi-step contract: state a short phase plan before first write-capable tool call.");
  }
  if (lines.length === 0) return null;
  return ["<SYNESIS_INTENT_GATES>", ...lines, "</SYNESIS_INTENT_GATES>"].join("\n");
}

const FILE_RE_GLOBAL = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|yaml|yml|md|sql|sh|tf|hcl)\b/g;

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "typescript", jsx: "typescript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "java",
  cs: "csharp", sql: "sql", sh: "bash", bash: "bash",
  tf: "terraform", hcl: "terraform",
  yaml: "yaml-k8s", yml: "yaml-k8s",
};

function detectLanguagesFromMessages(messages: Array<{ role: string; content: unknown }>): string[] {
  const allText = messages.map((m) => typeof m.content === "string" ? m.content : "").join("\n");
  const files = allText.match(FILE_RE_GLOBAL) ?? [];
  const langs = new Set<string>();
  for (const f of files) {
    const ext = f.split(".").pop()?.toLowerCase();
    if (ext && EXTENSION_TO_LANGUAGE[ext]) {
      langs.add(EXTENSION_TO_LANGUAGE[ext]);
    }
  }
  return Array.from(langs);
}

/**
 * Resolve the effective session key. Clients without an explicit
 * conversation_id get an active rotated alias instead of the bare
 * synesis:{user}:{client}:_ key, so a fresh local project cannot inherit old
 * Postgres usage rows after Redis state expires.
 */
async function getSessionKey(identity: SessionIdentity): Promise<string> {
  const decision = await resolveSessionKey({
    identity,
    nowMs: Date.now(),
    inactivityRotationMs: config.SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS,
    activeByBaseKey: rotatedSessionByBaseKey,
    loadRecord: async (sessionKey) => sessions.get(sessionKey)?.record ?? await sessionStore.load(sessionKey),
    loadActiveSessionKey: (baseKey) => sessionStore.loadActiveSessionKey(baseKey),
    saveActiveSessionKey: (baseKey, sessionKey) => sessionStore.saveActiveSessionKey(baseKey, sessionKey),
  });
  if (decision.reason === "new_implicit_conversation") {
    sessions.delete(decision.baseKey);
    contentDedupBySession.delete(decision.baseKey);
    fileSnapshotBySession.delete(decision.baseKey);
    structuralIndexBySession.delete(decision.baseKey);
    memoryGovernorBySession.delete(decision.baseKey);
    clearSessionMemory(decision.baseKey);
    blockedDiscoveryBySession.delete(decision.baseKey);
    app.log.info(
      { baseKey: decision.baseKey, sessionKey: decision.sessionKey, clientKind: identity.clientKind },
      "session_implicit_conversation_rotation"
    );
  }
  return decision.sessionKey;
}

async function getSessionState(key: string, identity: SessionIdentity): Promise<SessionState> {
  const existing = sessions.get(key);
  if (existing) {
    existing.record.lastActiveAt = Date.now();
    if (existing.record.userId === "anon" && identity.userId !== "anon") {
      existing.record.userId = identity.userId;
      existing.record.orgId = identity.orgId;
    }
    return existing;
  }
  const loaded = await sessionStore.load(key);
  const record: SessionRecord = loaded ?? {
    sessionKey: key,
    userId: identity.userId,
    orgId: identity.orgId,
    conversationId: identity.conversationId,
    clientKind: identity.clientKind,
    displayName: identity.displayName,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalTokensCached: 0,
    totalTokensSaved: 0,
    requestCount: 0,
    escalationCount: 0,
    consecutiveFailedVerifications: 0,
    metadata: {},
    version: 0
  };
  if (identity.displayName && !record.displayName) {
    record.displayName = identity.displayName;
  }
  const metaConsecutive = Number(record.metadata?.consecutive_tool_calls ?? 0);
  const metaStagnant = Number(record.metadata?.stagnant_tool_cycles ?? 0);
  const metaToolSignalHash = String(record.metadata?.last_tool_signal_hash ?? "");
  const metaAwaitingAck = record.metadata?.awaiting_tool_loop_user_ack === true;
  const metaAckAnchorHash = String(record.metadata?.tool_loop_ack_anchor_user_hash ?? "");
  const metaNoAckCount = Number(record.metadata?.tool_loop_no_user_ack_count ?? 0);
  const metaBlockBroadVerification = record.metadata?.block_broad_verification_until_edit === true;
  const metaBlockFailingVerification = record.metadata?.block_failing_verification_until_edit === true;
  const history: SessionState["history"] = [];

  if (!loaded) {
    resetRecoveryCounters();
  }

  const hasExplicitConversation = typeof identity.conversationId === "string" && identity.conversationId.trim().length > 0;
  const allowCarryForwardBootstrap =
    !hasExplicitConversation && config.SYNESIS_YARN_SESSION_CARRY_FORWARD_BOOTSTRAP_ENABLED;

  if (!loaded && identity.userId !== "anon" && config.SYNESIS_YARN_SESSION_CONTINUITY_ENABLED && allowCarryForwardBootstrap) {
    const prevContinuity = await sessionStore.loadContinuity(identity.userId);
    if (prevContinuity) {
      const block = sessionContinuity.toSystemBlock(prevContinuity);
      if (block) {
        history.push({ role: "system", content: block });
      }
    }
  }

  if (!loaded && identity.userId !== "anon" && config.SYNESIS_YARN_CROSS_CONVERSATION_RECALL_ENABLED && allowCarryForwardBootstrap) {
    try {
      const pgContinuity = await usageWriter.loadLatestContinuity(identity.userId, config.SYNESIS_YARN_RECALL_MAX_AGE_MS);
      if (pgContinuity) {
        const recallBlock = sessionContinuity.toRecallBlock(pgContinuity);
        if (recallBlock) {
          history.push({ role: "system", content: recallBlock });
          recordSessionEvent(key, identity.userId, identity.orgId, "cross_conversation_recall", "getSessionState", `Loaded prior continuity (age ${Math.round((Date.now() - pgContinuity.updatedAt) / 3600000)}h)`);
        }
        if (pgContinuity.planGraph && typeof pgContinuity.planGraph === "object") {
          const restoredPlan = deserializePlanGraph(pgContinuity.planGraph as Record<string, unknown>);
          if (restoredPlan) {
            let planBlock = formatPlanProgressBlock(restoredPlan);
            if (planBlock && pgContinuity.planFilePath) {
              planBlock += `\nplan_file=${pgContinuity.planFilePath}\nTo continue this plan, read the plan file: Read(${pgContinuity.planFilePath})`;
            }
            if (planBlock) {
              history.push({ role: "system", content: planBlock });
            }
          }
        }
      }
    } catch (err) {
      app.log.warn({ err }, "Cross-conversation recall failed (non-fatal)");
    }
  }

  const state: SessionState = {
    history,
    toolCallsSinceCheckpoint: 0,
    consecutiveToolCalls: Number.isFinite(metaConsecutive) ? metaConsecutive : 0,
    stagnantToolCycles: Number.isFinite(metaStagnant) ? metaStagnant : 0,
    lastToolSignalHash: metaToolSignalHash,
    awaitingToolLoopUserAck: metaAwaitingAck,
    toolLoopAckAnchorUserHash: metaAckAnchorHash,
    toolLoopNoUserAckCount: Number.isFinite(metaNoAckCount) ? metaNoAckCount : 0,
    blockBroadVerificationUntilEdit: metaBlockBroadVerification,
    blockFailingVerificationUntilEdit: metaBlockFailingVerification,
    record,
    pruningWatermark: 0,
    consecutiveRecoveryFires: 0,
    consecutiveEditContextMisses: 0,
    editReplayHardStopGraceUsed: false,
    editMissForceReadPending: false,
    artifactEditTurns: new Map(),
    seenFailureSignatures: new Set(),
    previousFailureSignature: null,
    lastEvidenceDelta: null,
    lastIncomingMessageCount: 0,
    governorPrePauseAttemptsByRule: new Map(),
    implementationSoftStallNudgeStrikes: 0,
    regroundCooldownRemaining: 0,
    lastGovernorNoPauseAt: 0,
    lastGovernorCachedResult: null,
    skipToolIdStabilization: false,
    gitInspectionBlockCount: 0,
    scopeEnvelope: "unconstrained",
    diffStats: createDiffStats(),
    taskLedger: record.metadata.task_ledger
      ? deserializeTaskLedger(record.metadata.task_ledger)
      : null,
    taskCapabilities: null,
  };

  if (loaded) {
    try {
      const snap = await sessionStore.loadSessionState(key);
      if (snap && snap.snapshotAt > 0) {
        rehydrateFromSnapshot(state, snap);
        app.log.info({ sessionKey: key, snapshotAge: Date.now() - snap.snapshotAt }, "session_state_rehydrated");
      }
    } catch (err) {
      app.log.warn({ err, sessionKey: key }, "Session state rehydration failed (non-fatal)");
    }
  }

  sessions.set(key, state);
  return state;
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

function buildSessionStateSnapshot(state: SessionState): SessionStateSnapshot {
  return {
    history: state.history,
    toolCallsSinceCheckpoint: state.toolCallsSinceCheckpoint,
    consecutiveToolCalls: state.consecutiveToolCalls,
    stagnantToolCycles: state.stagnantToolCycles,
    lastToolSignalHash: state.lastToolSignalHash,
    awaitingToolLoopUserAck: state.awaitingToolLoopUserAck,
    toolLoopAckAnchorUserHash: state.toolLoopAckAnchorUserHash,
    toolLoopNoUserAckCount: state.toolLoopNoUserAckCount,
    blockBroadVerificationUntilEdit: state.blockBroadVerificationUntilEdit,
    blockFailingVerificationUntilEdit: state.blockFailingVerificationUntilEdit,
    pruningWatermark: state.pruningWatermark,
    consecutiveRecoveryFires: state.consecutiveRecoveryFires,
    consecutiveEditContextMisses: state.consecutiveEditContextMisses,
    editReplayHardStopGraceUsed: state.editReplayHardStopGraceUsed,
    editMissForceReadPending: state.editMissForceReadPending,
    lastGovernorPhase: state.lastGovernorPhase ?? null,
    artifactEditTurns: Object.fromEntries(state.artifactEditTurns),
    seenFailureSignatures: [...state.seenFailureSignatures],
    previousFailureSignature: state.previousFailureSignature,
    lastIncomingMessageCount: state.lastIncomingMessageCount,
    implementationSoftStallNudgeStrikes: state.implementationSoftStallNudgeStrikes,
    regroundCooldownRemaining: state.regroundCooldownRemaining,
    lastGovernorNoPauseAt: state.lastGovernorNoPauseAt,
    skipToolIdStabilization: state.skipToolIdStabilization,
    gitInspectionBlockCount: state.gitInspectionBlockCount,
    snapshotAt: Date.now(),
  };
}

function rehydrateFromSnapshot(state: SessionState, snap: SessionStateSnapshot): void {
  state.history = snap.history as SessionState["history"];
  state.toolCallsSinceCheckpoint = snap.toolCallsSinceCheckpoint;
  state.consecutiveToolCalls = snap.consecutiveToolCalls;
  state.stagnantToolCycles = snap.stagnantToolCycles;
  state.lastToolSignalHash = snap.lastToolSignalHash;
  state.awaitingToolLoopUserAck = snap.awaitingToolLoopUserAck;
  state.toolLoopAckAnchorUserHash = snap.toolLoopAckAnchorUserHash;
  state.toolLoopNoUserAckCount = snap.toolLoopNoUserAckCount;
  state.blockBroadVerificationUntilEdit = snap.blockBroadVerificationUntilEdit;
  state.blockFailingVerificationUntilEdit = snap.blockFailingVerificationUntilEdit;
  state.pruningWatermark = snap.pruningWatermark;
  state.consecutiveRecoveryFires = snap.consecutiveRecoveryFires;
  state.consecutiveEditContextMisses = snap.consecutiveEditContextMisses;
  state.editReplayHardStopGraceUsed = snap.editReplayHardStopGraceUsed;
  state.editMissForceReadPending = snap.editMissForceReadPending;
  state.lastGovernorPhase = (snap.lastGovernorPhase as SessionState["lastGovernorPhase"]) ?? undefined;
  state.artifactEditTurns = new Map(Object.entries(snap.artifactEditTurns));
  state.seenFailureSignatures = new Set(snap.seenFailureSignatures);
  state.previousFailureSignature = snap.previousFailureSignature;
  state.lastIncomingMessageCount = snap.lastIncomingMessageCount;
  state.implementationSoftStallNudgeStrikes = (snap.implementationSoftStallNudgeStrikes === 1 ? 1 : 0) as 0 | 1;
  state.regroundCooldownRemaining = snap.regroundCooldownRemaining;
  state.lastGovernorNoPauseAt = snap.lastGovernorNoPauseAt;
  state.skipToolIdStabilization = snap.skipToolIdStabilization;
  state.gitInspectionBlockCount = snap.gitInspectionBlockCount;
}

async function casSessionSave(state: SessionState): Promise<void> {
  try {
    if (state.history.length > 2 && state.record.userId !== "anon") {
      const continuity = sessionContinuity.extract(state.history);
      const existingPlanGraph = parsePlanGraph(state.record.metadata);
      if (existingPlanGraph) {
        continuity.planGraph = serializePlanGraph(existingPlanGraph);
      }
      const metaPlanFilePath = state.record.metadata.plan_file_path;
      if (typeof metaPlanFilePath === "string" && metaPlanFilePath) {
        continuity.planFilePath = metaPlanFilePath;
      }
      state.record.continuity = continuity;
      void sessionStore.saveContinuity(state.record.userId, continuity).catch((err) => { console.warn("[session] saveContinuity failed:", (err as Error).message ?? err); });
    }
    if (state.taskLedger && state.taskLedger.tasks.length > 0) {
      state.record.metadata.task_ledger = serializeTaskLedger(state.taskLedger);
    }
    const ok = await sessionStore.save(state.record);
    if (!ok) {
      const reloaded = await sessionStore.load(state.record.sessionKey);
      if (reloaded) {
        reloaded.totalTokensIn = Math.max(reloaded.totalTokensIn, state.record.totalTokensIn);
        reloaded.totalTokensOut = Math.max(reloaded.totalTokensOut, state.record.totalTokensOut);
        reloaded.totalTokensCached = Math.max(reloaded.totalTokensCached, state.record.totalTokensCached);
        reloaded.totalTokensSaved = Math.max(reloaded.totalTokensSaved ?? 0, state.record.totalTokensSaved ?? 0);
        reloaded.requestCount = Math.max(reloaded.requestCount, state.record.requestCount);
        reloaded.lastActiveAt = Math.max(reloaded.lastActiveAt, state.record.lastActiveAt);
        const remoteEstimated = Number(reloaded.metadata.total_estimated_cost_usd ?? 0);
        const localEstimated = Number(state.record.metadata.total_estimated_cost_usd ?? 0);
        reloaded.metadata.total_estimated_cost_usd = Math.max(remoteEstimated, localEstimated);

        const remoteActual = Number(reloaded.metadata.total_actual_cost_usd ?? 0);
        const localActual = Number(state.record.metadata.total_actual_cost_usd ?? 0);
        reloaded.metadata.total_actual_cost_usd = Math.max(remoteActual, localActual);
        state.record = reloaded;
        await sessionStore.save(state.record);
      }
    }
    void sessionStore.saveSessionState(state.record.sessionKey, buildSessionStateSnapshot(state)).catch((err) => {
      app.log.warn({ err }, "Session state snapshot persist failed (non-fatal)");
    });
  } catch (err) {
    app.log.warn({ err }, "Session persistence failed (non-fatal)");
    recordSessionEvent(state.record.sessionKey, state.record.userId, state.record.orgId, "persistence_error", "casSessionSave", String(err instanceof Error ? err.message : err).slice(0, 500));
  }
}

const SYNESIS_COMPACTION_BACKEND_META = "synesis_compaction_backend_model";

function resolveCompactionBackendModelHintFromRequestModel(modelId: string | undefined): string {
  const id = (modelId ?? "").trim();
  const fallbackTier = tierRegistry.getTierConfig(config.SYNESIS_YARN_DEFAULT_TIER);
  if (!id) return (fallbackTier?.backendModel ?? "").trim();
  const tier = tierRegistry.getTierConfig(id) ?? fallbackTier;
  return (tier?.backendModel ?? id).trim();
}

function pinchCompactionBackendModelMetadata(
  session: SessionState,
  tierId: string,
  requestedFallback: string,
): void {
  const tier = tierRegistry.getTierConfig(tierId) ?? tierRegistry.getTierConfig(config.SYNESIS_YARN_DEFAULT_TIER);
  const backend = (tier?.backendModel ?? requestedFallback).trim();
  if (backend) {
    session.record.metadata[SYNESIS_COMPACTION_BACKEND_META] = backend;
  }
}

function compactionCheckpointHints(state: SessionState): { backendHint: string; sensitivity: CompactionSensitivity } {
  const meta = String(state.record.metadata[SYNESIS_COMPACTION_BACKEND_META] ?? "").trim();
  const tierId = String(state.record.lastTier ?? "").trim();
  const backendHint = meta || resolveCompactionBackendModelHintFromRequestModel(tierId);
  return { backendHint, sensitivity: inferCompactionSensitivity(backendHint) };
}

function maybeCheckpoint(state: SessionState): void {
  const { sensitivity } = compactionCheckpointHints(state);
  const isMinimal = config.SYNESIS_YARN_CONTEXT_BUDGET_COMPACTION_MODE === "minimal";
  const baseToolCalls = config.SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS;
  const baseHistLen = 60;
  const toolTh = effectiveSawtoothCheckpointToolCalls(isMinimal ? baseToolCalls * 2 : baseToolCalls, sensitivity);
  const histTh = effectiveSawtoothHistoryLengthThreshold(isMinimal ? baseHistLen * 2 : baseHistLen, sensitivity);
  if (!sawtooth.shouldCheckpoint(state.history, state.toolCallsSinceCheckpoint, {
    toolCallsThreshold: toolTh,
    historyLengthThreshold: histTh,
  })) {
    return;
  }
  const charsBefore = state.history.reduce((sum, m) => sum + m.content.length, 0);
  void sawtooth.compressTrajectory(state.history, { sensitivity }).then((consolidated) => {
    state.history = [{ role: "system", content: consolidated.summary }];
    state.toolCallsSinceCheckpoint = 0;
    getFileSnapshotRegistry(state.record.sessionKey).markCompaction("SUMMARY_ONLY");
    getContentDedup(state.record.sessionKey).reset();
    svcMetrics.compactionTotal.inc({ type: "sawtooth" });
    svcMetrics.sessionCheckpointTotal.inc();
    const charsAfter = consolidated.summary.length;
    const charsSaved = Math.max(0, charsBefore - charsAfter);
    svcMetrics.compactionCharsSaved.inc(charsSaved);
  }).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    app.log.warn({ err, sessionKey: state.record.sessionKey }, "compaction_failed");
    recordSessionEvent(state.record.sessionKey, state.record.userId, state.record.orgId, "compaction_error", "sawtooth", detail.slice(0, 500));
  });
}

async function forceCheckpoint(state: SessionState): Promise<boolean> {
  if (state.history.length <= 1) return false;
  const charsBefore = state.history.reduce((sum, m) => sum + m.content.length, 0);
  try {
    const { sensitivity } = compactionCheckpointHints(state);
    const consolidated = await sawtooth.compressTrajectory(state.history, { sensitivity });
    state.history = [{ role: "system", content: consolidated.summary }];
    state.toolCallsSinceCheckpoint = 0;
    getFileSnapshotRegistry(state.record.sessionKey).markCompaction("SUMMARY_ONLY");
    getContentDedup(state.record.sessionKey).reset();
    svcMetrics.compactionTotal.inc({ type: "manual" });
    svcMetrics.sessionCheckpointTotal.inc();
    const charsAfter = consolidated.summary.length;
    const charsSaved = Math.max(0, charsBefore - charsAfter);
    svcMetrics.compactionCharsSaved.inc(charsSaved);
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    app.log.warn({ err, sessionKey: state.record.sessionKey }, "forced_compaction_failed");
    recordSessionEvent(state.record.sessionKey, state.record.userId, state.record.orgId, "compaction_error", "forced", detail.slice(0, 500));
    return false;
  }
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
import type { GovernedToolCall, PlanWriteAuditRecord } from "./path-governance/tool-call-governance.js";
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

function parseJsonIfPossible(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractBestDiagnosticsFromValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): { structuredErrorsCount: number; diagnosticLinesCount: number } {
  if (depth > 6 || value === null || value === undefined) {
    return { structuredErrorsCount: 0, diagnosticLinesCount: 0 };
  }
  if (typeof value === "string") {
    const parsed = parseJsonIfPossible(value);
    if (!parsed) return { structuredErrorsCount: 0, diagnosticLinesCount: 0 };
    return extractBestDiagnosticsFromValue(parsed, depth + 1, seen);
  }
  if (typeof value !== "object") {
    return { structuredErrorsCount: 0, diagnosticLinesCount: 0 };
  }
  if (seen.has(value as object)) {
    return { structuredErrorsCount: 0, diagnosticLinesCount: 0 };
  }
  seen.add(value as object);

  const score = (candidate: { structuredErrorsCount: number; diagnosticLinesCount: number }) =>
    candidate.diagnosticLinesCount * 1000 + candidate.structuredErrorsCount;
  let best = { structuredErrorsCount: 0, diagnosticLinesCount: 0 };

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractBestDiagnosticsFromValue(item, depth + 1, seen);
      if (score(nested) > score(best)) best = nested;
    }
    return best;
  }

  const row = value as Record<string, unknown>;
  const errors = Array.isArray(row.errors) ? row.errors : null;
  const errorLines = Array.isArray(row.errorLines) ? row.errorLines : null;
  if (errors || errorLines) {
    best = {
      structuredErrorsCount: errors?.length ?? 0,
      diagnosticLinesCount: errorLines?.length ?? 0,
    };
  }

  const nestedKeys = ["result", "content", "data", "payload", "output", "text"];
  for (const key of nestedKeys) {
    if (!(key in row)) continue;
    const nested = extractBestDiagnosticsFromValue(row[key], depth + 1, seen);
    if (score(nested) > score(best)) best = nested;
  }

  return best;
}

function inferTrajectoryDiagnosticsFromMessages(
  messages: Array<{ role: string; content: unknown }>,
): { structuredErrorsCount: number; diagnosticLinesCount: number; structuredErrorCoverage: number } {
  let structuredErrorsCount = 0;
  let diagnosticLinesCount = 0;
  for (const message of messages) {
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    const found = extractBestDiagnosticsFromValue(message.content);
    structuredErrorsCount += found.structuredErrorsCount;
    diagnosticLinesCount += found.diagnosticLinesCount;
  }
  const structuredErrorCoverage = diagnosticLinesCount > 0
    ? Number((structuredErrorsCount / diagnosticLinesCount).toFixed(3))
    : (structuredErrorsCount > 0 ? 1 : 0);
  return { structuredErrorsCount, diagnosticLinesCount, structuredErrorCoverage };
}

type CompletionFinalizeResult = {
  finalText: string;
  applied: boolean;
  missingMust: number;
  missingShould: number;
  blockedByVerification: boolean;
  criticBlocked: boolean;
};

type PostStreamFinalizeResult = {
  finalText: string;
  missingMust: number;
  missingShould: number;
  blockedByVerification: boolean;
};

async function finalizeCompletionText(
  input: {
    requestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
    assistantText: string;
    checklist: RequirementChecklist | null;
    traceRootPrompt: string;
    latestUserPrompt: string;
    verification: VerificationAssessment;
    recentToolNames: string[];
    nonActionableEventDetail: string;
    planGraph?: PlanGraph | null;
    session?: SessionState | null;
  },
): Promise<CompletionFinalizeResult> {
  if (input.session?.taskLedger) {
    const taskGate = evaluateTaskCompletionGate(input.session.taskLedger, input.session.taskCapabilities);
    if (!taskGate.allow && taskGate.nudge) {
      input.session.taskLedger = incrementReconciliationAttempts(input.session.taskLedger);
      recordSessionEvent(
        input.sessionKey,
        input.userId,
        input.orgId,
        "task_ledger_reconciliation_nudge",
        "task-ledger",
        `open_tasks=${input.session.taskLedger.tasks.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "unknown").length} attempt=${input.session.taskLedger.reconciliationAttempts}`,
        input.requestId,
      );
    }
  }

  const gate = applyCompletionGate({
    config,
    checklist: input.checklist,
    originalText: input.assistantText,
    traceRootPrompt: input.traceRootPrompt,
    latestUserPrompt: input.latestUserPrompt,
    verification: input.verification,
    planGraph: input.planGraph,
  });

  let finalText = gate.finalText;
  if (gate.applied) {
    recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      gate.blockedByVerification ? "completion_blocked_quality_gate" : "completion_gap",
      "completion-gate",
      gate.blockedByVerification
        ? `Blocking verification failures (${gate.blockingVerificationFailures})`
        : `Missing must-have requirements (${gate.missingMust})`,
      input.requestId,
    );
  } else if (input.checklist) {
    recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      "completion_pass",
      "completion-gate",
      "No missing must-have requirements detected",
      input.requestId,
    );
  }

  let criticBlocked = false;
  if (!gate.applied && config.SYNESIS_YARN_PREFINALIZE_CRITIC_ENABLED) {
    const critic = await runPreFinalizeCritic({
      requestId: input.requestId,
      assistantText: finalText,
      verification: input.verification,
      recentToolNames: input.recentToolNames,
    });
    if (critic.blocked) {
      criticBlocked = true;
      finalText = [
        "Completion paused by pre-finalization critic.",
        "",
        "Findings:",
        ...critic.findings.map((f) => `- ${f}`),
        "",
        "Next actions:",
        ...(critic.suggestedNextActions.length > 0
          ? critic.suggestedNextActions.map((s) => `- ${s}`)
          : ["- Address verification/quality gaps and rerun checks."]),
      ].join("\n");
      recordSessionEvent(
        input.sessionKey,
        input.userId,
        input.orgId,
        "pre_finalize_critic_block",
        "completion-gate",
        `critic_source=${critic.source}`,
        input.requestId,
      );
    }
  }

  const nonSilent = enforceNonSilentFinalizeText(finalText);
  if (nonSilent.applied) {
    finalText = nonSilent.text;
    recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      "completion_non_actionable_fallback",
      "completion-gate",
      input.nonActionableEventDetail,
      input.requestId,
    );
  }

  const scrubbed = scrubTaskLedgerOutput(finalText);
  if (scrubbed.scrubbed) {
    finalText = scrubbed.text;
    recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      "task_ledger_output_scrubbed",
      "task-ledger",
      "Removed internal task-ledger governance from assistant output",
      input.requestId,
    );
  }

  return {
    finalText,
    applied: gate.applied,
    missingMust: gate.missingMust,
    missingShould: gate.missingShould,
    blockedByVerification: gate.blockedByVerification,
    criticBlocked,
  };
}

function finalizePostStreamText(
  input: {
    requestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
    assistantText: string;
    applyGate: boolean;
    checklist: RequirementChecklist | null;
    traceRootPrompt: string;
    latestUserPrompt: string;
    verification: VerificationAssessment;
    toolStopReason: boolean;
    nonActionableEventDetail: string;
    planGraph?: PlanGraph | null;
  },
): PostStreamFinalizeResult {
  let finalText = input.assistantText;
  let missingMust = 0;
  let missingShould = 0;
  let blockedByVerification = false;
  if (input.applyGate && !input.toolStopReason) {
    const gate = applyCompletionGate({
      config,
      checklist: input.checklist,
      originalText: finalText,
      traceRootPrompt: input.traceRootPrompt,
      latestUserPrompt: input.latestUserPrompt,
      verification: input.verification,
      planGraph: input.planGraph,
    });
    finalText = gate.finalText;
    missingMust = gate.missingMust;
    missingShould = gate.missingShould;
    blockedByVerification = gate.blockedByVerification;
  }
  finalText = applyMarkdownGuardrail(
    finalText,
    config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
  );
  if (!input.toolStopReason) {
    const nonSilent = enforceNonSilentFinalizeText(finalText);
    if (nonSilent.applied) {
      finalText = nonSilent.text;
      recordSessionEvent(
        input.sessionKey,
        input.userId,
        input.orgId,
        "completion_non_actionable_fallback",
        "completion-gate",
        input.nonActionableEventDetail,
        input.requestId,
      );
    }
  }
  return {
    finalText,
    missingMust,
    missingShould,
    blockedByVerification,
  };
}

async function runPreFinalizeCritic(
  input: {
    requestId: string;
    assistantText: string;
    verification: VerificationAssessment;
    recentToolNames: string[];
  },
): Promise<CriticAssessment> {
  const deterministic = evaluateDeterministicPreFinalize(input.verification, input.recentToolNames);
  if (!deterministic.blocked) return deterministic;
  const findings = deterministic.findings;
  const next = deterministic.suggestedNextActions;
  if (!config.SYNESIS_YARN_PREFINALIZE_LLM_CRITIC_ENABLED) {
    return {
      blocked: true,
      findings,
      suggestedNextActions: [
        ...next,
        "Self-Review: Review the changes you just made against the original user request. Did you miss any edge cases? Did you break any existing imports?",
      ],
      source: "deterministic",
    };
  }
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3500);
    const prompt = [
      "You are a strict pre-finalization critic for coding tasks.",
      "Evaluate if the task is genuinely complete. Fail if there are unverified assumptions, token bloat (e.g. repeating unchanged code), or unresolved verification failures.",
      "Return JSON only: {\"verdict\":\"pass|fail\",\"reason\":\"...\"}",
      `Assistant text: ${input.assistantText.slice(0, 1200)}`,
      `Verification failures: ${JSON.stringify(input.verification.failures).slice(0, 1600)}`,
      `Recent tool names: ${input.recentToolNames.join(",")}`,
    ].join("\n");
    const resp = await fetch(`${config.SYNESIS_YARN_CRITIC_URL}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        ...(config.SYNESIS_INTERNAL_SERVICE_TOKEN ? { authorization: `Bearer ${config.SYNESIS_INTERNAL_SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        model: config.SYNESIS_YARN_CRITIC_MODEL,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
        ...(isQwenModelName(config.SYNESIS_YARN_CRITIC_MODEL)
          ? { response_format: { type: "json_object" } }
          : {}),
      }),
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      return { blocked: true, findings, suggestedNextActions: next, source: "deterministic" };
    }
    const body = await resp.json() as Record<string, unknown>;
    const text = String((((body.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {}).message as Record<string, unknown> | undefined)?.content ?? "");
    const parsed = parseJsonIfPossible(text) as { verdict?: string; reason?: string } | null;
    if (parsed?.verdict?.toLowerCase() === "pass") {
      return {
        blocked: false,
        findings: [`LLM critic override: ${parsed.reason ?? "passed"}`],
        suggestedNextActions: [],
        source: "llm_fallback",
      };
    }
    return {
      blocked: true,
      findings: [parsed?.reason ?? findings.join(" ")],
      suggestedNextActions: [
        ...next,
        "Self-Review: Review the changes you just made against the original user request. Did you miss any edge cases? Did you break any existing imports?",
      ],
      source: "llm_fallback",
    };
  } catch {
    return {
      blocked: true,
      findings,
      suggestedNextActions: [
        ...next,
        "Self-Review: Review the changes you just made against the original user request. Did you miss any edge cases? Did you break any existing imports?",
      ],
      source: "deterministic",
    };
  }
}

function normalizeForSignal(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? "";
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => normalizeForSignal(v));
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const key of keys) out[key] = normalizeForSignal((value as Record<string, unknown>)[key]);
  return out;
}

function stableSignalString(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  return JSON.stringify(normalizeForSignal(value));
}

function hashTextSignal(value: unknown): string {
  const text = typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : stableSignalString(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return crypto.createHash("sha256").update(text.slice(0, 4000)).digest("hex");
}

const LOOP_TRACKED_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "terminal",
  "run_command",
  "run_terminal_command",
  "execute_command",
  "run_bash",
  "glob",
  "list_files",
  "read_dir",
  "read_directory",
]);

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

type CommandLoopSignal = {
  commandSignatureHash: string;
  commandRepeatCount: number;
  failureSignatureHash: string;
  broadDiscoveryRepeatCount: number;
};

function parseJsonObjectLoose(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function commandFromArgs(args: unknown): string {
  if (typeof args === "string") {
    const parsed = parseJsonObjectLoose(args);
    if (parsed) {
      return commandFromArgs(parsed);
    }
    return args.replace(/\s+/g, " ").trim().slice(0, 512);
  }
  if (!args || typeof args !== "object") return "";
  const row = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) {
      return v.replace(/\s+/g, " ").trim().slice(0, 512);
    }
  }
  const globPattern = row.glob_pattern;
  if (typeof globPattern === "string" && globPattern.trim()) {
    return `glob:${globPattern.replace(/\s+/g, " ").trim().slice(0, 256)}`;
  }
  const path = row.path ?? row.dir ?? row.directory;
  if (typeof path === "string" && path.trim()) {
    return `path:${path.replace(/\s+/g, " ").trim().slice(0, 256)}`;
  }
  return "";
}

function isBroadDiscoveryLoopCall(toolName: string, command: string): boolean {
  const tool = toolName.toLowerCase();
  const cmd = command.toLowerCase();
  if (tool === "glob") {
    return cmd === "glob:*" || cmd === "glob:**/*" || cmd.startsWith("glob:**/");
  }
  return (tool === "list_files" || tool === "read_dir" || tool === "read_directory")
    && (cmd === "path:." || cmd === "path:/" || cmd === "path:");
}

function normalizedToolOutputSignal(content: unknown): string {
  if (typeof content === "string") {
    return normalizeCommandOutputForComparison(content).slice(0, 1600);
  }
  return normalizeCommandOutputForComparison(stableSignalString(content)).slice(0, 1600);
}

function looksLikeFailureSignal(value: string): boolean {
  if (!value) return false;
  return /(fail|error|panic|traceback|exception|not found|undefined|cannot|fatal|exit code)/i.test(value);
}

function analyzeRecentCommandLoop(messages: ToolLoopMessage[]): CommandLoopSignal {
  const callMap = new Map<string, { command: string; toolName: string }>();
  const history: Array<{ command: string; toolName: string; failureHash: string }> = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = typeof call.id === "string" ? call.id : "";
        if (!id) continue;
        const toolName = String(call.function?.name ?? call.name ?? "").toLowerCase();
        if (!LOOP_TRACKED_TOOL_NAMES.has(toolName)) continue;
        const command = commandFromArgs(call.function?.arguments ?? call.input);
        if (!command) continue;
        callMap.set(id, { command, toolName });
      }
      continue;
    }
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
    if (!toolCallId) continue;
    const call = callMap.get(toolCallId);
    if (!call) continue;
    const out = normalizedToolOutputSignal(message.content);
    const failureHash = looksLikeFailureSignal(out) ? hashTextSignal(out) : "";
    history.push({ command: call.command, toolName: call.toolName, failureHash });
  }
  if (history.length === 0) {
    return {
      commandSignatureHash: "",
      commandRepeatCount: 0,
      failureSignatureHash: "",
      broadDiscoveryRepeatCount: 0,
    };
  }

  const latest = history[history.length - 1];
  let commandRepeatCount = 0;
  let failureRepeatCount = 0;
  let broadDiscoveryRepeatCount = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].command !== latest.command) break;
    commandRepeatCount += 1;
    if (isBroadDiscoveryLoopCall(history[i].toolName, history[i].command)) {
      broadDiscoveryRepeatCount += 1;
    }
    if (latest.failureHash && history[i].failureHash === latest.failureHash) {
      failureRepeatCount += 1;
    }
  }

  return {
    commandSignatureHash: hashTextSignal(latest.command),
    commandRepeatCount,
    failureSignatureHash: failureRepeatCount >= 2 ? latest.failureHash : "",
    broadDiscoveryRepeatCount,
  };
}

function resetWorkspaceScopedSessionState(sessionKey: string, state: SessionState): void {
  clearWorkspaceScopedMetadata(state.record.metadata);
  contentDedupBySession.delete(sessionKey);
  fileSnapshotBySession.delete(sessionKey);
  structuralIndexBySession.delete(sessionKey);
  memoryGovernorBySession.delete(sessionKey);
  clearSessionMemory(sessionKey);
  blockedDiscoveryBySession.delete(sessionKey);
  stablePrefixService.evictSession(sessionKey);
  state.history = [];
  state.lastVolatileContent = undefined;
  state.lastVolatileHash = undefined;
  state.pruningWatermark = 0;
  state.consecutiveToolCalls = 0;
  state.stagnantToolCycles = 0;
  state.lastToolSignalHash = "";
  state.awaitingToolLoopUserAck = false;
  state.toolLoopAckAnchorUserHash = "";
  state.toolLoopNoUserAckCount = 0;
  state.blockBroadVerificationUntilEdit = false;
  state.blockFailingVerificationUntilEdit = false;
  state.consecutiveRecoveryFires = 0;
  state.consecutiveEditContextMisses = 0;
  state.editReplayHardStopGraceUsed = false;
  state.editMissForceReadPending = false;
  state.artifactEditTurns.clear();
  state.seenFailureSignatures.clear();
  state.previousFailureSignature = null;
  state.lastEvidenceDelta = null;
  state.lastIncomingMessageCount = 0;
  state.governorPrePauseAttemptsByRule.clear();
  state.implementationSoftStallNudgeStrikes = 0;
  state.regroundCooldownRemaining = 0;
  state.lastGovernorNoPauseAt = 0;
  state.lastGovernorCachedResult = null;
  state.skipToolIdStabilization = false;
  state.gitInspectionBlockCount = 0;
  state.scopeEnvelope = "unconstrained";
  state.diffStats = createDiffStats();
  state.taskLedger = null;
  state.taskCapabilities = null;
}

function workspaceStatePresence(sessionKey: string) {
  return {
    hasFileSnapshot: fileSnapshotBySession.has(sessionKey),
    hasContentDedup: contentDedupBySession.has(sessionKey),
    hasStructuralIndex: structuralIndexBySession.has(sessionKey),
    sessionMemoryCount: getSessionMemoryCount(sessionKey),
  };
}

function logAndPersistSafetyEvent(
  decision: PolicyDecision,
  sessionKey: string,
  sessionTokensIn: number
): void {
  for (const event of policyEngine.getRecentEvents().slice(-1)) {
    app.log.warn({
      safetyEvent: event.kind,
      sessionKey,
      detail: event.detail,
      repeatCount: event.repeatCount,
      tokensBurned: event.tokensBurned ?? sessionTokensIn,
      consecutiveToolCalls: event.consecutiveToolCalls
    }, `policy_safety_event: ${event.kind}`);
    usageWriter.enqueueSafetyEventInsert({
      sessionKey,
      userId: "",
      orgId: "",
      eventKind: event.kind,
      detail: event.detail,
      repeatCount: event.repeatCount,
      tokensBurned: event.tokensBurned ?? sessionTokensIn,
      consecutiveToolCalls: event.consecutiveToolCalls
    });
  }
}

function emitPlanWriteAuditEvent(
  sessionKey: string,
  userId: string,
  orgId: string,
  requestId: string,
  audit: PlanWriteAuditRecord,
): void {
  const eventKind = audit.allowed ? "plan_file_write_allowed" : "plan_file_write_blocked";
  recordSessionEvent(
    sessionKey,
    userId,
    orgId,
    eventKind,
    "tool_call_governance",
    audit.reason ?? "ok",
    requestId,
    {
      path: audit.path,
      allowed: audit.allowed,
      reason: audit.reason,
      proposedContentHash: audit.proposedContentHash,
      shadowContentHash: audit.shadowContentHash,
    },
  );
}

function emitDecisionEvents(
  sessionKey: string,
  userId: string,
  orgId: string,
  requestId: string,
  snapshot: DecisionSnapshot | undefined,
): void {
  if (!snapshot || !config.SYNESIS_YARN_DECISION_MATRIX_ENABLED) return;
  recordSessionEvent(sessionKey, userId, orgId, "decision_routing", "phase-model-orchestrator",
    `${snapshot.decisionPath} → ${snapshot.tier} (${snapshot.phase})`, requestId, {
      decisionPath: snapshot.decisionPath,
      tier: snapshot.tier,
      phase: snapshot.phase,
      escalated: snapshot.escalated,
      recallRouting: snapshot.recallRouting,
      recallConfidence: snapshot.recallConfidence,
    });
  if (snapshot.escalated) {
    recordSessionEvent(sessionKey, userId, orgId, "escalation", "phase-model-orchestrator",
      snapshot.escalationReason ?? "escalated", requestId, {
        tier: snapshot.tier,
        phase: snapshot.phase,
        recallRouting: snapshot.recallRouting,
        verificationRound: snapshot.verificationRound,
        verificationStalled: snapshot.verificationStalled,
      });
  }
  if (snapshot.sensemakingTriggered && config.SYNESIS_YARN_SENSEMAKING_ENABLED) {
    recordSessionEvent(sessionKey, userId, orgId, "sensemaking_triggered", "sensemaking-engine",
      snapshot.sensemakingReason ?? "sensemaking", requestId, {
        phase: snapshot.phase,
        decisionPath: snapshot.decisionPath,
        reason: snapshot.sensemakingReason,
      });
  }
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
