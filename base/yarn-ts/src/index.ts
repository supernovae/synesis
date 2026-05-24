import crypto from "node:crypto";
import { readdir } from "node:fs/promises";
import Fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { Registry } from "prom-client";
import { generateText, streamText } from "ai";
import {
  createServiceMetrics,
  recordUsageMetrics,
  extractUsage,
  emitTrace,
} from "@synesis/telemetry";
import { loadConfig } from "./config.js";
import {
  ClaudeBootstrapQuerySchema,
  ClaudeCommandExecuteRequestSchema,
  ClaudeModelResolutionQuerySchema,
  ClaudeMessagesRequestSchema,
  type ClaudeBootstrapQuery,
  type ClaudeCommandExecuteRequest,
  type ClaudeModelResolutionQuery,
  type ClaudeMessagesRequest,
  type OpenAIChatCompletionRequest
} from "./schemas.js";
import {
  chatCompletionToResponseObject,
  OpenAIResponsesRequestSchema,
  responseObjectToSseEvents,
  responsesRequestToChatCompletion,
} from "./responses-compat.js";
import {
  buildClaudeBootstrapTemplate,
  executeClaudeCompatCommand,
  resolveClaudeModelSelection,
} from "./claude-compat.js";
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
import { buildAiSdkTextRequestOptions } from "./providers/ai-sdk-request-options.js";
import { PrefixOptimizer, extractMetadataFromMessages, type MarkerBackend } from "./providers/prefix-optimizer/index.js";
import { normalizeToolDescriptions } from "./compat/tool-description-normalizer.js";
import { resolveEndpointCapabilityId } from "./providers/endpoint-capabilities/resolve.js";
import { SawtoothContextManager } from "./context/sawtooth-manager.js";
import {
  effectiveSawtoothCheckpointToolCalls,
  effectiveSawtoothHistoryLengthThreshold,
  inferCompactionSensitivity,
  type CompactionSensitivity,
} from "./context/compaction-sensitivity.js";
import { SessionStore, type SessionRecord, type SessionStateSnapshot } from "./state/session-store.js";
import {
  resolveSessionKey,
  shouldResetImplicitSessionForFreshTranscript,
  type SessionIdentity,
} from "./session/session-key.js";
import {
  applySessionTaskCapabilities,
  buildProtocolSessionIdentity,
  runProtocolSessionBootstrap,
} from "./session/protocol-session.js";
import { DiagnosticStore } from "./state/diagnostic-store.js";
import { UsageWriter } from "./state/usage-writer.js";
import { AuthResolver } from "./auth.js";
import { ValidationNormalizationService } from "./validation/service.js";
import {
  buildChecklistFromPrompt,
  evaluateRequirementCoverage,
  summarizeMissingCoverage,
  type RequirementChecklist,
} from "./validation/requirement-coverage.js";
import { buildTaskIntake, type TaskIntake } from "./planning/task-intake.js";
import { advancePlanGraph, createPlanGraph, formatPlanProgressBlock, isPlanComplete, serializePlanGraph, deserializePlanGraph, type PlanGraph } from "./planning/plan-graph.js";
import { buildShadowFromContent, deserializeShadow, serializeShadow, type PlanContentShadow } from "./planning/plan-content-shadow.js";
import { looksLikeClarificationTurnAssistantMessage } from "./validation/clarification-turn.js";
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
  type KnowledgeResolveContext,
} from "./state/knowledge-search.js";
import {
  WebSearchService,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_ALIAS,
  type WebSearchResolveContext,
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
import { ToolResultReductionService, type ReduceMessagesOpts } from "./reduction/tool-result-reducer.js";
import { TranscriptPruningService } from "./reduction/transcript-pruning.js";
import { applyIngressCapToToolMessages } from "./reduction/ingress-cap.js";
import { ContentAddressedDedup } from "./reduction/content-addressed-dedup.js";
import { FileSnapshotRegistry, parseReadSnapshotEnvelope } from "./reduction/file-snapshot-registry.js";
import { normalizeReadSnapshotMessages } from "./reduction/read-snapshot-normalizer.js";
import { normalizeHistoricalContent, stabilizeToolCallIds } from "./reduction/historical-normalizer.js";
import { BlockStore } from "./store/block-store.js";
import { OptimizationLedger, type OptimizationLedgerSnapshot } from "./telemetry/optimization-ledger.js";
import {
  cachePolicyLogRecord,
  evaluateCachePolicyController,
  type CachePolicyControllerDecision,
  type ProviderCachePolicyWindow,
} from "./telemetry/cache-policy-controller.js";
import {
  DEFAULT_USER_RUNTIME_PREFERENCES,
  applyRuntimePreferenceLoopLimits,
  normalizeUserRuntimePreferences,
  userRuntimePreferencesResponse,
  type UserRuntimePreferences,
} from "./runtime/user-preferences.js";
import {
  detectClientToolCapabilities,
  type ClientToolCapabilities,
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
  buildPlannerTodoPacketPrompt,
  deserializePlannerTodoPacket,
  formatPlannerTodoPacketBlock,
  parsePlannerTodoPacket,
  plannerTodoPacketToHarnessTasks,
  serializePlannerTodoPacket,
  shouldGeneratePlannerTodoPacket,
} from "./planning/planner-todo-packet.js";
import {
  assessVerificationFromMessages as assessVerificationSignals,
  evaluateDeterministicPreFinalize,
} from "./verification/staff-completion.js";
import { enforceNonSilentFinalizeText } from "./verification/non-silent-finalize.js";
import { registerMcpRoutes, getToolRegistry } from "./mcp/index.js";
import { registerEvalRoutes } from "./eval/routes.js";
import { enableObserver as enableEvalObserver } from "./eval/session-observer.js";
import { runEvalObserverPersistence } from "./eval/session-observer-persistence.js";
import { DedupeLayer } from "./dedupe/DedupeLayer.js";
import { ToolPrefixCache } from "./tool-prefix-cache/ToolPrefixCache.js";
import {
  registerToolCollapseRoutes,
} from "./tool-collapse/index.js";
import { applyDiscoveryGuardrails, type DiscoveryGuardrailRedirect } from "./tool-collapse/discovery-guardrails.js";
import {
  buildBlockedDiscoveryGuidance,
  buildBlockedDiscoveryRecoveryWithSnapshot,
  buildBlockedDiscoveryRecoveryWithoutSnapshot,
  type BlockedDiscoveryDetail,
} from "./tool-collapse/blocked-discovery-recovery.js";
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
  buildYarnUpperHarnessContext,
  evaluateYarnPromptIntakeSteer,
  formatUpperHarnessDecisionSummary,
  type YarnPromptIntakeResult,
  type UpperHarnessDecision,
} from "./upper-harness/bridge.js";
import {
  openAIToolsToSDK,
  claudeToolsToSDK,
  claudeMessagesToOpenAI,
  openAIMessagesToModelMessages,
  ensureSystemMessagesAtBeginning,
  coalesceLeadingSystemMessages,
  sanitizeToolCalls,
  reconstructMissingToolCalls,
} from "./tool-mapping.js";
import { appendSystemMessageAndNormalize, normalizeSystemMessageOrdering } from "./transcript/system-message-ordering.js";
import { applyToolSearchPolicy } from "./compat/tool-search-policy.js";
import { sortToolSchemas } from "./compat/sorted-tools.js";
import { detectToolProgress } from "./policy/tool-progress-detector.js";
import { CircuitBreakerRegistry } from "./providers/circuit-breaker.js";
import { UserRateLimiter } from "./middleware/user-rate-limit.js";
import { initOtel, getTracer, withSpan, withSpanAsync } from "./telemetry/otel.js";
import { startEventLoopMonitor, getEventLoopStats } from "./telemetry/event-loop-monitor.js";
import { buildDecisionSnapshot, type DecisionSnapshot } from "./telemetry/decision-snapshot.js";
import {
  buildRequestForensics,
  withUsage as withForensicsUsage,
  type RequestForensicsRecord,
} from "./telemetry/request-forensics.js";
import {
  applySensemakingStats,
  createEmptySensemakingStats,
  runSensemaking,
  type SensemakingResult,
  type SensemakingStats,
} from "./sensemaking/index.js";
import { DistributedCounterService } from "./state/distributed-counters.js";
import { StreamAdmissionController } from "./middleware/stream-admission.js";
import {
  finalizeClaudeNonStreamProviderSuccess,
  handleClaudeNonStreamProviderError,
} from "./streaming/claude-nonstream-lifecycle.js";
import {
  createClaudeNonStreamPostProviderInput,
  processClaudeNonStreamProviderResult,
} from "./streaming/claude-nonstream-postprocess.js";
import {
  createClaudeNonStreamProviderExecutorInput,
  executeClaudeNonStreamProviderLoop,
} from "./streaming/claude-nonstream-provider-executor.js";
import { buildClaudeNonStreamMessageResponse } from "./streaming/claude-nonstream-response.js";
import { createClaudeNonStreamRouteScope } from "./streaming/claude-nonstream-route-scope.js";
import { createClaudeStreamAfterEventsHandler } from "./streaming/claude-stream-after-events.js";
import { createClaudeStreamRouteComponents } from "./streaming/claude-stream-components.js";
import {
  createClaudeStreamCompletionFinalizerInput,
  createClaudeStreamFinalizationHandlers,
  finalizeClaudeStreamCompletion,
} from "./streaming/claude-stream-finalizer.js";
import { createClaudeStreamLifecycleHandlers } from "./streaming/claude-stream-lifecycle.js";
import { prepareClaudeStreamProviderRequest } from "./streaming/claude-stream-provider-request.js";
import { createClaudeStreamRouteEventHandlers } from "./streaming/claude-stream-route-event-handlers.js";
import { startClaudeStreamRouteRuntime } from "./streaming/claude-stream-runtime.js";
import { createClaudeStreamTelemetryInput, runClaudeStreamTelemetry } from "./streaming/claude-stream-telemetry.js";
import { runClaudeStreamingPipeline } from "./streaming/claude-streaming-pipeline.js";
import { createRouteToolCallSideEffects } from "./streaming/route-tool-call-side-effects.js";
import { createStreamAbortRuntime } from "./streaming/stream-abort-runtime.js";
import {
  buildStreamAdmissionRejection,
  buildStreamCircuitBreakerRejection,
} from "./streaming/stream-route-gates.js";
import { captureStreamRequestForensics } from "./streaming/stream-request-forensics.js";
import { createStreamRouteScopeBundle } from "./streaming/stream-route-scope.js";
import { createStreamTelemetryRouteBase } from "./streaming/stream-telemetry-route-base.js";
import {
  runSessionUsagePersistence,
  type RequestTrajectoryInput,
} from "./state/session-usage-persistence.js";
import { runPersistenceTokenEconomicsAccounting } from "./state/persistence-token-economics.js";
import {
  readPersistedChatStateSnapshot,
} from "./state/persistence-state-channels.js";
import { prepareProtocolPauseState } from "./session/protocol-pause-state.js";
import { EnrichmentPool } from "./workers/pool.js";
import type { TierCFallbackContext, TierCFallbackResult } from "./validation/normalizer.js";
import {
  evaluateExecutionGovernor,
  buildExecutionGovernorHardStopUserMessage,
  buildExecutionGovernorPauseEnvelope,
  inferGovernorPhaseFromMessages,
  governorPhaseToWorkflowPhase,
  extractCommandEvents,
  extractEditedFileHints,
  type ExecutionGovernorDecision,
  type GovernorPauseEnvelope,
  type GovernorInputMessage,
  type SessionPhase,
  isPlanRecoveryDiscoveryIntent,
} from "./governance/execution-governor.js";
import {
  persistGovernorPauseSoftFail,
  resetGovernorPauseRecoveryState,
} from "./governance/governor-pause-route.js";
import { applyGovernorPhaseRouteBookkeeping } from "./governance/governor-phase-route.js";
import { GovernorService, disabledExecutionGovernorDecision } from "./governance/governor-service.js";
import {
  createOpenAIChatNonStreamRoutePipelineInput,
  runOpenAIChatNonStreamPipeline,
} from "./pipeline/openai-chat-nonstream-pipeline.js";
import { OpenAIChatPipeline, sendOpenAIChatPipelineResult } from "./pipeline/openai-chat-pipeline.js";
import {
  admissionErrorMessage,
  countMessageRoles,
} from "./pipeline/context-admission.js";
import { runRouteContextAdmission } from "./pipeline/route-context-admission.js";
import { runOpenAIChatStreamPipeline } from "./pipeline/openai-chat-stream-pipeline.js";
import {
  createOpenAIChatRouteFinalizerBase,
  createOpenAIChatRouteTelemetryBase,
  createOpenAIChatRouteToolHandlingBase,
  createOpenAINonStreamCollapseRouteInput,
  createOpenAINonStreamDiscoveryRouteInput,
} from "./pipeline/openai-route-inputs.js";
import { prepareOpenAIRouteTranscript } from "./pipeline/openai-route-transcript-prep.js";
import { stabilizeOpenAITranscript } from "./pipeline/openai-route-transcript-stabilization.js";
import { finalizeOpenAIProviderRequest } from "./pipeline/openai-route-provider-finalization.js";
import { buildRouteGovernanceBlocks } from "./pipeline/route-governance-blocks.js";
import { finalizePostEnrichmentMessages } from "./pipeline/post-enrichment-finalization.js";
import { applyWorkspaceMetadataPrebackfill } from "./pipeline/workspace-metadata-prebackfill.js";
import {
  extractRecentToolNames,
  injectGovernorRecoveryMessage,
  prepareRouteTools,
} from "./pipeline/route-tool-preparation.js";
import { applyRoutePhasePolicy } from "./pipeline/route-phase-policy.js";
import {
  applyRouteAdapterPivot,
  resetQwenInterventionOnUserTurn,
} from "./pipeline/route-adapter-pivot.js";
import { assembleRouteModelMessages } from "./pipeline/route-model-message-assembly.js";
import {
  createOpenAINonStreamProviderForensics,
  createOpenAINonStreamServerSideToolResolvers,
} from "./pipeline/openai-nonstream-provider-executor.js";
import { createOpenAINonStreamRouteScope } from "./pipeline/openai-nonstream-route-scope.js";
import { shouldRunGovernorForMode } from "./pipeline/modes.js";
import {
  buildOpenAIChatProviderRequestOptions,
  suppressThinkingWhenRequiredToolChoice,
} from "./pipeline/provider-options.js";
import {
  buildGovernorPauseContextSnapshot,
  buildGovernorPauseResumeBlock,
  GOVERNOR_PAUSE_CONTEXT_METADATA_KEY,
  GOVERNOR_PAUSE_PENDING_METADATA_KEY,
  isGovernorPauseSummaryRequest,
  parseGovernorPauseContextSnapshot,
  type GovernorPauseSurface,
} from "./governance/governor-pause-context.js";
import {
  evaluateSensemakingGovernor,
  compareSensemakingWithLegacy,
  buildSensemakingPauseMessage,
  buildSensemakingGuidanceInjection,
  type SensemakingDecision,
} from "./governance/sensemaking-governor.js";
import {
  buildRequiredRepairPrompt,
  validateRequiredToolCalls,
  type PhaseAwareToolChoice,
} from "./governance/phase-execution-policy.js";
import { deriveGovernorLoopObservability } from "./governance/governor-observability.js";
import { buildArtifactShadows, summarizeArtifactContext } from "./governance/artifact-shadow.js";
import { toolDefinitionName, type GuardrailToolCall } from "./tools/tool-call-availability.js";
import { summarizeEvidenceDelta } from "./governance/evidence-delta.js";
import type { TurnEvidenceDelta } from "./governance/evidence-delta.js";
import {
  deriveChatState,
  type ChatPhase,
  type ChatState,
} from "./governance/chat-state.js";
import {
  deriveFileState,
  type FileState,
} from "./governance/file-state.js";
import {
  applyObjectiveScope,
  resolveObjectiveEpoch,
} from "./governance/objective-scope.js";
import {
  assessStateConfidence,
  formatStateConfidenceBlock,
  type StateConfidenceAssessment,
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
  type HandshakeStatus,
  type SessionPathHints,
} from "./state/workspace-session-boundary.js";
import type { CompactionMode } from "./governance/context-budget-manager.js";
import { StateTransitionGlobalCalibrator } from "./governance/state-transition-global-calibrator.js";
import { resetRecoveryCounters } from "./path-governance/tool-call-governance.js";
import {
  type TaskLedger,
  type ClientTaskCapabilities,
  detectClientTaskCapabilities,
  isTaskToolCall,
  normalizeTaskToolCall,
  reconcileFromToolCall,
  reconcileFromText,
  reconcileFromEvidence,
  createEmptyLedger,
  serializeTaskLedger,
  deserializeTaskLedger,
  evaluateTaskCompletionGate,
  incrementReconciliationAttempts,
  scrubTaskLedgerOutput,
  type EvidenceSignal,
} from "./task-ledger/index.js";

import { evaluateCliProjectAcceptance } from "./acceptance/cli-project-harness.js";

type SessionState = {
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  toolCallsSinceCheckpoint: number;
  consecutiveToolCalls: number;
  stagnantToolCycles: number;
  lastToolSignalHash: string;
  awaitingToolLoopUserAck: boolean;
  toolLoopAckAnchorUserHash: string;
  toolLoopNoUserAckCount: number;
  blockBroadVerificationUntilEdit: boolean;
  blockFailingVerificationUntilEdit: boolean;
  record: SessionRecord;
  lastVolatileContent?: string;
  lastVolatileHash?: string;
  pruningWatermark: number;
  consecutiveRecoveryFires: number;
  consecutiveEditContextMisses: number;
  editReplayHardStopGraceUsed: boolean;
  editMissForceReadPending: boolean;
  lastGovernorPhase?: import("./governance/execution-governor.js").SessionPhase;
  /** Per-file edit-turn tracking for artifact shadow staleness. */
  artifactEditTurns: Map<string, number>;
  /** All distinct failure signatures observed in this session. */
  seenFailureSignatures: Set<string>;
  /** The failure signature from the previous governor evaluation. */
  previousFailureSignature: string | null;
  /** Latest computed evidence delta for training signal export. */
  lastEvidenceDelta: TurnEvidenceDelta | null;
  /** Track incoming message count to detect external (client-side) compaction. */
  lastIncomingMessageCount: number;
  /** One-shot pre-pause recovery attempts keyed by phase+rule. */
  governorPrePauseAttemptsByRule: Map<string, number>;
  /**
   * 0: next implementation-only soft stall (explore/no_progress) may receive a nudge without pause;
   * 1: next identical stall is a full soft-fail pause, then reset to 0.
   */
  implementationSoftStallNudgeStrikes: 0 | 1;
  /** Turns remaining in the post-reground cooldown (skip reground for N turns after satisfaction). */
  regroundCooldownRemaining: number;
  /** Timestamp (ms) of the last governor evaluation that returned pause=false. */
  lastGovernorNoPauseAt: number;
  /** Cached governor result from the last evaluation that returned pause=false. */
  lastGovernorCachedResult: ExecutionGovernorDecision | null;
  /** Skip tool ID stabilization on next request after a MissingToolResults error. */
  skipToolIdStabilization: boolean;
  /** Count of compound git inspection blocks in this session. */
  gitInspectionBlockCount: number;
  /** Proportionality: classified scope envelope from the latest user message. */
  scopeEnvelope: import("./governance/intent-scope-classifier.js").ScopeEnvelope;
  /** Proportionality: cumulative diff stats for the current user turn. */
  diffStats: import("./governance/diff-accumulator.js").DiffStats;
  /** Normalized task ledger for cross-client task reconciliation. */
  taskLedger: TaskLedger | null;
  /** Detected client task/todo capabilities (set once per session). */
  taskCapabilities: ClientTaskCapabilities | null;
};

type DiscoveryRecoverySnapshot = {
  text: string;
  entryCount: number;
  usedTopLevelSnapshot: boolean;
  recoveryMode: "top_level_snapshot" | "no_project_root" | "root_empty" | "snapshot_io_error";
};

function blockedInputPreview(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const row = input as Record<string, unknown>;
  const trimmed: Record<string, unknown> = {};
  for (const key of ["glob_pattern", "pattern", "glob", "query", "path", "directory", "dir"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) trimmed[key] = value.trim().slice(0, 80);
  }
  const keys = Object.keys(trimmed);
  if (keys.length === 0) return undefined;
  return JSON.stringify(trimmed);
}

async function buildBlockedDiscoveryRecoverySnapshot(
  family: string,
  blocked: BlockedDiscoveryDetail[],
  projectRoot: string | null | undefined,
): Promise<DiscoveryRecoverySnapshot> {
  const base = buildBlockedDiscoveryGuidance(family, blocked);
  const safeRoot = typeof projectRoot === "string" ? projectRoot.trim() : "";
  if (!safeRoot) {
    return {
      text: buildBlockedDiscoveryRecoveryWithoutSnapshot(base, "no_project_root"),
      entryCount: 0,
      usedTopLevelSnapshot: false,
      recoveryMode: "no_project_root",
    };
  }
  try {
    const entries = await readdir(safeRoot, { withFileTypes: true });
    const normalized = entries
      .map((entry): { name: string; kind: "dir" | "file" } => ({
        name: entry.name,
        kind: entry.isDirectory() ? "dir" : "file",
      }))
      .filter((entry) => entry.name && !entry.name.startsWith("."))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    if (normalized.length === 0) {
      return {
        text: buildBlockedDiscoveryRecoveryWithoutSnapshot(base, "root_empty"),
        entryCount: 0,
        usedTopLevelSnapshot: false,
        recoveryMode: "root_empty",
      };
    }
    const withPreview = buildBlockedDiscoveryRecoveryWithSnapshot(base, normalized);
    return {
      text: withPreview.text,
      entryCount: withPreview.previewCount,
      usedTopLevelSnapshot: true,
      recoveryMode: "top_level_snapshot",
    };
  } catch {
    return {
      text: buildBlockedDiscoveryRecoveryWithoutSnapshot(base, "snapshot_io_error"),
      entryCount: 0,
      usedTopLevelSnapshot: false,
      recoveryMode: "snapshot_io_error",
    };
  }
}

const topLevelDirCache = new Map<string, { dirs: string[]; cachedAt: number }>();
const TOP_LEVEL_DIR_CACHE_TTL = 120_000;

async function getCachedTopLevelDirs(projectRoot: string | null | undefined): Promise<string[]> {
  const root = typeof projectRoot === "string" ? projectRoot.trim() : "";
  if (!root) return [];
  const cached = topLevelDirCache.get(root);
  if (cached && Date.now() - cached.cachedAt < TOP_LEVEL_DIR_CACHE_TTL) return cached.dirs;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    topLevelDirCache.set(root, { dirs, cachedAt: Date.now() });
    return dirs;
  } catch {
    return [];
  }
}

function applyDiscoveryToolGuardrail(
  calls: GuardrailToolCall[],
  topLevelDirs?: string[],
): {
  calls: GuardrailToolCall[];
  blockedCount: number;
  redirectedCount: number;
  collapsedCount: number;
  blockedDetails: BlockedDiscoveryDetail[];
  redirectedDetails: DiscoveryGuardrailRedirect[];
} {
  const guarded = applyDiscoveryGuardrails(calls, topLevelDirs);
  const callById = new Map(calls.map((call) => [call.toolCallId, call]));
  return {
    calls: guarded.calls as GuardrailToolCall[],
    blockedCount: guarded.blocked.length,
    redirectedCount: guarded.redirected.length,
    collapsedCount: guarded.collapsed.length,
    blockedDetails: guarded.blocked.map((b) => ({
      toolName: b.toolName,
      reason: b.reason,
      argsPreview: blockedInputPreview(callById.get(b.toolCallId)?.input),
    })),
    redirectedDetails: guarded.redirected,
  };
}

const FILE_UNCHANGED_RE = /<FILE_UNCHANGED\s[^>]*path="([^"]+)"/i;

function remediatePlanFileStubs(
  messages: Array<{ role: string; content: unknown }>,
): { messages: Array<{ role: string; content: unknown }>; remediatedCount: number } {
  let remediatedCount = 0;
  const out = messages.map((m) => {
    if (m.role !== "tool" || typeof m.content !== "string") return m;
    const text = m.content;
    if (!text.includes("<FILE_UNCHANGED")) return m;
    const pathMatch = text.match(FILE_UNCHANGED_RE);
    const extractedPath = pathMatch?.[1] ?? null;
    if (!extractedPath) return m;
    const isPlan = extractedPath.includes("/.claude/plans/") || extractedPath.includes("\\.claude\\plans\\");
    if (!isPlan) return m;
    remediatedCount += 1;
    return {
      ...m,
      content: [
        `<SYNESIS_TOOL_GUARDRAIL status="guided" code="plan_file_dedup_remediation" version="1">`,
        `file_path=${extractedPath}`,
        `reason=plan_file_incorrectly_deduplicated`,
        `next_action=read_plan_file_with_bash`,
        `[Plan file stub] A plan file was incorrectly deduplicated. You do not have the plan content.`,
        `Use Bash(cat ${extractedPath}) to retrieve the full plan file content.`,
        `</SYNESIS_TOOL_GUARDRAIL>`,
      ].join("\n"),
    };
  });
  return { messages: out, remediatedCount };
}

const PLAN_FILE_PATH_KEYS = ["filePath", "file_path", "path", "file", "fileName", "file_name"];
const PLAN_READ_TOOL_NAMES = new Set(["read", "read_file", "readfile", "file_read", "str_replace_editor"]);
const PLAN_WRITE_TOOL_NAMES = new Set([
  "write", "write_file", "writefile", "edit", "update",
  "str_replace_editor", "apply_patch", "file_write",
]);

function isPlanPath(p: string): boolean {
  return p.includes("/.claude/plans/") || p.includes("\\.claude\\plans\\");
}

function resolveToolCallPlanPaths(
  messages: Array<{ role: string; tool_call_id?: string; content: unknown }>,
  toolNameSet: Set<string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const toolCalls = (m as Record<string, unknown>).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const id = typeof tc?.id === "string" ? tc.id : "";
      const fnName = typeof tc?.function?.name === "string" ? tc.function.name.toLowerCase() : "";
      if (!id || !toolNameSet.has(fnName)) continue;
      let argsRaw = tc?.function?.arguments;
      if (typeof argsRaw === "string") {
        try { argsRaw = JSON.parse(argsRaw); } catch { continue; }
      }
      if (!argsRaw || typeof argsRaw !== "object") continue;
      const args = argsRaw as Record<string, unknown>;
      for (const key of PLAN_FILE_PATH_KEYS) {
        if (typeof args[key] === "string" && args[key]) {
          map.set(id, args[key] as string);
          break;
        }
      }
    }
  }
  return map;
}

/**
 * Detect plan file reads and append structured instructions so the model
 * knows to parse tasks and display a status summary instead of looping.
 *
 * Suppresses the annotation when the plan file has been subsequently edited
 * (the original read content is stale). In that case, annotates the edit
 * result instead so the model proceeds with the updated plan state.
 */
function annotatePlanFileReads(
  messages: Array<{ role: string; tool_call_id?: string; content: unknown }>,
): { messages: Array<{ role: string; tool_call_id?: string; content: unknown }>; annotatedCount: number; planFilePaths: string[] } {
  const readPathMap = resolveToolCallPlanPaths(messages, PLAN_READ_TOOL_NAMES);
  const writePathMap = resolveToolCallPlanPaths(messages, PLAN_WRITE_TOOL_NAMES);

  // Build set of plan paths that were edited after being read
  const editedPlanPaths = new Set<string>();
  for (const [, path] of writePathMap) {
    if (isPlanPath(path)) editedPlanPaths.add(path);
  }

  // Find the index of the last edit for each edited plan path
  const lastEditIndexByPath = new Map<string, number>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool" || !m.tool_call_id) continue;
    const writePath = writePathMap.get(m.tool_call_id);
    if (writePath && isPlanPath(writePath) && !lastEditIndexByPath.has(writePath)) {
      lastEditIndexByPath.set(writePath, i);
    }
  }

  let annotatedCount = 0;
  let cachedPlanReads = 0;
  const planFilePaths: string[] = [];
  // Track which plan paths already have a real (content-bearing) read in context
  const planPathHasFullRead = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    const rp = m.tool_call_id ? readPathMap.get(m.tool_call_id) : undefined;
    if (rp && isPlanPath(rp) && m.content.length > 200 && !m.content.includes("read_cache_stub") && !m.content.includes("Unchanged")) {
      planPathHasFullRead.add(rp);
    }
  }

  const out = messages.map((m, idx) => {
    if (m.role !== "tool" || typeof m.content !== "string") return m;
    const text = m.content;
    if (text.includes("<SYNESIS_PLAN_LOADED") || text.includes("<SYNESIS_PLAN_UPDATED") || text.includes("<SYNESIS_PLAN_ALREADY_UPDATED")) return m;

    const resolvedReadPath = m.tool_call_id ? readPathMap.get(m.tool_call_id) : undefined;
    const resolvedWritePath = m.tool_call_id ? writePathMap.get(m.tool_call_id) : undefined;

    // Case 0: Plan file read that returned a cache stub ("Unchanged" or guardrail)
    // The model already has this plan's content from an earlier read. Replace the
    // contradictory "use cat to re-read" guardrail with a definitive "do not re-read".
    // Escalation: each subsequent cached read gets progressively more forceful.
    if (resolvedReadPath && isPlanPath(resolvedReadPath) && !editedPlanPaths.has(resolvedReadPath)) {
      const isStub =
        text.length < 80
        || text.includes("read_cache_stub")
        || text.toLowerCase().includes("unchanged");
      if (isStub) {
        if (!planFilePaths.includes(resolvedReadPath)) planFilePaths.push(resolvedReadPath);
        annotatedCount += 1;
        cachedPlanReads += 1;
        const hasContent = planPathHasFullRead.has(resolvedReadPath);
        if (cachedPlanReads >= 3) {
          return {
            ...m,
            content: [
              `<SYNESIS_PLAN_LOADED path="${resolvedReadPath}" cached="true" reread_count="${cachedPlanReads}" severity="critical">`,
              `⛔ CRITICAL: You have re-read this plan file ${cachedPlanReads} times. It has NOT changed. STOP READING IT.`,
              `You are stuck in a loop. The plan content is already in this conversation.`,
              `DO NOT: re-read the plan, re-summarize completed items, search the codebase to verify completed items, or declare intent without acting.`,
              `DO THIS NOW: Pick the next incomplete task and make ONE code edit (Write/Edit). Nothing else.`,
              `</SYNESIS_PLAN_LOADED>`,
            ].join("\n"),
          };
        }
        return {
          ...m,
          content: [
            `<SYNESIS_PLAN_LOADED path="${resolvedReadPath}" cached="true" reread_count="${cachedPlanReads}">`,
            hasContent
              ? `The plan file is unchanged. You already have its full content from an earlier read in this conversation.`
              : `The plan file was read previously but the content may have been pruned. Use Bash(cat ${resolvedReadPath}) once if you need to see it.`,
            `Do NOT call Read on this file again. Do NOT re-read it. Do NOT say "I've already read this."`,
            hasContent
              ? `Refer to the plan content above. Identify the next INCOMPLETE task and begin working on it immediately.`
              : `After one cat, identify the next incomplete task and begin working on it immediately.`,
            `Trust the plan's status markers. Do NOT search or grep to re-verify items marked complete.`,
            `</SYNESIS_PLAN_LOADED>`,
          ].join("\n"),
        };
      }
    }

    // Skip non-plan short results
    if (text.length < 50) return m;

    // Case 1: This is a plan file READ result with actual content
    if (resolvedReadPath && isPlanPath(resolvedReadPath)) {
      if (!planFilePaths.includes(resolvedReadPath)) planFilePaths.push(resolvedReadPath);
      if (editedPlanPaths.has(resolvedReadPath)) {
        annotatedCount += 1;
        return {
          ...m,
          content: text + "\n\n" + [
            `<SYNESIS_PLAN_ALREADY_UPDATED path="${resolvedReadPath}">`,
            `You already updated this plan file earlier in this conversation.`,
            `Do NOT update it again. Do NOT re-read it. The plan is current.`,
            `Proceed with the next incomplete task or ask the user what to do.`,
            `</SYNESIS_PLAN_ALREADY_UPDATED>`,
          ].join("\n"),
        };
      }
      annotatedCount += 1;
      return {
        ...m,
        content: text + "\n\n" + [
          `<SYNESIS_PLAN_LOADED path="${resolvedReadPath}">`,
          `You have loaded a plan file. Your IMMEDIATE next actions:`,
          `1. Parse the task list from the YAML frontmatter above (look for 'todos:' or task entries with 'status:')`,
          `2. Display a progress summary table: completed tasks vs remaining tasks with their descriptions`,
          `3. State which task is next`,
          `4. Begin working on that task immediately — make a concrete code edit`,
          `Trust the plan's status markers. Do NOT search or grep the codebase to re-verify items already marked complete.`,
          `Do NOT re-read this file. Do NOT explore the repository before starting work.`,
          `</SYNESIS_PLAN_LOADED>`,
        ].join("\n"),
      };
    }

    // Case 2: This is a plan file EDIT result — and it's the last edit for that path
    if (resolvedWritePath && isPlanPath(resolvedWritePath) && lastEditIndexByPath.get(resolvedWritePath) === idx) {
      if (!planFilePaths.includes(resolvedWritePath)) planFilePaths.push(resolvedWritePath);
      annotatedCount += 1;
      return {
        ...m,
        content: text + "\n\n" + [
          `<SYNESIS_PLAN_UPDATED path="${resolvedWritePath}">`,
          `You have updated the plan file. The edit above reflects the latest task state.`,
          `Do NOT re-read the plan file. Do NOT re-display the progress summary you already showed.`,
          `The plan is updated. Proceed with the next task or ask the user what to do next.`,
          `</SYNESIS_PLAN_UPDATED>`,
        ].join("\n"),
      };
    }

    // Fallback: content-based detection for reads without resolved path
    if (!resolvedReadPath && !resolvedWritePath) {
      const isPlan = text.includes("/.claude/plans/") && /---\n/.test(text);
      if (isPlan) {
        planFilePaths.push("unknown-plan");
        annotatedCount += 1;
        return {
          ...m,
          content: text + "\n\n" + [
            `<SYNESIS_PLAN_LOADED path="the plan file">`,
            `You have loaded a plan file. Your IMMEDIATE next actions:`,
            `1. Parse the task list from the YAML frontmatter above (look for 'todos:' or task entries with 'status:')`,
            `2. Display a progress summary table: completed tasks vs remaining tasks with their descriptions`,
            `3. State which task is next`,
            `4. Begin working on that task immediately — make a concrete code edit`,
            `Trust the plan's status markers. Do NOT search or grep the codebase to re-verify items already marked complete.`,
            `Do NOT re-read this file. Do NOT explore the repository before starting work.`,
            `</SYNESIS_PLAN_LOADED>`,
          ].join("\n"),
        };
      }
    }

    return m;
  });
  return { messages: out, annotatedCount, planFilePaths };
}

const PLAN_MODE_ERROR_RE = /not in plan mode|only for exiting plan mode/i;

/**
 * Detect "not in plan mode" errors in recent tool results and inject a
 * guidance hint telling the agent to use Write/Bash instead. This prevents
 * the agent from looping on the client's plan-mode-restricted tool.
 */
function injectPlanModeRecoveryHint(
  messages: Array<{ role: string; content: unknown }>,
): boolean {
  const tail = messages.slice(-6);
  const hasPlanModeError = tail.some((m) => {
    if (m.role !== "tool" && m.role !== "user") return false;
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    return PLAN_MODE_ERROR_RE.test(text);
  });
  if (!hasPlanModeError) return false;

  const hint = [
    "<SYNESIS_EXECUTION_RECOVERY source=\"plan_mode_error\">",
    "The client's plan tool rejected your update because you are not in plan mode.",
    "To update a plan file from implementation mode, use the Write tool or Bash (e.g., cat > path) to write the file directly.",
    "Do NOT attempt to use the plan tool again — it only works in plan mode.",
    "If the plan is complete, write the updated content to the plan file using Write, then continue with your task.",
    "</SYNESIS_EXECUTION_RECOVERY>",
  ].join("\n");

  injectGovernorRecoveryMessage(messages, hint);
  return true;
}

/**
 * Extract a PlanContentShadow from the most recent successful plan file read
 * in the message history. Uses the read path map from annotatePlanFileReads.
 */
function extractPlanContentShadow(
  messages: Array<{ role: string; tool_call_id?: string; content: unknown }>,
  planFilePaths: string[],
): PlanContentShadow | null {
  if (planFilePaths.length === 0) return null;
  const readPathMap = resolveToolCallPlanPaths(messages, PLAN_READ_TOOL_NAMES);
  let bestShadow: PlanContentShadow | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool" || typeof m.content !== "string") continue;
    const rp = m.tool_call_id ? readPathMap.get(m.tool_call_id) : undefined;
    if (!rp || !isPlanPath(rp)) continue;
    const text = m.content;
    if (text.length < 200) continue;
    if (text.includes("read_cache_stub") || text.toLowerCase().includes("unchanged")) continue;
    bestShadow = buildShadowFromContent(rp, text);
    break;
  }
  return bestShadow;
}

const NO_TEST_FILES_RE = /\[no test files\]/i;
const PACKAGE_PATH_RE = /\?\s+(\S+)\s+\[no test files\]/;

/**
 * Annotate verification results that indicate actionable gaps so the model
 * can course-correct within the same turn rather than re-running the same
 * command in a loop.
 *
 * Currently handles:
 * - `[no test files]` — tells the model to create a test file instead of
 *   re-running the test command.
 */
function annotateVerificationGaps(
  messages: Array<{ role: string; tool_call_id?: string; content: unknown }>,
): { messages: Array<{ role: string; tool_call_id?: string; content: unknown }>; annotatedCount: number } {
  // Build a set of tool_call_ids whose assistant tool_call invoked a shell/bash tool
  const shellToolCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const toolCalls = (m as Record<string, unknown>).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const id = typeof tc?.id === "string" ? tc.id : "";
      const fnName = typeof tc?.function?.name === "string" ? tc.function.name.toLowerCase() : "";
      if (!id) continue;
      if (fnName.includes("bash") || fnName.includes("shell") || fnName.includes("run_command") || fnName.includes("execute")) {
        shellToolCallIds.add(id);
      }
    }
  }

  let annotatedCount = 0;
  const out = messages.map((m) => {
    if (m.role !== "tool" || typeof m.content !== "string") return m;
    const text = m.content;
    if (!NO_TEST_FILES_RE.test(text)) return m;
    if (text.includes("<SYNESIS_VERIFICATION_GAP")) return m;
    if (!m.tool_call_id || !shellToolCallIds.has(m.tool_call_id)) return m;

    const pkgMatch = text.match(PACKAGE_PATH_RE);
    const pkg = pkgMatch?.[1] ?? "the package";
    const lastSegment = pkg.includes("/") ? pkg.split("/").pop() : pkg;
    const testFileName = `${lastSegment}_test.go`;

    annotatedCount += 1;
    return {
      ...m,
      content: text + "\n\n" + [
        `<SYNESIS_VERIFICATION_GAP code="no_test_files">`,
        `package=${pkg}`,
        `There are NO test files for this package. Re-running "go test" will produce the same result.`,
        `ACTION REQUIRED: Create a test file (e.g. ${testFileName}) with test functions, then run the test command once.`,
        `Do NOT re-run "go test" until you have written a test file.`,
        `</SYNESIS_VERIFICATION_GAP>`,
      ].join("\n"),
    };
  });
  return { messages: out, annotatedCount };
}

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

function persistGovernorPauseContextMetadata(params: {
  session: SessionState;
  surface: GovernorPauseSurface;
  requestId: string;
  pauseEnvelope: GovernorPauseEnvelope;
  pauseContent: string;
  clientToolCapabilities: ClientToolCapabilities;
}): void {
  const snapshot = buildGovernorPauseContextSnapshot({
    surface: params.surface,
    requestId: params.requestId,
    envelope: params.pauseEnvelope,
    pauseMessage: params.pauseContent,
    questionToolName: params.clientToolCapabilities.hasQuestionTool
      ? params.clientToolCapabilities.questionToolName
      : null,
  });
  params.session.record.metadata[GOVERNOR_PAUSE_CONTEXT_METADATA_KEY] = snapshot as unknown as Record<string, unknown>;
  params.session.record.metadata[GOVERNOR_PAUSE_PENDING_METADATA_KEY] = true;
}

function clearGovernorPauseContextMetadata(session: SessionState): void {
  delete session.record.metadata[GOVERNOR_PAUSE_CONTEXT_METADATA_KEY];
  delete session.record.metadata[GOVERNOR_PAUSE_PENDING_METADATA_KEY];
}

function buildGovernorPauseResumeBlockForUser(session: SessionState, latestUserPrompt: string): string | null {
  if (!isGovernorPauseSummaryRequest(latestUserPrompt)) return null;
  const rawSnapshot = session.record.metadata[GOVERNOR_PAUSE_CONTEXT_METADATA_KEY];
  const pending = session.record.metadata[GOVERNOR_PAUSE_PENDING_METADATA_KEY] === true;
  const snapshot = parseGovernorPauseContextSnapshot(rawSnapshot);
  if (!pending || !snapshot) return null;
  session.record.metadata[GOVERNOR_PAUSE_PENDING_METADATA_KEY] = false;
  return buildGovernorPauseResumeBlock(snapshot, latestUserPrompt);
}

function applyObjectiveScopeAndPersist<TMessage extends {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
}>(
  params: {
    state: SessionState;
    sessionKey: string;
    requestId: string;
    userId: string;
    orgId: string;
    messages: TMessage[];
    chatState: ChatState;
    fileState: FileState;
    latestUserPromptText: string | null;
  },
): {
  scopedMessages: TMessage[];
  relevantEvidenceBlock: string | null;
  artifactBridgeBlock: string | null;
  boundaryIndex: number;
  retainedEvidenceCount: number;
  droppedPreBoundaryCount: number;
  objectiveChanged: boolean;
  epochId: number;
} {
  const requestOrdinal = params.state.record.requestCount + 1;
  const objectiveEpoch = resolveObjectiveEpoch({
    metadata: params.state.record.metadata,
    chatState: params.chatState,
    latestUserPromptText: params.latestUserPromptText,
    requestOrdinal,
  });
  const msgCount = params.messages.length;
  const scaledEvidence = msgCount > 200 ? 12 : msgCount > 100 ? 9 : 6;
  const epochInterval = Number(config.SYNESIS_YARN_SCOPE_EPOCH_INTERVAL ?? 10) || 10;
  const messageGrowthThreshold = Number(config.SYNESIS_YARN_SCOPE_MESSAGE_GROWTH_THRESHOLD ?? 80) || 80;
  const bucketSize = Number(config.SYNESIS_YARN_SCOPE_BUCKET_SIZE ?? 50) || 50;
  const scoped = applyObjectiveScope({
    messages: params.messages,
    chatState: params.chatState,
    fileState: params.fileState,
    epoch: objectiveEpoch,
    maxRelevantEvidence: scaledEvidence,
    preBoundaryWindow: 80,
    minimumScore: 3,
    requestOrdinal,
    epochInterval,
    messageGrowthThreshold,
    bucketSize,
  });

  params.state.record.metadata.objective_epoch_id = objectiveEpoch.epochId;
  params.state.record.metadata.objective_epoch_objective_hash = objectiveEpoch.objectiveHash;
  params.state.record.metadata.objective_epoch_objective_text = objectiveEpoch.objectiveText;
  params.state.record.metadata.objective_epoch_anchor_user_hash = objectiveEpoch.anchorUserHash;
  params.state.record.metadata.objective_epoch_set_request = objectiveEpoch.objectiveSetRequest;
  params.state.record.metadata.objective_scope_boundary_index = scoped.boundaryIndex;
  params.state.record.metadata.objective_scope_retained_evidence = scoped.retainedEvidenceCount;
  params.state.record.metadata.objective_scope_dropped_pre_boundary = scoped.droppedPreBoundaryCount;

  params.state.record.metadata.objective_epoch_pruning_frozen_boundary = scoped.updatedCheckpoint.frozenBoundaryIndex;
  params.state.record.metadata.objective_epoch_pruning_frozen_at_request = scoped.updatedCheckpoint.frozenAtRequest;
  params.state.record.metadata.objective_epoch_pruning_frozen_message_count = scoped.updatedCheckpoint.frozenMessageCount;

  if (
    objectiveEpoch.objectiveChanged
    || scoped.droppedPreBoundaryCount > 0
    || scoped.retainedEvidenceCount > 0
    || scoped.reanchored
  ) {
    recordSessionEvent(
      params.sessionKey,
      params.userId,
      params.orgId,
      "objective_scope_applied",
      "objective-scope",
      `epoch=${objectiveEpoch.epochId} changed=${objectiveEpoch.objectiveChanged} boundary=${scoped.boundaryIndex} retained=${scoped.retainedEvidenceCount} dropped=${scoped.droppedPreBoundaryCount} reanchored=${scoped.reanchored}`,
      params.requestId,
      {
        objective_epoch_id: objectiveEpoch.epochId,
        objective_changed: objectiveEpoch.objectiveChanged,
        objective_similarity: objectiveEpoch.similarityToPrevious,
        boundary_index: scoped.boundaryIndex,
        retained_evidence: scoped.retainedEvidenceCount,
        dropped_pre_boundary: scoped.droppedPreBoundaryCount,
        anchor_matched: scoped.anchorMatched,
        reanchored: scoped.reanchored,
      },
    );
  }

  return {
    scopedMessages: scoped.scopedMessages,
    relevantEvidenceBlock: scoped.relevantEvidenceBlock,
    artifactBridgeBlock: scoped.artifactBridgeBlock,
    boundaryIndex: scoped.boundaryIndex,
    retainedEvidenceCount: scoped.retainedEvidenceCount,
    droppedPreBoundaryCount: scoped.droppedPreBoundaryCount,
    objectiveChanged: objectiveEpoch.objectiveChanged,
    epochId: objectiveEpoch.epochId,
  };
}

function persistStateConfidence(
  metadata: Record<string, unknown>,
  assessment: StateConfidenceAssessment,
): void {
  metadata.state_confidence_chat = assessment.chatConfidence;
  metadata.state_confidence_file = assessment.fileConfidence;
  metadata.state_confidence_overall = assessment.overallConfidence;
  metadata.state_confidence_needs_reground = assessment.needsReground;
  metadata.state_confidence_recommended_path = assessment.recommendedReadPath ?? "";
  metadata.state_confidence_reasons = assessment.reasons;
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

function buildRequirementChecklistSnapshot(checklist: RequirementChecklist): Record<string, unknown> {
  return {
    version: checklist.version,
    sourceHash: checklist.sourceHash,
    sourcePreview: checklist.sourcePreview,
    updatedAt: Date.now(),
    must: checklist.must.map((r) => ({ id: r.id, title: r.title })),
    should: checklist.should.map((r) => ({ id: r.id, title: r.title })),
  };
}

function refreshRequirementChecklist(state: SessionState): RequirementChecklist | null {
  const rootPrompt = getMetadataString(state.record.metadata, "trace_root_prompt");
  if (!rootPrompt) return null;
  const sourceHash = hashTextSignal(rootPrompt);
  if (!sourceHash) return null;
  const checklist = buildChecklistFromPrompt(rootPrompt, sourceHash);
  state.record.metadata.requirement_checklist = buildRequirementChecklistSnapshot(checklist);
  return checklist;
}

function buildTaskIntakeSnapshot(intake: TaskIntake): Record<string, unknown> {
  return {
    sourceHash: intake.sourceHash,
    sourcePreview: intake.sourcePreview,
    acceptanceCriteriaCount: intake.acceptanceCriteria.length,
    rubric: intake.rubric,
    updatedAt: Date.now(),
  };
}

function persistPromptIntakeSnapshot(
  state: SessionState,
  result: YarnPromptIntakeResult,
): void {
  state.record.metadata.prompt_intake = result.metadataSnapshot;
  state.record.metadata.prompt_scope = result.decision.scope;
  state.record.metadata.prompt_intake_source_hash = result.decision.source_hash;
  state.record.metadata.prompt_intake_planning_steered = result.shouldAppend;
  state.record.metadata.prompt_intake_override = result.decision.override;
}

function recordPromptIntakeEvent(
  sessionKey: string,
  userId: string,
  orgId: string,
  requestId: string,
  surface: string,
  result: YarnPromptIntakeResult,
): void {
  if (result.decision.scope === "micro" && !result.shouldAppend && !result.decision.override) return;
  const planMode = result.metadataSnapshot.plan_mode_requested === true ? " plan_mode=true" : "";
  recordSessionEvent(
    sessionKey,
    userId,
    orgId,
    "prompt_intake_evaluated",
    "upper-harness",
    `${surface} scope=${result.decision.scope} action=${result.decision.action} steered=${result.shouldAppend} override=${result.decision.override}${planMode}`,
    requestId,
    result.metadataSnapshot,
  );
}

async function maybeBuildPlannerTodoPacketBlock(options: {
  session: SessionState;
  sessionKey: string;
  identity: SessionIdentity;
  requestId: string;
  surface: "openai" | "claude";
  latestUserPrompt: string;
  promptIntake: YarnPromptIntakeResult;
  clientToolCapabilities: ClientToolCapabilities;
}): Promise<string | null> {
  const sourceHash = options.promptIntake.decision.source_hash || hashTextSignal(options.latestUserPrompt);
  if (!sourceHash) return null;
  const cachedSourceHash = getMetadataString(options.session.record.metadata, "planner_todo_packet_source_hash");
  const cachedPacket = cachedSourceHash === sourceHash
    ? deserializePlannerTodoPacket(options.session.record.metadata.planner_todo_packet)
    : null;
  const cachedModelId = getMetadataString(options.session.record.metadata, "planner_todo_packet_model");
  const effectiveExistingTaskCount = cachedSourceHash === sourceHash
    ? options.session.taskLedger?.tasks.length ?? 0
    : 0;

  const basePlannerTodoDecision = {
    enabled: config.SYNESIS_YARN_PLANNER_TODO_PACKET_ENABLED,
    governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    requireClientPlanningTool: config.SYNESIS_YARN_PLANNER_TODO_REQUIRE_NATIVE_TOOL,
    promptScope: options.promptIntake.decision.scope,
    planningSteered: options.promptIntake.shouldAppend,
    planningOverride: options.promptIntake.decision.override,
    planModeRequested: options.promptIntake.metadataSnapshot.plan_mode_requested === true
      || options.clientToolCapabilities.planModeRequested,
    capabilities: options.clientToolCapabilities,
  };
  const cachedPacketAllowed = shouldGeneratePlannerTodoPacket({
    ...basePlannerTodoDecision,
    existingTaskCount: effectiveExistingTaskCount,
  });
  if (cachedPacket && cachedPacketAllowed) {
    return formatPlannerTodoPacketBlock({
      packet: cachedPacket,
      sourceHash,
      modelId: cachedModelId || config.SYNESIS_YARN_PLANNER_TODO_MODEL,
      capabilities: options.clientToolCapabilities,
    });
  }

  const shouldGenerate = shouldGeneratePlannerTodoPacket({
    ...basePlannerTodoDecision,
    existingTaskCount: effectiveExistingTaskCount,
  });
  if (!shouldGenerate) return null;

  try {
    tierRegistry.setCurrentRequestContext({
      sessionKey: options.sessionKey,
      requestId: options.requestId,
      clientKind: options.identity.clientKind,
    });
    const plannerModelId = (config.SYNESIS_YARN_PLANNER_TODO_MODEL || "coder-horizon").trim() || "coder-horizon";
    const resolved = tierRegistry.resolve(plannerModelId, "synesis-horizon");
    const plannerPrompt = buildPlannerTodoPacketPrompt({
      prompt: options.latestUserPrompt,
      sourceHash,
      capabilities: options.clientToolCapabilities,
      maxPromptChars: Math.max(1000, config.SYNESIS_YARN_PLANNER_TODO_MAX_PROMPT_CHARS),
    });
    const result = await generateText({
      model: resolved.model as never,
      maxOutputTokens: clampMaxOutputTokensForSafety(
        Math.max(300, config.SYNESIS_YARN_PLANNER_TODO_MAX_OUTPUT_TOKENS),
      ),
      messages: [
        {
          role: "system",
          content: "Return strict JSON only. You are planning for another coding model; never write implementation code.",
        },
        { role: "user", content: plannerPrompt },
      ] as never,
      abortSignal: AbortSignal.timeout(Math.max(500, config.SYNESIS_YARN_PLANNER_TODO_TIMEOUT_MS)),
    });
    const parsed = parsePlannerTodoPacket(result.text);
    if (!parsed.packet) {
      recordSessionEvent(
        options.sessionKey,
        options.identity.userId,
        options.identity.orgId,
        "planner_todo_packet_failed",
        "planner-todo",
        `surface=${options.surface} model=${resolved.resolvedModelId} parse_error=${parsed.parseError ?? "unknown"}`,
        options.requestId,
        {
          surface: options.surface,
          source_hash: sourceHash,
          model_id: resolved.resolvedModelId,
          parse_error: parsed.parseError ?? "unknown",
        },
      );
      return null;
    }

    options.session.record.metadata.planner_todo_packet = serializePlannerTodoPacket(parsed.packet);
    options.session.record.metadata.planner_todo_packet_source_hash = sourceHash;
    options.session.record.metadata.planner_todo_packet_model = resolved.resolvedModelId;
    options.session.record.metadata.planner_todo_packet_updated_at = Date.now();
    options.session.record.metadata.planner_todo_packet_ambiguity = parsed.packet.ambiguity;
    options.session.record.metadata.planner_todo_packet_todos = parsed.packet.todos.length;
    options.session.record.metadata.planner_todo_packet_questions = parsed.packet.questions.length;
    options.session.record.metadata.planner_todo_packet_carrier = options.clientToolCapabilities.hasTodoTool
      ? "native_todo_tool"
      : "prompt_block";

    if (!options.session.taskLedger || options.session.taskLedger.tasks.length === 0) {
      options.session.taskLedger = createEmptyLedger(
        options.session.record.sessionKey,
        Boolean(options.session.taskCapabilities?.hasExplicitTodoTool ?? options.clientToolCapabilities.hasTodoTool),
        Boolean(options.session.taskCapabilities?.hasExplicitPlanMode ?? options.clientToolCapabilities.planModeRequested),
      );
      options.session.taskLedger = reconcileFromText(
        options.session.taskLedger,
        plannerTodoPacketToHarnessTasks(parsed.packet, options.session.record.requestCount),
        options.session.record.requestCount,
      );
    }

    recordSessionEvent(
      options.sessionKey,
      options.identity.userId,
      options.identity.orgId,
      "planner_todo_packet_generated",
      "planner-todo",
      `surface=${options.surface} model=${resolved.resolvedModelId} todos=${parsed.packet.todos.length} questions=${parsed.packet.questions.length} ambiguity=${parsed.packet.ambiguity}`,
      options.requestId,
      {
        surface: options.surface,
        source_hash: sourceHash,
        model_id: resolved.resolvedModelId,
        todo_count: parsed.packet.todos.length,
        question_count: parsed.packet.questions.length,
        ambiguity: parsed.packet.ambiguity,
        todo_tool: options.clientToolCapabilities.todoToolName,
        question_tool: options.clientToolCapabilities.questionToolName,
        carrier: options.clientToolCapabilities.hasTodoTool ? "native_todo_tool" : "prompt_block",
      },
    );

    return formatPlannerTodoPacketBlock({
      packet: parsed.packet,
      sourceHash,
      modelId: resolved.resolvedModelId,
      capabilities: options.clientToolCapabilities,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    app.log.warn({ err, sessionKey: options.sessionKey, surface: options.surface }, "planner_todo_packet_failed");
    recordSessionEvent(
      options.sessionKey,
      options.identity.userId,
      options.identity.orgId,
      "planner_todo_packet_failed",
      "planner-todo",
      `surface=${options.surface} ${detail.slice(0, 240)}`,
      options.requestId,
      {
        surface: options.surface,
        source_hash: sourceHash,
        model_id: config.SYNESIS_YARN_PLANNER_TODO_MODEL,
        error: detail.slice(0, 500),
      },
    );
    return null;
  }
}

function refreshTaskIntake(state: SessionState): TaskIntake | null {
  if (!config.SYNESIS_YARN_TASK_INTAKE_ENABLED) return null;
  const rootPrompt = getMetadataString(state.record.metadata, "trace_root_prompt");
  if (!rootPrompt) return null;
  const sourceHash = hashTextSignal(rootPrompt);
  if (!sourceHash) return null;
  const intake = buildTaskIntake(rootPrompt, sourceHash);
  state.record.metadata.task_intake = buildTaskIntakeSnapshot(intake);
  return intake;
}

function parsePlanGraph(meta: Record<string, unknown>): PlanGraph | null {
  const raw = meta.plan_graph;
  if (!raw || typeof raw !== "object") return null;
  return deserializePlanGraph(raw as Record<string, unknown>);
}

function updatePlanGraph(
  state: SessionState,
  intake: TaskIntake | null,
  messages: Array<{ role: string; content: unknown }>,
  verificationFailures: number,
): PlanGraph | null {
  if (!config.SYNESIS_YARN_PLAN_GRAPH_ENABLED || !intake) return null;
  const existing = parsePlanGraph(state.record.metadata);
  const base = !existing || existing.sourceHash !== intake.sourceHash
    ? createPlanGraph(intake)
    : existing;
  const recentTools = extractRecentToolNames(messages);
  const latestAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const advanced = advancePlanGraph(base, {
    recentToolNames: recentTools,
    latestAssistantText: typeof latestAssistant?.content === "string" ? latestAssistant.content : "",
    verificationFailures,
  });
  state.record.metadata.plan_graph = advanced as unknown as Record<string, unknown>;
  return advanced;
}

function getChecklistSourceHash(meta: Record<string, unknown>): string {
  const row = meta.requirement_checklist;
  if (!row || typeof row !== "object") return "";
  const value = (row as Record<string, unknown>).sourceHash;
  return typeof value === "string" ? value : "";
}

function buildCompletionGapMessage(missingSummary: string): string {
  return [
    "Partial completion detected. I have not yet implemented all required request items.",
    "",
    "Missing requirements:",
    missingSummary,
    "",
    "Next step: continue implementation to close these gaps (instead of marking the task done).",
  ].join("\n");
}

function extractNewFileMentions(text: string): string[] {
  const out = new Set<string>();
  const rx = /\b(?:created|added|new file)\b[^.\n]*\b([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9_]+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    if (m[1]) out.add(m[1]);
    if (out.size >= 12) break;
  }
  return [...out];
}

function hasUsageOrReferenceCue(text: string, filePath: string): boolean {
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`\\b(import|use|used by|wired|hooked|referenced|route|register|include)\\b[^\\n]{0,140}${escaped}`, "i");
  return rx.test(text);
}

type CompletionGateOutcome = {
  finalText: string;
  applied: boolean;
  missingMust: number;
  missingShould: number;
  blockedByVerification: boolean;
  blockingVerificationFailures: number;
  suggestedNextActions: string[];
};

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

function applyCompletionGate(
  checklist: RequirementChecklist | null,
  originalText: string,
  traceRootPrompt: string,
  latestUserPrompt: string,
  verification: VerificationAssessment,
  planGraph?: PlanGraph | null,
): CompletionGateOutcome {
  const blockedByVerification =
    config.SYNESIS_YARN_COMPLETION_GATE_BLOCK_VERIFICATION
    && verification.hasBlockingFailures;
  if (blockedByVerification) {
    const top = verification.failures.slice(0, 3);
    const detail = top.map((f, i) => `- ${i + 1}. [${f.category}] ${f.summary}`).join("\n");
    const boundedCleanup = config.SYNESIS_YARN_COMPLETION_GATE_BOUNDED_CLEANUP_PASS
      ? [
          "Run one bounded cleanup pass before finalizing:",
          "- Scope: changed files / touched package only",
          "- Fix only blocking diagnostics and obvious patch debris",
          "- Re-run the same failing verification preset(s)",
        ].join("\n")
      : "";
    const nextActions = [
      ...top.map((f) => `rerun verification preset ${f.preset ?? "unknown"} after minimal fix`),
      "only finalize when blocking verification failures are cleared",
    ];
    return {
      finalText: [
        "Not complete: blocking verification failures remain.",
        "",
        "Blocking failures:",
        detail || "- (no details)",
        ...(boundedCleanup ? ["", boundedCleanup] : []),
        "",
        "Next: repair these failures and rerun verification before finalizing.",
      ].join("\n"),
      applied: true,
      missingMust: 0,
      missingShould: 0,
      blockedByVerification: true,
      blockingVerificationFailures: verification.failingSignals,
      suggestedNextActions: nextActions,
    };
  }
  if (!config.SYNESIS_YARN_COMPLETION_GATE_ENABLED || !checklist) {
    return {
      finalText: originalText,
      applied: false,
      missingMust: 0,
      missingShould: 0,
      blockedByVerification: false,
      blockingVerificationFailures: 0,
      suggestedNextActions: [],
    };
  }
  if (checklist.must.length === 0 && checklist.should.length === 0) {
    return {
      finalText: originalText,
      applied: false,
      missingMust: 0,
      missingShould: 0,
      blockedByVerification: false,
      blockingVerificationFailures: 0,
      suggestedNextActions: [],
    };
  }
  if (
    config.SYNESIS_YARN_COMPLETION_GATE_SKIP_CLARIFICATION &&
    looksLikeClarificationTurnAssistantMessage(originalText)
  ) {
    return {
      finalText: originalText,
      applied: false,
      missingMust: 0,
      missingShould: 0,
      blockedByVerification: false,
      blockingVerificationFailures: 0,
      suggestedNextActions: [],
    };
  }
  const evidence = [traceRootPrompt, latestUserPrompt, originalText].filter(Boolean).join("\n");
  const report = evaluateRequirementCoverage(checklist, evidence);
  let cliAcceptanceNotes: string[] = [];
  if (config.SYNESIS_YARN_CLI_ACCEPTANCE_HARNESS_ENABLED) {
    const fileMatches = evidence.match(/[a-zA-Z0-9_\-./]+/g) ?? [];
    const acceptance = evaluateCliProjectAcceptance({
      repoTree: fileMatches.filter((v) => v.includes("/") || v.includes(".")),
      promptText: traceRootPrompt,
      verificationSummary: originalText,
    });
    if (!acceptance.passed) {
      cliAcceptanceNotes = [
        ...acceptance.missingRequired.map((v) => `missing required path: ${v}`),
        ...acceptance.notes,
      ];
    }
  }
  const newFileNotes: string[] = [];
  const mentionedNewFiles = extractNewFileMentions(originalText);
  for (const fp of mentionedNewFiles) {
    if (!hasUsageOrReferenceCue(originalText, fp) && !hasUsageOrReferenceCue(latestUserPrompt, fp)) {
      newFileNotes.push(`new file mentioned without usage reference: ${fp}`);
    }
  }
  const planAdvisory: string[] = [];
  if (planGraph && !isPlanComplete(planGraph)) {
    planAdvisory.push(`Plan stage is "${planGraph.activeStage}", not finalize. Advance plan stages before final completion.`);
  }
  if (report.missingMust.length === 0) {
    return {
      finalText: originalText,
      applied: false,
      missingMust: 0,
      missingShould: report.missingShould.length,
      blockedByVerification: false,
      blockingVerificationFailures: 0,
      suggestedNextActions: [...planAdvisory, ...cliAcceptanceNotes, ...newFileNotes],
    };
  }
  const summary = summarizeMissingCoverage(report);
  const replacement = config.SYNESIS_YARN_COMPLETION_GATE_HARD_FAIL
    ? [
        "Completion blocked: required items are still missing.",
        "",
        "Missing requirements:",
        summary,
        "",
        "Continue implementation before declaring completion.",
      ].join("\n")
    : buildCompletionGapMessage(summary);
  return {
    finalText: replacement,
    applied: true,
    missingMust: report.missingMust.length,
    missingShould: report.missingShould.length,
    blockedByVerification: false,
    blockingVerificationFailures: 0,
    suggestedNextActions: [
      "continue implementation to close missing must-have requirements",
      ...planAdvisory,
      ...cliAcceptanceNotes,
      ...newFileNotes,
    ],
  };
}

type ToolExecutionFailureObservation = {
  toolName: string;
  toolCallId: string;
  filePath?: string;
  reason: string;
  snippet: string;
};

// More specific "anchor miss" / patch signals must come *before* the generic
// "error editing file" line so tool results like "Error editing file" + "not
// found" classify as edit_context_miss (drives read-preservation, counters).
const TOOL_FAILURE_PATTERNS: Array<{ reason: string; re: RegExp }> = [
  { reason: "edit_context_miss", re: /\bfailed to find context\b/i },
  { reason: "edit_context_miss", re: /\bold[_\s-]?string\b.*\bnot found\b/i },
  { reason: "edit_context_miss", re: /\bnot found in file\b/i },
  { reason: "edit_context_miss", re: /\bexactly once\b/i },
  { reason: "edit_context_miss", re: /\bfound \d+ matches\b.*\breplace_all\b.*\bfalse\b/i },
  { reason: "edit_context_miss", re: /\breplace_all is false\b/i },
  { reason: "edit_context_miss", re: /\buniquely identify the instance\b/i },
  { reason: "edit_error", re: /\berror editing file\b/i },
  { reason: "patch_apply_failed", re: /\b(apply\s*patch|patch)\b.*\b(failed|error)\b/i },
  { reason: "write_permission_denied", re: /\b(permission denied|operation not permitted)\b/i },
];
const TOOL_IDEMPOTENT_PATTERNS: RegExp[] = [
  /\balready (?:replaced|exists|present)\b/i,
  /\balready contains\b/i,
  /\bno changes (?:made|needed)\b/i,
  /\bnothing to (?:replace|update)\b/i,
];
const WRITE_ONLY_FAILURE_REASONS = new Set([
  "edit_error",
  "edit_context_miss",
  "patch_apply_failed",
  "write_permission_denied",
  "write_tool_error",
]);
const GOVERNOR_COOLDOWN_MS = 3_000;

function collectToolExecutionFailureObservations(
  messages: Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>,
): ToolExecutionFailureObservation[] {
  const toolMetaById = new Map<string, { toolName: string; filePath?: string }>();
  const latestWritePathByToolName = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const row = message as Record<string, unknown>;
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const id = typeof call.id === "string" ? call.id.trim() : "";
      const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : null;
      const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
      const filePath = readFilePathFromToolCallArgs(typeof fn?.arguments === "string" ? fn.arguments : "");
      if (id && name) toolMetaById.set(id, { toolName: name, filePath });
      if (name && filePath && isWriteCapableToolName(name)) {
        latestWritePathByToolName.set(name.toLowerCase(), filePath);
      }
    }
    const parts = Array.isArray(row.content) ? row.content : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "tool_use") continue;
      const id = typeof p.id === "string" ? p.id.trim() : "";
      const name = typeof p.name === "string" ? p.name.trim() : "";
      const filePath = readFilePathFromUnknownInput(p.input);
      if (id && name) toolMetaById.set(id, { toolName: name, filePath });
      if (name && filePath && isWriteCapableToolName(name)) {
        latestWritePathByToolName.set(name.toLowerCase(), filePath);
      }
    }
  }

  const observations: ToolExecutionFailureObservation[] = [];
  const seen = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    const chunks = collectToolResultTextChunks(message.content);
    if (chunks.length === 0) continue;
    const rawText = chunks.join("\n").trim();
    if (!rawText) continue;

    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : "";
    const mappedMeta = toolCallId ? (toolMetaById.get(toolCallId) ?? null) : null;
    const mappedName = mappedMeta?.toolName ?? "";
    const toolName = (typeof message.name === "string" ? message.name : mappedName).trim() || "unknown_tool";
    const fallbackFilePath = latestWritePathByToolName.get(toolName.toLowerCase());
    const observedFilePath = mappedMeta?.filePath ?? fallbackFilePath;
    const writeCapableTool = isWriteCapableToolName(toolName);
    const lower = rawText.toLowerCase();
    let reason = "";
    for (const candidate of TOOL_FAILURE_PATTERNS) {
      if (WRITE_ONLY_FAILURE_REASONS.has(candidate.reason) && !writeCapableTool) continue;
      if (candidate.re.test(lower)) {
        reason = candidate.reason;
        break;
      }
    }
    if (!reason && writeCapableTool && TOOL_IDEMPOTENT_PATTERNS.some((re) => re.test(lower))) {
      reason = "edit_already_applied";
    }
    if (!reason && writeCapableTool && /\b(error|failed|invalid)\b/i.test(rawText)) {
      reason = "write_tool_error";
    }
    if (!reason) continue;

    const snippet = rawText.replace(/\s+/g, " ").slice(0, 220);
    const key = `${toolName}|${toolCallId}|${reason}|${snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    observations.push({ toolName, toolCallId, filePath: observedFilePath, reason, snippet });
    if (observations.length >= 3) break;
  }
  return observations;
}

/**
 * Finds the index of the last genuine human user message (not a tool-result wrapper).
 * Used to determine the turn boundary for snapshot replay decisions.
 */
function findLastUserPromptIdx(messages: Array<{ role?: string; content?: unknown }>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    // Skip pure tool-result user messages (array of only tool_result blocks)
    if (Array.isArray(m.content) && m.content.length > 0
      && (m.content as Array<{ type?: string }>).every((b) => b?.type === "tool_result")) continue;
    // Must have some text content
    const text = typeof m.content === "string" ? m.content.trim() : "";
    if (!text && !Array.isArray(m.content)) continue;
    return i;
  }
  return -1;
}

function isToolResultOnlyUserContent(content: unknown): boolean {
  return Array.isArray(content)
    && content.length > 0
    && (content as Array<{ type?: string }>).every((b) => b?.type === "tool_result");
}

function hasGenuineUserTextContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return (content as Array<{ type?: string; text?: unknown }>).some((b) => {
    if (!b || typeof b !== "object") return false;
    if (b.type !== "text") return false;
    return typeof b.text === "string" && b.text.trim().length > 0;
  });
}

function isGenuineUserPromptMessage(message: { role?: string; content?: unknown } | undefined): boolean {
  if (!message || message.role !== "user") return false;
  if (isToolResultOnlyUserContent(message.content)) return false;
  return hasGenuineUserTextContent(message.content);
}

function sliceMessagesSinceLastUserPrompt<T extends { role?: string; content?: unknown }>(messages: T[]): T[] {
  const boundary = findLastUserPromptIdx(messages as Array<{ role?: string; content?: unknown }>);
  return boundary >= 0 ? messages.slice(boundary + 1) : messages;
}

type EditContextMissGuardState = {
  active: boolean;
  filePath: string;
  missCount: number;
};

function deriveEditContextMissGuardState(
  messages: Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>,
): EditContextMissGuardState | null {
  // Window to messages after the last genuine user prompt so that edit failures
  // from a previous session/interrupt don't bleed into the current task attempt.
  const turnBoundaryIdx = findLastUserPromptIdx(messages as Array<{ role?: string; content?: unknown }>);
  const turnMessages = turnBoundaryIdx >= 0 ? messages.slice(turnBoundaryIdx + 1) : messages;
  const toolMetaById = buildToolCallMetaById(turnMessages);
  const latestWritePathByToolName = buildLatestWritePathByToolName(turnMessages);
  const states = new Map<string, {
    filePath: string;
    misses: number;
    missesSinceRead: number;
    lastReadIdx: number;
    lastMissIdx: number;
  }>();
  let selected: { filePath: string; misses: number; lastMissIdx: number } | null = null;

  for (let i = 0; i < turnMessages.length; i += 1) {
    const message = turnMessages[i];
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : "";
    const meta = toolCallId ? toolMetaById.get(toolCallId) : undefined;
    const explicitToolName = typeof message.name === "string" ? message.name.trim() : "";
    const toolName = (explicitToolName || meta?.toolName || "").toLowerCase();
    const fallbackFilePath = latestWritePathByToolName.get(toolName);
    const filePath = canonicalizeToolPath(meta?.filePath ?? fallbackFilePath ?? "");
    if (!toolName || !filePath) continue;

    const chunks = collectToolResultTextChunks(message.content);
    if (chunks.length === 0) continue;
    const rawText = chunks.join("\n").trim();
    if (!rawText) continue;

    if (isReadToolName(toolName) && isResolvableReadResult(message.content, rawText)) {
      const prev = states.get(filePath);
      states.set(filePath, {
        filePath,
        misses: prev?.misses ?? 0,
        missesSinceRead: 0,
        lastReadIdx: i,
        lastMissIdx: prev?.lastMissIdx ?? -1,
      });
      continue;
    }

    if (!isWriteCapableToolName(toolName) || !isEditContextMissText(rawText)) continue;
    const prev = states.get(filePath);
    const nextMisses = prev ? prev.misses + 1 : 1;
    const nextMissesSinceRead = prev ? prev.missesSinceRead + 1 : 1;
    const nextState = {
      filePath,
      misses: nextMisses,
      missesSinceRead: nextMissesSinceRead,
      lastReadIdx: prev?.lastReadIdx ?? -1,
      lastMissIdx: i,
    };
    states.set(filePath, nextState);
    if (nextState.missesSinceRead >= 1 && nextState.lastMissIdx > nextState.lastReadIdx) {
      if (!selected || nextState.lastMissIdx >= selected.lastMissIdx) {
        selected = {
          filePath: nextState.filePath,
          misses: nextState.misses,
          lastMissIdx: nextState.lastMissIdx,
        };
      }
    }
  }

  if (!selected) return null;
  return {
    active: true,
    filePath: selected.filePath,
    missCount: selected.misses,
  };
}

function applyEditContextMissReadGate(
  tools: unknown[] | undefined,
): { tools: unknown[] | undefined; removed: string[]; forcedReadToolName?: string } {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { tools, removed: [] };
  }
  const removed: string[] = [];
  const readOnly: unknown[] = [];
  const filtered = tools.filter((tool) => {
    if (!tool || typeof tool !== "object") return true;
    const row = tool as Record<string, unknown>;
    const nested = row.function && typeof row.function === "object" ? (row.function as Record<string, unknown>) : null;
    const rawName = (typeof row.name === "string" ? row.name : "")
      || (nested && typeof nested.name === "string" ? nested.name : "");
    const name = rawName.trim();
    if (!name) return true;
    const lowered = name.toLowerCase();
    if (isReadToolName(lowered)) {
      readOnly.push(tool);
      return true;
    }
    if (isWriteCapableToolName(lowered)) {
      removed.push(name);
      return false;
    }
    // During edit-context recovery, prevent test/search churn by allowing only Read.
    removed.push(name);
    return false;
  });
  const forcedReadToolName = findPreferredReadToolName(readOnly.length > 0 ? readOnly : filtered);
  return {
    tools: readOnly.length > 0 ? readOnly : filtered,
    removed,
    forcedReadToolName,
  };
}

function buildEditContextMissGuardPrompt(filePath: string, missCount: number): string {
  const lines = [
    `EDIT RECOVERY REQUIRED: ${missCount} recent edit-context misses were detected for \`${filePath}\`.`,
    "Before any Edit/Write/Patch tool call, issue exactly one Read tool call for this same file path to refresh anchors.",
    "Read a substantial block (for example 20-60 lines around the target, or the full file if small) so the next anchor is unambiguous.",
    "Use that fresh content to prepare a new exact anchor, then apply one focused edit.",
    "Do not repeat the same old_string/anchor without a fresh read.",
    "If the editor reports multiple matches (for example replace_all=false with many matches), choose a smaller unique anchor first instead of retrying the same broad replacement.",
    "If the error says 'Found 2 matches' (or a small fixed number) and BOTH occurrences need the same change, set replace_all to true, OR expand old_string with enough surrounding lines to match exactly once, OR use Write/ApplyPatch for a whole contiguous block.",
    "Never use a whole-file old_string anchor for retries.",
  ];
  if (missCount >= 2) {
    lines.push(
      "If the refreshed file still does not match your expected anchor, stop retrying the same replacement.",
      "Pivot to verification of existing behavior and tests, or choose a different exact anchor before the next edit.",
    );
  }
  return lines.join("\n");
}

type LatestReadRefreshSignal = {
  hasRecentReadSuccess: boolean;
  toolName: string;
  toolCallId: string;
  filePath: string;
  snippet: string;
};

function classifyLatestReadRefresh(
  messages: Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>,
): LatestReadRefreshSignal {
  const turnBoundaryIdx = findLastUserPromptIdx(messages as Array<{ role?: string; content?: unknown }>);
  const turnMessages = turnBoundaryIdx >= 0 ? messages.slice(turnBoundaryIdx + 1) : messages;
  const toolMetaById = buildToolCallMetaById(turnMessages);
  for (let i = turnMessages.length - 1; i >= 0; i -= 1) {
    const message = turnMessages[i];
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    const chunks = collectToolResultTextChunks(message.content);
    if (chunks.length === 0) continue;
    const rawText = chunks.join("\n").trim();
    if (!rawText) continue;
    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : "";
    const mappedMeta = toolCallId ? (toolMetaById.get(toolCallId) ?? null) : null;
    const mappedName = mappedMeta?.toolName ?? "";
    const toolName = (typeof message.name === "string" ? message.name : mappedName).trim();
    if (!toolName || !isReadToolName(toolName)) continue;
    return {
      hasRecentReadSuccess: isResolvableReadResult(message.content, rawText),
      toolName,
      toolCallId,
      filePath: canonicalizeToolPath(mappedMeta?.filePath ?? ""),
      snippet: rawText.replace(/\s+/g, " ").slice(0, 220),
    };
  }
  return {
    hasRecentReadSuccess: false,
    toolName: "",
    toolCallId: "",
    filePath: "",
    snippet: "",
  };
}

function buildEditContextMissForcedReadPrompt(filePath?: string): string {
  const target = filePath && filePath.trim()
    ? `for \`${filePath.trim()}\``
    : "for the file you are trying to edit";
  return [
    "TOKEN-SAVING RECOVERY MODE: repeated edit anchor failures are still active.",
    `Your next action MUST be exactly one Read tool call ${target}.`,
    "Do not run Edit/Write/Test/Search tools in this turn.",
    "After that single Read result, perform one anchored edit in the next turn.",
  ].join("\n");
}

function buildStateRegroundReadPrompt(path: string, reasons: string[]): string {
  const safePath = path.trim() || "<unknown>";
  const reasonLine = reasons.length > 0
    ? `State confidence was low due to: ${reasons.slice(0, 5).join(", ")}.`
    : "State confidence was low and requires one deterministic refresh step.";
  return [
    "STATE REGROUND REQUIRED:",
    reasonLine,
    `Your next action MUST be exactly one Read tool call for \`${safePath}\`.`,
    "Do not run Edit/Write/Test/Search tools in this turn.",
    "After this single Read result, continue with one focused implementation action in the next turn.",
  ].join("\n");
}

function buildToolCallMetaById(
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>,
): Map<string, { toolName: string; filePath?: string }> {
  const out = new Map<string, { toolName: string; filePath?: string }>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const row = message as Record<string, unknown>;
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const id = typeof call.id === "string" ? call.id.trim() : "";
      const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : null;
      const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
      const filePath = readFilePathFromToolCallArgs(typeof fn?.arguments === "string" ? fn.arguments : "");
      if (id && name) out.set(id, { toolName: name, filePath });
    }
    const parts = Array.isArray(row.content) ? row.content : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "tool_use") continue;
      const id = typeof p.id === "string" ? p.id.trim() : "";
      const name = typeof p.name === "string" ? p.name.trim() : "";
      const filePath = readFilePathFromUnknownInput(p.input);
      if (id && name) out.set(id, { toolName: name, filePath });
    }
  }
  return out;
}

function buildLatestWritePathByToolName(
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const row = message as Record<string, unknown>;
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const call = tc as Record<string, unknown>;
      const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : null;
      const name = fn && typeof fn.name === "string" ? fn.name.trim() : "";
      const filePath = readFilePathFromToolCallArgs(typeof fn?.arguments === "string" ? fn.arguments : "");
      if (name && filePath && isWriteCapableToolName(name)) {
        out.set(name.toLowerCase(), filePath);
      }
    }
    const parts = Array.isArray(row.content) ? row.content : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "tool_use") continue;
      const name = typeof p.name === "string" ? p.name.trim() : "";
      const filePath = readFilePathFromUnknownInput(p.input);
      if (name && filePath && isWriteCapableToolName(name)) {
        out.set(name.toLowerCase(), filePath);
      }
    }
  }
  return out;
}

function readFilePathFromToolCallArgs(rawArgs: string): string | undefined {
  if (!rawArgs) return undefined;
  try {
    const parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    return readFilePathFromUnknownInput(parsed);
  } catch {
    return undefined;
  }
}

function readFilePathFromUnknownInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const row = input as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "file"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function canonicalizeToolPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\\/g, "/");
}

function isEditContextMissText(rawText: string): boolean {
  for (const candidate of TOOL_FAILURE_PATTERNS) {
    if (candidate.reason !== "edit_context_miss") continue;
    if (candidate.re.test(rawText)) return true;
  }
  return false;
}

function isReadToolName(toolName: string): boolean {
  const lowered = toolName.trim().toLowerCase();
  return lowered === "read" || lowered === "read_file" || lowered === "readfile" || lowered === "file_read";
}

function findReadToolDefinition(tools: unknown[] | undefined): unknown | undefined {
  if (!Array.isArray(tools)) return undefined;
  for (const tool of tools) {
    const name = toolDefinitionName(tool);
    if (name && isReadToolName(name)) return tool;
  }
  return undefined;
}

function isResolvableReadResult(content: unknown, rawText: string): boolean {
  const direct = typeof content === "string" ? content.trim() : "";
  if (direct.startsWith("{")) {
    const envelope = parseReadSnapshotEnvelope(direct);
    if (envelope) {
      const hasContent = typeof envelope.content === "string" && envelope.content.trim().length > 0;
      if (envelope.status === "ok/full_content" || envelope.status === "ok/replayed_snapshot") {
        return hasContent;
      }
      if (envelope.status === "ok/unchanged_snapshot_still_visible") {
        return hasContent;
      }
      return false;
    }
  }
  if (/unchanged since last read/i.test(rawText)) return false;
  if (/already read|already in memory|already in context|already loaded|cached/i.test(rawText)) return false;
  return rawText.length > 0;
}

function findPreferredReadToolName(tools: unknown[]): string | undefined {
  for (const tool of tools) {
    const name = toolDefinitionName(tool);
    if (!name) continue;
    if (isReadToolName(name)) return name;
  }
  return undefined;
}

function ensureReadToolAvailabilityForEditMissGuard(
  tools: unknown[] | undefined,
  fallbackTools: unknown[] | undefined,
): { tools: unknown[] | undefined; readToolName?: string; rehydrated: boolean; available: boolean } {
  const current = Array.isArray(tools) ? [...tools] : [];
  const existing = findPreferredReadToolName(current);
  if (existing) {
    return { tools: current, readToolName: existing, rehydrated: false, available: true };
  }
  const fallbackRead = findReadToolDefinition(fallbackTools);
  if (!fallbackRead) {
    return { tools: current, rehydrated: false, available: false };
  }
  const fallbackName = toolDefinitionName(fallbackRead) || findPreferredReadToolName([fallbackRead]) || "Read";
  return {
    tools: [...current, fallbackRead],
    readToolName: fallbackName,
    rehydrated: true,
    available: true,
  };
}

function collectToolResultTextChunks(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 5 || value === null || value === undefined || out.length >= 12) return out;
  if (typeof value === "string") {
    const t = value.trim();
    if (t) out.push(t);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolResultTextChunks(item, depth + 1, out);
      if (out.length >= 12) break;
    }
    return out;
  }
  if (typeof value !== "object") return out;
  const row = value as Record<string, unknown>;
  const directText = typeof row.text === "string" ? row.text.trim() : "";
  if (directText) out.push(directText);
  const nestedKeys = ["message", "error", "stderr", "stdout", "summary", "content", "result", "data", "payload", "output"];
  for (const key of nestedKeys) {
    if (!(key in row)) continue;
    collectToolResultTextChunks(row[key], depth + 1, out);
    if (out.length >= 12) break;
  }
  return out;
}

function isOpenClawProfile(profile: { family?: string }): boolean {
  return profile.family === "openclaw";
}

function isWriteCapableToolName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "write"
    || n === "edit"
    || n === "update"
    || n === "write_file"
    || n === "str_replace"
    || n === "git_add_guarded"
    || n === "git_commit_guarded"
    || n === "format_code";
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

interface RequestDiagnostic {
  timestamp: number;
  sessionKey: string;
  path: string;
  systemMessageCount: number;
  userMessageCount: number;
  toolMessageCount: number;
  totalInputChars: number;
  toolDefinitionCount: number;
  artifactToolInjected: boolean;
  knowledgeToolInjected: boolean;
  reducedToolResults: number;
  finishReason: string;
  tokensIn: number;
  tokensOut: number;
  policyDecision: string;
  latencyMs: number;
  recallRouting?: string;
  recallConfidence?: number;
  verificationRound?: number;
  verificationFindings?: number;
  verificationStalled?: boolean;
  decisionPath?: string;
  decisionEscalated?: boolean;
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
  evidencePrefetchHit?: boolean;
  evidencePrefetchConfidence?: number;
  evidencePrefetchMs?: number;
  evidenceQuality?: Record<string, unknown>;
  requestId?: string;
  promptProfileIds?: number[];
  promptProfileHashes?: string[];
  prefixHash?: string;
  prefixChangeReasons?: string[];
  completionGateApplied?: boolean;
  missingMustRequirements?: number;
  missingShouldRequirements?: number;
  requirementChecklistMust?: number;
  requirementChecklistShould?: number;
  contextAdmissionDecision?: "allow" | "warn" | "reject";
  contextAdmissionReason?: string;
  contextAdmissionEstimatedTokens?: number;
  contextAdmissionEstimatedChars?: number;
  requestForensicsSummary?: string;
  requestForensicsLcpRatio?: number;
  requestForensicsFirstChangedSection?: string;
  requestForensicsTokenEstimate?: number;
  cacheStrategy?: string;
  prefixFingerprint?: string;
}

const diagnosticRing: RequestDiagnostic[] = [];
let DIAGNOSTIC_RING_MAX = 20;
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
const requestForensicsLastBySession = new Map<string, { requestId: string; serialized: string }>();

function captureRequestForensics(
  sessionKey: string,
  requestId: string,
  path: string,
  providerModel: string,
  stream: boolean,
  messages: Array<{ role: string; content: unknown }>,
  tools: unknown[] | undefined,
  toolChoice: unknown,
  providerOptions: unknown,
  phasePolicy?: RequestForensicsRecord["phasePolicy"],
  capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"],
): { record: RequestForensicsRecord; serialized: string } | null {
  if (config.SYNESIS_YARN_REQUEST_FORENSICS_MODE === "off") return null;
  const previous = requestForensicsLastBySession.get(sessionKey);
  const built = buildRequestForensics({
    providerModel,
    path,
    requestId,
    stream,
    messages,
    tools,
    toolChoice,
    providerOptions,
    phasePolicy,
    capabilityMatrix,
    previous,
    capturePayload: config.SYNESIS_YARN_REQUEST_FORENSICS_MODE === "full",
    maxPreviewChars: config.SYNESIS_YARN_REQUEST_FORENSICS_MAX_PREVIEW_CHARS,
  });
  return built;
}

function finalizeRequestForensics(
  session: SessionState,
  requestId: string,
  forensics: { record: RequestForensicsRecord; serialized: string } | null,
  usage?: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheCreationTokens: number; costUsd: number },
): RequestForensicsRecord | undefined {
  if (!forensics) return undefined;
  const record = usage ? withForensicsUsage(forensics.record, usage) : forensics.record;
  requestForensicsLastBySession.set(session.record.sessionKey, {
    requestId,
    serialized: forensics.serialized,
  });
  usageWriter.enqueueSessionEvent({
    sessionKey: session.record.sessionKey,
    requestId,
    userId: session.record.userId,
    orgId: session.record.orgId,
    eventKind: "request_forensics_v1",
    component: "yarn",
    detail: record.summary.slice(0, 2048),
    metadataJson: {
      schema_version: "request_forensics_v1",
      ...record,
    },
  });
  return record;
}

function pushDiagnostic(d: RequestDiagnostic): void {
  diagnosticRing.push(d);
  if (diagnosticRing.length > DIAGNOSTIC_RING_MAX) diagnosticRing.shift();
  if (d.requestId) {
    diagnosticStore.persistDiagnostic(d.requestId, d as unknown as Record<string, unknown>);
  }
}

import { initFgaClient, fgaCheck } from "./openfga-client.js";

const config = loadConfig();
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
const diagnosticStore = new DiagnosticStore(config);
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

function extractBearerToken(authorizationHeader: string | undefined): string {
  const raw = authorizationHeader ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) return "";
  return raw.slice(7).trim();
}

function knowledgeResolveContext(
  authUser: import("./auth.js").AuthUser,
  req: { headers: { authorization?: string } },
): KnowledgeResolveContext {
  return {
    orgId: authUser.orgId,
    userId: authUser.userId,
    tenantIds: authUser.tenantIds,
    bearerToken: extractBearerToken(req.headers.authorization),
  };
}

function webSearchResolveContext(
  authUser: import("./auth.js").AuthUser,
  req: { headers: { authorization?: string } },
  args: {
    requestId?: string;
    sessionKey?: string;
    conversationId?: string;
    traceId?: string;
    sourceSurface?: "yarn_chat" | "yarn_mcp_http";
    toolName?: string;
  } = {},
): WebSearchResolveContext {
  return {
    orgId: authUser.orgId,
    userId: authUser.userId,
    tenantIds: authUser.tenantIds,
    bearerToken: extractBearerToken(req.headers.authorization),
    requestId: args.requestId,
    sessionKey: args.sessionKey,
    conversationId: args.conversationId,
    traceId: args.traceId,
    sourceSurface: args.sourceSurface ?? "yarn_chat",
    toolName: args.toolName ?? WEB_SEARCH_TOOL_NAME,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasClaudeNativeWebSearchTool(tools: unknown[] | undefined): boolean {
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return tools.some((tool) => {
    if (!isObjectRecord(tool)) return false;
    const type = String(tool.type ?? "").toLowerCase();
    const name = String(tool.name ?? "").toLowerCase();
    return type.startsWith("web_search_") || name === "web_search";
  });
}

function isClaudeWebSearchToolName(toolName: string): boolean {
  return toolName.trim().toLowerCase() === "web_search";
}

type ClaudeServerWebSearchEvent = {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  query: string;
  results: Array<{ type: "web_search_result"; url: string; title: string; snippet: string }>;
  errorCode?: string;
};

function toClaudeServerWebSearchEvent(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): ClaudeServerWebSearchEvent {
  const query = String(response.query ?? input.query ?? "");
  const rawResults = Array.isArray(response.results) ? response.results : [];
  const results = rawResults
    .map((row) => {
      if (!isObjectRecord(row)) return null;
      return {
        type: "web_search_result" as const,
        url: String(row.url ?? ""),
        title: String(row.title ?? ""),
        snippet: String(row.snippet ?? ""),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  let errorCode: string | undefined;
  if (typeof response.error === "string" && response.error.trim().length > 0) {
    errorCode = response.error;
  } else if (typeof response.status === "number" && response.status >= 400) {
    errorCode = "upstream_error";
  }

  return {
    toolUseId: `srvtoolu_${toolCallId || crypto.randomUUID().replace(/-/g, "")}`,
    toolName,
    input,
    query,
    results,
    errorCode,
  };
}

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
const streamAdmission = new StreamAdmissionController({
  maxConcurrentStreams: config.SYNESIS_YARN_MAX_CONCURRENT_STREAMS,
  maxQueueDepth: config.SYNESIS_YARN_STREAM_QUEUE_MAX_DEPTH,
  queueWaitTimeoutMs: config.SYNESIS_YARN_STREAM_QUEUE_WAIT_TIMEOUT_MS,
});
DIAGNOSTIC_RING_MAX = config.SYNESIS_YARN_DIAGNOSTIC_RING_MAX;
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
  policyRejectClaudeBody,
  policyRejectOpenAIBody,
  sendClaudeSoftFail,
  sendClaudeWorkspaceHandshake,
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

function persistSessionAndUsage(
  state: SessionState,
  requestId: string,
  resolvedModelId: string,
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheCreationTokens: number; costUsd: number },
  latencyMs: number,
  finishReason: string,
  tokensSavedByReduction = 0,
  escalated = false,
  snapshot?: DecisionSnapshot,
  trajectory?: RequestTrajectoryInput,
  optimizationLedger?: OptimizationLedgerSnapshot,
  clientRequestedModel?: string,
): void {
  const origRaw = (clientRequestedModel ?? "").trim();
  const orig = origRaw && origRaw.toLowerCase() !== "auto" ? origRaw : "";
  const traceModel = orig || resolvedModelId;
  const persistSpan = getTracer().startSpan("yarn.persist_session", {
    "yarn.request_id": requestId,
    "yarn.model": traceModel,
    "yarn.latency_ms": latencyMs,
  });
  const tier = tierRegistry.getTierConfig(resolvedModelId);
  const tokenAccounting = runPersistenceTokenEconomicsAccounting({
    resolvedModelId,
    traceModel,
    tier,
    metadata: state.record.metadata,
    orgId: state.record.orgId,
    clientKind: state.record.clientKind,
    usage,
    optimizationLedger,
    providerObservationTtlMs: Math.max(2, config.SYNESIS_YARN_CACHE_POLICY_PROVIDER_WINDOW_HOURS + 1) * 3_600_000,
    recordProviderCacheObservation: (...args) => sessionStore.recordProviderCacheObservation(...args),
    logFallbackPricing: (notice) => {
      app.log.info(notice, "fallback_pricing_in_effect: set rates in admin Model Registry for accurate costs");
    },
    warnProviderCacheObservation: (err, provider) => {
      app.log.warn({ err, provider }, "provider_cache_observation_record_failed");
    },
  });
  runSessionUsagePersistence({
    state,
    requestId,
    resolvedModelId,
    traceModel,
    backendModel: tier?.backendModel,
    clientRequestedModel,
    usage,
    latencyMs,
    finishReason,
    tokensSavedByReduction,
    escalated,
    snapshot,
    trajectory,
    optimizationLedger,
    costBreakdown: tokenAccounting.costBreakdown,
    normalizedEstimatedCostUsd: tokenAccounting.normalizedEstimatedCostUsd,
    normalizedActualCostUsd: tokenAccounting.normalizedActualCostUsd,
    pricingSource: tokenAccounting.pricingSource,
    tierRates: tokenAccounting.tierRates,
    tokenEconomicsRecommendation: tokenAccounting.tokenEconomicsDecision.recommendation,
    tokenEconomicsWarnings: tokenAccounting.tokenEconomicsDecision.warnings,
    tokenEconomicsMetadata: tokenAccounting.tokenEconomicsMetadata,
    conversationMemoryEnabled: config.SYNESIS_YARN_CONVERSATION_MEMORY_ENABLED,
    hourlyTokenThrottleEnabled: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_ENABLED,
    hourlyTokenThrottleWindowMs: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_WINDOW_MS,
    hourlyTokenThrottleSessionLimit: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_SESSION_LIMIT,
    hourlyTokenThrottleUserLimit: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_USER_LIMIT,
    toolCallsSinceCheckpoint: state.toolCallsSinceCheckpoint,
    evidenceDelta: summarizeEvidenceDelta(state.lastEvidenceDelta),
    writer: usageWriter,
    saveSession: () => casSessionSave(state),
    counter: distributedCounters,
    recordSessionEvent: (event) => {
      recordSessionEvent(
        event.sessionKey,
        event.userId,
        event.orgId,
        event.eventKind,
        event.component,
        event.detail,
        event.requestId,
        event.metadataJson,
      );
    },
    globalCalibrator: stateTransitionGlobalCalibrator,
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
    warn: (message, err) => app.log.warn({ err }, message),
  });
  persistSpan.setStatus("ok");
  persistSpan.end();
}

function persistAndEmitDecisionTelemetry(input: {
  state: SessionState;
  requestId: string;
  resolvedModelId: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheCreationTokens: number; costUsd: number };
  latencyMs: number;
  finishReason: string;
  tokensSavedByReduction: number;
  escalated: boolean;
  snapshot: DecisionSnapshot;
  trajectory?: RequestTrajectoryInput;
  sessionKey: string;
  userId: string;
  orgId: string;
  optimizationLedger?: OptimizationLedgerSnapshot;
  clientRequestedModel?: string;
}): void {
  persistSessionAndUsage(
    input.state,
    input.requestId,
    input.resolvedModelId,
    input.usage,
    input.latencyMs,
    input.finishReason,
    input.tokensSavedByReduction,
    input.escalated,
    input.snapshot,
    input.trajectory,
    input.optimizationLedger,
    input.clientRequestedModel,
  );
  maybeCheckpoint(input.state);
  emitDecisionEvents(input.sessionKey, input.userId, input.orgId, input.requestId, input.snapshot);
  runEvalObserverPersistence({
    sessionKey: input.sessionKey,
    userId: input.userId,
    orgId: input.orgId,
    requestId: input.requestId,
    history: input.state.history,
    snapshot: input.snapshot,
    recordSessionEvent: (event) => {
      recordSessionEvent(
        event.sessionKey,
        event.userId,
        event.orgId,
        event.eventKind,
        event.component,
        event.detail,
        event.requestId,
        event.metadataJson,
      );
    },
    warn: (err) => app.log.warn({ err }, "eval_observer_error"),
  });
}

function readUsage(input: unknown): { inputTokens: number; outputTokens: number; cachedTokens: number; cacheCreationTokens: number; costUsd: number } {
  const obj = (input ?? {}) as Record<string, unknown>;

  if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
    app.log.debug({ rawUsage: obj }, "raw_usage_from_sdk");
  }

  const normalized = extractUsage(obj as never);
  const cost = Number(obj.costUsd ?? obj.cost_usd ?? obj.estimated_cost ?? normalized.actual_cost_usd ?? 0);
  return {
    inputTokens: Number.isFinite(normalized.prompt_tokens) ? normalized.prompt_tokens : 0,
    outputTokens: Number.isFinite(normalized.completion_tokens) ? normalized.completion_tokens : 0,
    cachedTokens: Number.isFinite(normalized.cached_prompt_tokens) ? normalized.cached_prompt_tokens : 0,
    cacheCreationTokens: Number.isFinite(normalized.cache_creation_tokens) ? normalized.cache_creation_tokens! : 0,
    costUsd: Number.isFinite(cost) ? cost : 0
  };
}

function resolveClaudeConversationId(
  metadata: Record<string, unknown> | undefined,
  headers: Record<string, unknown>,
): string {
  if (metadata) {
    for (const key of ["synesis_conversation_id", "conversation_id", "session_id"]) {
      const val = metadata[key];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
    // Claude Code nests session_id inside metadata.user_id as a JSON string:
    // {"device_id":"...","account_uuid":"","session_id":"<uuid>"}
    const rawUserId = metadata.user_id;
    if (typeof rawUserId === "string" && rawUserId.startsWith("{")) {
      try {
        const parsed = JSON.parse(rawUserId) as Record<string, unknown>;
        const nested = parsed.session_id;
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      } catch { /* not JSON, ignore */ }
    }
  }
  for (const hdr of ["x-synesis-conversation-id", "x-claude-session-id"]) {
    const val = headers[hdr];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
    app.log.debug({ metadata, knownHeaders: {
      "x-synesis-conversation-id": headers["x-synesis-conversation-id"],
      "x-claude-session-id": headers["x-claude-session-id"],
      "x-request-id": headers["x-request-id"],
    }}, "claude_conversation_id_resolution_miss");
  }
  return "";
}

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

type VerificationFailure = {
  tool: string;
  preset?: string;
  summary: string;
  category: "format_or_lint" | "build_or_typecheck" | "test" | "runtime";
  topErrorLines: string[];
};

type VerificationAssessment = {
  verificationSignals: number;
  failingSignals: number;
  failures: VerificationFailure[];
  hasBlockingFailures: boolean;
};

type CriticAssessment = {
  blocked: boolean;
  findings: string[];
  suggestedNextActions: string[];
  source: "deterministic" | "llm_fallback";
};

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

  const gate = applyCompletionGate(
    input.checklist,
    input.assistantText,
    input.traceRootPrompt,
    input.latestUserPrompt,
    input.verification,
    input.planGraph,
  );

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
    const gate = applyCompletionGate(
      input.checklist,
      finalText,
      input.traceRootPrompt,
      input.latestUserPrompt,
      input.verification,
      input.planGraph,
    );
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

function recordSessionEvent(
  sessionKey: string,
  userId: string,
  orgId: string,
  eventKind: string,
  component: string,
  detail: string,
  requestId?: string,
  meta?: Record<string, unknown>,
): void {
  app.log.warn({ sessionKey, requestId, component, eventKind, detail: detail.slice(0, 200) }, `session_event: ${eventKind}`);
  usageWriter.enqueueSessionEvent({
    sessionKey,
    requestId,
    userId,
    orgId,
    eventKind,
    component,
    detail,
    metadataJson: meta,
  });
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

function getBearerToken(authHeader: string | undefined): string {
  const raw = authHeader ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) return "";
  return raw.slice(7).trim();
}

function safeWrite(raw: NodeJS.WritableStream & { destroyed?: boolean }, data: string): boolean {
  try {
    if (raw.destroyed) return false;
    raw.write(data);
    return true;
  } catch { return false; }
}

function safeSse(reply: { raw: NodeJS.WritableStream & { destroyed?: boolean } }, event: string, data: unknown): boolean {
  return safeWrite(reply.raw, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function safeEnd(raw: NodeJS.WritableStream & { destroyed?: boolean }): void {
  try { if (!raw.destroyed) raw.end(); } catch { /* already closed */ }
}

function startSseHeartbeat(args: {
  raw: NodeJS.WritableStream & { destroyed?: boolean; on?(event: string, listener: () => void): unknown };
  intervalMs: number;
  longWaitEventMs: number;
  onLongWait?: (elapsedMs: number) => void;
}): { stop: () => void } {
  let stopped = false;
  const normalizedInterval = Math.max(1000, Number.isFinite(args.intervalMs) ? args.intervalMs : 15_000);
  const normalizedLongWait = Math.max(normalizedInterval, Number.isFinite(args.longWaitEventMs) ? args.longWaitEventMs : 45_000);
  const startedAt = Date.now();
  const interval = setInterval(() => {
    if (stopped) return;
    // SSE comment frame; ignored by clients, but keeps idle proxies/connections alive.
    safeWrite(args.raw, ": keep-alive\n\n");
  }, normalizedInterval);
  let longWaitTimer: NodeJS.Timeout | undefined;
  if (args.onLongWait) {
    longWaitTimer = setTimeout(() => {
      if (stopped) return;
      args.onLongWait?.(Date.now() - startedAt);
    }, normalizedLongWait);
  }
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    if (longWaitTimer) clearTimeout(longWaitTimer);
  };
  args.raw.on?.("close", stop);
  args.raw.on?.("error", stop);
  return { stop };
}

function sanitizeUpstreamError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/timed?\s*out/i.test(raw)) return "Upstream model request timed out";
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up/i.test(raw)) return "Upstream model service unavailable";
  if (/\b[45]\d{2}\b/.test(raw)) return "Upstream model service error";
  if (/rate.?limit/i.test(raw)) return "Upstream rate limit exceeded";
  if (/context.?length|too.?long|too.?large/i.test(raw)) return "Request too large for model context window";
  if (/MissingToolResults|missing tool results?/i.test(raw)) return "Internal message integrity error (missing tool results)";
  return "Model request failed";
}

interface UpstreamErrorDiagnostics {
  userMessage: string;
  rawMessage: string;
  errorName?: string;
  errorCode?: string;
  httpStatus?: number;
  isVercelAiSdkError: boolean;
  isMissingToolResults: boolean;
}

function extractUpstreamErrorDiagnostics(err: unknown): UpstreamErrorDiagnostics {
  const row = (typeof err === "object" && err !== null) ? (err as Record<string, unknown>) : {};
  const rawMessage = err instanceof Error ? err.message : String(err);
  const errorNameRaw =
    (err instanceof Error ? err.name : undefined)
    ?? (typeof row.name === "string" ? row.name : undefined);
  const errorCodeRaw =
    (typeof row.code === "string" || typeof row.code === "number")
      ? String(row.code)
      : undefined;
  const httpStatusRaw =
    typeof row.statusCode === "number"
      ? row.statusCode
      : (typeof row.status === "number" ? row.status : undefined);
  const stackText = err instanceof Error ? String(err.stack ?? "") : "";
  const isMissingToolResults =
    /MissingToolResultsError/i.test(rawMessage)
    || /MissingToolResultsError/i.test(stackText)
    || /missing tool results?/i.test(rawMessage);
  const isVercelAiSdkError =
    /^AI[_A-Z]/.test(String(errorNameRaw ?? ""))
    || /\b@?vercel\/ai\b/i.test(stackText)
    || isMissingToolResults;
  return {
    userMessage: sanitizeUpstreamError(err),
    rawMessage,
    errorName: errorNameRaw,
    errorCode: errorCodeRaw,
    httpStatus: httpStatusRaw,
    isVercelAiSdkError,
    isMissingToolResults,
  };
}

function requireInternalToken(req: { headers: Record<string, unknown> }): boolean {
  const token = config.SYNESIS_INTERNAL_SERVICE_TOKEN;
  if (!token) return false;
  const bearer = getBearerToken(req.headers.authorization as string | undefined);
  return bearer === token;
}

/**
 * Convert Claude's top-level `system` field (string or content-block array)
 * into a system-role message that can be prepended to the OpenAI message list.
 */
function claudeSystemToMessage(system: unknown): { role: "system"; content: string; providerOptions?: Record<string, unknown> } | null {
  if (!system) return null;
  if (typeof system === "string") {
    return system.length > 0 ? { role: "system", content: system } : null;
  }
  if (Array.isArray(system)) {
    const textParts = system
      .filter((b: unknown) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text")
      .map((b: unknown) => String((b as Record<string, unknown>).text ?? ""));
    const joined = textParts.join("\n");
    if (joined.length === 0) return null;

    const lastCacheControl = system
      .filter((b: unknown) => typeof b === "object" && b !== null && (b as Record<string, unknown>).cache_control)
      .map((b: unknown) => (b as Record<string, unknown>).cache_control)
      .pop();

    if (lastCacheControl) {
      return {
        role: "system",
        content: joined,
        providerOptions: { anthropic: { cacheControl: lastCacheControl } },
      };
    }
    return { role: "system", content: joined };
  }
  return null;
}

function resolveRequestId(headers: Record<string, unknown>): string {
  const explicit = headers["x-request-id"] ?? headers["anthropic-request-id"];
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return `req-${crypto.randomUUID()}`;
}

function formatValidationError(error: { issues?: Array<{ path?: PropertyKey[]; message?: string }>; message: string }): string {
  const issue = error.issues?.[0];
  if (issue) {
    const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.map(String).join(".") : "request";
    const message = typeof issue.message === "string" && issue.message.trim() ? issue.message.trim() : "invalid value";
    return `Invalid request: ${path}: ${message}`;
  }
  return `Invalid request: ${error.message.slice(0, 500)}`;
}

function selectedOpenAiCompatHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "authorization"
      || lower === "user-agent"
      || lower === "x-request-id"
      || lower === "openai-organization"
      || lower === "openai-project"
      || lower.startsWith("x-synesis-")
    ) {
      out[lower] = Array.isArray(value) ? value.join(",") : String(value);
    }
  }
  return out;
}

function debugProtocolLog(
  logger: { info(obj: Record<string, unknown>, msg: string): void },
  reqId: string,
  path: string,
  extra: Record<string, unknown>
): void {
  if (!config.SYNESIS_YARN_DEBUG_PROTOCOL) return;
  logger.info({ reqId, path, ...extra }, "debug_protocol");
}

// --- Session TTL eviction ---
const SESSION_TTL_MS = config.SYNESIS_YARN_SESSION_TTL_MS;
const sessionEvictionTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, state] of sessions) {
    if (now - state.record.lastActiveAt > SESSION_TTL_MS) {
      void casSessionSave(state);
      sessions.delete(key);
      contentDedupBySession.delete(key);
      fileSnapshotBySession.delete(key);
      structuralIndexBySession.delete(key);
      memoryGovernorBySession.delete(key);
      clearSessionMemory(key);
      blockedDiscoveryBySession.delete(key);
      stablePrefixService.evictSession(key);
    }
  }
}, 60_000);

// --- Graceful shutdown ---
let shuttingDown = false;

async function snapshotSessionsToRedis(): Promise<void> {
  const saves: Promise<unknown>[] = [];
  for (const [key, state] of sessions) {
    state.record.lastActiveAt = Date.now();
    saves.push(sessionStore.save(state.record));
    saves.push(sessionStore.saveSessionState(key, buildSessionStateSnapshot(state)));
  }
  await Promise.allSettled(saves);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(sessionEvictionTimer);
  clearInterval(tierPollTimer);
  streamAdmission.close();
  userRateLimiter.close();
  policyEngine.close();
  governanceClient?.close();
  artifactStore.close();
  await snapshotSessionsToRedis();
  await app.close();
  await Promise.all([sessionStore.close(), usageWriter.close(), authResolver.close(), distributedCounters.close(), diagnosticStore.close(), enrichmentPool.close(), memoryStoreRedis?.quit()]);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

function computeEfficiencyIndex(): {
  score: number;
  reducerHitRate: number;
  artifactOffloadRate: number;
  tokenSavingsRate: number;
  jsonCompactionRate: number;
} {
  const stats = toolResultReduction.getStats();
  const total = stats.reducedCount + stats.fallbackToArtifactCount;
  const reducerHitRate = total > 0 ? (total - stats.fallbackToArtifactCount) / total : 0;
  const artifactOffloadRate = total > 0 ? stats.artifactHandleCount / total : 0;
  const tokenSavingsRate = stats.rawCharsTotal > 0
    ? (stats.rawCharsTotal - stats.reducedCharsTotal) / stats.rawCharsTotal
    : 0;
  const jsonCompactionRate = total > 0 ? stats.jsonCompactionCount / total : 0;
  const score = reducerHitRate * 0.3 + artifactOffloadRate * 0.15 + tokenSavingsRate * 0.45 + jsonCompactionRate * 0.1;
  return {
    score: Math.round(score * 1000) / 1000,
    reducerHitRate: Math.round(reducerHitRate * 1000) / 1000,
    artifactOffloadRate: Math.round(artifactOffloadRate * 1000) / 1000,
    tokenSavingsRate: Math.round(tokenSavingsRate * 1000) / 1000,
    jsonCompactionRate: Math.round(jsonCompactionRate * 1000) / 1000
  };
}

// --- Health endpoints ---
app.get("/health", async () => ({
  status: "ok",
  usage_persistence_enabled: usagePersistenceEnabled,
  usage_write_queue: usageWriter.getStats(),
}));
app.get("/health/readiness", async (_req, reply) => {
  const redisOk = await sessionStore.ping();
  if (!redisOk) {
    return reply.code(503).send({ status: "not_ready", reason: "redis_unreachable" });
  }
  return { status: "ready" };
});
app.get("/health/telemetry", async (req, reply) => {
  if (!requireInternalToken(req as never)) {
    return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
  }
  let activeSessionCount = 0;
  let totalHistoryEntries = 0;
  let checkpointedSessions = 0;
  for (const [, state] of sessions) {
    activeSessionCount++;
    totalHistoryEntries += state.history.length;
    if (state.history.some((m) => m.content.includes("<ARCHITECTURAL_STATE>"))) {
      checkpointedSessions++;
    }
  }
  return {
    timestamp: Date.now(),
    writeQueue: usageWriter.getStats(),
    validationNormalization: validationNormalization.getStats(),
    toolResultReduction: toolResultReduction.getStats(),
    transcriptPruning: transcriptPruning.getStats(),
    contentAddressedDedup: {
      activeSessions: contentDedupBySession.size,
      aggregate: Array.from(contentDedupBySession.values()).reduce(
        (acc, d) => {
          const s = d.getStats();
          return {
            totalReads: acc.totalReads + s.totalReads,
            deduplicatedReads: acc.deduplicatedReads + s.deduplicatedReads,
            charsSaved: acc.charsSaved + s.charsSaved,
          };
        },
        { totalReads: 0, deduplicatedReads: 0, charsSaved: 0 },
      ),
    },
    toolArgHardening: { ...toolArgHardeningStats },
    toolSchemaPruning: { ...toolSchemaPruningStats },
    openClawProfile: { ...openClawProfileStats },
    contextAdmission: { ...contextAdmissionStats, byPath: { ...contextAdmissionStats.byPath } },
    workingFrame: workingFrameService.getStats(),
    projectManifest: projectManifestService.getStats(),
    deterministicPolicy: policyEngine.getStats(),
    governance: governanceClient ? governanceClient.getStats() : { enabled: false },
    phaseOrchestrator: phaseOrchestrator.getStats(),
    clientAdapterPacks: clientAdapterPacks.getStats(),
    sawtoothContext: {
      activeSessionCount,
      totalHistoryEntries,
      checkpointedSessions,
      checkpointThreshold: config.SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS
    },
    stablePrefix: stablePrefixService.getStats(),
    toolPrefixCache: yarnToolPrefixCache ? yarnToolPrefixCache.getStats() : { enabled: false },
    artifactRetrieval: artifactRetrieval.getStats(),
    knowledgeSearch: knowledgeSearch.getStats(),
    evidencePrefetch: getEvidencePrefetchStats(),
    patternPrefetch: getPatternPrefetchStats(),
    patternFeedback: getPatternFeedbackStats(),
    artifactStore: artifactStore.getStats(),
    circuitBreakers: circuitBreakers.getStats(),
    userRateLimiter: userRateLimiter.getStats(),
    distributedCounters: distributedCounters.getStats(),
    streamAdmission: streamAdmission.getStats(),
    attentionPositioning: attentionPositioning.getStats(),
    compressionEfficiencyIndex: computeEfficiencyIndex(),
    recall: toolResultReduction.getRecallStats(),
    verification: toolResultReduction.getVerificationStats(),
    languagePacks: getLanguagePackRegistry().getConformanceMatrix(),
    sessionContinuity: sessionContinuity.getStats(),
    conversationMemory: usageWriter.getConversationMemoryStats(),
    workerPool: enrichmentPool.getStats(),
    sensemaking: sensemakingStats,
    eventLoopLag: getEventLoopStats(),
    promptLibrary: {
      loaded: Boolean(promptSnapshotRegistry),
      service: promptSnapshotRegistry?.service ?? "yarn",
      profiles: promptSnapshotRegistry?.profiles.length ?? 0,
      assignments: promptSnapshotRegistry?.assignments.length ?? 0,
      profileHashes: (promptSnapshotRegistry?.profiles ?? []).map((p) => p.content_hash).slice(0, 12),
      updatedAt: promptSnapshotRegistry?.updated_at ?? null,
    },
    connectionPools: {
      auth: authResolver.getPoolStats(),
      usageWriter: usageWriter.getPoolStats(),
    },
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    diagnosticRingMax: DIAGNOSTIC_RING_MAX,
    diagnosticRingCurrent: diagnosticRing.length,
    featureFlags: {
      toolBlobRedis: Boolean(toolBlobTier),
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
    }
  };
});

app.get("/metrics", async (_req, reply) => {
  reply.header("Content-Type", promRegistry.contentType);
  return promRegistry.metrics();
});

app.get("/v1/diagnostics/recent", async (req, reply) => {
  if (!requireInternalToken(req as never)) {
    return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
  }
  if (diagnosticRing.length > 0) {
    return { diagnostics: [...diagnosticRing], count: diagnosticRing.length, source: "memory" };
  }
  const recentIds = await diagnosticStore.listRecentDiagnostics(DIAGNOSTIC_RING_MAX);
  if (recentIds.length === 0) {
    return { diagnostics: [], count: 0, source: "redis_empty" };
  }
  const redisDiags: RequestDiagnostic[] = [];
  for (const id of recentIds) {
    const d = await diagnosticStore.getDiagnostic(id);
    if (d) redisDiags.push(d as unknown as RequestDiagnostic);
  }
  return { diagnostics: redisDiags, count: redisDiags.length, source: "redis" };
});

app.get("/v1/diagnostics/:requestId", async (req, reply) => {
  if (!requireInternalToken(req as never)) {
    return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
  }
  const { requestId } = req.params as { requestId: string };
  const inMemory = diagnosticRing.find((d) => d.requestId === requestId);
  if (inMemory) return inMemory;
  const persisted = await diagnosticStore.getDiagnostic(requestId);
  if (persisted) return persisted;
  return reply.code(404).send({ error: { type: "not_found", message: "Diagnostic not found" } });
});

app.get("/v1", async () => ({
  status: "ok",
  service: "synesis-yarn-ts",
  version: "0.2.0",
  endpoints: ["/v1/models", "/v1/models/{model}", "/v1/chat/completions", "/v1/responses", "/v1/messages"]
}));

app.get("/v1/models", async () => ({
  object: "list",
  data: tierRegistry.getAvailableModels()
}));

app.get("/v1/models/:model", async (req, reply) => {
  const { model } = req.params as { model: string };
  const found = tierRegistry.getAvailableModels().find((entry) => entry.id === model);
  if (!found) {
    return reply.code(404).send({ error: { type: "invalid_request_error", message: `Model '${model}' was not found.` } });
  }
  return found;
});

app.post("/v1/responses", async (req, reply) => {
  const responseReqId = resolveRequestId(req.headers as Record<string, unknown>);
  const normalizedIngress = normalizeToolDescriptions(req.body, "responses", "/v1/responses");
  for (const truncation of normalizedIngress.truncations) {
    app.log.warn({ reqId: responseReqId, ...truncation }, "tool_description_truncated");
  }
  const parsed = OpenAIResponsesRequestSchema.safeParse(normalizedIngress.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: { type: "invalid_request_error", message: formatValidationError(parsed.error) } });
  }
  const responseRequest = parsed.data;
  const chatRequest = responsesRequestToChatCompletion(responseRequest);
  const injected = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: selectedOpenAiCompatHeaders(req.headers as Record<string, unknown>),
    payload: JSON.stringify({ ...chatRequest, stream: false }),
  });

  let chatPayload: Record<string, unknown>;
  try {
    chatPayload = JSON.parse(injected.body) as Record<string, unknown>;
  } catch {
    chatPayload = {
      error: {
        type: "api_error",
        message: injected.body || "Unable to parse upstream chat completion response.",
      },
    };
  }
  if (injected.statusCode >= 400) {
    return reply.code(injected.statusCode).send(chatPayload);
  }

  const response = chatCompletionToResponseObject(chatPayload, responseRequest);
  if (!responseRequest.stream) {
    return reply.send(response);
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  for (const evt of responseObjectToSseEvents(response)) {
    if (!safeWrite(reply.raw, `event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`)) break;
  }
  safeWrite(reply.raw, "data: [DONE]\n\n");
  safeEnd(reply.raw);
  return reply;
});

app.get("/v1/claude/bootstrap", async (req, reply) => {
  let authUser: import("./auth.js").AuthUser;
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
  const fgaResult = await fgaCheck(`user:${authUser.userId}`, "can_invoke", "yarn_endpoint", "messages");
  if (!fgaResult.allowed) {
    return reply.code(403).send({ error: { type: "authz_error", message: "Authorization denied by policy" } });
  }
  const rateResult = await userRateLimiter.check(authUser.userId);
  if (!rateResult.allowed) {
    reply.header("Retry-After", String(rateResult.retryAfterSeconds));
    return reply.code(429).send({ error: { type: "rate_limit_error", message: `Rate limit exceeded. Retry after ${rateResult.retryAfterSeconds} seconds.` } });
  }

  const parsedQuery = ClaudeBootstrapQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return reply.code(400).send({ error: { type: "invalid_request_error", message: parsedQuery.error.message } });
  }
  const query: ClaudeBootstrapQuery = parsedQuery.data;
  const template = buildClaudeBootstrapTemplate(query.preset);
  return {
    object: "claude_bootstrap",
    template,
  };
});

app.get("/v1/claude/model-resolution", async (req, reply) => {
  let authUser: import("./auth.js").AuthUser;
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
  const fgaResult = await fgaCheck(`user:${authUser.userId}`, "can_invoke", "yarn_endpoint", "messages");
  if (!fgaResult.allowed) {
    return reply.code(403).send({ error: { type: "authz_error", message: "Authorization denied by policy" } });
  }
  const rateResult = await userRateLimiter.check(authUser.userId);
  if (!rateResult.allowed) {
    reply.header("Retry-After", String(rateResult.retryAfterSeconds));
    return reply.code(429).send({ error: { type: "rate_limit_error", message: `Rate limit exceeded. Retry after ${rateResult.retryAfterSeconds} seconds.` } });
  }

  const parsedQuery = ClaudeModelResolutionQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return reply.code(400).send({ error: { type: "invalid_request_error", message: parsedQuery.error.message } });
  }
  const query: ClaudeModelResolutionQuery = parsedQuery.data;
  try {
    return {
      object: "claude_model_resolution",
      resolution: resolveClaudeModelSelection(query.model, config.SYNESIS_YARN_CLAUDE_TIER_MAP),
      available_models: tierRegistry.getAvailableModels().map((m) => m.id),
    };
  } catch (err) {
    app.log.error({ err, path: "/v1/claude/model-resolution" }, "claude model-resolution handler failed");
    return reply.code(500).send({
      error: {
        type: "internal_error",
        message: err instanceof Error ? err.message : "Model resolution failed",
      },
    });
  }
});

app.post("/v1/claude/commands/execute", async (req, reply) => {
  let authUser: import("./auth.js").AuthUser;
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
  const fgaResult = await fgaCheck(`user:${authUser.userId}`, "can_invoke", "yarn_endpoint", "messages");
  if (!fgaResult.allowed) {
    return reply.code(403).send({ error: { type: "authz_error", message: "Authorization denied by policy" } });
  }
  const rateResult = await userRateLimiter.check(authUser.userId);
  if (!rateResult.allowed) {
    reply.header("Retry-After", String(rateResult.retryAfterSeconds));
    return reply.code(429).send({ error: { type: "rate_limit_error", message: `Rate limit exceeded. Retry after ${rateResult.retryAfterSeconds} seconds.` } });
  }

  const parsedBody = ClaudeCommandExecuteRequestSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return reply.code(400).send({ error: { type: "invalid_request_error", message: parsedBody.error.message } });
  }
  const body: ClaudeCommandExecuteRequest = parsedBody.data;

  const clientKind = String((req.headers["x-synesis-client"] as string | undefined) ?? "claude-code");
  const conversationId = (body.conversation_id ?? body.session_id ?? "").trim();
  const identity: SessionIdentity = {
    userId: authUser.userId,
    orgId: authUser.orgId,
    conversationId,
    clientKind,
    displayName: authUser.displayName,
  };
  const sessionKey = await getSessionKey(identity);

  try {
    if (body.command.trim().toLowerCase() === "compact") {
      const state = await getSessionState(sessionKey, identity);
      const compacted = await forceCheckpoint(state);
      await casSessionSave(state);
      recordSessionEvent(
        state.record.sessionKey,
        state.record.userId,
        state.record.orgId,
        "compat_command_compact",
        "claude-command-api",
        compacted
          ? "Manual compaction requested via /v1/claude/commands/execute (compacting)"
          : "Manual compaction requested via /v1/claude/commands/execute (no-op)",
      );
    }

    const result = executeClaudeCompatCommand({
      tierMap: config.SYNESIS_YARN_CLAUDE_TIER_MAP,
      availableModels: tierRegistry.getAvailableModels().map((m) => m.id),
      command: body.command,
      model: body.model,
      conversationId,
      sessionKey,
    });
    return {
      object: "claude_command_result",
      ...result,
    };
  } catch (err) {
    app.log.error({ err, path: "/v1/claude/commands/execute" }, "claude command execute failed");
    return reply.code(500).send({
      error: {
        type: "internal_error",
        message: err instanceof Error ? err.message : "Claude command failed",
      },
    });
  }
});

app.get("/v1/adapter-packs", async () => ({
  catalog: clientAdapterPacks.getCatalog()
}));

app.get("/v1/user-runtime-preferences/:userId", async (req, reply) => {
  if (!requireInternalToken(req as never)) {
    return reply.code(401).send({ error: { type: "auth_error", message: "Internal service token required" } });
  }
  const { userId } = req.params as { userId: string };
  const preferences = await loadUserRuntimePreferences(userId);
  return userRuntimePreferencesResponse(preferences);
});

app.put("/v1/user-runtime-preferences/:userId", async (req, reply) => {
  if (!requireInternalToken(req as never)) {
    return reply.code(401).send({ error: { type: "auth_error", message: "Internal service token required" } });
  }
  const { userId } = req.params as { userId: string };
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const preferences = normalizeUserRuntimePreferences({ ...body, updatedAt: Date.now() });
  await sessionStore.saveUserRuntimePreferences(
    userId,
    preferences,
    config.SYNESIS_YARN_USER_RUNTIME_PREFERENCES_TTL_MS,
  );
  return userRuntimePreferencesResponse(preferences);
});

app.get("/v1/artifacts/:id", async (req, reply) => {
  if (!requireInternalToken(req as never)) {
    return reply.code(401).send({
      error: { type: "auth_error", message: "Internal service token required" },
    });
  }
  const id = (req.params as { id: string }).id;
  const artifact = artifactStore.get(id);
  if (!artifact) {
    return reply.code(404).send({ error: { type: "not_found", message: "Artifact not found" } });
  }
  return artifact;
});

// --- Native MCP tools (replaces Python MCP proxy) ---
getToolRegistry().setTimeoutMs(config.SYNESIS_YARN_MCP_TOOL_TIMEOUT_MS);
await registerMcpRoutes(app, {
  authResolver,
  enabled: config.SYNESIS_YARN_MCP_TOOLS_ENABLED,
  openClawProfileEnabled: config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED,
  openClawMcpAllowlistEnabled: config.SYNESIS_YARN_OPENCLAW_MCP_ALLOWLIST_ENABLED,
  openClawStrictGovernanceEnabled: config.SYNESIS_YARN_OPENCLAW_STRICT_GOVERNANCE_ENABLED,
  synesisMcpDeps: {
    plannerBaseUrl: config.SYNESIS_YARN_PLANNER_URL,
    internalServiceToken: config.SYNESIS_INTERNAL_SERVICE_TOKEN,
  },
});
await registerToolCollapseRoutes(app, {
  authResolver,
  config,
  dedupeLayer: yarnDedupeLayer,
  toolPrefixCache: yarnToolPrefixCache,
});

// --- Eval Gym routes ---
registerEvalRoutes(app, config, { requireInternalToken });
if (config.SYNESIS_YARN_EVAL_OBSERVER_ENABLED) {
  enableEvalObserver();
  console.log("[eval-observer] Session observer enabled via env");
}

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
  let authUser: import("./auth.js").AuthUser;
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
    session,
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

  let oaiPrefetchResult: import("./evidence/fast-path.js").FastPathResult | undefined;
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

  let oaiPatternResult: import("./evidence/fast-path.js").PatternPrefetchResult | undefined;
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
    persistSessionAndUsage,
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
      persistSessionAndUsage,
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
        persistSessionAndUsage,
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
    adapter,
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
    recordSessionEvent: (eventKind, component, detail) =>
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, eventKind, component, detail, oaiTraceReqId),
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
    recordSessionEvent: (eventKind, component, detail, metadataJson) =>
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, eventKind, component, detail, reqId, metadataJson),
    applyEditContextMissReadGate,
    findPreferredReadToolName,
    ensureReadToolAvailability: ensureReadToolAvailabilityForEditMissGuard,
  });
  const oaiPhasePolicy = oaiPhaseApplication.phasePolicy;
  const oaiPhaseFiltered = oaiPhaseApplication.phaseFiltered;
  effectiveTools = oaiPhaseApplication.effectiveTools;
  let effectiveToolChoice = oaiPhaseApplication.effectiveToolChoice;
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
    recordSessionEvent: (eventKind, component, detail) =>
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, eventKind, component, detail, oaiTraceReqId),
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
    recordSessionEvent: (eventKind, component, detail, metadataJson) =>
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, eventKind, component, detail, reqId, metadataJson),
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
      state: session,
      resolvedModelId: resolved.resolvedModelId,
      clientRequestedModel: request.model,
      recordSessionEvent,
      persistDecisionTelemetry: (telemetry) => persistAndEmitDecisionTelemetry({
        ...telemetry,
        optimizationLedger: telemetry.optimizationLedger as OptimizationLedgerSnapshot,
      }),
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
      persistDecisionTelemetry: ({ finishReason, telemetry }) => persistAndEmitDecisionTelemetry({
        state: session,
        requestId: reqId,
        resolvedModelId: resolved.resolvedModelId,
        usage: telemetry.usage,
        latencyMs: telemetry.latencyMs,
        finishReason,
        tokensSavedByReduction: telemetry.tokensSavedByReduction,
        escalated: orchestration.escalated,
        snapshot: telemetry.snapshot,
        trajectory: telemetry.trajectory,
        sessionKey,
        userId: identity.userId,
        orgId: identity.orgId,
        optimizationLedger: telemetry.optimizationLedger as OptimizationLedgerSnapshot,
        clientRequestedModel: request.model,
      }),
      logOptimizationLedger: (record) => app.log.info({ reqId, ...record }, "optimization_ledger"),
    },
  });
  return sendOpenAIChatPipelineResult(reply, streamResult);
});

// --- Claude Messages API ---
app.post("/v1/messages", async (req, reply) => {
  let claudeAuthUser: import("./auth.js").AuthUser;
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

  let claudePrefetchResult: import("./evidence/fast-path.js").FastPathResult | undefined;
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

  let claudePatternResult: import("./evidence/fast-path.js").PatternPrefetchResult | undefined;
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
    persistSessionAndUsage,
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
      persistSessionAndUsage,
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
        persistSessionAndUsage,
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
    recordSessionEvent: (eventKind, component, detail) =>
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, eventKind, component, detail, traceReqId),
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
    recordSessionEvent: (eventKind, component, detail) =>
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, eventKind, component, detail, traceReqId),
  }).modelMessages as typeof claudeModelMessages;

  claudeModelMessages = normalizeSystemMessageOrdering(claudeModelMessages as Array<{ role: string }>) as typeof claudeModelMessages;

  const resolvedClaudeTierConfig = tierRegistry.getTierConfig(resolved.resolvedModelId);
  const claudeTierSamplingDefaults = resolvedClaudeTierConfig?.samplingDefaults;
  const adapterClaudeProviderOptions = claudeAdapter.providerOptions?.();
  const claudeEffectiveMinP = body.min_p ?? claudeTierSamplingDefaults?.min_p;
  const claudeEffectiveRepetitionPenalty =
    body.repetition_penalty ?? claudeTierSamplingDefaults?.repetition_penalty;
  const claudeEffectiveEnableThinking =
    body.enable_thinking ?? claudeTierSamplingDefaults?.enable_thinking;
  const claudeEffectiveReasoningEffort =
    body.reasoning_effort ?? claudeTierSamplingDefaults?.reasoning_effort;
  const claudeProviderOpenAiOverrides = {
    ...(body.thinking !== undefined ? { thinking: body.thinking } : {}),
    ...(claudeEffectiveMinP !== undefined ? { min_p: claudeEffectiveMinP } : {}),
    ...(claudeEffectiveRepetitionPenalty !== undefined
      ? { repetition_penalty: claudeEffectiveRepetitionPenalty }
      : {}),
    ...(claudeEffectiveEnableThinking !== undefined
      ? { enable_thinking: claudeEffectiveEnableThinking }
      : {}),
    ...(claudeEffectiveReasoningEffort !== undefined
      ? { reasoning_effort: claudeEffectiveReasoningEffort }
      : {}),
  };
  let providerOptions = Object.keys(claudeProviderOpenAiOverrides).length
    ? {
        ...(adapterClaudeProviderOptions ?? {}),
        openai: {
          ...((adapterClaudeProviderOptions?.openai ?? {}) as Record<string, unknown>),
          ...claudeProviderOpenAiOverrides,
        },
      }
    : adapterClaudeProviderOptions;
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
    recordSessionEvent: (eventKind, component, detail, metadataJson) =>
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, eventKind, component, detail, traceReqId, metadataJson),
    applyEditContextMissReadGate,
    findPreferredReadToolName,
    ensureReadToolAvailability: ensureReadToolAvailabilityForEditMissGuard,
  });
  const claudePhasePolicy = claudePhaseApplication.phasePolicy;
  const claudePhaseFiltered = claudePhaseApplication.phaseFiltered;
  effectiveClaudeTools = claudePhaseApplication.effectiveTools;
  let effectiveClaudeToolChoice = claudePhaseApplication.effectiveToolChoice;
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
  const claudeAdapterSampling = claudeAdapter.defaultSamplingParams?.();
  const claudeSupportsTopK = claudeAdapter.family !== "minimax";
  const claudeEffectiveTemp =
    body.temperature ?? claudeTierSamplingDefaults?.temperature ?? claudeAdapterSampling?.temperature;
  const claudeEffectiveTopP =
    body.top_p ?? claudeTierSamplingDefaults?.top_p ?? claudeAdapterSampling?.top_p;
  const claudeEffectiveTopK = claudeSupportsTopK ? (body.top_k ?? claudeTierSamplingDefaults?.top_k) : undefined;
  const claudeEffectivePresencePenalty =
    body.presence_penalty ?? claudeTierSamplingDefaults?.presence_penalty;
  const claudeSamplingOptions = {
    ...(claudeEffectiveTemp !== undefined ? { temperature: claudeEffectiveTemp } : {}),
    ...(claudeEffectiveTopP !== undefined ? { topP: claudeEffectiveTopP } : {}),
    ...(claudeEffectiveTopK !== undefined ? { topK: Math.max(0, Math.trunc(claudeEffectiveTopK)) } : {}),
    ...(claudeEffectivePresencePenalty !== undefined
      ? { presencePenalty: claudeEffectivePresencePenalty }
      : {}),
  };
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
    recordSessionEvent: (eventKind, component, detail, metadataJson) =>
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, eventKind, component, detail, traceReqId, metadataJson),
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

  if (body.stream) {
    if (claudeNativeWebSearchRequested || claudeForceNonStreamKickoff) {
      const started = Date.now();
      let currentMessages = claudeModelMessages;
      const serverEvents: ClaudeServerWebSearchEvent[] = [];
      let streamedResult: Awaited<ReturnType<typeof generateText>> | null = null;
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
      for (let round = 0; round < 3; round++) {
        streamedResult = await generateText(buildAiSdkTextRequestOptions({
          model: resolved.model,
          messages: currentMessages,
          maxOutputTokens: clampMaxOutputTokensForSafety(Math.max(claudeOrchestration.maxOutputTokens, body.max_tokens ?? 0)),
          samplingOptions: claudeSamplingOptions,
          stopSequences: sdkStop,
          tools: sdkTools,
          toolChoice: effectiveClaudeToolChoice,
          providerOptions,
        }) as never);

        let allCalls = (streamedResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
        if (claudeForceNonStreamKickoff && round === 0 && claudePhasePolicy.toolChoice === "required") {
          let validation = validateRequiredToolCalls(allCalls, claudePhasePolicy);
          if (!validation.valid) {
            recordSessionEvent(
              claudeSessionKey,
              claudeIdentity.userId,
              claudeIdentity.orgId,
              "phase_required_validation_retry",
              "execution-governor",
              `reasons=${validation.reasons.join(",") || "unknown"}`,
              traceReqId,
            );
            currentMessages = appendSystemMessageAndNormalize(
              currentMessages as Array<{ role: string; content?: unknown }>,
              buildRequiredRepairPrompt(claudeGovernorPhase, claudePhasePolicy.allowedCanonicalTools),
            ) as typeof currentMessages;
            streamedResult = await generateText(buildAiSdkTextRequestOptions({
              model: resolved.model,
              messages: currentMessages,
              maxOutputTokens: clampMaxOutputTokensForSafety(Math.max(claudeOrchestration.maxOutputTokens, body.max_tokens ?? 0)),
              samplingOptions: claudeSamplingOptions,
              stopSequences: sdkStop,
              tools: sdkTools,
              toolChoice: effectiveClaudeToolChoice,
              providerOptions,
            }) as never);
            allCalls = (streamedResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
            validation = validateRequiredToolCalls(allCalls, claudePhasePolicy);
            if (!validation.valid) {
              recordSessionEvent(
                claudeSessionKey,
                claudeIdentity.userId,
                claudeIdentity.orgId,
                "phase_required_validation_fallback",
                "execution-governor",
                `fallback_after_retry reasons=${validation.reasons.join(",") || "unknown"}`,
                traceReqId,
              );
              effectiveClaudeToolChoice = "auto";
              currentMessages = appendSystemMessageAndNormalize(
                currentMessages as Array<{ role: string; content?: unknown }>,
                "Phase execution policy fallback: required tool-call contract failed after retry. Continue with tool_choice=auto and recover safely.",
              ) as typeof currentMessages;
              streamedResult = await generateText(buildAiSdkTextRequestOptions({
                model: resolved.model,
                messages: currentMessages,
                maxOutputTokens: clampMaxOutputTokensForSafety(Math.max(claudeOrchestration.maxOutputTokens, body.max_tokens ?? 0)),
                samplingOptions: claudeSamplingOptions,
                stopSequences: sdkStop,
                tools: sdkTools,
                toolChoice: effectiveClaudeToolChoice,
                providerOptions,
              }) as never);
              allCalls = (streamedResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
            }
          }
        }
        const serverCalls = claudeNativeWebSearchRequested
          ? allCalls.filter((tc) => isClaudeWebSearchToolName(tc.toolName))
          : [];
        if (serverCalls.length === 0) break;

        const assistantParts: Array<
          { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
        > = [];
        if (streamedResult.text) assistantParts.push({ type: "text", text: streamedResult.text });
        const toolResults: Array<{
          type: "tool-result";
          toolCallId: string;
          toolName: string;
          output: { type: "text"; value: string };
        }> = [];

        for (const call of serverCalls) {
          const input = isObjectRecord(call.input) ? call.input : {};
          const searchOutput = await webSearch.resolve(
            input,
            webSearchResolveContext(claudeAuthUser, req, {
              requestId: reqId,
              sessionKey: claudeSessionKey,
              conversationId: session.record.conversationId || undefined,
              traceId: reqId,
              sourceSurface: "yarn_chat",
              toolName: "web_search",
            }),
          );
          const payload = isObjectRecord(searchOutput) ? searchOutput : { error: "invalid_server_tool_payload" };
          serverEvents.push(toClaudeServerWebSearchEvent(call.toolCallId, call.toolName, input, payload));
          assistantParts.push({
            type: "tool-call",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input,
          });
          toolResults.push({
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: "text", value: JSON.stringify(payload) },
          });
        }

        if (assistantParts.length === 0) assistantParts.push({ type: "text", text: "" });
        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: assistantParts } as never,
          { role: "tool", content: toolResults } as never,
        ];
      }

      const claudeNonStreamForensics = captureRequestForensics(
        claudeSessionKey,
        reqId,
        "/v1/messages",
        resolved.resolvedModelId,
        false,
        currentMessages as Array<{ role: string; content: unknown }>,
        effectiveClaudeTools as unknown[],
        effectiveClaudeToolChoice,
        providerOptions,
        claudeForensicsPhasePolicy,
        claudeForensicsCapabilityMatrix,
      );
      const finalResult = streamedResult ?? await generateText(buildAiSdkTextRequestOptions({
        model: resolved.model,
        messages: currentMessages,
        maxOutputTokens: clampMaxOutputTokensForSafety(Math.max(claudeOrchestration.maxOutputTokens, body.max_tokens ?? 0)),
        samplingOptions: claudeSamplingOptions,
        stopSequences: sdkStop,
        tools: sdkTools,
        toolChoice: effectiveClaudeToolChoice,
        providerOptions,
      }) as never);

      const usage = readUsage((finalResult as unknown as { usage?: unknown }).usage);
      const claudeNonStreamForensicsDone = finalizeRequestForensics(session, reqId, claudeNonStreamForensics, usage);
      const msgId = `msg_${crypto.randomUUID()}`;
      let idx = 0;
      let stopReason = "end_turn";
      const finalText = finalResult.text ?? "";
      const finalCalls = (finalResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
      const externalCalls = finalCalls.filter((tc) => !isClaudeWebSearchToolName(tc.toolName));
      if (externalCalls.length > 0) stopReason = "tool_use";

      reply.raw.writeHead(200, sseHeadersWithClarification(session.record.metadata));
      safeSse(reply, "message_start", {
        type: "message_start",
        message: { id: msgId, type: "message", role: "assistant", model: resolved.resolvedModelId, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
      });

      for (const evt of serverEvents) {
        safeSse(reply, "content_block_start", {
          type: "content_block_start",
          index: idx,
          content_block: { type: "server_tool_use", id: evt.toolUseId, name: evt.toolName, input: evt.input },
        });
        safeSse(reply, "content_block_stop", { type: "content_block_stop", index: idx });
        idx += 1;
        safeSse(reply, "content_block_start", {
          type: "content_block_start",
          index: idx,
          content_block: evt.errorCode
            ? {
                type: "web_search_tool_result",
                tool_use_id: evt.toolUseId,
                content: { type: "web_search_tool_result_error", error_code: evt.errorCode },
              }
            : { type: "web_search_tool_result", tool_use_id: evt.toolUseId, content: evt.results },
        });
        safeSse(reply, "content_block_stop", { type: "content_block_stop", index: idx });
        idx += 1;
      }

      if (finalText) {
        safeSse(reply, "content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
        safeSse(reply, "content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: finalText } });
        safeSse(reply, "content_block_stop", { type: "content_block_stop", index: idx });
        idx += 1;
        session.history.push({ role: "assistant", content: finalText });
      }

      for (const call of externalCalls) {
        safeSse(reply, "content_block_start", {
          type: "content_block_start",
          index: idx,
          content_block: { type: "tool_use", id: call.toolCallId, name: call.toolName },
        });
        safeSse(reply, "content_block_delta", {
          type: "content_block_delta",
          index: idx,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input ?? {}) },
        });
        safeSse(reply, "content_block_stop", { type: "content_block_stop", index: idx });
        idx += 1;
      }

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
      persistAndEmitDecisionTelemetry({
        state: session,
        requestId: reqId,
        resolvedModelId: resolved.resolvedModelId,
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
        sessionKey: claudeSessionKey,
        userId: claudeIdentity.userId,
        orgId: claudeIdentity.orgId,
        clientRequestedModel: body.model,
      });

      safeSse(reply, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
      });
      safeSse(reply, "message_stop", { type: "message_stop" });
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
      });
      safeEnd(reply.raw);
      return reply;
    }

    const claudeAdmission = await streamAdmission.acquire();
    const claudeStreamGateScope = {
      sessionKey: claudeSessionKey,
      userId: claudeIdentity.userId,
      orgId: claudeIdentity.orgId,
      requestId: traceReqId,
    };
    const claudeAdmissionRejection = buildStreamAdmissionRejection({
      admission: claudeAdmission,
      queueStats: streamAdmission.getStats(),
      logMessage: "stream_admission_rejected_claude",
      scope: claudeStreamGateScope,
      logger: app.log,
      recordSessionEvent,
      payload: { type: "error", error: { type: "overloaded_error", message: "Server at capacity. Try again shortly." } },
    });
    if (claudeAdmissionRejection) {
      reply.header("Retry-After", claudeAdmissionRejection.retryAfter);
      return reply.code(claudeAdmissionRejection.statusCode).send(claudeAdmissionRejection.payload);
    }

    const claudeBreakerRejection = buildStreamCircuitBreakerRejection({
      allowed: circuitBreakers.allowRequest(resolved.resolvedModelId, claudeIdentity.orgId),
      admission: claudeAdmission,
      model: resolved.resolvedModelId,
      orgId: claudeIdentity.orgId,
      detail: `Circuit breaker open for ${resolved.resolvedModelId} (claude stream)`,
      logMessage: "circuit_breaker_open_claude_stream",
      scope: claudeStreamGateScope,
      logger: app.log,
      recordSessionEvent,
      payload: { type: "error", error: { type: "overloaded_error", message: "Model provider temporarily unavailable. Try again shortly." } },
    });
    if (claudeBreakerRejection) {
      reply.header("Retry-After", claudeBreakerRejection.retryAfter);
      return reply.code(claudeBreakerRejection.statusCode).send(claudeBreakerRejection.payload);
    }
    const claudeStreamSpan = getTracer().startSpan("yarn.claude.stream", { model: resolved.resolvedModelId, sessionKey: claudeSessionKey });
    const started = Date.now();
    const claudeStreamScopeBundle = createStreamRouteScopeBundle(claudeStreamGateScope, recordSessionEvent);
    const claudeStreamScope = claudeStreamScopeBundle.scope;
    const claudeStreamForensics = captureStreamRequestForensics({
      scope: claudeStreamScope,
      path: "/v1/messages (stream)",
      resolvedModelId: resolved.resolvedModelId,
      messages: claudeModelMessages as Array<{ role: string; content: unknown }>,
      tools: effectiveClaudeTools as unknown[],
      toolChoice: effectiveClaudeToolChoice,
      providerOptions,
      phasePolicy: claudeForensicsPhasePolicy,
      capabilityMatrix: claudeForensicsCapabilityMatrix,
      capture: captureRequestForensics,
    });
    const claudeResponseScope = {
      ...claudeStreamScope,
      requestId: reqId,
    };
    const recordClaudeStreamEvent = claudeStreamScopeBundle.recordEvent;
    const claudeStreamToolSideEffects = createRouteToolCallSideEffects({
      session,
      sessionKey: claudeSessionKey,
      userId: claudeIdentity.userId,
      orgId: claudeIdentity.orgId,
      requestId: traceReqId,
      clientKind: claudeClientKind,
      upperHarnessComponent: "upper-harness:claude-stream",
      logger: app.log as never,
      strictGovernanceStats: openClawProfileStats,
      updateDiffAccumulator,
      maybeUpdateTaskLedgerFromToolCall,
      emitPlanWriteAuditEvent,
      maybeLogEnvelopeUnwrapSample,
      recordUpperHarnessDecision,
    });
    const claudeStreamAbortRuntime = createStreamAbortRuntime({
      protocolLabel: "Claude",
      model: resolved.resolvedModelId,
      startedAtMs: started,
      longWaitEventMs: config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS,
      hardTimeoutMs: config.SYNESIS_YARN_SSE_STREAM_HARD_TIMEOUT_MS,
      recordSessionEvent: recordClaudeStreamEvent,
    });
    const claudeStreamProviderRequest = prepareClaudeStreamProviderRequest({
      requestId: traceReqId,
      model: resolved.model,
      messages: claudeModelMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }>,
      adapter: claudeAdapter,
      abortSignal: claudeStreamAbortRuntime.abortController.signal,
      orchestrationMaxOutputTokens: claudeOrchestration.maxOutputTokens,
      requestMaxTokens: body.max_tokens,
      samplingOptions: claudeSamplingOptions,
      stopSequences: sdkStop,
      tools: sdkTools,
      toolChoice: effectiveClaudeToolChoice,
      providerOptions,
      clampMaxOutputTokens: clampMaxOutputTokensForSafety,
      logger: app.log,
      recordSessionEvent: recordClaudeStreamEvent,
    });
    claudeModelMessages = claudeStreamProviderRequest.messages as typeof claudeModelMessages;
    const streamed = streamText(claudeStreamProviderRequest.options as never);
    const claudeRuntime = startClaudeStreamRouteRuntime({
      raw: reply.raw,
      headers: sseHeadersWithClarification(session.record.metadata),
      model: resolved.resolvedModelId,
      heartbeatIntervalMs: config.SYNESIS_YARN_SSE_HEARTBEAT_INTERVAL_MS,
      longWaitEventMs: config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS,
      startHeartbeat: startSseHeartbeat,
      ...claudeStreamScope,
      createMessageId: () => `msg_${crypto.randomUUID()}`,
      sendSse: (event, data) => safeSse(reply, event, data),
      recordSessionEvent,
    });
    const claudeHeartbeat = claudeRuntime.heartbeat;

    const resolvedTier = tierRegistry.getTierConfig(resolved.resolvedModelId);
    const claudeStreamComponents = createClaudeStreamRouteComponents({
      modelMessages: claudeModelMessages as Array<{ role: string; content: unknown }>,
      tierConfig: resolvedTier,
      resolvedModelId: resolved.resolvedModelId,
      ...claudeStreamScope,
      computePrefixFingerprint,
      sendSse: (event, data) => safeSse(reply, event, data),
      recordSessionEvent,
    });
    const claudeStreamState = claudeStreamComponents.streamState;
    const claudeStreamGate = claudeStreamComponents.gate;
    const claudeStreamDiscovery = claudeStreamComponents.discovery;
    const claudeStreamGuardrailAccepted = claudeStreamComponents.guardrailAccepted;
    const claudeStreamBlockedDetails = claudeStreamComponents.blockedDetails;
    const claudeStreamToolSequence = claudeStreamComponents.toolSequence;
    const isLocalLikeBaseUrl = claudeStreamComponents.localLikeBaseUrl;
    const claudeCacheStrategy = claudeStreamComponents.cacheStrategy;
    const claudePrefixFingerprint = claudeStreamComponents.prefixFingerprint;
    const closeClaudeStreamingTextBlock = claudeStreamComponents.closeTextBlock;
    const scrubAndFlushClaudeTextBlock = claudeStreamComponents.scrubAndFlushTextBlock;
    const claudeStreamFinalization = createClaudeStreamFinalizationHandlers({
      session,
      pendingRequestId: traceReqId,
      historyRequestId: reqId,
      sessionKey: claudeSessionKey,
      userId: claudeIdentity.userId,
      orgId: claudeIdentity.orgId,
      checklist: claudeRequirementChecklist,
      traceRootPrompt: getMetadataString(session.record.metadata, "trace_root_prompt"),
      latestUserPrompt: getMetadataString(session.record.metadata, "latest_user_prompt"),
      verification: claudeVerificationAssessment,
      recentToolNames: extractRecentToolNames(openAIShape.messages as Array<{ role: string; content: unknown }>),
      planGraph: claudePlanGraph,
      responseStyleMode: config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
      applyMarkdownGuardrail,
      finalizeCompletionText,
      finalizePostStreamText,
    });
    const claudeStreamRouteHandlers = createClaudeStreamRouteEventHandlers({
      streamState: claudeStreamState,
      adapter: claudeAdapter,
      requestId: traceReqId,
      clientKind: claudeClientKind,
      debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
      strictGovernance: claudeOpenClawStrictGovernance,
      upperHarness: claudeUpperHarness,
      recentToolNames: claudeRecentCallsForSteering.map((call) => call.toolName),
      taskCue: claudeTaskCue,
      clientPlanModeRequested: claudeClientToolCapabilities.planModeRequested,
      sensemakingRestrictDiscovery: claudeSensemakingDecision?.shouldRestrictDiscovery,
      pathContext: effectiveClaudePathCtx,
      enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
      blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
      pathSandboxEnabled: config.SYNESIS_YARN_PATH_SANDBOX_ENABLED,
      artifactShadows: claudeArtifactShadows,
      normalizedMessageCount: (normalizedFromClaude.messages as Array<{ role: string }>).length,
      session,
      acceptedGuardrailCalls: claudeStreamGuardrailAccepted,
      blockedDiscoveryDetails: claudeStreamBlockedDetails,
      discovery: claudeStreamDiscovery,
      toolSequence: claudeStreamToolSequence,
      stats: toolArgHardeningStats,
      logger: app.log,
      sendSse: (eventName, data) => safeSse(reply, eventName, data),
      scrubAndFlushTextBlock: scrubAndFlushClaudeTextBlock,
      isWriteCapableToolName,
      shouldRestrictDiscoveryForPlanWork,
      deserializePlanShadow: deserializeShadow,
      buildPathSandboxPolicy: buildDefaultPolicy,
      ...claudeStreamToolSideEffects,
      recordRedirectedDiscovery: (count) => {
        recordBlockedDiscovery(claudeSessionKey, count);
      },
      getTopLevelDirs: getCachedTopLevelDirs,
      applyDiscoveryGuardrail: applyDiscoveryToolGuardrail,
      buildBlockedDiscoveryRecovery: (blockedDetails) => buildBlockedDiscoveryRecoverySnapshot(
        resolved.resolvedModelId,
        blockedDetails,
        effectiveClaudePathCtx.projectRoot,
      ),
    });
    const claudeStreamLifecycle = createClaudeStreamLifecycleHandlers({
      requestId: traceReqId,
      model: resolved.resolvedModelId,
      orgId: claudeIdentity.orgId,
      session,
      abortSignal: claudeStreamAbortRuntime.abortController.signal,
      hardTimeout: claudeStreamAbortRuntime.hardTimeout,
      admissionRelease: () => claudeAdmission.release!(),
      streamState: claudeStreamState,
      span: claudeStreamSpan,
      circuitBreakers,
      logger: app.log,
      extractUpstreamErrorDiagnostics,
      sendSse: (eventName, data) => safeSse(reply, eventName, data),
      recordSessionEvent: recordClaudeStreamEvent,
    });
    const claudeStreamAfterEvents = createClaudeStreamAfterEventsHandler({
      adapter: claudeAdapter,
      localLikeBaseUrl: isLocalLikeBaseUrl,
      requestId: traceReqId,
      resolvedModelId: resolved.resolvedModelId,
      baseUrl: resolvedTier?.baseUrl,
      sessionKey: claudeStreamScope.sessionKey,
      userId: claudeStreamScope.userId,
      orgId: claudeStreamScope.orgId,
      streamState: claudeStreamState,
      discovery: claudeStreamDiscovery,
      blockedDetails: claudeStreamBlockedDetails,
      stats: toolArgHardeningStats,
      logger: app.log,
      recordBlockedDiscovery,
      getBlockedDiscoveryCount,
      recordSessionEvent,
    });

    const claudeStreamingPipeline = await runClaudeStreamingPipeline({
      streamParts: streamed.fullStream,
      handleLocalEvent: claudeStreamRouteHandlers.handleLocalEvent,
      handleToolCall: claudeStreamRouteHandlers.handleToolCall,
      afterEvents: claudeStreamAfterEvents,
      onEventError: claudeStreamLifecycle.onEventError,
      finalizeLifecycle: claudeStreamLifecycle.finalizeLifecycle,
    });
    const stopReason = claudeStreamingPipeline.stopReason;

    const claudeStreamFinalized = await finalizeClaudeStreamCompletion(createClaudeStreamCompletionFinalizerInput({
      streamState: claudeStreamState,
      gate: claudeStreamGate,
      stopReason,
      streamed: {
        totalUsage: streamed.totalUsage as PromiseLike<unknown>,
        text: streamed.text,
      },
      session,
      ...claudeResponseScope,
      readUsage,
      finalizeRequestForensics: (usage) => finalizeRequestForensics(session, reqId, claudeStreamForensics, usage),
      handlers: claudeStreamFinalization,
      writeFinalText: scrubAndFlushClaudeTextBlock,
      closeTextBlock: closeClaudeStreamingTextBlock,
      sendSse: (eventName, data) => safeSse(reply, eventName, data),
      endStream: () => safeEnd(reply.raw),
      stopHeartbeat: () => claudeHeartbeat.stop(),
      recordSessionEvent,
    }));
    runClaudeStreamTelemetry(createClaudeStreamTelemetryInput({
      ...createStreamTelemetryRouteBase({
        scope: claudeResponseScope,
        startedAtMs: started,
        resolvedModelId: resolved.resolvedModelId,
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
        requirementChecklistMust: claudeRequirementChecklist?.must.length || undefined,
        requirementChecklistShould: claudeRequirementChecklist?.should.length || undefined,
        contextAdmission: claudeContextAdmission,
        cacheStrategy: claudeCacheStrategy !== "none" ? claudeCacheStrategy : undefined,
        prefixFingerprint: claudePrefixFingerprint,
        countMessageRoles,
        pushDiagnostic: (diagnostic) => pushDiagnostic(diagnostic as unknown as RequestDiagnostic),
      }),
      finishReason: stopReason,
      usage: claudeStreamFinalized.usage,
      toolNames: claudeStreamToolSequence,
      gate: claudeStreamGate,
      requestForensicsDone: claudeStreamFinalized.requestForensicsDone,
      session,
      recordSessionEvent,
      persistDecisionTelemetry: persistAndEmitDecisionTelemetry,
    }));
    return reply;
  }

  // Non-streaming
  if (!circuitBreakers.allowRequest(resolved.resolvedModelId, claudeIdentity.orgId)) {
    app.log.warn({ model: resolved.resolvedModelId, orgId: claudeIdentity.orgId }, "circuit_breaker_open_claude");
    recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "breaker_open_reject", "circuit-breaker",
      `Circuit breaker open for ${resolved.resolvedModelId} (claude)`, reqId, { model: resolved.resolvedModelId });
    reply.header("Retry-After", "30");
    return reply.code(503).send({ type: "error", error: { type: "overloaded_error", message: "Model provider temporarily unavailable. Try again shortly." } });
  }
  const claudeNonStreamSpan = getTracer().startSpan("yarn.claude.generate", { model: resolved.resolvedModelId, sessionKey: claudeSessionKey });
  const started = Date.now();
  const claudeNonStreamScope = createClaudeNonStreamRouteScope({
    sessionKey: claudeSessionKey,
    userId: claudeIdentity.userId,
    orgId: claudeIdentity.orgId,
    requestId: reqId,
    state: session,
    resolvedModelId: resolved.resolvedModelId,
    clientRequestedModel: body.model,
    recordSessionEvent,
    persistDecisionTelemetry: persistAndEmitDecisionTelemetry,
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
  let result: Awaited<ReturnType<typeof generateText>>;
  let claudeServerWebSearchEvents: ClaudeServerWebSearchEvent[];
  let lastClaudeNonStreamForensics: RequestForensicsRecord | undefined;
  try {
    const executed = await executeClaudeNonStreamProviderLoop(createClaudeNonStreamProviderExecutorInput({
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
    }));
    result = executed.result as Awaited<ReturnType<typeof generateText>>;
    claudeServerWebSearchEvents = executed.serverWebSearchEvents;
    lastClaudeNonStreamForensics = executed.requestForensicsDone;
  } catch (err) {
    const errorResponse = handleClaudeNonStreamProviderError(
      {
        requestId: reqId,
        model: resolved.resolvedModelId,
        orgId: claudeIdentity.orgId,
        span: claudeNonStreamSpan,
        circuitBreakers,
        logger: app.log,
        extractUpstreamErrorDiagnostics,
        recordSessionEvent: claudeNonStreamScope.recordEvent,
      },
      err,
    );
    return reply.code(errorResponse.statusCode).send(errorResponse.payload);
  }
  finalizeClaudeNonStreamProviderSuccess({
    model: resolved.resolvedModelId,
    orgId: claudeIdentity.orgId,
    span: claudeNonStreamSpan,
    circuitBreakers,
  });
  const claudePostProvider = await processClaudeNonStreamProviderResult(createClaudeNonStreamPostProviderInput({
    result: result as unknown as {
      text?: string;
      reasoning?: unknown;
      usage?: unknown;
      toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
    },
    serverWebSearchEvents: claudeServerWebSearchEvents,
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
      requestForensicsDone: lastClaudeNonStreamForensics,
      countMessageRoles,
      pushDiagnostic,
    },
  }));

  applyClarificationRoundResponseHeader(reply, session.record.metadata);
  return reply.send(buildClaudeNonStreamMessageResponse({
    id: `msg_${crypto.randomUUID()}`,
    model: resolved.resolvedModelId,
    content: claudePostProvider.content,
    stopReason: claudePostProvider.stopReason,
    usage: claudePostProvider.usage,
  }));
});

await refreshTierRegistry();
const tierPollTimer = setInterval(() => {
  void refreshTierRegistry();
}, config.SYNESIS_YARN_TIER_POLL_INTERVAL * 1000);

await app.listen({ port: config.PORT, host: config.HOST });
