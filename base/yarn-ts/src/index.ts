import crypto from "node:crypto";
import { readdir } from "node:fs/promises";
import Fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { Registry } from "prom-client";
import { generateText, streamText } from "ai";
import {
  createServiceMetrics,
  recordUsageMetrics,
  computeCost,
  extractUsage,
  emitTrace,
  type LlmUsage as TelemetryLlmUsage,
  type PricingSource,
  type TraceRecord,
} from "@synesis/telemetry";
import { loadConfig } from "./config.js";
import {
  ClaudeBootstrapQuerySchema,
  ClaudeCommandExecuteRequestSchema,
  ClaudeModelResolutionQuerySchema,
  ClaudeMessagesRequestSchema,
  OpenAIChatCompletionRequestSchema,
  type ClaudeBootstrapQuery,
  type ClaudeCommandExecuteRequest,
  type ClaudeModelResolutionQuery,
  type ClaudeMessagesRequest,
  type OpenAIChatCompletionRequest
} from "./schemas.js";
import { shouldIncludeStreamUsage, toOpenAiUsage } from "./openai-compat.js";
import {
  buildClaudeBootstrapTemplate,
  executeClaudeCompatCommand,
  resolveClaudeModelSelection,
} from "./claude-compat.js";
import {
  fetchTierRegistrySnapshot,
  TIER_TO_ROLE,
  type PromptSnapshot,
  type RoleAssignmentConfig,
} from "./providers/admin-tier-registry.js";
import { SynesisProviderRegistry, type DashScopeCacheOpts } from "./providers/synesis-provider.js";
import { PrefixOptimizer, type MarkerBackend } from "./providers/prefix-optimizer/index.js";
import { SawtoothContextManager } from "./context/sawtooth-manager.js";
import { SessionStore, type SessionRecord } from "./state/session-store.js";
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
import { buildTaskIntake, formatTaskIntakeBlock, type TaskIntake } from "./planning/task-intake.js";
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
import { runEvidencePrefetch, formatEvidenceBlock, getEvidencePrefetchStats, runPatternPrefetch, formatPatternBlock, getPatternPrefetchStats } from "./evidence/fast-path.js";
import { initPatternFeedback, getPatternFeedbackStats } from "./evidence/pattern-feedback.js";
import { ToolResultReductionService } from "./reduction/tool-result-reducer.js";
import { TranscriptPruningService } from "./reduction/transcript-pruning.js";
import { ContentAddressedDedup } from "./reduction/content-addressed-dedup.js";
import { FileSnapshotRegistry, parseReadSnapshotEnvelope } from "./reduction/file-snapshot-registry.js";
import { normalizeReadSnapshotMessages } from "./reduction/read-snapshot-normalizer.js";
import { normalizeHistoricalContent, stabilizeToolCallIds } from "./reduction/historical-normalizer.js";
import { BlockStore } from "./store/block-store.js";
import { OptimizationLedger, type OptimizationLedgerSnapshot } from "./telemetry/optimization-ledger.js";
import { type PromptFrame, computeVolatileFingerprint } from "./context/prompt-frame.js";
import { IncrementalStructuralIndex } from "./memory/incremental-index.js";
import { MemoryGovernorTracker, evaluateMemoryRules } from "./memory/governor-integration.js";
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
import { VerificationLoopTracker } from "./verification/loop-tracker.js";
import {
  assessVerificationFromMessages as assessVerificationSignals,
  evaluateDeterministicPreFinalize,
} from "./verification/staff-completion.js";
import { enforceNonSilentFinalizeText } from "./verification/non-silent-finalize.js";
import { registerMcpRoutes, getToolRegistry } from "./mcp/index.js";
import { registerEvalRoutes } from "./eval/routes.js";
import { isObserverEnabled, shouldObserveSession, buildObservedTurn, buildTranscriptEvent, buildLiveEvalEvent, enableObserver as enableEvalObserver } from "./eval/session-observer.js";
import { DedupeLayer } from "./dedupe/DedupeLayer.js";
import { ToolPrefixCache } from "./tool-prefix-cache/ToolPrefixCache.js";
import {
  registerToolCollapseRoutes,
  ToolCallInterceptor,
  planToSyntheticToolCalls,
  defaultShellAllowlistFromEnv,
} from "./tool-collapse/index.js";
import { applyDiscoveryGuardrails, type DiscoveryGuardrailRedirect } from "./tool-collapse/discovery-guardrails.js";
import { normalizeClaudeStreamStopReason, normalizeOpenAIStreamFinishReason } from "./tool-collapse/stream-stop-normalizer.js";
import {
  buildBlockedDiscoveryGuidance,
  buildBlockedDiscoveryRecoveryWithSnapshot,
  buildBlockedDiscoveryRecoveryWithoutSnapshot,
  type BlockedDiscoveryDetail,
} from "./tool-collapse/blocked-discovery-recovery.js";
import { DeterministicPolicyEngine, type PolicyDecision } from "./policy/deterministic-policy-engine.js";
import { classifyLatestToolProgress } from "./governance/recovery-progress.js";
import { synesisPolicyErrorExtension } from "./policy/policy-error-extension.js";
import { PhaseModelOrchestrator, type WorkflowPhase } from "./orchestration/phase-model-orchestrator.js";
import {
  appendPathContextToAdapterBlock,
  ClientAdapterPacks,
  parseSessionExecutionContext,
  resolveWorkspaceRootForCollapse,
} from "./adapters/client-adapter-packs.js";
import { toSessionExecutionContextSystemBlock } from "./adapters/session-execution-context.js";
import { StablePrefixService } from "./context/stable-prefix.js";
import { detectCacheStrategy, computePrefixFingerprint, type CacheStrategy } from "./context/provider-cache-hints.js"; // annotateCacheBreakpoints was dead import; vLLM now uses implicit_prefix for KV reporting
import { AttentionPositioningService } from "./context/attention-positioning.js";
import { SessionContinuityService } from "./context/session-continuity.js";
import { applyMarkdownGuardrail, buildResponseStyleBlock } from "./response-style.js";
import {
  openAIToolsToSDK,
  claudeToolsToSDK,
  mapToolChoice,
  sdkToolCallsToOpenAI,
  sdkToolCallsToClaude,
  claudeMessagesToOpenAI,
  openAIMessagesToModelMessages,
  ensureSystemMessagesAtBeginning,
  coalesceLeadingSystemMessages,
  sanitizeToolCalls
} from "./tool-mapping.js";
import { appendSystemMessageAndNormalize, normalizeSystemMessageOrdering } from "./transcript/system-message-ordering.js";
import { applyToolSearchPolicy } from "./compat/tool-search-policy.js";
import { splitJitter, applyJitter } from "./compat/jitter-buffer.js";
import { sortToolSchemas } from "./compat/sorted-tools.js";
import { detectToolProgress } from "./policy/tool-progress-detector.js";
import {
  extractToolSchemaName,
  pruneToolSchemas,
} from "./compat/tool-schema-pruning.js";
import { buildRetrievalPolicyToolPromptFragment, mergeToolSystemPrompts } from "./retrieval-tool-policy.js";
import { applyTrustPackets } from "./security/transcript-trust.js";
import { CircuitBreakerRegistry } from "./providers/circuit-breaker.js";
import { UserRateLimiter } from "./middleware/user-rate-limit.js";
import { initOtel, getTracer, withSpan, withSpanAsync } from "./telemetry/otel.js";
import { startEventLoopMonitor, getEventLoopStats } from "./telemetry/event-loop-monitor.js";
import { buildDecisionSnapshot, snapshotToTraceFields, type DecisionSnapshot } from "./telemetry/decision-snapshot.js";
import {
  buildRequestForensics,
  withUsage as withForensicsUsage,
  type RequestForensicsRecord,
} from "./telemetry/request-forensics.js";
import {
  createEmptySensemakingStats,
  type SensemakingResult,
  type SensemakingStats,
} from "./sensemaking/index.js";
import { DistributedCounterService } from "./state/distributed-counters.js";
import { StreamAdmissionController } from "./middleware/stream-admission.js";
import { EnrichmentPool } from "./workers/pool.js";
import type { TierCFallbackContext, TierCFallbackResult } from "./validation/normalizer.js";
import {
  evaluateExecutionGovernor,
  executionGovernorRecoveryRewriteBlock,
  buildExecutionGovernorHardStopUserMessage,
  buildExecutionGovernorPauseEnvelope,
  inferGovernorPhaseFromMessages,
  governorPhaseToWorkflowPhase,
  type GovernorPauseEnvelope,
  type GovernorInputMessage,
} from "./governance/execution-governor.js";
import {
  buildRequiredRepairPrompt,
  derivePhaseExecutionPolicy,
  filterToolsByPhasePolicy,
  resolvePhaseToolChoice,
  validateRequiredToolCalls,
  type PhaseAwareToolChoice,
} from "./governance/phase-execution-policy.js";
import { deriveGovernorLoopObservability } from "./governance/governor-observability.js";
import { resetRecoveryCounters } from "./path-governance/tool-call-governance.js";
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
  lastGovernorPhase?: import("./governance/execution-governor.js").SessionPhase;
};

type GuardrailToolCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };

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

function applyExecutionGovernorToolRestrictions(
  tools: unknown[] | undefined,
  matchedRules?: string[],
  options?: { pureExploration?: boolean; preserveReadTools?: boolean },
): { tools: unknown[] | undefined; removed: string[] } {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, removed: [] };
  const explorationDominant = matchedRules?.some((r) =>
    r === "bounded_exploration_budget" || r === "broad_discovery_repeat"
  ) ?? false;
  const explorationStall = matchedRules?.some((r) =>
    r === "exploration_stall_no_edit"
    || r === "no_progress_loop"
    || r === "source_file_stale_reread"
    || r === "verbal_intent_without_action"
    || r === "verification_intent_without_action"
    || r === "finalize_action_required"
  ) ?? false;
  const failureFixContext = matchedRules?.some((r) =>
    r === "verification_same_failure_signature_replay"
    || r === "verification_fail_repeat_block"
    || r === "verification_churn_no_edit"
  ) ?? false;
  const repeatUserPromptLoop = matchedRules?.some((r) => r === "repeat_user_prompt_loop") ?? false;
  const verificationIntentHardGate = matchedRules?.some((r) => r === "verification_intent_without_action") ?? false;
  const finalizeGreenLock = matchedRules?.some((r) =>
    r === "verification_done_report" || r === "finalize_action_required"
  ) && matchedRules?.some((r) =>
    r === "completion_claim_requires_task_update" || r === "verification_done_report"
  );

  const deny = new Set<string>();
  if (explorationDominant) {
    deny.add("explore").add("agent");
  } else {
    deny.add("glob").add("explore").add("agent");
  }
  if (explorationStall) {
    // During pure exploration (no edits or verification yet), keep read tools available
    // so the model can finish its initial discovery. But once no_progress_loop fires
    // (model cycling through same commands), pureExploration is disabled at the call
    // site and reads are blocked too — the model already has its information.
    const blockedDiscoveryTools = (failureFixContext || options?.pureExploration)
      ? ["search", "grep", "find", "list_dir", "list_files"]
      : ["read_file", "read", "readfile", "file_read", "search", "grep", "find", "list_dir", "list_files"];
    for (const t of blockedDiscoveryTools) {
      deny.add(t);
    }
  }
  if (repeatUserPromptLoop) {
    for (const t of ["askuserquestion", "ask_user_question", "askuser", "askquestion", "user_question"]) {
      deny.add(t);
    }
  }
  if (finalizeGreenLock) {
    for (const t of ["bash", "shell", "run_test", "run_build", "run_lint", "execute", "terminal"]) {
      deny.add(t);
    }
  }

  const removed: string[] = [];
  const verificationIntentAllowlist = new Set<string>([
    "bash",
    "shell",
    "run_test",
    "run_build",
    "run_lint",
    "edit",
    "write",
    "applypatch",
    "str_replace",
    "strreplace",
    "filewrite",
  ]);
  const filtered = tools.filter((tool) => {
    if (!tool || typeof tool !== "object") return true;
    const row = tool as Record<string, unknown>;
    const nested = row.function && typeof row.function === "object" ? (row.function as Record<string, unknown>) : null;
    const rawName = (typeof row.name === "string" ? row.name : "")
      || (nested && typeof nested.name === "string" ? nested.name : "");
    const name = rawName.trim().toLowerCase();
    if (verificationIntentHardGate && !verificationIntentAllowlist.has(name)) {
      removed.push(rawName || name);
      return false;
    }
    if (options?.preserveReadTools && isReadToolName(name)) return true;
    if (!deny.has(name)) return true;
    removed.push(rawName || name);
    return false;
  });
  return { tools: filtered, removed };
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

type TrajectoryBucket = "micro" | "repo" | "feature" | "investigation";

type RequestTrajectoryInput = {
  toolSequence?: string[];
  retryCountTotal?: number;
  taskBucket?: TrajectoryBucket;
  verificationSteps?: string[];
  diagnostics?: {
    structuredErrorsCount?: number;
    diagnosticLinesCount?: number;
    structuredErrorCoverage?: number;
  };
  completionGateBlocked?: boolean;
  criticBlocked?: boolean;
  patchOpsCount?: number;
  wholeWriteOpsCount?: number;
  outcomeState?: "verified" | "partial" | "stalled" | "policy_reject" | "user_abort";
  failureStage?: "discovery" | "mutation" | "verification" | "policy" | null;
};

function classifyToolKind(name: string): "discovery" | "evidence" | "mutation" | "verification" | "other" {
  const n = name.toLowerCase();
  if (n.includes("search") || n.includes("inspect") || n.includes("classify")) return "discovery";
  if (n.includes("read") || n.includes("diff") || n.includes("status")) return "evidence";
  if (n.includes("patch") || n.includes("write") || n.includes("format") || n.includes("git_add") || n.includes("git_commit")) {
    return "mutation";
  }
  if (n.includes("run_test") || n.includes("run_build") || n.includes("run_lint")) return "verification";
  return "other";
}

function inferTrajectoryBucket(sequence: string[], patchOps: number, wholeWriteOps: number): TrajectoryBucket {
  const edits = patchOps + wholeWriteOps;
  if (edits === 0) return "investigation";
  if (edits === 1 && sequence.length <= 5) return "micro";
  if (edits >= 4 || sequence.length >= 12) return "feature";
  return "repo";
}

function countEditsFromToolSequence(sequence: string[]): { patchOps: number; wholeWriteOps: number } {
  let patchOps = 0;
  let wholeWriteOps = 0;
  for (const name of sequence) {
    if (name === "str_replace") patchOps += 1;
    if (name === "write_file") wholeWriteOps += 1;
  }
  return { patchOps, wholeWriteOps };
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

function completionCriticBlock(checklist: RequirementChecklist): string {
  const must = checklist.must.map((m) => `- ${m.title}`).join("\n");
  const should = checklist.should.map((m) => `- ${m.title}`).join("\n");
  const sections = [
    "<COMPLETION_CRITIC>",
    "Before claiming completion, verify requested capability coverage.",
    "If any must-have item is not implemented yet, do not claim done; explicitly state partial completion and continue implementation.",
    "Must-have checklist:",
    must || "- (none detected)",
  ];
  if (should) {
    sections.push("Should-have checklist:", should);
  }
  sections.push("</COMPLETION_CRITIC>");
  return sections.join("\n");
}

function appendCriticBlock(
  messages: Array<{ role: string; content: unknown }>,
  checklist: RequirementChecklist | null,
): Array<{ role: string; content: unknown }> {
  if (!checklist || (checklist.must.length === 0 && checklist.should.length === 0)) return messages;
  const block = completionCriticBlock(checklist);
  const criticMsg = { role: "system", content: block };
  const next = [...messages];
  const sysIdx = next.findIndex((m) => m.role === "system" && typeof m.content === "string");
  if (sysIdx >= 0) {
    next.splice(sysIdx + 1, 0, criticMsg);
  } else {
    next.unshift(criticMsg);
  }
  return next;
}

function extractRecentToolNames(messages: Array<{ role: string; content: unknown }>): string[] {
  const names: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !m || typeof m !== "object") continue;
    const row = m as Record<string, unknown>;
    const toolCalls = row.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== "object") continue;
        const fn = (tc as Record<string, unknown>).function;
        if (fn && typeof fn === "object") {
          const n = (fn as Record<string, unknown>).name;
          if (typeof n === "string" && n.trim()) names.push(n.trim());
        }
      }
    }
  }
  return names;
}

function extractRecentToolCallDetails(messages: Array<{ role: string; content: unknown }>): RecentToolCall[] {
  const calls: RecentToolCall[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !m || typeof m !== "object") continue;
    const row = m as Record<string, unknown>;
    const toolCalls = row.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const fn = (tc as Record<string, unknown>).function;
      if (!fn || typeof fn !== "object") continue;
      const name = (fn as Record<string, unknown>).name;
      if (typeof name !== "string" || !name.trim()) continue;
      let args: Record<string, unknown> | undefined;
      const rawArgs = (fn as Record<string, unknown>).arguments;
      if (typeof rawArgs === "string") {
        try { args = JSON.parse(rawArgs); } catch { /* ignore */ }
      } else if (rawArgs && typeof rawArgs === "object") {
        args = rawArgs as Record<string, unknown>;
      }
      const filePath = args?.file_path ?? args?.path ?? args?.filename;
      calls.push({
        toolName: name.trim(),
        filePath: typeof filePath === "string" ? filePath : undefined,
        args,
      });
    }
  }
  return calls;
}

function extractRecentAssistantText(messages: Array<{ role: string; content: unknown }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          const row = part as Record<string, unknown>;
          return typeof row.text === "string" ? row.text : "";
        })
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return null;
}

function extractRecentToolResultText(messages: Array<{ role: string; content: unknown }>): string | null {
  const chunks: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool" && m.role !== "tool_result") continue;
    const content = m.content;
    if (typeof content === "string" && content.trim()) {
      chunks.push(content.trim());
    } else if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          const row = part as Record<string, unknown>;
          return typeof row.text === "string" ? row.text : "";
        })
        .join("\n")
        .trim();
      if (text) chunks.push(text);
    }
    if (chunks.length >= 4) break;
  }
  if (chunks.length === 0) return null;
  return chunks.join("\n").slice(0, 6000);
}

type ToolExecutionFailureObservation = {
  toolName: string;
  toolCallId: string;
  filePath?: string;
  reason: string;
  snippet: string;
};

const TOOL_FAILURE_PATTERNS: Array<{ reason: string; re: RegExp }> = [
  { reason: "edit_error", re: /\berror editing file\b/i },
  { reason: "edit_context_miss", re: /\bfailed to find context\b/i },
  { reason: "edit_context_miss", re: /\bold[_\s-]?string\b.*\bnot found\b/i },
  { reason: "edit_context_miss", re: /\bnot found in file\b/i },
  { reason: "edit_context_miss", re: /\bexactly once\b/i },
  { reason: "edit_context_miss", re: /\bfound \d+ matches\b.*\breplace_all\b.*\bfalse\b/i },
  { reason: "edit_context_miss", re: /\breplace_all is false\b/i },
  { reason: "edit_context_miss", re: /\buniquely identify the instance\b/i },
  { reason: "patch_apply_failed", re: /\b(apply\s*patch|patch)\b.*\b(failed|error)\b/i },
  { reason: "write_permission_denied", re: /\b(permission denied|operation not permitted)\b/i },
];
const TOOL_IDEMPOTENT_PATTERNS: RegExp[] = [
  /\balready (?:replaced|exists|present)\b/i,
  /\balready contains\b/i,
  /\bno changes (?:made|needed)\b/i,
  /\bnothing to (?:replace|update)\b/i,
];

function collectToolExecutionFailureObservations(
  messages: Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>,
): ToolExecutionFailureObservation[] {
  const toolMetaById = new Map<string, { toolName: string; filePath?: string }>();
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
    }
  }

  const observations: ToolExecutionFailureObservation[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    const chunks = collectToolResultTextChunks(message.content);
    if (chunks.length === 0) continue;
    const rawText = chunks.join("\n").trim();
    if (!rawText) continue;

    const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id.trim() : "";
    const mappedMeta = toolCallId ? (toolMetaById.get(toolCallId) ?? null) : null;
    const mappedName = mappedMeta?.toolName ?? "";
    const toolName = (typeof message.name === "string" ? message.name : mappedName).trim() || "unknown_tool";
    const lower = rawText.toLowerCase();
    let reason = "";
    for (const candidate of TOOL_FAILURE_PATTERNS) {
      if (candidate.re.test(lower)) {
        reason = candidate.reason;
        break;
      }
    }
    if (!reason && isWriteCapableToolName(toolName) && TOOL_IDEMPOTENT_PATTERNS.some((re) => re.test(lower))) {
      reason = "edit_already_applied";
    }
    if (!reason && isWriteCapableToolName(toolName) && /\b(error|failed|invalid)\b/i.test(rawText)) {
      reason = "write_tool_error";
    }
    if (!reason) continue;

    const snippet = rawText.replace(/\s+/g, " ").slice(0, 220);
    const key = `${toolName}|${toolCallId}|${reason}|${snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    observations.push({ toolName, toolCallId, filePath: mappedMeta?.filePath, reason, snippet });
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
    const filePath = canonicalizeToolPath(meta?.filePath ?? "");
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
  const filtered = tools.filter((tool) => {
    if (!tool || typeof tool !== "object") return true;
    const row = tool as Record<string, unknown>;
    const nested = row.function && typeof row.function === "object" ? (row.function as Record<string, unknown>) : null;
    const rawName = (typeof row.name === "string" ? row.name : "")
      || (nested && typeof nested.name === "string" ? nested.name : "");
    const name = rawName.trim();
    if (!name) return true;
    const lowered = name.toLowerCase();
    if (isWriteCapableToolName(lowered)) {
      removed.push(name);
      return false;
    }
    return true;
  });
  const forcedReadToolName = findPreferredReadToolName(filtered);
  return {
    tools: filtered,
    removed,
    forcedReadToolName,
  };
}

function buildEditContextMissGuardPrompt(filePath: string, missCount: number): string {
  const lines = [
    `EDIT RECOVERY REQUIRED: ${missCount} recent edit-context misses were detected for \`${filePath}\`.`,
    "Before any Edit/Write/Patch tool call, issue exactly one Read tool call for this same file path to refresh anchors.",
    "Use that fresh content to prepare a new exact anchor, then apply one focused edit.",
    "Do not repeat the same old_string/anchor without a fresh read.",
  ];
  if (missCount >= 2) {
    lines.push(
      "If the refreshed file still does not match your expected anchor, stop retrying the same replacement.",
      "Pivot to verification of existing behavior and tests, or choose a different exact anchor before the next edit.",
    );
  }
  return lines.join("\n");
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

function toolDefinitionName(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const row = tool as Record<string, unknown>;
  const nested = row.function && typeof row.function === "object" ? (row.function as Record<string, unknown>) : null;
  return ((typeof row.name === "string" ? row.name : "")
    || (nested && typeof nested.name === "string" ? nested.name : "")).trim();
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
      return envelope.status === "ok/full_content"
        || envelope.status === "ok/replayed_snapshot"
        || envelope.status === "ok/unchanged_snapshot_still_visible";
    }
  }
  if (/unchanged since last read/i.test(rawText)) return false;
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

function detectQwenLoopRisk(recentToolCalls: RecentToolCall[]): boolean {
  const tail = recentToolCalls.slice(-8).map((c) => c.toolName.toLowerCase());
  if (tail.length < 4) return false;
  const readSearch = new Set(["read", "grep", "glob", "find", "rg", "cat", "head", "tail"]);
  let run = 0;
  let maxRun = 0;
  for (const t of tail) {
    if (readSearch.has(t)) {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else {
      run = 0;
    }
  }
  return maxRun >= 3;
}

function prioritizeWriteCapableTools(tools: unknown[], prioritize: boolean): unknown[] {
  if (!prioritize) return tools;
  const writeLike: unknown[] = [];
  const others: unknown[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      others.push(tool);
      continue;
    }
    const row = tool as Record<string, unknown>;
    const openAIName = row.type === "function" && row.function && typeof row.function === "object"
      ? (row.function as Record<string, unknown>).name
      : undefined;
    const directName = row.name;
    const name = typeof openAIName === "string" ? openAIName : (typeof directName === "string" ? directName : "");
    if (name && isWriteCapableToolName(name)) {
      writeLike.push(tool);
    } else {
      others.push(tool);
    }
  }
  return [...writeLike, ...others];
}

interface QwenPivotState {
  lastTurnMarker: number;
  /** How many consecutive pivots the model has ignored (same pattern fires again). */
  consecutiveIgnored: number;
}

const qwenInterventionBySession = new Map<string, Map<string, QwenPivotState>>();
const qwenInterventionTurnBySession = new Map<string, number>();

/**
 * Decide whether to suppress a pivot injection.
 *
 * The old logic used a flat cooldown that suppressed every pivot within N turns —
 * this caused the model to loop indefinitely because it never saw the warning.
 *
 * New logic: after the first pivot fires, allow one cooldown turn. If the adapter
 * detects the SAME pattern on the very next evaluation, that means the model
 * ignored the pivot. We stop suppressing and let escalating messages through.
 * After IGNORED_PIVOT_HARD_STOP consecutive ignored pivots, return "hard_stop"
 * so the caller can abort the request.
 */
function shouldSuppressQwenIntervention(
  sessionKey: string,
  turnMarker: number,
  pivotKind: string,
): "allow" | "suppress" | "hard_stop" {
  const byKind = qwenInterventionBySession.get(sessionKey);
  if (!byKind) return "allow";
  const state = byKind.get(pivotKind);
  if (!state) return "allow";

  if (state.consecutiveIgnored >= 5) {
    return "hard_stop";
  }

  const gap = turnMarker - state.lastTurnMarker;
  const cooldownTurns = Math.max(0, config.SYNESIS_YARN_QWEN_RESUME_NUDGE_COOLDOWN_TURNS);

  if (gap <= cooldownTurns && state.consecutiveIgnored === 0) {
    return "suppress";
  }

  return "allow";
}

function markQwenIntervention(sessionKey: string, turnMarker: number, pivotKind: string): void {
  let byKind = qwenInterventionBySession.get(sessionKey);
  if (!byKind) {
    byKind = new Map();
    qwenInterventionBySession.set(sessionKey, byKind);
  }
  const state = byKind.get(pivotKind);
  if (state) {
    state.consecutiveIgnored += 1;
    state.lastTurnMarker = turnMarker;
  } else {
    byKind.set(pivotKind, { lastTurnMarker: turnMarker, consecutiveIgnored: 0 });
  }
}

function resetQwenInterventionOnUserTurn(sessionKey: string): void {
  qwenInterventionBySession.delete(sessionKey);
  qwenInterventionTurnBySession.delete(sessionKey);
}

function nextQwenInterventionTurn(sessionKey: string): number {
  const next = (qwenInterventionTurnBySession.get(sessionKey) ?? 0) + 1;
  qwenInterventionTurnBySession.set(sessionKey, next);
  return next;
}

function classifyQwenPivotEvent(
  prompt: string,
  recentToolCalls: RecentToolCall[],
  source: "early" | "dampening" = "early",
): string {
  if (source === "dampening") return "adapter_qwen_dampening";
  const tail = recentToolCalls.slice(-8);
  let consecutiveEditSameFile = 0;
  let lastEditPath = "";
  let readLikeCount = 0;
  let gitInspectionCount = 0;
  const sigCounts = new Map<string, number>();
  for (const call of tail) {
    const tool = call.toolName.trim().toLowerCase();
    const filePath = (call.filePath ?? "").trim();
    const sig = `${tool}:${filePath}`;
    sigCounts.set(sig, (sigCounts.get(sig) ?? 0) + 1);
    if (tool === "edit" || tool === "update") {
      if (filePath && (lastEditPath === "" || lastEditPath === filePath)) {
        consecutiveEditSameFile += 1;
      } else {
        consecutiveEditSameFile = 1;
      }
      lastEditPath = filePath;
    }
    if (tool === "read" || tool === "cat" || tool === "head" || tool === "tail") {
      readLikeCount += 1;
    }
    if (tool === "bash") {
      const cmd = typeof call.args?.command === "string" ? call.args.command.toLowerCase() : "";
      if (
        /\bgit\s+status\b/.test(cmd)
        || /\bgit\s+diff\b/.test(cmd)
        || /\bgit\s+log\b/.test(cmd)
        || /\bgit\s+show\b/.test(cmd)
      ) {
        gitInspectionCount += 1;
      }
    }
  }
  if (consecutiveEditSameFile >= 3) return "adapter_qwen_edit_retry";
  if (gitInspectionCount >= 4) return "adapter_qwen_git_introspection";
  if (readLikeCount >= 3) return "adapter_qwen_read_loop";
  if ([...sigCounts.values()].some((v) => v >= 3)) return "adapter_qwen_repeated_intent";
  const p = prompt.toLowerCase();
  if (p.includes("implementation plan")) return "adapter_qwen_plan_no_action";
  if (p.includes("repeating the same intent")) return "adapter_qwen_repeated_intent";
  if (p.includes("attempted to edit")) return "adapter_qwen_edit_retry";
  if (p.includes("you have read")) return "adapter_qwen_read_loop";
  return "adapter_qwen_early_pivot";
}

function enrichToolSchemasForAdapter(
  tools: unknown[],
  adapter: ModelAdapter,
): unknown[] {
  if (!adapter.enrichToolDescription || adapter.family !== "qwen3-coder") return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const t = tool as Record<string, unknown>;
    // OpenAI format: { type: "function", function: { name, description, ... } }
    if (t.type === "function" && t.function && typeof t.function === "object") {
      const fn = t.function as Record<string, unknown>;
      const name = fn.name;
      const desc = fn.description;
      if (typeof name === "string" && typeof desc === "string") {
        const enriched = adapter.enrichToolDescription!(name, desc);
        if (enriched !== desc) {
          return { ...t, function: { ...fn, description: enriched } };
        }
      }
      return tool;
    }
    // Claude format: { name, description, ... }
    const name = t.name;
    const desc = t.description;
    if (typeof name === "string" && typeof desc === "string") {
      const enriched = adapter.enrichToolDescription!(name, desc);
      if (enriched !== desc) {
        return { ...t, description: enriched };
      }
    }
    return tool;
  });
}

function extractRequestedToolNames(userText: string, tools: unknown[]): string[] {
  const t = userText.toLowerCase();
  if (!t.trim()) return [];
  const requested: string[] = [];
  for (const tool of tools) {
    const name = extractToolSchemaName(tool);
    if (!name) continue;
    const norm = name.toLowerCase();
    if (t.includes(norm) || t.includes(`tool ${norm}`) || t.includes(`use ${norm}`)) {
      requested.push(name);
    }
  }
  return requested;
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

function resolveToolSchemaBudget(
  adapterMaxEffectiveTools: number | undefined,
  profileToolBudgetCap: number | undefined,
): number {
  if (!config.SYNESIS_YARN_TOOL_SCHEMA_PRUNING_ENABLED) return 0;
  const override = config.SYNESIS_YARN_TOOL_SCHEMA_PRUNING_MAX_OVERRIDE;
  let adapterLimit = adapterMaxEffectiveTools ?? 0;
  if (profileToolBudgetCap && profileToolBudgetCap > 0) {
    adapterLimit = adapterLimit > 0 ? Math.min(adapterLimit, profileToolBudgetCap) : profileToolBudgetCap;
  }
  if (override > 0 && adapterLimit > 0) return Math.min(override, adapterLimit);
  if (override > 0) return override;
  return adapterLimit;
}

function adjustToolSchemaBudgetForSession(
  baseBudget: number,
  phase: WorkflowPhase,
  clientKind: string,
): number {
  if (baseBudget <= 0) return baseBudget;
  const client = clientKind.toLowerCase();
  const codingClient = client.includes("claude-code") || client.includes("cursor");
  if (!codingClient) return baseBudget;

  if (phase === "validation") return Math.max(1, Math.min(baseBudget, 6));
  if (phase === "implementation") return Math.max(1, Math.min(baseBudget, 8));
  if (phase === "planning") return Math.max(1, Math.min(baseBudget, 10));
  return Math.max(1, Math.min(baseBudget, 8));
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
): { record: RequestForensicsRecord; serialized: string } | null {
  if (!config.SYNESIS_YARN_REQUEST_FORENSICS_ENABLED) return null;
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
    previous,
    capturePayload: config.SYNESIS_YARN_REQUEST_FORENSICS_CAPTURE_PAYLOAD,
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
await app.register(fastifyRateLimit, { global: false });

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
const tierRegistry = new SynesisProviderRegistry();

// DashScope explicit cache and markerBackend removed (see synesis-provider.ts). Prefix optimizer
// now always uses "none" for markers (relies on implicit_prefix for vLLM KV cache). This allows
// variable/high cached_tokens reporting from your self-hosted vLLM with prefix caching enabled.
const prefixOptimizer = config.SYNESIS_YARN_PREFIX_OPTIMIZER_ENABLED
  ? new PrefixOptimizer({
      markerBackend: "none" as MarkerBackend,
      maxMarkers: 0,
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
});
const artifactRetrieval = new ArtifactRetrievalService(artifactStore);
const knowledgeSearch = new KnowledgeSearchService({
  plannerBaseUrl: config.SYNESIS_YARN_PLANNER_URL,
  criticUrl: config.SYNESIS_YARN_CRITIC_URL,
  criticModel: config.SYNESIS_YARN_CRITIC_MODEL,
  internalServiceToken: config.SYNESIS_INTERNAL_SERVICE_TOKEN,
});
const webSearch = new WebSearchService({
  plannerBaseUrl: config.SYNESIS_YARN_PLANNER_URL,
  criticUrl: config.SYNESIS_YARN_CRITIC_URL,
  criticModel: config.SYNESIS_YARN_CRITIC_MODEL,
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
const transcriptPruning = new TranscriptPruningService({
  enabled: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED,
  keepTurns: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TURNS,
  keepToolResults: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_KEEP_TOOL_RESULTS,
  budgetChars: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_BUDGET_CHARS,
  stubMaxChars: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_STUB_MAX_CHARS,
  assistantCondenseChars: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_ASSISTANT_CONDENSE_CHARS,
});
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
});
const distributedCounters = new DistributedCounterService(config);
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

function inferModelFamily(backendModel: string): string {
  const m = (backendModel || "").toLowerCase();
  if (/qwen3.*coder/.test(m)) return "qwen3-coder";
  if (/deepseek/.test(m)) return "deepseek";
  if (/kimi|moonshot/.test(m)) return "kimi";
  return "generic";
}

function isQwenModelName(modelName: string | undefined): boolean {
  return /qwen/i.test((modelName ?? "").toLowerCase());
}

function enrichWithFrameAndManifest(
  messages: Array<{ role: string; content: unknown }>,
  sessionKey: string,
  adapterBlock?: string,
  promptContext?: { tier?: string; role?: string; modelFamily?: string; node?: string },
  pathHints?: { projectRoot: string | null; shellCwd: string | null } | null,
  governanceBlocks?: string[],
  topLevelDirs?: string[],
  sessionState?: SessionState | null,
): EnrichResult {
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
    workingFrame: workingFrameBlock,
    structuralCritic: structuralCriticBlock,
    projectManifest: projectManifestBlock ? blockStore.intern(projectManifestBlock) : null,
    structuralIndex: structuralIndexBlock ? blockStore.intern(structuralIndexBlock) : null,
    fileSummary: fileSummaryBlock,
    verificationPlan: verificationPlanBlock ? blockStore.intern(verificationPlanBlock) : null,
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

interface SessionIdentity {
  userId: string;
  orgId: string;
  conversationId: string;
  clientKind: string;
  displayName?: string;
}

function buildSessionKey(userId: string, clientKind: string, conversationId: string): string {
  const user = userId || "anon";
  const client = clientKind || "unknown";
  const convo = conversationId || "_";
  return `synesis:${user}:${client}:${convo}`;
}

/**
 * Resolve the effective session key, applying inactivity rotation when no
 * explicit conversation_id was provided by the client. Without rotation,
 * clients like Claude Code (which never sends a conversation_id) accumulate
 * all token spend into a single immortal session that eventually hits the
 * budget ceiling.
 *
 * When the existing session has been idle longer than
 * SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS, a new key with a
 * timestamp-based rotation suffix is used so the user gets a fresh budget.
 */
async function getSessionKey(identity: SessionIdentity): Promise<string> {
  const baseKey = buildSessionKey(identity.userId, identity.clientKind, identity.conversationId);
  const hasExplicitConvo = !!(identity.conversationId && identity.conversationId.trim());

  if (hasExplicitConvo) return baseKey;

  const inMemory = sessions.get(baseKey);
  if (inMemory) {
    const idle = Date.now() - inMemory.record.lastActiveAt;
    if (idle > config.SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS) {
      app.log.info(
        { oldKey: baseKey, idleMs: idle, tokens: inMemory.record.totalTokensIn },
        "session_inactivity_rotation"
      );
      sessions.delete(baseKey);
      contentDedupBySession.delete(baseKey);
      structuralIndexBySession.delete(baseKey);
      memoryGovernorBySession.delete(baseKey);
      clearSessionMemory(baseKey);
      blockedDiscoveryBySession.delete(baseKey);
      const rotated = `${baseKey}:r${Date.now()}`;
      return rotated;
    }
    return baseKey;
  }

  const loaded = await sessionStore.load(baseKey);
  if (loaded) {
    const idle = Date.now() - loaded.lastActiveAt;
    if (idle > config.SYNESIS_YARN_SESSION_INACTIVITY_ROTATION_MS) {
      app.log.info(
        { oldKey: baseKey, idleMs: idle, tokens: loaded.totalTokensIn },
        "session_inactivity_rotation_redis"
      );
      const rotated = `${baseKey}:r${Date.now()}`;
      return rotated;
    }
  }

  return baseKey;
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

  if (!loaded && identity.userId !== "anon" && config.SYNESIS_YARN_SESSION_CONTINUITY_ENABLED) {
    const prevContinuity = await sessionStore.loadContinuity(identity.userId);
    if (prevContinuity) {
      const block = sessionContinuity.toSystemBlock(prevContinuity);
      if (block) {
        history.push({ role: "system", content: block });
      }
    }
  }

  if (!loaded && identity.userId !== "anon" && config.SYNESIS_YARN_CROSS_CONVERSATION_RECALL_ENABLED) {
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
  };
  sessions.set(key, state);
  return state;
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
      void sessionStore.saveContinuity(state.record.userId, continuity).catch(() => {});
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
  } catch (err) {
    app.log.warn({ err }, "Session persistence failed (non-fatal)");
    recordSessionEvent(state.record.sessionKey, state.record.userId, state.record.orgId, "persistence_error", "casSessionSave", String(err instanceof Error ? err.message : err).slice(0, 500));
  }
}

function maybeCheckpoint(state: SessionState): void {
  if (!sawtooth.shouldCheckpoint(state.history, state.toolCallsSinceCheckpoint)) {
    return;
  }
  const charsBefore = state.history.reduce((sum, m) => sum + m.content.length, 0);
  void sawtooth.compressTrajectory(state.history).then((consolidated) => {
    state.history = [{ role: "system", content: consolidated.summary }];
    state.toolCallsSinceCheckpoint = 0;
    getFileSnapshotRegistry(state.record.sessionKey).markCompaction("SUMMARY_ONLY");
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
    const consolidated = await sawtooth.compressTrajectory(state.history);
    state.history = [{ role: "system", content: consolidated.summary }];
    state.toolCallsSinceCheckpoint = 0;
    getFileSnapshotRegistry(state.record.sessionKey).markCompaction("SUMMARY_ONLY");
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
    tierRegistry.updateTiers(snapshot.tiers);
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

import type { ModelAdapter, RecentToolCall } from "./providers/model-adapter.js";
import {
  repairBashToolCall,
  repairWriteToolCall,
} from "./providers/model-adapter.js";
import { governToolCall } from "./path-governance/tool-call-governance.js";
import type { GovernedToolCall, PlanWriteAuditRecord } from "./path-governance/tool-call-governance.js";
import {
  buildWorkspaceHandshakeBashCommand,
  contextFromSessionMetadata,
  extractClaudeToolResult,
  extractOpenAIToolResult,
  hasBashTool,
  lastToolUseIdFromClaudeMessages,
  makeWorkspaceHandshakeToolCallId,
  parseWorkspaceContextOutput,
} from "./session/workspace-context-handshake.js";

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
}; // No-op after DashScope removal; resolve() ignores it. Enables clean vLLM KV cache reporting.

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
 * Same tool pipeline for OpenAI and Claude: remap param aliases → Write/Bash repairs → governToolCall.
 * `streamToolName` is optional (Claude streaming may differ from tool-call name for edge cases).
 */
function applyAdapterToolHardening(
  adapter: ModelAdapter,
  toolNameFromCall: string,
  input: Record<string, unknown>,
  streamToolName?: string,
): {
  toolName: string;
  input: Record<string, unknown>;
  remapped: boolean;
  repairedWrite: boolean;
  repairedBash: boolean;
} {
  let finalInput = { ...input };
  let remapped = false;
  if (adapter.remapToolArgs) {
    const r = adapter.remapToolArgs(toolNameFromCall, finalInput);
    finalInput = r.input;
    remapped = r.remapped;
  }
  let emitToolName = (streamToolName ?? toolNameFromCall).trim() || toolNameFromCall;

  let repairedWrite = false;
  const writeRepair = repairWriteToolCall(emitToolName, finalInput);
  if (writeRepair) {
    emitToolName = writeRepair.rewrittenToolName;
    finalInput = writeRepair.rewrittenInput;
    repairedWrite = true;
  }

  let repairedBash = false;
  const bashRepair = repairBashToolCall(emitToolName, finalInput);
  if (bashRepair) {
    finalInput = bashRepair.input;
    repairedBash = bashRepair.repaired;
  }

  return {
    toolName: emitToolName,
    input: finalInput,
    remapped,
    repairedWrite,
    repairedBash,
  };
}

function trackGovernedHardening(governed: GovernedToolCall): void {
  if (governed.normalizedPath) toolArgHardeningStats.normalizedPathCount += 1;
  if (governed.constrainedToRoot) toolArgHardeningStats.projectRootConstrainedCount += 1;
  if (governed.envelopeUnwrapped) {
    toolArgHardeningStats.envelopeUnwrappedCount += 1;
    switch (governed.envelopeSource) {
      case "args_object":
        toolArgHardeningStats.envelopeUnwrappedArgsObjectCount += 1;
        break;
      case "args_json_string":
        toolArgHardeningStats.envelopeUnwrappedArgsJsonStringCount += 1;
        break;
      case "arguments_object":
        toolArgHardeningStats.envelopeUnwrappedArgumentsObjectCount += 1;
        break;
      case "arguments_json_string":
        toolArgHardeningStats.envelopeUnwrappedArgumentsJsonStringCount += 1;
        break;
      case "input_object":
        toolArgHardeningStats.envelopeUnwrappedInputObjectCount += 1;
        break;
      case "input_json_string":
        toolArgHardeningStats.envelopeUnwrappedInputJsonStringCount += 1;
        break;
      default:
        break;
    }
  }
  if (governed.blockedBashDrift) toolArgHardeningStats.blockedBashPathDriftCount += 1;
  if (governed.blockedUnsafeShell) toolArgHardeningStats.blockedUnsafeShellCount += 1;
  if (governed.blockedWriteCapable) toolArgHardeningStats.blockedWriteCapableToolCount += 1;
  if (governed.validationMissing.length > 0) toolArgHardeningStats.validationFailedCount += 1;
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
): void {
  const persistSpan = getTracer().startSpan("yarn.persist_session", {
    "yarn.request_id": requestId,
    "yarn.model": resolvedModelId,
    "yarn.latency_ms": latencyMs,
  });
  const tier = tierRegistry.getTierConfig(resolvedModelId);
  const tierRates = {
    input_per_million: Number(tier?.inputPerM ?? 0),
    output_per_million: Number(tier?.outputPerM ?? 0),
    cached_input_per_million: tier?.cachedPerM ?? null,
  };
  let pricingSource: PricingSource = tier?.pricingSource ?? "unknown";
  const result = computeCost(
    {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
      cached_prompt_tokens: usage.cachedTokens,
      cache_creation_tokens: usage.cacheCreationTokens,
      estimated_cost_usd: 0,
      actual_cost_usd: 0,
    },
    tierRates,
  );
  let estimatedCostUsd = result.estimated_cost_usd;
  if (pricingSource === "unknown" || pricingSource === "fallback_base") {
    pricingSource = result.pricing_source;
  }
  let actualCostUsd = usage.costUsd > 0 ? usage.costUsd : 0;
  if (actualCostUsd > 0) {
    pricingSource = "provider";
  }
  const normalizedEstimatedCostUsd = Number.isFinite(estimatedCostUsd) ? Math.max(0, estimatedCostUsd) : 0;
  const normalizedActualCostUsd = Number.isFinite(actualCostUsd) ? Math.max(0, actualCostUsd) : 0;

  if (pricingSource === "fallback_base" && (usage.inputTokens + usage.outputTokens) > 0) {
    app.log.info({
      model: resolvedModelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      pricingSource,
      tierInputPerM: tier?.inputPerM ?? null,
      tierOutputPerM: tier?.outputPerM ?? null,
    }, "fallback_pricing_in_effect: set rates in admin Model Registry for accurate costs");
  }
  state.record.totalTokensIn += usage.inputTokens;
  state.record.totalTokensOut += usage.outputTokens;
  state.record.totalTokensCached += usage.cachedTokens;
  state.record.totalTokensSaved = (state.record.totalTokensSaved ?? 0) + tokensSavedByReduction;
  const prevEstimatedCost = Number(state.record.metadata.total_estimated_cost_usd ?? 0);
  const prevActualCost = Number(state.record.metadata.total_actual_cost_usd ?? 0);
  state.record.metadata.total_estimated_cost_usd = prevEstimatedCost + normalizedEstimatedCostUsd;
  state.record.metadata.total_actual_cost_usd = prevActualCost + normalizedActualCostUsd;
  state.record.requestCount += 1;
  state.record.lastActiveAt = Date.now();
  const previousTraceId = getMetadataString(state.record.metadata, "last_trace_id");
  const rootTraceId = getMetadataString(state.record.metadata, "root_trace_id") || previousTraceId || requestId;
  const parentTraceId = previousTraceId || undefined;
  state.record.metadata.root_trace_id = rootTraceId;
  state.record.metadata.last_trace_id = requestId;

  if (finishReason === "tool_calls" || finishReason === "tool_use") {
    state.consecutiveToolCalls += 1;
  } else {
    state.consecutiveToolCalls = 0;
    state.stagnantToolCycles = 0;
    state.lastToolSignalHash = "";
  }
  state.record.metadata.consecutive_tool_calls = state.consecutiveToolCalls;
  state.record.metadata.stagnant_tool_cycles = state.stagnantToolCycles;
  state.record.metadata.last_tool_signal_hash = state.lastToolSignalHash;
  state.record.metadata.awaiting_tool_loop_user_ack = state.awaitingToolLoopUserAck;
  state.record.metadata.tool_loop_ack_anchor_user_hash = state.toolLoopAckAnchorUserHash;
  state.record.metadata.tool_loop_no_user_ack_count = state.toolLoopNoUserAckCount;
  state.record.metadata.block_broad_verification_until_edit = state.blockBroadVerificationUntilEdit;
  state.record.metadata.block_failing_verification_until_edit = state.blockFailingVerificationUntilEdit;

  if (snapshot?.governor) {
    state.record.metadata.last_governor_pause = snapshot.governor.pause;
    state.record.metadata.last_governor_rules = snapshot.governor.matchedRules;
    const prevPauseCount = Number(state.record.metadata.governor_pause_count ?? 0);
    state.record.metadata.governor_pause_count = prevPauseCount + (snapshot.governor.pause ? 1 : 0);
  }

  void distributedCounters.setConsecutiveToolCalls(
    state.record.sessionKey,
    state.consecutiveToolCalls
  );

  void casSessionSave(state);
  usageWriter.enqueueSessionUpsert(state.record);

  if (config.SYNESIS_YARN_CONVERSATION_MEMORY_ENABLED && state.record.continuity) {
    usageWriter.enqueueContinuityUpsert(
      state.record.userId,
      state.record.orgId,
      state.record.sessionKey,
      state.record.continuity,
    );
  }

  usageWriter.enqueueUsageInsert({
    sessionKey: state.record.sessionKey,
    requestId,
    userId: state.record.userId,
    orgId: state.record.orgId,
    provider: resolvedModelId,
    model: resolvedModelId,
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    tokensCached: usage.cachedTokens,
    tokensSavedByReduction,
    latencyMs,
    estimatedCostUsd: normalizedEstimatedCostUsd,
    actualCostUsd: normalizedActualCostUsd,
    pricingSource,
    escalated,
    toolCallsCount: state.toolCallsSinceCheckpoint,
    finishReason
  });

  if (config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_ENABLED && usage.inputTokens > 0) {
    const prevSessionWindowTokens = Number(state.record.metadata.hourly_tokens_session ?? 0) || 0;
    const prevUserWindowTokens = Number(state.record.metadata.hourly_tokens_user ?? 0) || 0;
    const windowMs = Math.max(60_000, config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_WINDOW_MS);
    const windowMinutes = Math.max(1, Math.ceil(windowMs / 60_000));
    const sessionLimit = Math.max(1, config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_SESSION_LIMIT);
    const userLimit = Math.max(1, config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_USER_LIMIT);
    void distributedCounters.addInputTokensAndReadHourlyWindow(
      state.record.sessionKey,
      state.record.userId,
      usage.inputTokens,
    ).then((snapshot) => {
      if (!snapshot) return;
      state.record.metadata.hourly_tokens_session = snapshot.sessionTokensInWindow;
      state.record.metadata.hourly_tokens_user = snapshot.userTokensInWindow;
      if (snapshot.sessionTokensInWindow > sessionLimit && prevSessionWindowTokens <= sessionLimit) {
        recordSessionEvent(
          state.record.sessionKey,
          state.record.userId,
          state.record.orgId,
          "hourly_token_throttle_warn",
          "token-throttle",
          `Session input tokens in rolling ${windowMinutes}m window exceeded ${sessionLimit.toLocaleString()} (used: ${snapshot.sessionTokensInWindow.toLocaleString()})`,
          requestId,
          {
            scope: "session",
            mode: "audit",
            window_ms: windowMs,
            limit_tokens: sessionLimit,
            observed_tokens: snapshot.sessionTokensInWindow,
          },
        );
      }
      if (snapshot.userTokensInWindow > userLimit && prevUserWindowTokens <= userLimit) {
        recordSessionEvent(
          state.record.sessionKey,
          state.record.userId,
          state.record.orgId,
          "hourly_token_throttle_warn",
          "token-throttle",
          `User input tokens in rolling ${windowMinutes}m window exceeded ${userLimit.toLocaleString()} (used: ${snapshot.userTokensInWindow.toLocaleString()})`,
          requestId,
          {
            scope: "user",
            mode: "audit",
            window_ms: windowMs,
            limit_tokens: userLimit,
            observed_tokens: snapshot.userTokensInWindow,
          },
        );
      }
      void casSessionSave(state);
    });
  }

  const toolSequence = trajectory?.toolSequence ?? [];
  const inferredEdits = countEditsFromToolSequence(toolSequence);
  const patchOpsCount = trajectory?.patchOpsCount ?? inferredEdits.patchOps;
  const wholeWriteOpsCount = trajectory?.wholeWriteOpsCount ?? inferredEdits.wholeWriteOps;
  const verificationSteps = trajectory?.verificationSteps ?? [];
  const countsByKind = { discovery: 0, evidence: 0, mutation: 0, verification: 0, other: 0 };
  for (const name of toolSequence) {
    const kind = classifyToolKind(name);
    countsByKind[kind] += 1;
  }
  const taskBucket = trajectory?.taskBucket ?? inferTrajectoryBucket(toolSequence, patchOpsCount, wholeWriteOpsCount);
  const firstPassVerifyOk =
    finishReason !== "error"
    && !snapshot?.verificationStalled
    && (snapshot?.verificationRound === undefined || snapshot.verificationRound <= 1);
  const structuredErrorsCount = trajectory?.diagnostics?.structuredErrorsCount ?? 0;
  const diagnosticLinesCount = trajectory?.diagnostics?.diagnosticLinesCount ?? 0;
  const structuredErrorCoverage = trajectory?.diagnostics?.structuredErrorCoverage
    ?? (diagnosticLinesCount > 0
      ? Number((structuredErrorsCount / diagnosticLinesCount).toFixed(3))
      : (structuredErrorsCount > 0 ? 1 : 0));
  const completionGateBlocked = trajectory?.completionGateBlocked ?? false;
  const criticBlocked = trajectory?.criticBlocked ?? false;
  const outcomeState = trajectory?.outcomeState
    ?? (finishReason === "error" ? "stalled" : snapshot?.verificationStalled ? "stalled" : (completionGateBlocked || criticBlocked) ? "partial" : "verified");
  const failureStage = trajectory?.failureStage
    ?? (finishReason === "error" ? "verification" : snapshot?.verificationStalled ? "verification" : completionGateBlocked ? "verification" : criticBlocked ? "policy" : null);

  usageWriter.enqueueSessionEvent({
    sessionKey: state.record.sessionKey,
    requestId,
    userId: state.record.userId,
    orgId: state.record.orgId,
    eventKind: "request_trajectory_v1",
    component: "yarn",
    detail: `trajectory ${outcomeState} bucket=${taskBucket} tools=${toolSequence.length}`,
    metadataJson: {
      schema_version: "request_trajectory_v1",
      request_id: requestId,
      session_key: state.record.sessionKey,
      task_bucket: taskBucket,
      identity: {
        client_kind: state.record.clientKind || "unknown",
        model: resolvedModelId,
      },
      workflow: {
        decision_path: snapshot?.decisionPath,
        phase: snapshot?.phase ?? "unknown",
        escalated,
        policy_rules_matched: snapshot?.policyDecision ? String(snapshot.policyDecision).split(",").filter(Boolean) : [],
      },
      tools: {
        sequence: toolSequence,
        counts_by_kind: countsByKind,
        retry_count_total: trajectory?.retryCountTotal ?? state.stagnantToolCycles,
        blind_retry_count: state.stagnantToolCycles,
      },
      edits: {
        files_read_count: undefined,
        bytes_read_total: undefined,
        files_written_count: patchOpsCount + wholeWriteOpsCount,
        patch_ops_count: patchOpsCount,
        whole_write_ops_count: wholeWriteOpsCount,
        patch_success_rate: patchOpsCount + wholeWriteOpsCount > 0
          ? Number((patchOpsCount / (patchOpsCount + wholeWriteOpsCount)).toFixed(3))
          : undefined,
      },
      verification: {
        steps: verificationSteps,
        round: snapshot?.verificationRound,
        stalled: snapshot?.verificationStalled,
        findings: snapshot?.verificationFindings,
        first_pass_verify_ok: firstPassVerifyOk,
        structured_errors_count: structuredErrorsCount,
        diagnostic_lines_count: diagnosticLinesCount,
        structured_error_coverage: structuredErrorCoverage,
        completion_gate_blocked: completionGateBlocked,
        critic_blocked: criticBlocked,
      },
      cost: {
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
        tokens_saved_by_reduction: tokensSavedByReduction,
        latency_ms: latencyMs,
        tool_latency_ms_total: undefined,
      },
      outcome: {
        state: outcomeState,
        failure_stage: failureStage,
      },
      governor: snapshot?.governor ? {
        pause: snapshot.governor.pause,
        reason: snapshot.governor.reason,
        matched_rules: snapshot.governor.matchedRules,
        telemetry: snapshot.governor.telemetry,
      } : undefined,
      training_signals: {
        governor_intervened: snapshot?.governor?.pause ?? false,
        governor_rules: snapshot?.governor?.matchedRules ?? [],
        no_edit_evidence: snapshot?.governor?.telemetry?.noEditEvidence ?? false,
        trailing_verification_stall: (snapshot?.governor?.telemetry?.trailingVerificationRunLength ?? 0) >= 3,
        false_green_detected: false,
        evidence_delta: "unknown",
      },
    },
  });

  const telemetryUsage: TelemetryLlmUsage = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    cached_prompt_tokens: usage.cachedTokens,
    cache_creation_tokens: usage.cacheCreationTokens,
    estimated_cost_usd: normalizedEstimatedCostUsd,
    actual_cost_usd: usage.costUsd > 0 ? usage.costUsd : 0,
  };
  recordUsageMetrics(svcMetrics, resolvedModelId, resolvedModelId, telemetryUsage, latencyMs / 1000);
  const rootPromptSnippet = getMetadataString(state.record.metadata, "trace_root_prompt");
  const latestPromptSnippet = getMetadataString(state.record.metadata, "latest_user_prompt");

  const trace: TraceRecord = {
    service: "yarn",
    trace_id: requestId,
    request_id: requestId,
    conversation_id: state.record.sessionKey,
    parent_trace_id: parentTraceId,
    root_trace_id: rootTraceId,
    timestamp: Date.now() / 1000,
    user_id: state.record.userId,
    org_id: state.record.orgId,
    tenant_id: "",
    model: resolvedModelId,
    query_snippet: (rootPromptSnippet || latestPromptSnippet).slice(0, 2000),
    tokens: telemetryUsage,
    cost: {
      estimated_usd: normalizedEstimatedCostUsd,
      actual_usd: usage.costUsd > 0 ? usage.costUsd : 0,
      rates_snapshot: {
        input_per_million: Number(tier?.inputPerM ?? 0),
        output_per_million: Number(tier?.outputPerM ?? 0),
        cached_input_per_million: tier?.cachedPerM ?? null,
      },
    },
    latency_ms: latencyMs,
    ...(snapshot ? snapshotToTraceFields(snapshot) : {}),
    trace_context: {
      ...(snapshot ? snapshotToTraceFields(snapshot).trace_context : {}),
      turn_index: state.record.requestCount,
      root_user_prompt: rootPromptSnippet || undefined,
      latest_user_prompt: latestPromptSnippet || undefined,
      parent_trace_id: parentTraceId,
      root_trace_id: rootTraceId,
    },
    ...(optimizationLedger ? { optimization_ledger: optimizationLedger } : {}),
    has_error: finishReason === "error" || undefined,
  };
  emitTrace(trace, traceEmitterConfig, app.log);
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
  );
  maybeCheckpoint(input.state);
  emitDecisionEvents(input.sessionKey, input.userId, input.orgId, input.requestId, input.snapshot);

  // Eval observer — record transcript + anomalies if enabled for this session
  if (isObserverEnabled() && shouldObserveSession(input.sessionKey)) {
    try {
      const lastAssistant = input.state.history.filter(m => m.role === "assistant").at(-1);
      const observedTurn = buildObservedTurn({
        sessionKey: input.sessionKey,
        requestId: input.requestId,
        inputMessages: input.state.history.filter(m => m.role !== "assistant").slice(-20) as never[],
        response: lastAssistant ? { role: "assistant", content: typeof lastAssistant.content === "string" ? lastAssistant.content : "" } : null,
        governorDecision: input.snapshot.governor ? {
          pause: input.snapshot.governor.pause,
          reason: input.snapshot.governor.reason ?? "",
          matchedRules: input.snapshot.governor.matchedRules,
          telemetry: input.snapshot.governor.telemetry as Record<string, unknown>,
        } : undefined,
      });
      const transcriptEvent = buildTranscriptEvent(observedTurn);
      recordSessionEvent(input.sessionKey, input.userId, input.orgId, transcriptEvent.eventKind, transcriptEvent.component, transcriptEvent.detail, input.requestId, transcriptEvent.metadataJson);
      const liveEvent = buildLiveEvalEvent(observedTurn);
      if (liveEvent) {
        recordSessionEvent(input.sessionKey, input.userId, input.orgId, liveEvent.eventKind, liveEvent.component, liveEvent.detail, input.requestId, liveEvent.metadataJson);
      }
    } catch (observerErr) {
      app.log.warn({ err: observerErr }, "eval_observer_error");
    }
  }
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
  return /\b(continue|resume|update|mark|check off|complete|remaining|next|phase|load)\b/.test(text);
}

function countMessageRoles(messages: Array<{ role: string; content: unknown }>): {
  systemMessageCount: number;
  userMessageCount: number;
  toolMessageCount: number;
  totalInputChars: number;
} {
  let systemMessageCount = 0;
  let userMessageCount = 0;
  let toolMessageCount = 0;
  let totalInputChars = 0;
  for (const m of messages) {
    const chars = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
    totalInputChars += chars;
    if (m.role === "system") systemMessageCount++;
    else if (m.role === "user") userMessageCount++;
    else if (m.role === "tool") toolMessageCount++;
  }
  return { systemMessageCount, userMessageCount, toolMessageCount, totalInputChars };
}

interface ContextAdmissionResult {
  decision: "allow" | "warn" | "reject";
  reason?: string;
  estimatedTokens: number;
  estimatedChars: number;
}

function estimateToolSchemaChars(tools: unknown[]): number {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  try {
    return JSON.stringify(tools).length;
  } catch {
    return 0;
  }
}

function evaluateContextAdmission(
  messages: Array<{ role: string; content: unknown }>,
  tools: unknown[],
  mode: "advisory" | "hybrid" | "enforced",
  warnTokens: number,
  hardTokens: number,
): ContextAdmissionResult {
  const msgChars = countMessageRoles(messages).totalInputChars;
  const schemaChars = estimateToolSchemaChars(tools);
  const estimatedChars = msgChars + schemaChars;
  const estimatedTokens = Math.ceil(estimatedChars / 4);
  if (hardTokens <= 0) {
    return { decision: "allow", estimatedTokens, estimatedChars };
  }
  if (estimatedTokens > hardTokens) {
    return {
      decision: "reject",
      reason: `estimated_input_tokens_exceeded_hard_limit (${estimatedTokens} > ${hardTokens})`,
      estimatedTokens,
      estimatedChars,
    };
  }
  if (warnTokens > 0 && estimatedTokens > warnTokens) {
    if (mode === "enforced") {
      return {
        decision: "reject",
        reason: `estimated_input_tokens_exceeded_warn_limit_enforced (${estimatedTokens} > ${warnTokens})`,
        estimatedTokens,
        estimatedChars,
      };
    }
    return {
      decision: "warn",
      reason: `estimated_input_tokens_above_warn_limit (${estimatedTokens} > ${warnTokens})`,
      estimatedTokens,
      estimatedChars,
    };
  }
  return { decision: "allow", estimatedTokens, estimatedChars };
}

function admissionErrorMessage(result: ContextAdmissionResult): string {
  const base = "Request context is too large for safe model admission.";
  const est = `Estimated input tokens: ${result.estimatedTokens.toLocaleString()}.`;
  const hint = "Reduce history length, narrow tool output, or split the task into smaller turns.";
  return `${base} ${est} ${hint}`;
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

const VERIFY_TOOL_HINTS = ["run_lint", "run_build", "run_test", "format_code"];

function classifyVerificationCategory(text: string): VerificationFailure["category"] {
  const t = text.toLowerCase();
  if (/(pytest|jest|test\b|assert|--- fail|^fail\b)/i.test(t)) return "test";
  if (/(format|fmt|prettier|ruff format|gofmt|clippy|eslint|lint|unused)/i.test(t)) return "format_or_lint";
  if (/(build|compile|type|ts\d+|mypy|vet|cargo check|go build)/i.test(t)) return "build_or_typecheck";
  return "runtime";
}

function extractBestVerificationPayload(
  value: unknown,
  toolNameHint: string,
  depth = 0,
  seen = new Set<object>(),
): { ok: boolean; preset?: string; summary: string; errorLines: string[] } | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = parseJsonIfPossible(value);
    if (!parsed) return null;
    return extractBestVerificationPayload(parsed, toolNameHint, depth + 1, seen);
  }
  if (typeof value !== "object") return null;
  if (seen.has(value as object)) return null;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const row of value) {
      const found = extractBestVerificationPayload(row, toolNameHint, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  const row = value as Record<string, unknown>;
  const ok = typeof row.ok === "boolean" ? row.ok : undefined;
  const preset = typeof row.preset === "string" ? row.preset : undefined;
  const summary = typeof row.summary === "string" ? row.summary : "";
  const errorLines = Array.isArray(row.errorLines)
    ? row.errorLines.map((l) => String(l)).filter(Boolean)
    : [];
  const command = typeof row.command === "string" ? row.command : "";
  const likelyVerify = VERIFY_TOOL_HINTS.some((x) => toolNameHint.includes(x))
    || Boolean(preset)
    || /(lint|build|test|format|compile|pytest|eslint|mypy|tsc|cargo|go test|go build)/i.test(command);
  if (ok !== undefined && likelyVerify) {
    return { ok, preset, summary: summary || command || `verification via ${toolNameHint}`, errorLines };
  }
  for (const key of ["result", "content", "data", "payload", "output", "text"]) {
    if (!(key in row)) continue;
    const nested = extractBestVerificationPayload(row[key], toolNameHint, depth + 1, seen);
    if (nested) return nested;
  }
  return null;
}

function assessVerificationFromMessages(
  messages: Array<{ role: string; content: unknown; name?: string }>,
): VerificationAssessment {
  const failures: VerificationFailure[] = [];
  let verificationSignals = 0;
  for (const m of messages) {
    if (m.role !== "tool" && m.role !== "tool_result") continue;
    const toolName = String(m.name ?? "").toLowerCase();
    const payload = extractBestVerificationPayload(m.content, toolName);
    if (!payload) continue;
    verificationSignals += 1;
    if (payload.ok) continue;
    const category = classifyVerificationCategory(`${payload.summary}\n${payload.errorLines.join("\n")}`);
    failures.push({
      tool: toolName || "verification_tool",
      preset: payload.preset,
      summary: payload.summary || "verification failed",
      category,
      topErrorLines: payload.errorLines.slice(0, 3),
    });
  }
  return {
    verificationSignals,
    failingSignals: failures.length,
    failures,
    hasBlockingFailures: failures.length > 0,
  };
}

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
  },
): Promise<CompletionFinalizeResult> {
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

function toolLoopSoftFailMessage(decision: PolicyDecision): string {
  const reason = decision.rejectReason ?? "Tool loop policy triggered before another automated action.";
  return [
    "I paused automated tool execution to avoid getting stuck in a repair loop.",
    reason,
    "If you want me to continue, share one adjustment (for example: install missing local tools, choose a different command, or confirm a narrower fix strategy) and I will resume from here."
  ].join(" ");
}

function repeatLoopSoftFailMessage(decision: PolicyDecision): string {
  const reason = decision.rejectReason ?? "Repeated request fingerprint detected without progress.";
  return [
    "I paused this turn because the same request pattern keeps replaying, so continuing automatically is unlikely to make progress.",
    reason,
    "Next step: start a new chat/session (not Resume) and ask me to recover from current files, summarize the last failure, propose two alternatives, then execute one.",
  ].join(" ");
}

function policyRejectOpenAIBody(decision: PolicyDecision) {
  const message = decision.rejectReason ?? "Policy rejected request.";
  const synesis = synesisPolicyErrorExtension(decision.matchedRules);
  return {
    error: {
      type: "invalid_request_error" as const,
      message,
      ...(synesis ? { synesis } : {}),
    },
  };
}

function policyRejectClaudeBody(decision: PolicyDecision) {
  const message = decision.rejectReason ?? "Policy rejected request.";
  const synesis = synesisPolicyErrorExtension(decision.matchedRules);
  return {
    type: "error" as const,
    error: {
      type: "invalid_request_error" as const,
      message,
      ...(synesis ? { synesis } : {}),
    },
  };
}

type HandshakeStatus = "pending" | "ready" | "unavailable";
type SessionPathHints = {
  projectRoot: string | null;
  shellCwd: string | null;
  platform?: string;
  osVersion?: string;
  shell?: string;
  gitSummary?: string;
  clientModelLabel?: string;
  knowledgeCutoff?: string;
};

function getHandshakeStatus(meta: Record<string, unknown>): HandshakeStatus | "" {
  const s = String(meta.workspace_context_status ?? "").trim();
  return s === "pending" || s === "ready" || s === "unavailable" ? s : "";
}

function getHandshakeAttempts(meta: Record<string, unknown>): number {
  const n = Number(meta.workspace_context_attempts ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function mergeSessionPathHints(base: SessionPathHints, state: SessionState): SessionPathHints {
  const fromSession = contextFromSessionMetadata(state.record.metadata);
  if (!fromSession) return base;
  return {
    ...base,
    projectRoot: base.projectRoot ?? fromSession.projectRoot,
    shellCwd: base.shellCwd ?? fromSession.cwd,
    shell: base.shell ?? fromSession.shell,
    platform: base.platform ?? fromSession.os,
    osVersion: base.osVersion ?? fromSession.arch,
  };
}

function setSessionWorkspaceContext(
  state: SessionState,
  status: HandshakeStatus,
  reqId: string,
  details?: { toolCallId?: string; reason?: string; cwd?: string; projectRoot?: string; shell?: string; os?: string; arch?: string },
): void {
  state.record.metadata.workspace_context_status = status;
  state.record.metadata.workspace_context_updated_at = Date.now();
  if (details?.toolCallId) {
    state.record.metadata.workspace_context_tool_call_id = details.toolCallId;
  }
  if (details?.reason) {
    state.record.metadata.workspace_context_reason = details.reason.slice(0, 300);
  }
  if (details?.cwd) state.record.metadata.workspace_context_cwd = details.cwd;
  if (details?.projectRoot) state.record.metadata.workspace_context_project_root = details.projectRoot;
  if (details?.shell) state.record.metadata.workspace_context_shell = details.shell;
  if (details?.os) state.record.metadata.workspace_context_os = details.os;
  if (details?.arch) state.record.metadata.workspace_context_arch = details.arch;
  state.record.metadata.last_trace_id = reqId;
}

function shouldStartWorkspaceHandshake(
  state: SessionState,
  pathCtx: SessionPathHints,
): boolean {
  void state;
  void pathCtx;
  // Fix-forward policy: synthetic workspace handshake is disabled globally.
  // Context anchors must come from headers/metadata only.
  return false;
}

function sendOpenAIWorkspaceHandshake(
  reply: import("fastify").FastifyReply,
  requestId: string,
  model: string,
  stream: boolean,
  toolCallId: string,
): import("fastify").FastifyReply {
  const input = {
    command: buildWorkspaceHandshakeBashCommand(),
    description: "Initializing workspace context (read-only): cwd/project root/shell/os",
  };
  if (!stream) {
    return reply.send({
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: toolCallId,
            type: "function",
            function: { name: "Bash", arguments: JSON.stringify(input) },
          }],
        },
        finish_reason: "tool_calls",
      }],
    });
  }

  const ts = Math.floor(Date.now() / 1000);
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  safeWrite(reply.raw, `data: ${JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name: "Bash", arguments: JSON.stringify(input) } }] }, finish_reason: null }],
  })}\n\n`);
  safeWrite(reply.raw, `data: ${JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  })}\n\n`);
  safeWrite(reply.raw, "data: [DONE]\n\n");
  safeEnd(reply.raw);
  return reply;
}

function sendClaudeWorkspaceHandshake(
  reply: import("fastify").FastifyReply,
  model: string,
  stream: boolean,
  toolCallId: string,
): import("fastify").FastifyReply {
  const input = {
    command: buildWorkspaceHandshakeBashCommand(),
    description: "Initializing workspace context (read-only): cwd/project root/shell/os",
  };
  if (!stream) {
    return reply.send({
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "tool_use", id: toolCallId, name: "Bash", input }],
      stop_reason: "tool_use",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }

  const msgId = `msg_${crypto.randomUUID()}`;
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  safeSse(reply, "message_start", {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
  });
  safeSse(reply, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: toolCallId, name: "Bash" },
  });
  safeSse(reply, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
  });
  safeSse(reply, "content_block_stop", { type: "content_block_stop", index: 0 });
  safeSse(reply, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use" },
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  safeSse(reply, "message_stop", { type: "message_stop" });
  safeEnd(reply.raw);
  return reply;
}

function sendOpenAISoftFail(
  reply: import("fastify").FastifyReply,
  requestId: string,
  model: string,
  content: string,
  stream: boolean,
  pauseEnvelope?: GovernorPauseEnvelope,
): import("fastify").FastifyReply {
  if (!stream) {
    return reply.send({
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      ...(pauseEnvelope ? { synesis_governor_pause: pauseEnvelope } : {}),
    });
  }

  const ts = Math.floor(Date.now() / 1000);
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  safeWrite(reply.raw, `data: ${JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    ...(pauseEnvelope ? { synesis_governor_pause: pauseEnvelope } : {}),
  })}\n\n`);
  safeWrite(reply.raw, `data: ${JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    ...(pauseEnvelope ? { synesis_governor_pause: pauseEnvelope } : {}),
  })}\n\n`);
  safeWrite(reply.raw, "data: [DONE]\n\n");
  safeEnd(reply.raw);
  return reply;
}

function sendClaudeSoftFail(
  reply: import("fastify").FastifyReply,
  model: string,
  content: string,
  stream: boolean,
  pauseEnvelope?: GovernorPauseEnvelope,
): import("fastify").FastifyReply {
  if (!stream) {
    return reply.send({
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
      ...(pauseEnvelope ? { synesis_governor_pause: pauseEnvelope } : {}),
    });
  }

  const msgId = `msg_${crypto.randomUUID()}`;
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  safeSse(reply, "message_start", {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 0, output_tokens: 0 } }
  });
  safeSse(reply, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" }
  });
  safeSse(reply, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: content }
  });
  safeSse(reply, "content_block_stop", { type: "content_block_stop", index: 0 });
  safeSse(reply, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { input_tokens: 0, output_tokens: 0 }
  });
  if (pauseEnvelope) {
    safeSse(reply, "synesis_governor_pause", {
      type: "synesis_governor_pause",
      pause: pauseEnvelope,
    });
  }
  safeSse(reply, "message_stop", { type: "message_stop" });
  safeEnd(reply.raw);
  return reply;
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

async function proxyMcpGet(
  path: string,
  bearer: string,
  headers?: { requestId?: string; traceparent?: string },
): Promise<unknown> {
  try {
    const response = await fetch(`${config.SYNESIS_YARN_ADMIN_API_URL}${path}`, {
      signal: AbortSignal.timeout(config.SYNESIS_YARN_MCP_PROXY_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(headers?.requestId ? { "x-request-id": headers.requestId } : {}),
        ...(headers?.traceparent ? { traceparent: headers.traceparent } : {}),
      }
    });
    if (!response.ok) {
      throw new Error(`MCP upstream error ${response.status}`);
    }
    return response.json();
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`MCP upstream timeout after ${config.SYNESIS_YARN_MCP_PROXY_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

async function proxyMcpPost(
  path: string,
  bearer: string,
  body: unknown,
  headers?: { requestId?: string; traceparent?: string },
): Promise<unknown> {
  try {
    const response = await fetch(`${config.SYNESIS_YARN_ADMIN_API_URL}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(config.SYNESIS_YARN_MCP_PROXY_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        ...(headers?.requestId ? { "x-request-id": headers.requestId } : {}),
        ...(headers?.traceparent ? { traceparent: headers.traceparent } : {}),
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`MCP upstream error ${response.status}`);
    }
    return response.json();
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`MCP upstream timeout after ${config.SYNESIS_YARN_MCP_PROXY_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

function sse(reply: { raw: { write(data: string): boolean } }, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
function claudeSystemToMessage(system: unknown): { role: "system"; content: string } | null {
  if (!system) return null;
  if (typeof system === "string") {
    return system.length > 0 ? { role: "system", content: system } : null;
  }
  if (Array.isArray(system)) {
    const textParts = system
      .filter((b: unknown) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text")
      .map((b: unknown) => String((b as Record<string, unknown>).text ?? ""));
    const joined = textParts.join("\n");
    return joined.length > 0 ? { role: "system", content: joined } : null;
  }
  return null;
}

function resolveRequestId(headers: Record<string, unknown>): string {
  const explicit = headers["x-request-id"] ?? headers["anthropic-request-id"];
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return `req-${crypto.randomUUID()}`;
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
      structuralIndexBySession.delete(key);
      memoryGovernorBySession.delete(key);
      clearSessionMemory(key);
      blockedDiscoveryBySession.delete(key);
      stablePrefixService.evictSession(key);
    }
  }
}, 60_000);

// --- Graceful shutdown ---
async function shutdown(): Promise<void> {
  clearInterval(sessionEvictionTimer);
  clearInterval(tierPollTimer);
  streamAdmission.close();
  userRateLimiter.close();
  policyEngine.close();
  governanceClient?.close();
  artifactStore.close();
  await app.close();
  await Promise.all([sessionStore.close(), usageWriter.close(), authResolver.close(), distributedCounters.close(), diagnosticStore.close(), enrichmentPool.close(), memoryStoreRedis?.quit()]);
  process.exit(0);
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
app.get("/health/readiness", async () => ({ status: "ready" }));
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
      stablePrefix: config.SYNESIS_YARN_STABLE_PREFIX_ENABLED,
      jsonCompaction: config.SYNESIS_YARN_JSON_COMPACTION_ENABLED,
      attentionPositioning: config.SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED,
      artifactRetrieval: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
      knowledgeSearch: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
      evidencePrefetch: config.SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED,
      governance: config.SYNESIS_YARN_GOVERNANCE_ENABLED,
      sessionContinuity: config.SYNESIS_YARN_SESSION_CONTINUITY_ENABLED,
      conversationMemory: config.SYNESIS_YARN_CONVERSATION_MEMORY_ENABLED,
      crossConversationRecall: config.SYNESIS_YARN_CROSS_CONVERSATION_RECALL_ENABLED,
      workerPool: config.SYNESIS_YARN_WORKER_POOL_ENABLED,
      contentDispatch: config.SYNESIS_YARN_CONTENT_DISPATCH_ENABLED,
      transcriptPruning: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED,
      patternRecall: config.SYNESIS_YARN_PATTERN_RECALL_ENABLED,
      recallBypass: config.SYNESIS_YARN_RECALL_BYPASS_ENABLED,
      verificationPlan: config.SYNESIS_YARN_VERIFICATION_PLAN_ENABLED,
      completionGate: config.SYNESIS_YARN_COMPLETION_GATE_ENABLED,
      completionGateHardFail: config.SYNESIS_YARN_COMPLETION_GATE_HARD_FAIL,
      completionGateSkipClarification: config.SYNESIS_YARN_COMPLETION_GATE_SKIP_CLARIFICATION,
      planningUseHorizon: config.SYNESIS_YARN_PLANNING_USE_HORIZON,
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
  endpoints: ["/v1/models", "/v1/chat/completions", "/v1/messages"]
}));

app.get("/v1/models", async () => ({
  object: "list",
  data: tierRegistry.getAvailableModels()
}));

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
  const rateResult = userRateLimiter.check(authUser.userId);
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
  const rateResult = userRateLimiter.check(authUser.userId);
  if (!rateResult.allowed) {
    reply.header("Retry-After", String(rateResult.retryAfterSeconds));
    return reply.code(429).send({ error: { type: "rate_limit_error", message: `Rate limit exceeded. Retry after ${rateResult.retryAfterSeconds} seconds.` } });
  }

  const parsedQuery = ClaudeModelResolutionQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return reply.code(400).send({ error: { type: "invalid_request_error", message: parsedQuery.error.message } });
  }
  const query: ClaudeModelResolutionQuery = parsedQuery.data;
  return {
    object: "claude_model_resolution",
    resolution: resolveClaudeModelSelection(query.model, config.SYNESIS_YARN_CLAUDE_TIER_MAP),
    available_models: tierRegistry.getAvailableModels().map((m) => m.id),
  };
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
  const rateResult = userRateLimiter.check(authUser.userId);
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
});

app.get("/v1/adapter-packs", async () => ({
  catalog: clientAdapterPacks.getCatalog()
}));

app.get("/v1/artifacts/:id", async (req, reply) => {
  try {
    await authResolver.resolve(req.headers.authorization);
  } catch {
    return reply.code(401).send({ error: { type: "auth_error", message: "Authentication required" } });
  }
  const id = (req.params as { id: string }).id;
  const artifact = artifactStore.get(id);
  if (!artifact) {
    return reply.code(404).send({ error: { type: "not_found", message: "Artifact not found" } });
  }
  return reply.send(artifact);
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
    criticUrl: config.SYNESIS_YARN_CRITIC_URL,
    criticModel: config.SYNESIS_YARN_CRITIC_MODEL,
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
registerEvalRoutes(app, config);
if (config.SYNESIS_YARN_EVAL_OBSERVER_ENABLED) {
  enableEvalObserver();
  console.log("[eval-observer] Session observer enabled via env");
}

// --- OpenAI chat completions ---
app.post("/v1/chat/completions", async (req, reply) => {
  const parsed = OpenAIChatCompletionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: { type: "invalid_request_error", message: parsed.error.message } });
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

  const oaiRateResult = userRateLimiter.check(authUser.userId);
  if (!oaiRateResult.allowed) {
    app.log.warn({ userId: authUser.userId, count: oaiRateResult.currentCount, limit: oaiRateResult.limit }, "rate_limit_rejected");
    recordSessionEvent("", authUser.userId, authUser.orgId, "rate_limit_reject", "user-rate-limiter",
      `${oaiRateResult.currentCount}/${oaiRateResult.limit} in window — retry after ${oaiRateResult.retryAfterSeconds}s`);
    reply.header("Retry-After", String(oaiRateResult.retryAfterSeconds));
    return reply.code(429).send({ error: { type: "rate_limit_error", message: `Rate limit exceeded. Retry after ${oaiRateResult.retryAfterSeconds} seconds.` } });
  }

  const request = parsed.data;
  const oaiTraceReqId = resolveRequestId(req.headers as Record<string, unknown>);
  const oaiTaskCue = extractLatestUserPromptFromMessages(request.messages as Array<{ role: string; content: unknown }>);
  const oaiOptLedger = new OptimizationLedger();
  oaiOptLedger.recordOriginal(request.messages as Array<{ content?: unknown }>);

  // Sorted tools for cache stability
  if (config.SYNESIS_YARN_SORTED_TOOLS_ENABLED && request.tools) {
    request.tools = sortToolSchemas(request.tools) as never;
  }

  const oaiPeekWatermark = (() => {
    const id: SessionIdentity = {
      userId: request.user || authUser.userId,
      orgId: authUser.orgId,
      conversationId: request.conversation_id || "",
      clientKind: String((req.headers["x-synesis-client"] as string | undefined) ?? "unknown"),
      displayName: authUser.displayName,
    };
    const existingKey = `${id.userId}:${id.conversationId}:${id.clientKind}`;
    for (const [k, v] of sessions) {
      if (k.includes(existingKey) || k.includes(id.conversationId)) return v.pruningWatermark;
    }
    return undefined;
  })();
  const reducedOpenAI = config.SYNESIS_YARN_GOVERNANCE_DISABLED
    ? { messages: request.messages as never, reducedCount: 0 }
    : enrichmentPool.isAvailable()
      ? await withSpanAsync("yarn.enrichment", { "yarn.path": "openai" }, () =>
          toolResultReduction.reduceMessagesAsync(request.messages as never, enrichmentPool, oaiTaskCue, oaiPeekWatermark),
        )
      : withSpan("yarn.enrichment", { "yarn.path": "openai" }, () =>
          toolResultReduction.reduceMessages(request.messages as never, oaiTaskCue, oaiPeekWatermark),
        );
  const toolResultCount = (request.messages as Array<{ role: string }>).filter((m) => m.role === "tool").length;
  const normalizedOpenAI = await validationNormalization.normalizeMessagesAsync(
    reducedOpenAI.messages as never,
    runValidationTierCFallback,
  );
  if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const prunedOpenAI = transcriptPruning.prune(
      normalizedOpenAI.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>,
    );
    if (prunedOpenAI.pruned) {
      normalizedOpenAI.messages = prunedOpenAI.messages as never;
    }
  }
  const oaiTrajectoryDiagnostics = inferTrajectoryDiagnosticsFromMessages(
    request.messages as Array<{ role: string; content: unknown }>,
  );
  const oaiVerificationAssessment = assessVerificationSignals(
    request.messages as Array<{ role: string; content: unknown; name?: string }>,
  );
  const adapterProfile = clientAdapterPacks.resolve(
    String((req.headers["x-synesis-client"] as string | undefined) ?? "unknown"),
    String((req.headers["x-synesis-mode"] as string | undefined) ?? "")
  );
  const openClawStrictGovernance =
    config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED
    && config.SYNESIS_YARN_OPENCLAW_STRICT_GOVERNANCE_ENABLED
    && isOpenClawProfile(adapterProfile);
  if (isOpenClawProfile(adapterProfile)) {
    openClawProfileStats.requestsObserved += 1;
  }
  const oaiBodyMetaRaw = (request as Record<string, unknown>).metadata;
  const oaiBodyMeta =
    oaiBodyMetaRaw && typeof oaiBodyMetaRaw === "object" && !Array.isArray(oaiBodyMetaRaw)
      ? (oaiBodyMetaRaw as Record<string, unknown>)
      : null;
  const oaiPathCtx = parseSessionExecutionContext(req.headers as Record<string, string | string[] | undefined>, oaiBodyMeta);
  const adapterBlock = appendPathContextToAdapterBlock(
    clientAdapterPacks.toSystemBlock(adapterProfile),
    req.headers as Record<string, string | string[] | undefined>,
    oaiBodyMeta,
    String((req.headers["x-synesis-client"] as string | undefined) ?? ""),
    { gitPolicyMode: config.SYNESIS_YARN_GIT_POLICY_MODE },
  );
  const latestUserText = [...(normalizedOpenAI.messages as Array<{ role: string; content: unknown }>)].reverse().find((m) => m.role === "user");
  const preManifest = projectManifestService.build(normalizedOpenAI.messages as never);

  debugProtocolLog(app.log as never, oaiTraceReqId, "/v1/chat/completions", {
    model: request.model,
    messageCount: (request.messages as unknown[]).length,
    hasTools: !!(request.tools as unknown[])?.length,
    stream: request.stream,
    client: adapterProfile.client,
  });
  const oaiClientKind = String((req.headers["x-synesis-client"] as string | undefined) ?? "unknown");
  const identity: SessionIdentity = {
    userId: request.user || authUser.userId,
    orgId: authUser.orgId,
    conversationId: request.conversation_id || "",
    clientKind: oaiClientKind,
    displayName: authUser.displayName,
  };
  const sessionKey = await getSessionKey(identity);
  if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
    app.log.debug({ sessionKey, source: "conversation_id_body", conversationId: identity.conversationId, clientKind: oaiClientKind }, "session_resolution");
  }
  const session = await getSessionState(sessionKey, identity);
  const oaiMsgCount = (request.messages as unknown[]).length;
  const oaiRecentExempt = Number(config.SYNESIS_YARN_TASK_PRUNING_RECENT_EXEMPT) || 0;
  session.pruningWatermark = Math.max(session.pruningWatermark, oaiMsgCount - oaiRecentExempt);
  // When the latest incoming message is a user prompt, the client is starting a
  // new turn. Reset tool-loop counters so history from the previous turn's stall
  // does not immediately trip the policy engine on the first request of the new turn.
  const oaiLastIncomingRole = Array.isArray(request.messages) && request.messages.length > 0
    ? (request.messages[request.messages.length - 1] as { role?: string }).role
    : undefined;
  if (oaiLastIncomingRole === "user") {
    session.consecutiveToolCalls = 0;
    session.stagnantToolCycles = 0;
    session.lastToolSignalHash = "";
    session.consecutiveRecoveryFires = 0;
    session.consecutiveEditContextMisses = 0;
    // Also clear verification-block flags so a prior turn's failed/green verification
    // loop does not gate the new task attempt before it even starts.
    session.blockBroadVerificationUntilEdit = false;
    session.blockFailingVerificationUntilEdit = false;
    void distributedCounters.setConsecutiveToolCalls(sessionKey, 0).catch(() => {});
  }
  {
    const readSnapshotRegistry = getFileSnapshotRegistry(sessionKey);
    const readSnapshotNormalization = await normalizeReadSnapshotMessages(
      normalizedOpenAI.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown; tool_calls?: unknown }>,
      readSnapshotRegistry,
      {
        projectRoot: oaiPathCtx.projectRoot ?? oaiPathCtx.shellCwd ?? null,
        anchorDir: oaiPathCtx.shellCwd ?? oaiPathCtx.projectRoot ?? null,
        lastUserPromptIdx: findLastUserPromptIdx(normalizedOpenAI.messages as Array<{ role?: string; content?: unknown }>),
      },
    );
    if (readSnapshotNormalization.normalizedCount > 0) {
      normalizedOpenAI.messages = readSnapshotNormalization.messages as never;
      if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
        app.log.debug({
          reqId: oaiTraceReqId,
          normalized: readSnapshotNormalization.normalizedCount,
          replayed: readSnapshotNormalization.replayedCount,
          fallback: readSnapshotNormalization.fallbackCount,
        }, "read_snapshot_normalization_applied");
      }
    }
  }
  if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const oaiDedup = getContentDedup(sessionKey);
    const oaiDedupResult = oaiDedup.processMessages(
      normalizedOpenAI.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>,
    );
    if (oaiDedupResult.dedupCount > 0) {
      normalizedOpenAI.messages = oaiDedupResult.messages as never;
      const memTracker = getMemoryGovernor(sessionKey);
      for (const p of oaiDedupResult.dedupPaths) {
        memTracker.trackFileRead(p);
        if (oaiDedup.getStructuralIndex()?.getFileSummary(p)) {
          memTracker.trackSummaryGenerated(p);
        }
      }
      if (oaiDedupResult.dedupPaths.length > 0 && config.SYNESIS_YARN_DEBUG_PROTOCOL) {
        app.log.debug({ reqId: oaiTraceReqId, dedupCount: oaiDedupResult.dedupCount, paths: oaiDedupResult.dedupPaths }, "content_dedup_applied");
      }
    }
    // Response dedupe: replace identical tool results with compact stubs
    if (config.SYNESIS_YARN_RESPONSE_DEDUPE_ENABLED && yarnDedupeLayer) {
      const oaiMsgs = normalizedOpenAI.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }>;
      let responseDedupHits = 0;
      for (let mi = 0; mi < oaiMsgs.length; mi++) {
        const m = oaiMsgs[mi];
        if (m.role !== "tool" || typeof m.content !== "string") continue;
        const toolName = m.name ?? "";
        let toolInput: unknown;
        if (m.tool_call_id) {
          for (let ai = mi - 1; ai >= 0; ai--) {
            const am = oaiMsgs[ai];
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
            oaiMsgs[mi] = { ...m, content: wrapped };
            responseDedupHits += 1;
            oaiOptLedger?.addResponseDedupHit();
          } else {
            oaiOptLedger?.addResponseDedupMiss();
          }
        } catch (e) {
          app.log.warn({ reqId: oaiTraceReqId, err: (e as Error).message }, "response_dedupe_bypass");
        }
      }
      if (responseDedupHits > 0) {
        normalizedOpenAI.messages = oaiMsgs as never;
        if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
          app.log.debug({ reqId: oaiTraceReqId, hits: responseDedupHits }, "response_dedupe_applied");
        }
      }
    }
    // Historical normalization: stabilize old content for prefix cache
    if (config.SYNESIS_YARN_HISTORICAL_NORMALIZE_ENABLED) {
      const histMsgs = normalizedOpenAI.messages as Array<{ role: string; tool_call_id?: string; content: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }>;
      const keepFromIdx = transcriptPruning.computeKeepFromIndex?.(histMsgs as never) ?? histMsgs.length;
      const histResult = normalizeHistoricalContent(histMsgs as never, keepFromIdx);
      if (histResult.stats.messagesNormalized > 0) {
        normalizedOpenAI.messages = histResult.messages as never;
        oaiOptLedger?.addHistoricalNormReplacements(histResult.stats.timestampsReplaced + histResult.stats.pathsNormalized);
      }
      const idResult = stabilizeToolCallIds(normalizedOpenAI.messages as never, keepFromIdx);
      if (idResult.rewriteCount > 0) {
        normalizedOpenAI.messages = idResult.messages as never;
        oaiOptLedger?.addToolIdRewrites(idResult.rewriteCount);
        if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
          app.log.debug({ reqId: oaiTraceReqId, rewrites: idResult.rewriteCount }, "tool_id_stabilization_applied");
        }
      }
    }
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
  }
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
  const oaiToolFailures = collectToolExecutionFailureObservations(
    normalizedOpenAI.messages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>,
  );
  const oaiEditMissGuard = deriveEditContextMissGuardState(
    normalizedOpenAI.messages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>,
  );
  const oaiLatestToolProgress = classifyLatestToolProgress(
    (normalizedOpenAI.messages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>)
      .slice(findLastUserPromptIdx(normalizedOpenAI.messages as Array<{ role?: string; content?: unknown }>) + 1),
  );
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
  if (oaiLatestToolProgress.hasRecentWriteSuccess) {
    session.stagnantToolCycles = 0;
    session.lastToolSignalHash = "";
    session.consecutiveEditContextMisses = 0;
  } else if (oaiEditMissFailureCount > 0) {
    session.consecutiveEditContextMisses += 1;
  } else if (oaiLatestToolProgress.hasRecentFailure) {
    session.consecutiveEditContextMisses = 0;
  }
  if (oaiLatestToolProgress.hasRecentWriteSuccess && session.consecutiveRecoveryFires > 0) {
    session.consecutiveRecoveryFires = 0;
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
  const pendingWorkspaceToolId = String(session.record.metadata.workspace_context_tool_call_id ?? "");
  const workspaceStatus = getHandshakeStatus(session.record.metadata);
  if (workspaceStatus === "pending" && pendingWorkspaceToolId) {
    const toolResult = extractOpenAIToolResult(request.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>, pendingWorkspaceToolId);
    if (toolResult !== null) {
      const parsedCtx = parseWorkspaceContextOutput(toolResult);
      if (parsedCtx) {
        setSessionWorkspaceContext(session, "ready", oaiTraceReqId, {
          toolCallId: pendingWorkspaceToolId,
          cwd: parsedCtx.cwd,
          projectRoot: parsedCtx.projectRoot,
          shell: parsedCtx.shell,
          os: parsedCtx.os,
          arch: parsedCtx.arch,
        });
        recordSessionEvent(sessionKey, identity.userId, identity.orgId, "workspace_context_ready", "workspace-handshake", "Initializing workspace context completed", oaiTraceReqId);
      } else {
        setSessionWorkspaceContext(session, "unavailable", oaiTraceReqId, {
          toolCallId: pendingWorkspaceToolId,
          reason: "workspace context parse failed",
        });
        recordSessionEvent(sessionKey, identity.userId, identity.orgId, "workspace_context_fallback", "workspace-handshake", "Workspace context unavailable (parse failure)", oaiTraceReqId);
      }
    } else {
      setSessionWorkspaceContext(session, "unavailable", oaiTraceReqId, {
        toolCallId: pendingWorkspaceToolId,
        reason: "workspace context tool result not returned",
      });
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, "workspace_context_fallback", "workspace-handshake", "Workspace context unavailable (tool result missing/denied)", oaiTraceReqId);
    }
  }
  let effectiveOaiPathCtx = mergeSessionPathHints(oaiPathCtx, session);
  const effectiveOaiAdapterBlock = (() => {
    const ctxBlock = toSessionExecutionContextSystemBlock(effectiveOaiPathCtx);
    if (!ctxBlock) return adapterBlock;
    return `${clientAdapterPacks.toSystemBlock(adapterProfile)}\n\n${ctxBlock}`;
  })();
  if (shouldStartWorkspaceHandshake(session, effectiveOaiPathCtx)) {
    if (!hasBashTool(request.tools as unknown[] | undefined)) {
      setSessionWorkspaceContext(session, "unavailable", oaiTraceReqId, { reason: "Bash tool not available for workspace handshake" });
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, "workspace_context_fallback", "workspace-handshake", "Workspace context unavailable (Bash tool missing)", oaiTraceReqId);
    } else {
      const toolCallId = makeWorkspaceHandshakeToolCallId();
      session.record.metadata.workspace_context_attempts = getHandshakeAttempts(session.record.metadata) + 1;
      setSessionWorkspaceContext(session, "pending", oaiTraceReqId, { toolCallId, reason: "Initializing workspace context" });
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, "workspace_context_init", "workspace-handshake", "Initializing workspace context", oaiTraceReqId);
      await casSessionSave(session);
      return sendOpenAIWorkspaceHandshake(reply, oaiTraceReqId, request.model, !!request.stream, toolCallId);
    }
  }

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
  const oaiWorkingPhase: WorkflowPhase | undefined =
    oaiOrchestratorPhaseOverride
    ?? oaiFramePhase
    ?? governorPhaseToWorkflowPhase(oaiGovernorPreviewPhase);
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
  let oaiExecutionGovernor = config.SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED && !config.SYNESIS_YARN_GOVERNANCE_DISABLED
    ? withSpan("yarn.execution_governor.evaluate", {}, (govSpan) => {
      const decision = evaluateExecutionGovernor(
        normalizedOpenAI.messages as Array<GovernorInputMessage>,
        {
          profile: config.SYNESIS_YARN_GOVERNANCE_PROFILE,
          activePlanStage: oaiPlanGraph?.activeStage ?? null,
          editContextMissActive:
            oaiEditMissGuard?.active === true
            || oaiLatestToolProgress.hasRecentEditContextMiss
            || oaiToolFailures.some((failure) => failure.reason === "edit_context_miss"),
        },
      );
      govSpan.setAttribute("governor.pause", decision.pause);
      govSpan.setAttribute("governor.reason", decision.reason ?? "");
      govSpan.setAttribute("governor.matched_rules", decision.matchedRules.join(","));
      govSpan.setAttribute("governor.phase", decision.telemetry.phase);
      govSpan.setAttribute("governor.trailing_verification_run", decision.telemetry.trailingVerificationRunLength);
      govSpan.setAttribute("governor.no_edit_evidence", decision.telemetry.noEditEvidence);
      return decision;
    })
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
    oaiExecutionGovernor.matchedRules.includes("verification_green_repeat_block")
    || oaiExecutionGovernor.matchedRules.includes("verification_already_green")
  ) {
    session.blockBroadVerificationUntilEdit = true;
  }
  if (
    oaiExecutionGovernor.matchedRules.includes("verification_fail_repeat_block")
    || oaiExecutionGovernor.matchedRules.includes("verification_same_failure_signature_replay")
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
  const oaiLoopObs = deriveGovernorLoopObservability(
    normalizedOpenAI.messages as Array<{ role: string; tool_calls?: unknown }>,
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
      telemetry: oaiExecutionGovernor.telemetry,
    },
  );
  const oaiAggressiveRepeatGuard =
    (oaiCommandLoop.commandRepeatCount >= 2 && Boolean(oaiCommandLoop.failureSignatureHash))
    || oaiCommandLoop.broadDiscoveryRepeatCount >= 4;
  const oaiRepeatAwarePivot = oaiAggressiveRepeatGuard
    ? Math.max(3, Math.min(config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT, 6))
    : config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT;
  const oaiRepeatAwareHardReject = oaiAggressiveRepeatGuard
    ? Math.max(3, Math.min(config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER, 4))
    : config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER;
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
    consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
    consecutiveToolCallsPivot: oaiRepeatAwarePivot,
    toolProgressState: oaiLatestToolProgress.hasRecentWriteSuccess
      ? "progress"
      : (oaiLatestToolProgress.hasRecentFailure ? "stagnant" : oaiToolProgress.state),
    stagnantToolCycles: oaiLatestToolProgress.hasRecentWriteSuccess
      ? 0
      : (oaiLatestToolProgress.hasRecentFailure ? Math.max(session.stagnantToolCycles, 1) : session.stagnantToolCycles),
    stagnantToolCyclesLimit: config.SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT,
    toolLoopNoUserAckCount: session.toolLoopNoUserAckCount,
    toolLoopNoUserAckHardLimit: config.SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT,
    hardRejectAfter: oaiRepeatAwareHardReject,
    governanceRules: governanceClient?.getRules(),
  }));
  if (!policyPrecheck.allow) {
    logAndPersistSafetyEvent(policyPrecheck, sessionKey, session.record.totalTokensIn);
    if (config.SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED && policyPrecheck.softFailClass === "tool_loop") {
      const started = Date.now();
      const content = toolLoopSoftFailMessage(policyPrecheck);
      const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
      session.awaitingToolLoopUserAck = true;
      session.toolLoopAckAnchorUserHash = latestOpenAIUserHash;
      session.toolLoopNoUserAckCount = 0;
      session.history.push({ role: "assistant", content });
      persistSessionAndUsage(
        session,
        oaiTraceReqId,
        orchestration.selectedModel,
        usage,
        Date.now() - started,
        "stop",
        0
      );
      maybeCheckpoint(session);
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "tool_loop_soft_fail",
        "deterministic-policy",
        policyPrecheck.rejectReason ?? "Tool loop soft fail",
        oaiTraceReqId
      );
      return sendOpenAISoftFail(reply, oaiTraceReqId, orchestration.selectedModel, content, !!request.stream);
    }
    if (policyPrecheck.matchedRules.includes("repeat_loop_hard_reject")) {
      const started = Date.now();
      const content = repeatLoopSoftFailMessage(policyPrecheck);
      const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
      session.history.push({ role: "assistant", content });
      persistSessionAndUsage(
        session,
        oaiTraceReqId,
        orchestration.selectedModel,
        usage,
        Date.now() - started,
        "stop",
        0,
      );
      maybeCheckpoint(session);
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "repeat_loop_soft_fail",
        "deterministic-policy",
        policyPrecheck.rejectReason ?? "Repeat loop soft fail",
        oaiTraceReqId,
      );
      return sendOpenAISoftFail(reply, oaiTraceReqId, orchestration.selectedModel, content, !!request.stream);
    }
    return reply.code(400).send(policyRejectOpenAIBody(policyPrecheck));
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
  const oaiGovernorWorkflowPhase = governorPhaseToWorkflowPhase(oaiGovernorPhase);
  if (oaiWorkingPhase && oaiWorkingPhase !== oaiGovernorWorkflowPhase) {
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "governor_orchestrator_phase_mismatch",
      "execution-governor",
      `working=${oaiWorkingPhase} governor=${oaiGovernorWorkflowPhase}`,
      oaiTraceReqId,
      {
        governor_phase: oaiGovernorPhase,
        governor_workflow_phase: oaiGovernorWorkflowPhase,
        orchestrator_working_phase: oaiWorkingPhase,
        orchestrator_phase_override: oaiOrchestratorPhaseOverride ?? null,
      },
    );
  }
  if (session.lastGovernorPhase && oaiGovernorPhase !== session.lastGovernorPhase) {
    session.consecutiveRecoveryFires = 0;
    recordSessionEvent(sessionKey, identity.userId, identity.orgId, "governor_phase_transition", "execution-governor",
      `${session.lastGovernorPhase} → ${oaiGovernorPhase}`, oaiTraceReqId);
  }
  session.lastGovernorPhase = oaiGovernorPhase;
  if (oaiExecutionGovernor.pause && config.SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED) {
    const oaiTerminalRules = new Set([
      "finalize_action_required",
      "verification_after_completion_claim",
      "completion_claim_requires_task_update",
      "repeat_user_prompt_loop",
      "edit_failure_replay",
      "consecutive_edit_failures",
    ]);
    const oaiSuppressCompletionClaimTerminal =
      oaiEditMissGuard?.active === true
      || oaiLatestToolProgress.hasRecentEditContextMiss
      || oaiToolFailures.some((failure) => failure.reason === "edit_context_miss");
    const oaiTerminalMatchedRules = oaiExecutionGovernor.matchedRules.filter((rule) =>
      !(oaiSuppressCompletionClaimTerminal && rule === "completion_claim_requires_task_update"),
    );
    const oaiHasTerminalRule = oaiTerminalMatchedRules.some((rule) => oaiTerminalRules.has(rule));
    const oaiHasBlockingToolFailure = oaiToolFailures.some((failure) => failure.reason !== "edit_already_applied");
    const oaiHasConcreteProgress =
      oaiLatestToolProgress.hasRecentWriteSuccess
      || (
        oaiToolProgress.state === "progress"
        && !oaiLatestToolProgress.hasRecentFailure
        && !oaiHasBlockingToolFailure
        && oaiEditMissGuard?.active !== true
        && !(oaiSuppressCompletionClaimTerminal && oaiExecutionGovernor.matchedRules.includes("source_file_stale_reread"))
      );
    const oaiShouldHoldRecoveryFire =
      oaiLatestToolProgress.hasRecentEditContextMiss
      && oaiExecutionGovernor.matchedRules.length === 1
      && oaiExecutionGovernor.matchedRules[0] === "source_file_stale_reread"
      && (oaiEditMissGuard?.missCount ?? 0) <= 1;
    if (oaiShouldHoldRecoveryFire) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "execution_governor_recovery_hold",
        "execution-governor",
        "Holding recovery streak increment due to edit context miss; allow focused retry",
        oaiTraceReqId,
        {
          reason: "edit_context_miss",
          matched_rules: oaiExecutionGovernor.matchedRules,
          toolName: oaiLatestToolProgress.toolName || null,
          toolCallId: oaiLatestToolProgress.toolCallId || null,
        },
      );
    } else if (oaiHasConcreteProgress) {
      session.consecutiveRecoveryFires = Math.max(0, session.consecutiveRecoveryFires - 1);
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "execution_governor_recovery_reset",
        "execution-governor",
        "Decremented recovery streak due to concrete progress evidence",
        oaiTraceReqId,
        {
          matched_rules: oaiExecutionGovernor.matchedRules,
          progress_state: oaiToolProgress.state,
          has_recent_write_success: oaiLatestToolProgress.hasRecentWriteSuccess,
          has_recent_failure: oaiLatestToolProgress.hasRecentFailure,
          has_blocking_tool_failure: oaiHasBlockingToolFailure,
          edit_miss_guard_active: oaiEditMissGuard?.active === true,
          consecutive_recovery_fires: session.consecutiveRecoveryFires,
        },
      );
    } else {
      session.consecutiveRecoveryFires += 1;
    }
    const HARD_STOP_THRESHOLD = 7;
    if (session.consecutiveRecoveryFires >= HARD_STOP_THRESHOLD && oaiHasTerminalRule) {
      const oaiHardStopDedup = getContentDedup(sessionKey);
      const oaiHardStopFilesList = oaiHardStopDedup.generateFilesSummaryBlock() ?? "";
      const pauseEnvelope = buildExecutionGovernorPauseEnvelope({
        matchedRules: oaiExecutionGovernor.matchedRules,
        consecutiveRecoveryFires: session.consecutiveRecoveryFires,
        hardStopThreshold: HARD_STOP_THRESHOLD,
      });
      const hardStopContent = [
        buildExecutionGovernorHardStopUserMessage({
          consecutiveRecoveryFires: session.consecutiveRecoveryFires,
          matchedRules: oaiExecutionGovernor.matchedRules,
        }),
        ...(oaiHardStopFilesList ? ["", oaiHardStopFilesList] : []),
      ].join("\n");
      session.consecutiveRecoveryFires = 0;
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "execution_governor_hard_stop",
        "execution-governor",
        `Hard stop phase=${oaiGovernorPhase} after ${HARD_STOP_THRESHOLD} consecutive recovery fires (${oaiExecutionGovernor.matchedRules.join(",")})`,
        oaiTraceReqId,
        {
          phase: oaiGovernorPhase,
          matched_rules: oaiExecutionGovernor.matchedRules,
          has_run_test: oaiLoopObs.hasRunTest,
          last_assistant_tool_calls: oaiLoopObs.lastAssistantToolCalls,
          assistant_tool_calls_since_latest_user: oaiLoopObs.assistantToolCallsSinceLatestUser,
          blocked_before_first_tool_call: oaiLoopObs.assistantToolCallsSinceLatestUser === 0,
        },
      );
      maybeCheckpoint(session);
      return sendOpenAISoftFail(reply, oaiTraceReqId, orchestration.selectedModel, hardStopContent, !!request.stream, pauseEnvelope);
    }
    if (session.consecutiveRecoveryFires >= HARD_STOP_THRESHOLD && !oaiHasTerminalRule) {
      session.consecutiveRecoveryFires = HARD_STOP_THRESHOLD - 1;
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "execution_governor_hard_stop_deferred",
        "execution-governor",
        `Deferred hard stop because only advisory rules fired (${oaiExecutionGovernor.matchedRules.join(",")})`,
        oaiTraceReqId,
        {
          phase: oaiGovernorPhase,
          matched_rules: oaiExecutionGovernor.matchedRules,
          consecutive_recovery_fires: session.consecutiveRecoveryFires,
        },
      );
    }
    let recovery = executionGovernorRecoveryRewriteBlock(oaiExecutionGovernor);
    const oaiDedup = getContentDedup(sessionKey);
    const filesSummary = oaiDedup.generateFilesSummaryBlock();
    if (filesSummary) recovery += "\n" + filesSummary;
    const oaiMsgs = normalizedOpenAI.messages as Array<{ role: string; content: unknown }>;
    const oaiLastUserPromptIdx = findLastUserPromptIdx(oaiMsgs as Array<{ role?: string; content?: unknown }>);
    const oaiTailIdx = oaiLastUserPromptIdx >= 0 ? oaiLastUserPromptIdx + 1 : oaiMsgs.length;
    oaiMsgs.splice(oaiTailIdx, 0, { role: "system", content: recovery });
    const oaiPureExploration = oaiGovernorPhase === "edit"
      && !oaiExecutionGovernor.matchedRules.includes("completion_claim_requires_task_update")
      && !oaiExecutionGovernor.matchedRules.includes("source_file_stale_reread")
      && !oaiExecutionGovernor.matchedRules.includes("no_progress_loop");
    const restricted = applyExecutionGovernorToolRestrictions(
      request.tools as unknown[] | undefined,
      oaiExecutionGovernor.matchedRules,
      {
        pureExploration: oaiPureExploration,
        preserveReadTools: oaiEditMissGuard?.active === true,
      },
    );
    request.tools = restricted.tools as never;
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "execution_governor_recovery_rewrite",
      "execution-governor",
      `Rewrote loop path (${oaiExecutionGovernor.matchedRules.join(",")}); phase=${oaiGovernorPhase}; removed_tools=${restricted.removed.join(",") || "none"} (fire ${session.consecutiveRecoveryFires}/${HARD_STOP_THRESHOLD}); files_seen=${oaiDedup.getTrackedFileCount()}`,
      oaiTraceReqId,
    );
  } else if (!oaiExecutionGovernor.pause) {
    session.consecutiveRecoveryFires = 0;
  }
  const oaiRole = TIER_TO_ROLE[orchestration.tier];
  const oaiBackendModel = roleAssignmentRegistry.get(oaiRole)?.backendModel ?? "";
  const oaiPromptContext = {
    tier: orchestration.tier,
    role: oaiRole,
    modelFamily: inferModelFamily(oaiBackendModel),
  };
  const oaiSeedDirs = await getCachedTopLevelDirs(effectiveOaiPathCtx.projectRoot ?? effectiveOaiPathCtx.shellCwd);
  const oaiMemoryTracker = getMemoryGovernor(sessionKey);
  const oaiStructIdx = getStructuralIndex(sessionKey);
  if (oaiStructIdx) {
    oaiMemoryTracker.setIndexAvailable(oaiStructIdx.getStats().fileCount > 0);
  }
  oaiMemoryTracker.setFindingsCount(getSessionMemoryCount(sessionKey));
  const oaiMemRules = evaluateMemoryRules(oaiMemoryTracker.getSignals());
  const oaiMemBlocks = oaiMemRules.filter((r) => r.fired).map((r) =>
    `<MEMORY_GUIDANCE rule="${r.rule}">\n${r.message}\n</MEMORY_GUIDANCE>`
  );
  const oaiEnriched = enrichWithFrameAndManifest(
    normalizedOpenAI.messages as never,
    sessionKey,
    effectiveOaiAdapterBlock,
    oaiPromptContext,
    { projectRoot: effectiveOaiPathCtx.projectRoot, shellCwd: effectiveOaiPathCtx.shellCwd },
    [
      ...(oaiTaskIntake ? [formatTaskIntakeBlock(oaiTaskIntake)] : []),
      ...(oaiPlanGraph ? [formatPlanProgressBlock(oaiPlanGraph)] : []),
      ...oaiMemBlocks,
    ],
    oaiSeedDirs,
    session,
  );
  let oaiEnrichedMsgs = config.SYNESIS_YARN_GOVERNANCE_DISABLED
    ? oaiEnriched.messages as Array<{ role: string; content: unknown }>
    : appendCriticBlock(
        oaiEnriched.messages as Array<{ role: string; content: unknown }>,
        oaiRequirementChecklist,
      );

  // Sensemaking is intentionally disabled for regular coding sessions to avoid
  // adding volatile system blocks that degrade prefix cacheability.
  let oaiSensemakingResult: SensemakingResult | undefined;

  if (config.SYNESIS_YARN_JITTER_BUFFER_ENABLED && !config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const { stableMessages, jitterBlock } = splitJitter(oaiEnrichedMsgs);
    oaiEnrichedMsgs = applyJitter(stableMessages, jitterBlock) as typeof oaiEnrichedMsgs;
  }

  const trustResult = applyTrustPackets(oaiEnrichedMsgs, config, {
    requestId: oaiTraceReqId,
    sessionKey,
    userId: identity.userId,
    orgId: identity.orgId,
  }, securityIngestConfig, app.log as never);
  if (trustResult.blocked) {
    recordSessionEvent(sessionKey, identity.userId, identity.orgId, "trust_block", "transcript-trust", trustResult.blockDetail ?? "Content blocked", oaiTraceReqId);
    const trustCategory = trustResult.blockDetail?.match(/Injection detected: (\S+)/)?.[1] ?? "content_policy";
    return reply.code(400).send({ error: { type: "invalid_request_error", message: `Request blocked by content safety policy (${trustCategory}). Rephrase and retry.` } });
  }
  oaiEnrichedMsgs = trustResult.messages as typeof oaiEnrichedMsgs;

  const normalizedRequest: OpenAIChatCompletionRequest = {
    ...request,
    model: orchestration.selectedModel,
    messages: oaiEnrichedMsgs as never
  };

  session.toolCallsSinceCheckpoint += toolResultCount;
  const reqId = oaiTraceReqId;
  if (policyPrecheck.pivotPrompt) {
    session.history.push({ role: "system", content: policyPrecheck.pivotPrompt });
  }

  if (latestUserText?.content) {
    session.history.push({ role: "user", content: String(latestUserText.content) });
  }

  normalizedRequest.messages = injectSessionContext(
    normalizedRequest.messages as Array<{ role: string; content: unknown }>,
    session
  ) as never;

  // Server-side tools are only supported in non-streaming OpenAI requests (which have a loop)
  if (config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED && !normalizedRequest.stream) {
    normalizedRequest.tools = artifactRetrieval.injectToolOpenAI(normalizedRequest.tools as unknown[]) as never;
  }
  if (config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED && !normalizedRequest.stream) {
    normalizedRequest.tools = knowledgeSearch.injectToolOpenAI(normalizedRequest.tools as unknown[]) as never;
  }
  if (config.SYNESIS_YARN_WEB_SEARCH_ENABLED && !normalizedRequest.stream) {
    normalizedRequest.tools = webSearch.injectToolOpenAI(normalizedRequest.tools as unknown[]) as never;
  }

  if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const blocks: string[] = [];
    if (oaiPrefetchResult) {
      const evidenceBlock = formatEvidenceBlock(oaiPrefetchResult);
      if (evidenceBlock) blocks.push(evidenceBlock);
    }
    if (oaiPatternResult) {
      const patternBlock = formatPatternBlock(oaiPatternResult);
      if (patternBlock) blocks.push(patternBlock);
    }
    if (blocks.length > 0) {
      const combined = blocks.join("\n\n");
      const msgs = normalizedRequest.messages as Array<{ role: string; content: unknown }>;
      // Keep early system prefix stable: append volatile evidence as a separate
      // system message instead of mutating the first system block.
      msgs.push({ role: "system", content: combined });
      normalizedRequest.messages = msgs as never;
    }
  }

  if (prefixOptimizer) {
    try {
      tierRegistry.setCurrentSessionKey(sessionKey);
      const optimized = prefixOptimizer.optimize(
        normalizedRequest.messages as never,
        normalizedRequest.tools as never,
        sessionKey,
      );
      normalizedRequest.messages = optimized.messages as never;
      if (optimized.tools) {
        normalizedRequest.tools = optimized.tools as never;
      }

      const cm = optimized.clientMetadata;
      if (cm && (!effectiveOaiPathCtx.projectRoot || !effectiveOaiPathCtx.shellCwd)) {
        effectiveOaiPathCtx = {
          ...effectiveOaiPathCtx,
          projectRoot: effectiveOaiPathCtx.projectRoot ?? cm.projectRoot,
          shellCwd: effectiveOaiPathCtx.shellCwd ?? cm.shellCwd,
          shell: effectiveOaiPathCtx.shell ?? cm.shell ?? undefined,
          platform: effectiveOaiPathCtx.platform ?? cm.platform ?? undefined,
          osVersion: effectiveOaiPathCtx.osVersion ?? cm.osVersion ?? undefined,
        };
        if (cm.projectRoot || cm.shellCwd) {
          setSessionWorkspaceContext(session, "ready", oaiTraceReqId, {
            reason: "Extracted from client system message",
            projectRoot: cm.projectRoot ?? undefined,
            cwd: cm.shellCwd ?? undefined,
            shell: cm.shell ?? undefined,
            os: cm.platform ?? undefined,
          });
          app.log.info(
            { sessionKey, projectRoot: cm.projectRoot, shellCwd: cm.shellCwd, shell: cm.shell, platform: cm.platform },
            "prefix_optimizer_metadata_backfill",
          );
        }
      }
    } catch (err) {
      app.log.warn({ err, sessionKey }, "prefix_optimizer_oai_error");
    }
  }

  const resolveResult = runOpenAIRequest(normalizedRequest);
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
  const rawTools = ((normalizedRequest.tools as unknown[]) ?? []);
  const toolBudget = adjustToolSchemaBudgetForSession(
    resolveToolSchemaBudget(
    adapter.maxEffectiveTools,
    config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED && isOpenClawProfile(adapterProfile)
      ? Math.max(1, config.SYNESIS_YARN_OPENCLAW_TOOL_SCHEMA_CAP)
      : adapterProfile.features.toolSchemaBudgetCap,
    ),
    orchestration.phase,
    oaiClientKind,
  );
  const oaiRecentCallsForSteering = extractRecentToolCallDetails(
    normalizedRequest.messages as Array<{ role: string; content: unknown }>,
  );
  const qwenLoopRiskOpenAI = adapter.family === "qwen3-coder" && detectQwenLoopRisk(oaiRecentCallsForSteering);
  const prunedTools = pruneToolSchemas(
    rawTools,
    toolBudget,
    extractRecentToolNames(normalizedRequest.messages as Array<{ role: string; content: unknown }>),
    extractRequestedToolNames(String(latestUserText?.content ?? ""), rawTools),
  );
  toolSchemaPruningStats.requestsConsidered += 1;
  if (prunedTools.pruned) {
    toolSchemaPruningStats.requestsPruned += 1;
    toolSchemaPruningStats.toolsPrunedTotal += prunedTools.prunedCount;
  }
  const prioritizedTools = prioritizeWriteCapableTools(prunedTools.tools, qwenLoopRiskOpenAI);
  let effectiveTools = enrichToolSchemasForAdapter(prioritizedTools, adapter);
  const clientToolChoice = mapToolChoice(normalizedRequest.tool_choice);
  if (normalizedRequest.tool_choice !== undefined && clientToolChoice === undefined) {
    return reply.code(400).send({
      error: {
        type: "invalid_request_error",
        message: "Invalid tool_choice. Expected auto|none|required|any or object form {type:\"tool\",name:\"...\"}.",
      },
    });
  }
  const oaiPhasePolicy = derivePhaseExecutionPolicy({
    enabled: config.SYNESIS_YARN_PHASE_EXECUTION_POLICY_ENABLED,
    adapterFamily: adapter.family,
    enabledFamilies: config.SYNESIS_YARN_PHASE_EXECUTION_POLICY_FAMILIES,
    phase: oaiGovernorPhase,
    matchedRules: oaiExecutionGovernor.matchedRules,
    stream: !!normalizedRequest.stream,
    editContextMissActive: oaiEditMissGuard?.active === true,
  });
  const oaiPhaseFiltered = filterToolsByPhasePolicy(effectiveTools as unknown[], oaiPhasePolicy);
  effectiveTools = oaiPhaseFiltered.tools;
  let effectiveToolChoice = resolvePhaseToolChoice(clientToolChoice as PhaseAwareToolChoice | undefined, oaiPhasePolicy);
  if (oaiEditMissGuard?.active) {
    // Guard fires regardless of phase policy. When both fire together (source_file_stale_reread
    // forces write-only tools AND the model has stale anchors), we added Read back to the
    // phase policy's allowed list via editContextMissActive above. In standalone mode (no phase
    // policy), strip write tools entirely and force Read. In both modes, force tool_choice=Read
    // to break the loop.
    const guardMode = oaiPhasePolicy.active ? "alongside_phase_policy" : "standalone";
    const gated = guardMode === "standalone"
      ? applyEditContextMissReadGate(effectiveTools as unknown[])
      : { tools: effectiveTools as unknown[], removed: [] as string[], forcedReadToolName: findPreferredReadToolName(effectiveTools as unknown[]) };
    if (guardMode === "standalone") effectiveTools = gated.tools ?? effectiveTools;
    let forcedReadToolName = gated.forcedReadToolName;
    const ensuredRead = ensureReadToolAvailabilityForEditMissGuard(
      effectiveTools as unknown[] | undefined,
      oaiClientToolInventory,
    );
    effectiveTools = ensuredRead.tools ?? effectiveTools;
    if (!forcedReadToolName && ensuredRead.readToolName) {
      forcedReadToolName = ensuredRead.readToolName;
    }
    if (ensuredRead.rehydrated) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "edit_context_miss_guard_rehydrated_read",
        "execution-governor",
        `Reintroduced read tool for edit-context recovery file=${oaiEditMissGuard.filePath}`,
        reqId,
        {
          filePath: oaiEditMissGuard.filePath,
          read_tool: ensuredRead.readToolName ?? null,
        },
      );
    }
    if (!ensuredRead.available) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "edit_context_miss_guard_read_missing",
        "execution-governor",
        `Invariant violation: no read-capable tool available while edit-context guard is active for ${oaiEditMissGuard.filePath}`,
        reqId,
        {
          filePath: oaiEditMissGuard.filePath,
          matched_rules: oaiExecutionGovernor.matchedRules,
          phase: oaiGovernorPhase,
        },
      );
    }
    if (gated.removed.length > 0 || forcedReadToolName || ensuredRead.rehydrated || !ensuredRead.available) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "edit_context_miss_guard_enforced",
        "execution-governor",
        `mode=${guardMode} removed_write_tools=${gated.removed.length} file=${oaiEditMissGuard.filePath}`,
        reqId,
        {
          filePath: oaiEditMissGuard.filePath,
          missCount: oaiEditMissGuard.missCount,
          removed_tools: gated.removed,
          forced_read_tool: forcedReadToolName ?? null,
          guard_mode: guardMode,
          read_rehydrated: ensuredRead.rehydrated,
          read_available: ensuredRead.available,
        },
      );
    }
    if (forcedReadToolName) {
      effectiveToolChoice = { type: "tool", toolName: forcedReadToolName };
    }
  }
  const sdkTools = openAIToolsToSDK(effectiveTools as never);
  const oaiForensicsPhasePolicy: RequestForensicsRecord["phasePolicy"] = {
    enabled: oaiPhasePolicy.active,
    source: clientToolChoice !== undefined ? "client" : (effectiveToolChoice !== undefined ? "phase_policy" : "none"),
    phase: oaiGovernorPhase,
    effectiveToolChoice: typeof effectiveToolChoice === "string" ? effectiveToolChoice : effectiveToolChoice ? "tool" : undefined,
    filteredToolCount: oaiPhaseFiltered.removed.length,
    downgradedForStreaming: !!oaiPhasePolicy.downgradedForStreaming,
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
      },
    );
  }

  const modelToolPrompt = mergeToolSystemPrompts(
    adapter.toolSystemPrompt?.(effectiveTools.length),
    buildRetrievalPolicyToolPromptFragment(effectiveTools as unknown[]),
  );
  let modelMessages = modelToolPrompt
    ? ([{ role: "system" as const, content: modelToolPrompt }, ...messages] as typeof messages)
    : messages;
  if (policyPrecheck.pivotPrompt) {
    modelMessages = [...modelMessages, { role: "system" as const, content: policyPrecheck.pivotPrompt }] as typeof modelMessages;
  }
  if (oaiEditMissGuard?.active) {
    modelMessages = appendSystemMessageAndNormalize(
      modelMessages as Array<{ role: string; content?: unknown }>,
      buildEditContextMissGuardPrompt(oaiEditMissGuard.filePath, oaiEditMissGuard.missCount),
    ) as typeof modelMessages;
  }

  // Adapter-specific early pivot and same-tool dampening (fires after generic governance).
  // Skip when the execution governor already injected a recovery block — stacking both
  // creates compound noise that confuses the model with overlapping guidance.
  const oaiGovernorAlreadyIntervened = oaiExecutionGovernor.pause && config.SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED;
  if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED && !policyPrecheck.pivotPrompt && !oaiGovernorAlreadyIntervened && adapter.family === "qwen3-coder") {
    const oaiRecentCalls = oaiRecentCallsForSteering;
    const oaiRecentAssistantText = extractRecentAssistantText(
      normalizedRequest.messages as Array<{ role: string; content: unknown }>,
    );
    const oaiRecentToolResultText = extractRecentToolResultText(
      normalizedRequest.messages as Array<{ role: string; content: unknown }>,
    );
    const turnMarker = nextQwenInterventionTurn(sessionKey);
    if (adapter.getEarlyPivotPrompt) {
      const earlyPivot = adapter.getEarlyPivotPrompt(oaiRecentCalls, {
        recentAssistantText: oaiRecentAssistantText,
        recentUserPrompt: oaiTaskCue,
        recentToolResultText: oaiRecentToolResultText,
        stagnationWindow: config.SYNESIS_YARN_QWEN_STAGNATION_WINDOW,
        stagnationThreshold: config.SYNESIS_YARN_QWEN_STAGNATION_THRESHOLD,
        planNoActionLimit: config.SYNESIS_YARN_QWEN_PLAN_NO_ACTION_LIMIT,
        editRetryLimit: config.SYNESIS_YARN_QWEN_EDIT_RETRY_LIMIT,
      });
      if (earlyPivot) {
        const pivotKind = classifyQwenPivotEvent(earlyPivot, oaiRecentCalls, "early");
        const decision = shouldSuppressQwenIntervention(sessionKey, turnMarker, pivotKind);
        if (decision === "hard_stop") {
          app.log.warn(
            { sessionKey, family: adapter.family, turnMarker, pivotKind },
            "adapter_qwen_ignored_pivot_hard_stop",
          );
          const forcedRecovery = `${earlyPivot}\nCRITICAL: Do not ask the user for guidance. Continue autonomously by taking exactly one concrete action now: apply one focused Edit/Write that advances the requested task, then run one narrow verification command.`;
          modelMessages = appendSystemMessageAndNormalize(
            modelMessages as Array<{ role: string; content?: unknown }>,
            forcedRecovery,
          ) as typeof modelMessages;
          markQwenIntervention(sessionKey, turnMarker, pivotKind);
          recordSessionEvent(sessionKey, identity.userId, identity.orgId, "adapter_pivot_auto_recover", "adapter", `${pivotKind}: forced continue after ignored pivots`, oaiTraceReqId);
        } else if (decision === "suppress") {
          app.log.info(
            { sessionKey, family: adapter.family, turnMarker },
            "adapter_qwen_cooldown_suppressed",
          );
        } else {
          modelMessages = appendSystemMessageAndNormalize(
            modelMessages as Array<{ role: string; content?: unknown }>,
            earlyPivot,
          ) as typeof modelMessages;
          markQwenIntervention(sessionKey, turnMarker, pivotKind);
          app.log.info(
            { sessionKey, family: adapter.family, pivotLen: earlyPivot.length },
            pivotKind,
          );
        }
      }
    }
    if (adapter.dampenConsecutiveSameTools) {
      const oaiToolNames = oaiRecentCalls.map((c) => c.toolName);
      const dampening = adapter.dampenConsecutiveSameTools(oaiToolNames);
      if (dampening) {
        const dampeningPivotKind = classifyQwenPivotEvent(dampening, oaiRecentCalls, "dampening");
        const decision = shouldSuppressQwenIntervention(sessionKey, turnMarker, dampeningPivotKind);
        if (decision === "hard_stop") {
          app.log.warn(
            { sessionKey, family: adapter.family, turnMarker, pivotKind: dampeningPivotKind },
            "adapter_qwen_ignored_pivot_hard_stop",
          );
          const forcedRecovery = `${dampening}\nCRITICAL: Do not ask the user for guidance. Continue autonomously by taking exactly one concrete action now: apply one focused Edit/Write that advances the requested task, then run one narrow verification command.`;
          modelMessages = appendSystemMessageAndNormalize(
            modelMessages as Array<{ role: string; content?: unknown }>,
            forcedRecovery,
          ) as typeof modelMessages;
          markQwenIntervention(sessionKey, turnMarker, dampeningPivotKind);
          recordSessionEvent(sessionKey, identity.userId, identity.orgId, "adapter_pivot_auto_recover", "adapter", "dampening: forced continue after ignored pivots", oaiTraceReqId);
        } else if (decision === "suppress") {
          app.log.info(
            { sessionKey, family: adapter.family, turnMarker },
            "adapter_qwen_cooldown_suppressed",
          );
        } else {
          modelMessages = appendSystemMessageAndNormalize(
            modelMessages as Array<{ role: string; content?: unknown }>,
            dampening,
          ) as typeof modelMessages;
          markQwenIntervention(sessionKey, turnMarker, dampeningPivotKind);
          app.log.info({ sessionKey, family: adapter.family, dampenLen: dampening.length }, "adapter_dampening_oai");
        }
      }
    }
  }

  modelMessages = normalizeSystemMessageOrdering(modelMessages as Array<{ role: string }>) as typeof modelMessages;

  const adapterProviderOptions = adapter.providerOptions?.() as Record<string, Record<string, unknown>> | undefined;
  const adapterSampling = adapter.defaultSamplingParams?.();
  const oaiEffectiveTemp = request.temperature ?? adapterSampling?.temperature;
  const oaiEffectiveTopP = adapterSampling?.top_p;
  const oaiContextAdmission = evaluateContextAdmission(
    modelMessages as Array<{ role: string; content: unknown }>,
    effectiveTools as unknown[],
    config.SYNESIS_YARN_CONTEXT_ADMISSION_MODE,
    config.SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS,
    config.SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS,
  );
  contextAdmissionStats.checked += 1;
  contextAdmissionStats.byPath.openai += 1;
  if (oaiContextAdmission.decision === "warn") {
    contextAdmissionStats.warned += 1;
    app.log.warn(
      {
        requestId: reqId,
        estimatedTokens: oaiContextAdmission.estimatedTokens,
        estimatedChars: oaiContextAdmission.estimatedChars,
        reason: oaiContextAdmission.reason,
      },
      "context_admission_warn_openai",
    );
  }
  if (oaiContextAdmission.decision === "reject") {
    contextAdmissionStats.rejected += 1;
    app.log.warn(
      {
        requestId: reqId,
        estimatedTokens: oaiContextAdmission.estimatedTokens,
        estimatedChars: oaiContextAdmission.estimatedChars,
        reason: oaiContextAdmission.reason,
      },
      "context_admission_reject_openai",
    );
    return reply.code(400).send({
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
    });
  }

  if (!normalizedRequest.stream) {
    if (!circuitBreakers.allowRequest(resolved.resolvedModelId, identity.orgId)) {
      app.log.warn({ model: resolved.resolvedModelId, orgId: identity.orgId }, "circuit_breaker_open");
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, "breaker_open_reject", "circuit-breaker",
        `Circuit breaker open for ${resolved.resolvedModelId}`, reqId, { model: resolved.resolvedModelId });
      reply.header("Retry-After", "30");
      return reply.code(503).send({ error: { type: "service_unavailable", message: "Model provider temporarily unavailable. Try again shortly." } });
    }
    const otelSpan = getTracer().startSpan("yarn.openai.generate", { model: resolved.resolvedModelId, sessionKey });
    const started = Date.now();
    let finalResult;
    let lastOpenAiForensics: RequestForensicsRecord | undefined;
    try {
      let currentMessages = modelMessages;
      const firstForensics = captureRequestForensics(
        sessionKey,
        reqId,
        "/v1/chat/completions",
        resolved.resolvedModelId,
        false,
        currentMessages as Array<{ role: string; content: unknown }>,
        effectiveTools as unknown[],
        effectiveToolChoice,
        adapterProviderOptions,
        oaiForensicsPhasePolicy,
      );
      finalResult = await generateText({
        model: resolved.model as never,
        messages: currentMessages,
      maxOutputTokens: clampMaxOutputTokensForSafety(
        Math.max(orchestration.maxOutputTokens, request.max_tokens ?? request.max_completion_tokens ?? 0),
      ),
        ...(oaiEffectiveTemp !== undefined ? { temperature: oaiEffectiveTemp } : {}),
        ...(oaiEffectiveTopP !== undefined ? { topP: oaiEffectiveTopP } : {}),
        ...(sdkTools ? { tools: sdkTools } : {}),
        ...(effectiveToolChoice ? { toolChoice: effectiveToolChoice } : {}),
        ...(adapterProviderOptions ? { providerOptions: adapterProviderOptions as never } : {})
      });
      const firstCalls = (finalResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
      let firstValidation = validateRequiredToolCalls(firstCalls, oaiPhasePolicy);
      if (!firstValidation.valid && oaiPhasePolicy.toolChoice === "required") {
        recordSessionEvent(
          sessionKey,
          identity.userId,
          identity.orgId,
          "phase_required_validation_retry",
          "execution-governor",
          `reasons=${firstValidation.reasons.join(",") || "unknown"}`,
          reqId,
        );
        currentMessages = appendSystemMessageAndNormalize(
          currentMessages as Array<{ role: string; content?: unknown }>,
          buildRequiredRepairPrompt(oaiGovernorPhase, oaiPhasePolicy.allowedCanonicalTools),
        ) as typeof currentMessages;
        const repairForensics = captureRequestForensics(
          sessionKey,
          reqId,
          "/v1/chat/completions",
          resolved.resolvedModelId,
          false,
          currentMessages as Array<{ role: string; content: unknown }>,
          effectiveTools as unknown[],
          effectiveToolChoice,
          adapterProviderOptions,
          oaiForensicsPhasePolicy,
        );
        finalResult = await generateText({
          model: resolved.model as never,
          messages: currentMessages,
          maxOutputTokens: clampMaxOutputTokensForSafety(
            Math.max(orchestration.maxOutputTokens, request.max_tokens ?? request.max_completion_tokens ?? 0),
          ),
          ...(oaiEffectiveTemp !== undefined ? { temperature: oaiEffectiveTemp } : {}),
          ...(oaiEffectiveTopP !== undefined ? { topP: oaiEffectiveTopP } : {}),
          ...(sdkTools ? { tools: sdkTools } : {}),
          ...(effectiveToolChoice ? { toolChoice: effectiveToolChoice } : {}),
          ...(adapterProviderOptions ? { providerOptions: adapterProviderOptions as never } : {}),
        });
        const repairedUsage = readUsage((finalResult as unknown as { usage?: unknown }).usage);
        lastOpenAiForensics = finalizeRequestForensics(session, reqId, repairForensics, repairedUsage);
        const repairedCalls = (finalResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
        firstValidation = validateRequiredToolCalls(repairedCalls, oaiPhasePolicy);
        if (!firstValidation.valid) {
          recordSessionEvent(
            sessionKey,
            identity.userId,
            identity.orgId,
            "phase_required_validation_fallback",
            "execution-governor",
            `fallback_after_retry reasons=${firstValidation.reasons.join(",") || "unknown"}`,
            reqId,
          );
          effectiveToolChoice = "auto";
          currentMessages = appendSystemMessageAndNormalize(
            currentMessages as Array<{ role: string; content?: unknown }>,
            "Phase execution policy fallback: required tool-call contract failed after retry. Continue with tool_choice=auto and recover safely.",
          ) as typeof currentMessages;
          const fallbackForensics = captureRequestForensics(
            sessionKey,
            reqId,
            "/v1/chat/completions",
            resolved.resolvedModelId,
            false,
            currentMessages as Array<{ role: string; content: unknown }>,
            effectiveTools as unknown[],
            effectiveToolChoice,
            adapterProviderOptions,
            oaiForensicsPhasePolicy,
          );
          finalResult = await generateText({
            model: resolved.model as never,
            messages: currentMessages,
            maxOutputTokens: clampMaxOutputTokensForSafety(
              Math.max(orchestration.maxOutputTokens, request.max_tokens ?? request.max_completion_tokens ?? 0),
            ),
            ...(oaiEffectiveTemp !== undefined ? { temperature: oaiEffectiveTemp } : {}),
            ...(oaiEffectiveTopP !== undefined ? { topP: oaiEffectiveTopP } : {}),
            ...(sdkTools ? { tools: sdkTools } : {}),
            ...(effectiveToolChoice ? { toolChoice: effectiveToolChoice } : {}),
            ...(adapterProviderOptions ? { providerOptions: adapterProviderOptions as never } : {}),
          });
          const fallbackUsage = readUsage((finalResult as unknown as { usage?: unknown }).usage);
          lastOpenAiForensics = finalizeRequestForensics(session, reqId, fallbackForensics, fallbackUsage);
        }
      } else {
        const firstUsage = readUsage((finalResult as unknown as { usage?: unknown }).usage);
        lastOpenAiForensics = finalizeRequestForensics(session, reqId, firstForensics, firstUsage);
      }

      const SERVER_SIDE_TOOLS = new Set([ARTIFACT_TOOL_NAME, KNOWLEDGE_TOOL_NAME, DEV_DOCS_TOOL_NAME, WEB_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_ALIAS]);
      for (let round = 0; round < 3; round++) {
        const allCalls = (finalResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
        const serverCalls = allCalls.filter((tc) => SERVER_SIDE_TOOLS.has(tc.toolName));
        if (serverCalls.length === 0) break;
        const clientCalls = allCalls.filter((tc) => !SERVER_SIDE_TOOLS.has(tc.toolName));

        const toolResults: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: { type: "text"; value: string } }> = [];
        for (const ac of serverCalls) {
          if (ac.toolName === ARTIFACT_TOOL_NAME) {
            const inp = ac.input as { artifact_handle?: string; query?: string };
            const result = artifactRetrieval.retrieve(inp.artifact_handle ?? "", inp.query);
            toolResults.push({
              type: "tool-result",
              toolCallId: ac.toolCallId,
              toolName: ARTIFACT_TOOL_NAME,
              output: { type: "text", value: result.content }
            });
          } else if (ac.toolName === KNOWLEDGE_TOOL_NAME) {
            const inp = ac.input as Record<string, unknown>;
            const result = await knowledgeSearch.resolve(inp, knowledgeResolveContext(authUser, req));
            toolResults.push({
              type: "tool-result",
              toolCallId: ac.toolCallId,
              toolName: KNOWLEDGE_TOOL_NAME,
              output: { type: "text", value: JSON.stringify(result) }
            });
          } else if (ac.toolName === DEV_DOCS_TOOL_NAME) {
            const inp = ac.input as Record<string, unknown>;
            const result = await knowledgeSearch.resolveDevDocs(inp, knowledgeResolveContext(authUser, req));
            toolResults.push({
              type: "tool-result",
              toolCallId: ac.toolCallId,
              toolName: DEV_DOCS_TOOL_NAME,
              output: { type: "text", value: JSON.stringify(result) }
            });
          } else if (ac.toolName === WEB_SEARCH_TOOL_NAME || ac.toolName === WEB_SEARCH_TOOL_ALIAS) {
            const inp = ac.input as Record<string, unknown>;
            const result = await webSearch.resolve(
              inp,
              webSearchResolveContext(authUser, req, {
                requestId: reqId,
                sessionKey,
                conversationId: session.record.conversationId || undefined,
                traceId: reqId,
                sourceSurface: "yarn_chat",
                toolName: WEB_SEARCH_TOOL_NAME,
              }),
            );
            toolResults.push({
              type: "tool-result",
              toolCallId: ac.toolCallId,
              toolName: WEB_SEARCH_TOOL_NAME,
              output: { type: "text", value: JSON.stringify(result) },
            });
          }
        }

        if (clientCalls.length > 0) break;

        const assistantParts: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }> = [];
        if (finalResult.text) assistantParts.push({ type: "text", text: finalResult.text });
        for (const ac of serverCalls) {
          assistantParts.push({ type: "tool-call", toolCallId: ac.toolCallId, toolName: ac.toolName, input: ac.input });
        }
        if (assistantParts.length === 0) assistantParts.push({ type: "text", text: "" });

        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: assistantParts } as never,
          { role: "tool", content: toolResults } as never
        ];

        const loopForensics = captureRequestForensics(
          sessionKey,
          reqId,
          "/v1/chat/completions",
          resolved.resolvedModelId,
          false,
          currentMessages as Array<{ role: string; content: unknown }>,
          effectiveTools as unknown[],
          effectiveToolChoice,
          adapterProviderOptions,
          oaiForensicsPhasePolicy,
        );
        finalResult = await generateText({
          model: resolved.model as never,
          messages: currentMessages,
          maxOutputTokens: clampMaxOutputTokensForSafety(
            Math.max(orchestration.maxOutputTokens, request.max_tokens ?? request.max_completion_tokens ?? 0),
          ),
          ...(oaiEffectiveTemp !== undefined ? { temperature: oaiEffectiveTemp } : {}),
          ...(oaiEffectiveTopP !== undefined ? { topP: oaiEffectiveTopP } : {}),
          ...(sdkTools ? { tools: sdkTools } : {}),
          ...(effectiveToolChoice ? { toolChoice: effectiveToolChoice } : {})
        });
        const loopUsage = readUsage((finalResult as unknown as { usage?: unknown }).usage);
        lastOpenAiForensics = finalizeRequestForensics(session, reqId, loopForensics, loopUsage);
      }
    } catch (err) {
      const upstream = extractUpstreamErrorDiagnostics(err);
      circuitBreakers.recordFailure(resolved.resolvedModelId, identity.orgId);
      otelSpan.setStatus("error", upstream.userMessage);
      otelSpan.end();
      app.log.error(
        {
          err,
          reqId,
          model: resolved.resolvedModelId,
          upstream_error_name: upstream.errorName,
          upstream_error_code: upstream.errorCode,
          upstream_http_status: upstream.httpStatus,
          upstream_vercel_ai_sdk_error: upstream.isVercelAiSdkError,
          upstream_missing_tool_results: upstream.isMissingToolResults,
          upstream_raw_message: upstream.rawMessage.slice(0, 600),
        },
        "OpenAI non-stream generateText failed",
      );
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "upstream_error",
        "generateText",
        upstream.userMessage,
        reqId,
        {
          model: resolved.resolvedModelId,
          error_name: upstream.errorName ?? "",
          error_code: upstream.errorCode ?? "",
          error_status: upstream.httpStatus ?? 0,
          vercel_ai_sdk_error: upstream.isVercelAiSdkError,
          missing_tool_results: upstream.isMissingToolResults,
        },
      );
      return reply.code(502).send({ error: { type: "upstream_error", message: upstream.userMessage } });
    }
    circuitBreakers.recordSuccess(resolved.resolvedModelId, identity.orgId);
    otelSpan.setStatus("ok");
    otelSpan.end();

    const toolCalls = (finalResult as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
    let finalAssistantText = finalResult.text;
    let externalToolCalls = toolCalls
      .filter((tc) => tc.toolName !== ARTIFACT_TOOL_NAME)
      .map((tc) => {
        const rawInput =
          typeof tc.input === "object" && tc.input !== null && !Array.isArray(tc.input)
            ? (tc.input as Record<string, unknown>)
            : {};
        const hard = applyAdapterToolHardening(adapter, tc.toolName, rawInput);
        if (hard.remapped) toolArgHardeningStats.remappedArgsCount += 1;
        if (hard.repairedWrite) {
          toolArgHardeningStats.repairedWriteCount += 1;
          app.log.warn(
            {
              reqId,
              originalTool: tc.toolName,
              rewrittenTo: "Bash",
              filePath: rawInput.file_path ?? rawInput.path,
            },
            "write_tool_repaired_to_bash_heredoc",
          );
        }
        if (hard.repairedBash) {
          toolArgHardeningStats.repairedBashCount += 1;
          app.log.warn({ reqId, toolName: hard.toolName, bashRepaired: true }, "bash_tool_args_repaired");
        }
        if (isWriteCapableToolName(hard.toolName)) {
          session.blockBroadVerificationUntilEdit = false;
          session.blockFailingVerificationUntilEdit = false;
        }
        const governed = governToolCall({
          toolName: hard.toolName,
          input: hard.input,
          projectRoot: effectiveOaiPathCtx.projectRoot,
          shellCwd: effectiveOaiPathCtx.shellCwd,
          enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
          blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
          strictBashBlock: openClawStrictGovernance,
          blockWriteCapableTools: openClawStrictGovernance,
          clientKind: oaiClientKind,
          restrictDiscoveryForPlanWork: shouldRestrictDiscoveryForPlanWork(oaiTaskCue),
          blockBroadVerificationForGreen: session.blockBroadVerificationUntilEdit,
          blockVerificationForFailure: session.blockFailingVerificationUntilEdit,
          planContentShadow: deserializeShadow(session.record.metadata.plan_content_shadow as Record<string, unknown>),
        });
        trackGovernedHardening(governed);
        if (governed.planWriteAudit) {
          emitPlanWriteAuditEvent(sessionKey, identity.userId, identity.orgId, reqId, governed.planWriteAudit);
        }
        maybeLogEnvelopeUnwrapSample(app.log as never, reqId, governed.toolName, oaiClientKind, governed, tc.toolCallId);
        if (governed.validationMissing.length > 0) {
          app.log.warn(
            { reqId, toolName: governed.toolName, missing: governed.validationMissing },
            "tool_args_validation_failed",
          );
        }
        if (openClawStrictGovernance && isWriteCapableToolName(tc.toolName) && governed.toolName === "Bash") {
          openClawProfileStats.strictGovernanceRewrites += 1;
        }
        return {
          toolCallId: tc.toolCallId,
          toolName: governed.toolName,
          input: governed.input,
        };
      });
    let oaiBlockedBroadDiscovery = 0;
    let oaiRedirectedBroadDiscovery = 0;
    let oaiCollapsedBroadDiscovery = 0;
    const oaiTopLevelDirs = await getCachedTopLevelDirs(effectiveOaiPathCtx.projectRoot ?? effectiveOaiPathCtx.shellCwd);
    const oaiGuarded = applyDiscoveryToolGuardrail(externalToolCalls, oaiTopLevelDirs);
    externalToolCalls = oaiGuarded.calls;
    oaiBlockedBroadDiscovery = oaiGuarded.blockedCount;
    oaiRedirectedBroadDiscovery = oaiGuarded.redirectedCount;
    oaiCollapsedBroadDiscovery = oaiGuarded.collapsedCount;
    if (oaiRedirectedBroadDiscovery > 0) {
      recordBlockedDiscovery(sessionKey, oaiRedirectedBroadDiscovery);
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "broad_discovery_redirected",
        "tool-guardrails",
        `redirected=${oaiRedirectedBroadDiscovery};sessionTotal=${getBlockedDiscoveryCount(sessionKey)}`,
        reqId,
        { redirectedDetails: oaiGuarded.redirectedDetails.slice(0, 5), sessionBlockedTotal: getBlockedDiscoveryCount(sessionKey) },
      );
    }
    if (oaiBlockedBroadDiscovery > 0) {
      const sessionBlockedTotal = recordBlockedDiscovery(sessionKey, oaiBlockedBroadDiscovery);
      const recovery = await buildBlockedDiscoveryRecoverySnapshot(
        resolved.resolvedModelId,
        oaiGuarded.blockedDetails,
        effectiveOaiPathCtx.projectRoot,
      );
      finalAssistantText = [
        finalAssistantText?.trim() ?? "",
        recovery.text,
      ].filter(Boolean).join("\n\n");
      if (sessionBlockedTotal >= 2) {
        finalAssistantText += "\n\nCRITICAL: Glob has been blocked multiple times in this session. The Glob tool will be removed from your available tools. Use Read and Grep instead.";
      }
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "tool_call_blocked_broad_discovery",
        "tool-guardrails",
        `blocked=${oaiBlockedBroadDiscovery};sessionTotal=${sessionBlockedTotal}`,
        reqId,
        { blockedDetails: oaiGuarded.blockedDetails.slice(0, 5), recoveryMode: recovery.recoveryMode, sessionBlockedTotal },
      );
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "blocked_broad_discovery_then_recovery",
        "tool-guardrails",
        `mode=${recovery.recoveryMode};top_level_preview=${recovery.entryCount}`,
        reqId,
        { recoveryMode: recovery.recoveryMode, topLevelPreview: recovery.entryCount },
      );
    }
    if (oaiCollapsedBroadDiscovery > 0) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "duplicate_broad_call_collapsed",
        "tool-guardrails",
        `collapsed=${oaiCollapsedBroadDiscovery}`,
        reqId,
      );
    }
    if (
      config.SYNESIS_YARN_TOOL_COLLAPSE_ENABLED &&
      config.SYNESIS_YARN_TOOL_COLLAPSE_REWRITE_NON_STREAM &&
      String(req.headers["x-synesis-tool-collapse"] ?? "") === "apply" &&
      externalToolCalls.length > 1
    ) {
      const workspaceRoot = resolveWorkspaceRootForCollapse(
        req.headers as Record<string, string | string[] | undefined>,
        oaiBodyMeta,
      );
      const allowlist = defaultShellAllowlistFromEnv(config.SYNESIS_YARN_TOOL_COLLAPSE_SHELL_ALLOWLIST);
      const collapseInterceptor = new ToolCallInterceptor({
        workspaceRoot,
        shellAllowlist: allowlist,
        strictValidation: true,
        execute: false,
        executor: null,
        dedupeLayer: yarnDedupeLayer,
        toolPrefixCache: yarnToolPrefixCache,
        log: ({ msg, data }) => app.log.info({ msg, ...data }, "tool_collapse_non_stream"),
      });
      const parsedCalls = externalToolCalls.map((tc) => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input,
      }));
      const collapseResult = await collapseInterceptor.processImmediate(parsedCalls);
      if (collapseResult.validated.ok && collapseResult.usedCollapse) {
        const synthetic = planToSyntheticToolCalls(collapseResult.plan);
        externalToolCalls = synthetic.map((s) => ({
          toolCallId: s.toolCallId,
          toolName: s.toolName,
          input: s.input,
        }));
        app.log.info({ from: parsedCalls.length, to: synthetic.length, reqId }, "tool_collapse_rewrite_non_stream");
      }
    }
    finalAssistantText = finalAssistantText ?? "";
    const oaiLegacyGuarded = applyDiscoveryToolGuardrail(externalToolCalls, oaiTopLevelDirs);
    externalToolCalls = oaiLegacyGuarded.calls;
    if (oaiLegacyGuarded.redirectedCount > 0) {
      oaiRedirectedBroadDiscovery += oaiLegacyGuarded.redirectedCount;
      recordBlockedDiscovery(sessionKey, oaiLegacyGuarded.redirectedCount);
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, "broad_discovery_redirected", "tool-guardrails",
        `redirected=${oaiLegacyGuarded.redirectedCount};sessionTotal=${getBlockedDiscoveryCount(sessionKey)}`, reqId,
        { redirectedDetails: oaiLegacyGuarded.redirectedDetails.slice(0, 5), sessionBlockedTotal: getBlockedDiscoveryCount(sessionKey) });
    }
    if (oaiLegacyGuarded.blockedCount > 0) {
      const oaiLegacyBlockedTotal = recordBlockedDiscovery(sessionKey, oaiLegacyGuarded.blockedCount);
      const recovery = await buildBlockedDiscoveryRecoverySnapshot(
        resolved.resolvedModelId,
        oaiLegacyGuarded.blockedDetails,
        effectiveOaiPathCtx.projectRoot,
      );
      finalAssistantText = [
        finalAssistantText?.trim() ?? "",
        recovery.text,
      ].filter(Boolean).join("\n\n");
      if (oaiLegacyBlockedTotal >= 2) {
        finalAssistantText += "\n\nCRITICAL: Glob has been blocked multiple times in this session. The Glob tool will be removed from your available tools. Use Read and Grep instead.";
      }
      oaiBlockedBroadDiscovery += oaiLegacyGuarded.blockedCount;
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, "tool_call_blocked_broad_discovery", "tool-guardrails",
        `blocked=${oaiLegacyGuarded.blockedCount};sessionTotal=${oaiLegacyBlockedTotal}`, reqId,
        { blockedDetails: oaiLegacyGuarded.blockedDetails.slice(0, 5), sessionBlockedTotal: oaiLegacyBlockedTotal });
    }
    if (oaiLegacyGuarded.collapsedCount > 0) {
      oaiCollapsedBroadDiscovery += oaiLegacyGuarded.collapsedCount;
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "duplicate_broad_call_collapsed",
        "tool-guardrails",
        `collapsed=${oaiLegacyGuarded.collapsedCount}`,
        reqId,
      );
    }
    const finishReason = externalToolCalls.length > 0 ? "tool_calls" : "stop";
    finalAssistantText = applyMarkdownGuardrail(
      finalAssistantText,
      config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
    );
    let oaiGateApplied = false;
    let oaiMissingMust = 0;
    let oaiMissingShould = 0;
    let oaiGateBlockedVerification = false;
    let oaiCriticBlocked = false;
    if (finishReason === "stop") {
      const finalized = await finalizeCompletionText({
        requestId: reqId,
        sessionKey,
        userId: identity.userId,
        orgId: identity.orgId,
        assistantText: finalAssistantText,
        checklist: oaiRequirementChecklist,
        traceRootPrompt: getMetadataString(session.record.metadata, "trace_root_prompt"),
        latestUserPrompt: getMetadataString(session.record.metadata, "latest_user_prompt"),
        verification: oaiVerificationAssessment,
        recentToolNames: extractRecentToolNames(normalizedRequest.messages as Array<{ role: string; content: unknown }>),
        nonActionableEventDetail: "terminal stop had non-actionable text; emitted deterministic fallback",
        planGraph: oaiPlanGraph,
      });
      finalAssistantText = finalized.finalText;
      oaiGateApplied = finalized.applied;
      oaiMissingMust = finalized.missingMust;
      oaiMissingShould = finalized.missingShould;
      oaiGateBlockedVerification = finalized.blockedByVerification;
      oaiCriticBlocked = finalized.criticBlocked;
    }
    session.history.push({ role: "assistant", content: finalAssistantText });
    const usage = readUsage((finalResult as unknown as { usage?: unknown }).usage);
    const oaiLatency = Date.now() - started;
    const oaiSaved = toolResultReduction.getPerRequestDelta() + validationNormalization.getPerRequestDelta();
    const oaiGuidedTrimmed = toolResultReduction.getPerRequestGuidedTruncationDelta();
    const oaiTaskPruned = toolResultReduction.getPerRequestTaskPrunedDelta();
    if (oaiGuidedTrimmed > 0) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "tool_output_truncated_guided",
        "tool-guardrails",
        `count=${oaiGuidedTrimmed}`,
        reqId,
      );
    }
    if (oaiTaskPruned > 0) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "task_conditioned_prune_applied",
        "tool-reducer",
        `count=${oaiTaskPruned}`,
        reqId,
      );
    }
    const lastRecallOai = toolResultReduction.getLastRecallDecision();
    const vStateOai = toolResultReduction.getVerificationTracker().getState();
    const oaiSnapshot = buildDecisionSnapshot({
      orchestration,
      recallDecision: lastRecallOai,
      verificationState: vStateOai,
      policyMatchedRules: policyPrecheck.matchedRules,
      reducedToolResults: reducedOpenAI.reducedCount,
      tokensSavedByReduction: oaiSaved,
      evidencePrefetched: oaiPrefetchResult?.matched,
      evidenceConfidence: oaiPrefetchResult?.confidence,
      evidenceAuthoritative: oaiPrefetchResult?.authoritative,
      evidencePrefetchLatencyMs: oaiPrefetchResult ? Math.round(oaiPrefetchResult.latencyMs) : undefined,
      isStreaming: false,
      sensemakingTriggered: oaiSensemakingResult?.triggered,
      sensemakingReason: oaiSensemakingResult?.reason,
      governorDecision: oaiExecutionGovernor,
    });
    oaiOptLedger.setUpstreamCachedTokens(usage.cachedTokens ?? 0);
    oaiOptLedger.recordFinal(normalizedRequest.messages as Array<{ content?: unknown }>);
    const oaiLedgerSnap = oaiOptLedger.finalize();
    app.log.info({ reqId, ...oaiOptLedger.toLogRecord() }, "optimization_ledger");

    persistAndEmitDecisionTelemetry({
      state: session,
      requestId: reqId,
      resolvedModelId: resolved.resolvedModelId,
      usage,
      latencyMs: oaiLatency,
      finishReason,
      tokensSavedByReduction: oaiSaved,
      escalated: orchestration.escalated,
      snapshot: oaiSnapshot,
      trajectory: {
        toolSequence: externalToolCalls.map((tc) => tc.toolName),
        verificationSteps: inferVerificationSteps(externalToolCalls.map((tc) => tc.toolName)),
        diagnostics: oaiTrajectoryDiagnostics,
        completionGateBlocked: oaiGateBlockedVerification,
        criticBlocked: oaiCriticBlocked,
        outcomeState: (oaiGateBlockedVerification || oaiCriticBlocked) ? "partial" : undefined,
        failureStage: oaiGateBlockedVerification ? "verification" : undefined,
      },
      sessionKey,
      userId: identity.userId,
      orgId: identity.orgId,
      optimizationLedger: oaiLedgerSnap,
    });

    const msgCounts = countMessageRoles(normalizedRequest.messages as Array<{ role: string; content: unknown }>);
    pushDiagnostic({
      timestamp: Date.now(), sessionKey, path: "/v1/chat/completions", requestId: reqId,
      ...msgCounts,
      toolDefinitionCount: effectiveTools.length,
      artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
      knowledgeToolInjected: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
      reducedToolResults: reducedOpenAI.reducedCount,
      finishReason, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens,
      policyDecision: policyPrecheck.matchedRules.join(","), latencyMs: oaiLatency,
      recallRouting: lastRecallOai?.routing,
      recallConfidence: lastRecallOai?.resolution?.confidence,
      verificationRound: vStateOai.round > 0 ? vStateOai.round : undefined,
      verificationFindings: vStateOai.round > 0 ? vStateOai.findings.length : undefined,
      verificationStalled: vStateOai.stalled || undefined,
      decisionPath: orchestration.decisionPath,
      decisionEscalated: orchestration.escalated || undefined,
      sensemakingTriggered: oaiSensemakingResult?.triggered || undefined,
      sensemakingReason: oaiSensemakingResult?.reason,
      evidencePrefetchHit: oaiPrefetchResult?.matched && (oaiPrefetchResult?.confidence ?? 0) > 0 || undefined,
      evidencePrefetchConfidence: oaiPrefetchResult?.confidence || undefined,
      evidencePrefetchMs: oaiPrefetchResult ? Math.round(oaiPrefetchResult.latencyMs) : undefined,
      promptProfileIds: oaiEnriched.promptProfileIds,
      promptProfileHashes: oaiEnriched.promptProfileHashes,
      prefixHash: oaiEnriched.prefixHash,
      prefixChangeReasons: oaiEnriched.prefixChangeReasons,
      completionGateApplied: oaiGateApplied || undefined,
      missingMustRequirements: oaiMissingMust || undefined,
      missingShouldRequirements: oaiMissingShould || undefined,
      requirementChecklistMust: oaiRequirementChecklist?.must.length || undefined,
      requirementChecklistShould: oaiRequirementChecklist?.should.length || undefined,
      contextAdmissionDecision: oaiContextAdmission.decision,
      contextAdmissionReason: oaiContextAdmission.reason,
      contextAdmissionEstimatedTokens: oaiContextAdmission.estimatedTokens,
      contextAdmissionEstimatedChars: oaiContextAdmission.estimatedChars,
      requestForensicsSummary: lastOpenAiForensics?.summary,
      requestForensicsLcpRatio: lastOpenAiForensics?.lcpRatio,
      requestForensicsFirstChangedSection: lastOpenAiForensics?.firstChangedSection,
      requestForensicsTokenEstimate: lastOpenAiForensics?.tokenEstimate,
    });

    const message: Record<string, unknown> = { role: "assistant", content: finalAssistantText };
    if (externalToolCalls.length > 0) {
      message.tool_calls = sdkToolCallsToOpenAI(externalToolCalls);
    }
    applyClarificationRoundResponseHeader(reply, session.record.metadata);
    return reply.send({
      id: reqId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: resolved.resolvedModelId,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: toOpenAiUsage(usage),
    });
  }

  const oaiAdmission = await streamAdmission.acquire();
  if (!oaiAdmission.admitted) {
    app.log.warn({ reason: oaiAdmission.reason, queueStats: streamAdmission.getStats() }, "stream_admission_rejected");
    recordSessionEvent(sessionKey, identity.userId, identity.orgId, "stream_admission_reject", "stream-admission",
      oaiAdmission.reason ?? "stream admission rejected", reqId);
    reply.header("Retry-After", String(oaiAdmission.retryAfterSeconds ?? 5));
    return reply.code(503).send({ error: { type: "service_unavailable", message: "Server at capacity. Try again shortly." } });
  }

  if (!circuitBreakers.allowRequest(resolved.resolvedModelId, identity.orgId)) {
    oaiAdmission.release!();
    app.log.warn({ model: resolved.resolvedModelId, orgId: identity.orgId }, "circuit_breaker_open_stream");
    recordSessionEvent(sessionKey, identity.userId, identity.orgId, "breaker_open_reject", "circuit-breaker",
      `Circuit breaker open for ${resolved.resolvedModelId} (stream)`, reqId, { model: resolved.resolvedModelId });
    reply.header("Retry-After", "30");
    return reply.code(503).send({ error: { type: "service_unavailable", message: "Model provider temporarily unavailable. Try again shortly." } });
  }
  const otelStreamSpan = getTracer().startSpan("yarn.openai.stream", { model: resolved.resolvedModelId, sessionKey });
  const started = Date.now();
  const openAiStreamForensics = captureRequestForensics(
    sessionKey,
    reqId,
    "/v1/chat/completions (stream)",
    resolved.resolvedModelId,
    true,
    modelMessages as Array<{ role: string; content: unknown }>,
    effectiveTools as unknown[],
    effectiveToolChoice,
    adapterProviderOptions,
    oaiForensicsPhasePolicy,
  );
  const streamed = streamText({
    model: resolved.model as never,
    messages: modelMessages,
    maxOutputTokens: clampMaxOutputTokensForSafety(
      Math.max(orchestration.maxOutputTokens, request.max_tokens ?? request.max_completion_tokens ?? 0),
    ),
    ...(oaiEffectiveTemp !== undefined ? { temperature: oaiEffectiveTemp } : {}),
    ...(oaiEffectiveTopP !== undefined ? { topP: oaiEffectiveTopP } : {}),
    ...(sdkTools ? { tools: sdkTools } : {}),
    ...(effectiveToolChoice ? { toolChoice: effectiveToolChoice } : {}),
    ...(adapterProviderOptions ? { providerOptions: adapterProviderOptions as never } : {})
  });
  reply.raw.writeHead(200, sseHeadersWithClarification(session.record.metadata));
  const oaiHeartbeat = startSseHeartbeat({
    raw: reply.raw,
    intervalMs: config.SYNESIS_YARN_SSE_HEARTBEAT_INTERVAL_MS,
    longWaitEventMs: config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS,
    onLongWait: (elapsedMs) => {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "stream_long_wait",
        "stream-heartbeat",
        `OpenAI stream exceeded ${config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS}ms without finishing`,
        reqId,
        { elapsedMs, model: resolved.resolvedModelId },
      );
    },
  });

  let finishReason = "stop";
  const pendingToolCalls: Array<{ index: number; id: string; name: string; args: string }> = [];
  const pendingTextDeltas: string[] = [];
  const oaiStreamGuardrailAccepted: GuardrailToolCall[] = [];
  const oaiStreamBlockedDetails: BlockedDiscoveryDetail[] = [];
  let oaiStreamEmittedToolCalls = 0;
  let oaiStreamRecoveryPreviewEntries = 0;
  let oaiStreamRecoveryMode: DiscoveryRecoverySnapshot["recoveryMode"] | null = null;
  let oaiStreamBlockedBroadDiscovery = 0;
  let oaiStreamCollapsedBroadDiscovery = 0;
  let oaiStreamGateApplied = false;
  let oaiStreamMissingMust = 0;
  let oaiStreamMissingShould = 0;
  let oaiStreamGateBlockedVerification = false;
  let oaiStreamCriticBlocked = false;
  let oaiStreamToolRepairs = 0;
  let oaiStreamValidationFailures = 0;
  const resolvedTierOaiStream = tierRegistry.getTierConfig(resolved.resolvedModelId);
  const isLocalLikeOaiStreamBaseUrl =
    !!resolvedTierOaiStream?.baseUrl
    && (
      resolvedTierOaiStream.baseUrl.includes(".svc.cluster.local")
      || resolvedTierOaiStream.baseUrl.includes("localhost")
      || resolvedTierOaiStream.baseUrl.includes("127.0.0.1")
    );
  const oaiCacheStrategy = detectCacheStrategy(
    resolvedTierOaiStream?.baseUrl ?? "",
    resolvedTierOaiStream?.backendModel ?? resolved.resolvedModelId,
  );
  const oaiPrefixFingerprint = computePrefixFingerprint(
    modelMessages as Array<{ role: string; content: unknown }>,
  );

  const flushOpenAIText = (text: string): void => {
    if (!text) return;
    safeWrite(reply.raw, `data: ${JSON.stringify({
      id: reqId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: resolved.resolvedModelId,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}\n\n`);
  };

  try {
    for await (const part of streamed.fullStream) {
      const ts = Math.floor(Date.now() / 1000);
      if (part.type === "text-delta") {
        const td = (part as unknown as { text: string }).text ?? "";
        pendingTextDeltas.push(td);
        flushOpenAIText(td);
      } else if (part.type === "tool-call" || part.type === "tool-input-start") {
        const tc = part as unknown as { toolCallId?: string; toolName?: string; input?: unknown };
        if (pendingTextDeltas.length > 0) {
          pendingTextDeltas.length = 0;
        }
        if (part.type === "tool-input-start") {
          pendingToolCalls.push({ index: pendingToolCalls.length, id: tc.toolCallId ?? "", name: tc.toolName ?? "", args: "" });
        } else if (part.type === "tool-call") {
          finishReason = "tool_calls";
          let argsStr = typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {});
          const rawArgsLen = argsStr.length;
          if (adapter.normalizeToolCallArgs) argsStr = adapter.normalizeToolCallArgs(argsStr);
          const parsedInput =
            typeof tc.input === "object" && tc.input !== null && !Array.isArray(tc.input)
              ? (tc.input as Record<string, unknown>)
              : (() => {
                  try {
                    const parsed = JSON.parse(argsStr) as unknown;
                    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                      ? (parsed as Record<string, unknown>)
                      : {};
                  } catch {
                    return {};
                  }
                })();
          const hard = applyAdapterToolHardening(adapter, tc.toolName ?? "", parsedInput);
          if (hard.remapped) toolArgHardeningStats.remappedArgsCount += 1;
          if (hard.repairedWrite) {
            toolArgHardeningStats.repairedWriteCount += 1;
            oaiStreamToolRepairs += 1;
            app.log.warn(
              {
                reqId,
                originalTool: tc.toolName,
                rewrittenTo: "Bash",
                filePath: parsedInput.file_path ?? parsedInput.path,
              },
              "write_tool_repaired_to_bash_heredoc",
            );
          }
          if (hard.repairedBash) {
            toolArgHardeningStats.repairedBashCount += 1;
            oaiStreamToolRepairs += 1;
            app.log.warn({ reqId, toolName: hard.toolName, bashRepaired: true }, "bash_tool_args_repaired");
          }
          if (isWriteCapableToolName(hard.toolName)) {
            session.blockBroadVerificationUntilEdit = false;
            session.blockFailingVerificationUntilEdit = false;
          }
          const governed = governToolCall({
            toolName: hard.toolName,
            input: hard.input,
            projectRoot: effectiveOaiPathCtx.projectRoot,
            shellCwd: effectiveOaiPathCtx.shellCwd,
            enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
            blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
            strictBashBlock: openClawStrictGovernance,
            blockWriteCapableTools: openClawStrictGovernance,
            clientKind: oaiClientKind,
            restrictDiscoveryForPlanWork: shouldRestrictDiscoveryForPlanWork(oaiTaskCue),
            blockBroadVerificationForGreen: session.blockBroadVerificationUntilEdit,
            blockVerificationForFailure: session.blockFailingVerificationUntilEdit,
            planContentShadow: deserializeShadow(session.record.metadata.plan_content_shadow as Record<string, unknown>),
          });
          trackGovernedHardening(governed);
          if (governed.planWriteAudit) {
            emitPlanWriteAuditEvent(sessionKey, identity.userId, identity.orgId, reqId, governed.planWriteAudit);
          }
          maybeLogEnvelopeUnwrapSample(app.log as never, reqId, governed.toolName, oaiClientKind, governed, tc.toolCallId);
          if (governed.validationMissing.length > 0) {
            oaiStreamValidationFailures += 1;
            app.log.warn(
              { reqId, toolName: governed.toolName, missing: governed.validationMissing },
              "tool_args_validation_failed",
            );
          }
          if (openClawStrictGovernance && isWriteCapableToolName(tc.toolName ?? "") && governed.toolName === "Bash") {
            openClawProfileStats.strictGovernanceRewrites += 1;
          }
          argsStr = JSON.stringify(governed.input);
          if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
            app.log.debug({
              reqId, toolName: governed.toolName, toolCallId: tc.toolCallId,
              argsLen: rawArgsLen, normalized: argsStr.length !== rawArgsLen,
              adapterFamily: adapter.family,
            }, "tool_call_streamed");
          }
          let candidateCall: GuardrailToolCall = {
            toolCallId: tc.toolCallId ?? "",
            toolName: governed.toolName,
            input: governed.input,
          };
          const oaiStreamTopDirs = await getCachedTopLevelDirs(effectiveOaiPathCtx.projectRoot ?? effectiveOaiPathCtx.shellCwd);
          const streamGuarded = applyDiscoveryToolGuardrail([...oaiStreamGuardrailAccepted, candidateCall], oaiStreamTopDirs);
          if (streamGuarded.redirectedCount > 0) {
            oaiStreamBlockedBroadDiscovery += streamGuarded.redirectedCount;
            recordBlockedDiscovery(sessionKey, streamGuarded.redirectedCount);
            const redirectedCall = streamGuarded.calls[streamGuarded.calls.length - 1];
            if (redirectedCall) {
              candidateCall = redirectedCall as GuardrailToolCall;
              argsStr = JSON.stringify(redirectedCall.input);
            }
          }
          if (streamGuarded.calls.length === oaiStreamGuardrailAccepted.length) {
            oaiStreamBlockedBroadDiscovery += streamGuarded.blockedCount;
            oaiStreamCollapsedBroadDiscovery += streamGuarded.collapsedCount;
            const blockedId = tc.toolCallId ?? "";
            if (blockedId) {
              const idx = pendingToolCalls.findIndex((p) => p.id === blockedId);
              if (idx >= 0) pendingToolCalls.splice(idx, 1);
            }
            if (streamGuarded.blockedCount > 0) {
              const recovery = await buildBlockedDiscoveryRecoverySnapshot(
                resolved.resolvedModelId,
                streamGuarded.blockedDetails,
                effectiveOaiPathCtx.projectRoot,
              );
              oaiStreamBlockedDetails.push(...streamGuarded.blockedDetails);
              oaiStreamRecoveryPreviewEntries += recovery.entryCount;
              oaiStreamRecoveryMode = recovery.recoveryMode;
              flushOpenAIText(`\n${recovery.text}\n`);
            }
            continue;
          }
          oaiStreamGuardrailAccepted.push(candidateCall);
          const existing = pendingToolCalls.find((p) => p.id === tc.toolCallId);
          if (existing) {
            existing.name = governed.toolName;
            safeWrite(reply.raw, `data: ${JSON.stringify({
              id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
              choices: [{ index: 0, delta: { tool_calls: [{ index: existing.index, function: { arguments: argsStr } }] }, finish_reason: null }]
            })}\n\n`);
            oaiStreamEmittedToolCalls += 1;
          } else {
            safeWrite(reply.raw, `data: ${JSON.stringify({
              id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
              choices: [{ index: 0, delta: { tool_calls: [{ index: pendingToolCalls.length, id: tc.toolCallId, type: "function", function: { name: governed.toolName, arguments: argsStr } }] }, finish_reason: null }]
            })}\n\n`);
            oaiStreamEmittedToolCalls += 1;
          }
        }
      } else if (part.type === "tool-input-delta") {
        const td = part as unknown as { toolCallId?: string; inputTextDelta?: string };
        const idx = pendingToolCalls.findIndex((p) => p.id === td.toolCallId);
        if (idx >= 0) {
          pendingToolCalls[idx].args += td.inputTextDelta ?? "";
        }
      } else if ((part as any).type === "error") {
        throw (part as any).error;
      } else if ((part as any).type === "finish") {
        const fr = (part as any).finishReason;
        if (fr === "length") finishReason = "length";
      }
    }
    if (
      adapter.family === "qwen3-coder"
      && isLocalLikeOaiStreamBaseUrl
      && oaiStreamValidationFailures > 0
      && oaiStreamToolRepairs >= 2
    ) {
      toolArgHardeningStats.qwenParserMismatchSuspectCount += 1;
      app.log.warn(
        {
          reqId,
          resolvedModel: resolved.resolvedModelId,
          baseUrl: resolvedTierOaiStream?.baseUrl,
          validationFailures: oaiStreamValidationFailures,
          repairs: oaiStreamToolRepairs,
        },
        "qwen3_parser_mismatch_suspected: repeated tool arg repairs/validation failures on local endpoint; verify vLLM uses --tool-call-parser=qwen3_coder",
      );
    }
    finishReason = normalizeOpenAIStreamFinishReason(finishReason, oaiStreamEmittedToolCalls);
    if (oaiStreamBlockedBroadDiscovery > 0) {
      recordBlockedDiscovery(sessionKey, oaiStreamBlockedBroadDiscovery);
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "tool_call_blocked_broad_discovery",
        "tool-guardrails",
        `blocked=${oaiStreamBlockedBroadDiscovery};sessionTotal=${getBlockedDiscoveryCount(sessionKey)}`,
        reqId,
        {
          blockedDetails: oaiStreamBlockedDetails.slice(0, 5),
          recoveryMode: oaiStreamRecoveryMode,
          topLevelPreview: oaiStreamRecoveryPreviewEntries,
          sessionBlockedTotal: getBlockedDiscoveryCount(sessionKey),
        },
      );
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "blocked_broad_discovery_then_recovery",
        "tool-guardrails",
        `mode=${oaiStreamRecoveryMode ?? "unknown"};top_level_preview=${oaiStreamRecoveryPreviewEntries}`,
        reqId,
        { recoveryMode: oaiStreamRecoveryMode, topLevelPreview: oaiStreamRecoveryPreviewEntries },
      );
    }
    if (oaiStreamCollapsedBroadDiscovery > 0) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "duplicate_broad_call_collapsed",
        "tool-guardrails",
        `collapsed=${oaiStreamCollapsedBroadDiscovery}`,
        reqId,
      );
    }
  } catch (streamErr) {
    const upstream = extractUpstreamErrorDiagnostics(streamErr);
    circuitBreakers.recordFailure(resolved.resolvedModelId, identity.orgId);
    otelStreamSpan.setStatus("error", upstream.userMessage);
    app.log.error(
      {
        err: streamErr,
        reqId,
        model: resolved.resolvedModelId,
        upstream_error_name: upstream.errorName,
        upstream_error_code: upstream.errorCode,
        upstream_http_status: upstream.httpStatus,
        upstream_vercel_ai_sdk_error: upstream.isVercelAiSdkError,
        upstream_missing_tool_results: upstream.isMissingToolResults,
        upstream_raw_message: upstream.rawMessage.slice(0, 600),
      },
      `OpenAI stream error: ${upstream.rawMessage.slice(0, 500)}`,
    );
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "stream_error",
      "streamText",
      upstream.userMessage,
      reqId,
      {
        model: resolved.resolvedModelId,
        error_name: upstream.errorName ?? "",
        error_code: upstream.errorCode ?? "",
        error_status: upstream.httpStatus ?? 0,
        vercel_ai_sdk_error: upstream.isVercelAiSdkError,
        missing_tool_results: upstream.isMissingToolResults,
      },
    );
    finishReason = "error";
    safeWrite(reply.raw, `data: ${JSON.stringify({
      id: reqId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: resolved.resolvedModelId,
      choices: [{ index: 0, delta: { content: "\n\n[Upstream provider error — retrying may help]" }, finish_reason: null }]
    })}\n\n`);
  }

  oaiAdmission.release!();

  if (finishReason !== "error") {
    circuitBreakers.recordSuccess(resolved.resolvedModelId, identity.orgId);
    otelStreamSpan.setStatus("ok");
  }
  otelStreamSpan.end();

  if (finishReason !== "tool_calls" && pendingTextDeltas.length > 0) {
    const rawText = pendingTextDeltas.join("");
    const finalized = await finalizeCompletionText({
      requestId: reqId,
      sessionKey,
      userId: identity.userId,
      orgId: identity.orgId,
      assistantText: rawText,
      checklist: oaiRequirementChecklist,
      traceRootPrompt: getMetadataString(session.record.metadata, "trace_root_prompt"),
      latestUserPrompt: getMetadataString(session.record.metadata, "latest_user_prompt"),
      verification: oaiVerificationAssessment,
      recentToolNames: extractRecentToolNames(normalizedRequest.messages as Array<{ role: string; content: unknown }>),
      nonActionableEventDetail: "stream stop had non-actionable text; emitted deterministic fallback",
      planGraph: oaiPlanGraph,
    });
    oaiStreamGateApplied = finalized.applied;
    oaiStreamMissingMust = finalized.missingMust;
    oaiStreamMissingShould = finalized.missingShould;
    oaiStreamGateBlockedVerification = finalized.blockedByVerification;
    oaiStreamCriticBlocked = finalized.criticBlocked;
    const gateText = finalized.finalText;
      const guarded = applyMarkdownGuardrail(
        gateText,
        config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
      );
      if (rawText.length === 0) {
        flushOpenAIText(guarded);
      } else if (guarded !== rawText) {
        if (guarded.startsWith(rawText)) {
          flushOpenAIText(guarded.slice(rawText.length));
        } else {
          flushOpenAIText(guarded);
        }
      }
      pendingTextDeltas.length = 0;
  }

  let oaiStreamUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
  let streamedText = "";
  try { oaiStreamUsage = readUsage(await streamed.totalUsage as unknown); } catch { /* stream aborted */ }
  try { streamedText = await streamed.text; } catch { /* stream aborted */ }
  const finalChunkPayload: Record<string, unknown> = {
    id: reqId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: resolved.resolvedModelId,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  if (shouldIncludeStreamUsage(request.stream_options)) {
    finalChunkPayload.usage = toOpenAiUsage(oaiStreamUsage);
  }
  safeWrite(reply.raw, `data: ${JSON.stringify(finalChunkPayload)}\n\n`);
  safeWrite(reply.raw, "data: [DONE]\n\n");
  safeEnd(reply.raw);
  oaiHeartbeat.stop();
  if (streamedText) {
    const finalized = finalizePostStreamText({
      requestId: reqId,
      sessionKey,
      userId: identity.userId,
      orgId: identity.orgId,
      assistantText: streamedText,
      applyGate: oaiStreamGateApplied,
      checklist: oaiRequirementChecklist,
      traceRootPrompt: getMetadataString(session.record.metadata, "trace_root_prompt"),
      latestUserPrompt: getMetadataString(session.record.metadata, "latest_user_prompt"),
      verification: oaiVerificationAssessment,
      toolStopReason: finishReason === "tool_calls",
      nonActionableEventDetail: "streamed text was non-actionable; emitted deterministic fallback",
      planGraph: oaiPlanGraph,
    });
    streamedText = finalized.finalText;
    oaiStreamMissingMust = finalized.missingMust;
    oaiStreamMissingShould = finalized.missingShould;
    oaiStreamGateBlockedVerification = finalized.blockedByVerification;
    session.history.push({ role: "assistant", content: streamedText });
  }
  const oaiStreamLatency = Date.now() - started;
  const openAiStreamForensicsDone = finalizeRequestForensics(session, reqId, openAiStreamForensics, oaiStreamUsage);
  const oaiStreamSaved = toolResultReduction.getPerRequestDelta() + validationNormalization.getPerRequestDelta();
  const oaiStreamGuidedTrimmed = toolResultReduction.getPerRequestGuidedTruncationDelta();
  const oaiStreamTaskPruned = toolResultReduction.getPerRequestTaskPrunedDelta();
  if (oaiStreamGuidedTrimmed > 0) {
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "tool_output_truncated_guided",
      "tool-guardrails",
      `count=${oaiStreamGuidedTrimmed}`,
      reqId,
    );
  }
  if (oaiStreamTaskPruned > 0) {
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "task_conditioned_prune_applied",
      "tool-reducer",
      `count=${oaiStreamTaskPruned}`,
      reqId,
    );
  }
  const lastRecallOaiStream = toolResultReduction.getLastRecallDecision();
  const vStateOaiStream = toolResultReduction.getVerificationTracker().getState();
  const oaiStreamSnapshot = buildDecisionSnapshot({
    orchestration,
    recallDecision: lastRecallOaiStream,
    verificationState: vStateOaiStream,
    policyMatchedRules: policyPrecheck.matchedRules,
    reducedToolResults: reducedOpenAI.reducedCount,
    tokensSavedByReduction: oaiStreamSaved,
    evidencePrefetched: oaiPrefetchResult?.matched,
    evidenceConfidence: oaiPrefetchResult?.confidence,
    evidenceAuthoritative: oaiPrefetchResult?.authoritative,
    evidencePrefetchLatencyMs: oaiPrefetchResult ? Math.round(oaiPrefetchResult.latencyMs) : undefined,
    isStreaming: true,
    sensemakingTriggered: oaiSensemakingResult?.triggered,
    sensemakingReason: oaiSensemakingResult?.reason,
    governorDecision: oaiExecutionGovernor,
  });
  oaiOptLedger.setUpstreamCachedTokens(oaiStreamUsage.cachedTokens ?? 0);
  oaiOptLedger.recordFinal(normalizedRequest.messages as Array<{ content?: unknown }>);
  const oaiStreamLedgerSnap = oaiOptLedger.finalize();
  app.log.info({ reqId, ...oaiOptLedger.toLogRecord() }, "optimization_ledger");

  persistAndEmitDecisionTelemetry({
    state: session,
    requestId: reqId,
    resolvedModelId: resolved.resolvedModelId,
    usage: oaiStreamUsage,
    latencyMs: oaiStreamLatency,
    finishReason,
    tokensSavedByReduction: oaiStreamSaved,
    escalated: orchestration.escalated,
    snapshot: oaiStreamSnapshot,
    trajectory: {
      toolSequence: pendingToolCalls.map((tc) => tc.name),
      verificationSteps: inferVerificationSteps(pendingToolCalls.map((tc) => tc.name)),
      diagnostics: oaiTrajectoryDiagnostics,
      completionGateBlocked: oaiStreamGateBlockedVerification,
      criticBlocked: oaiStreamCriticBlocked,
      outcomeState: (oaiStreamGateBlockedVerification || oaiStreamCriticBlocked) ? "partial" : undefined,
      failureStage: oaiStreamGateBlockedVerification ? "verification" : undefined,
    },
    sessionKey,
    userId: identity.userId,
    orgId: identity.orgId,
    optimizationLedger: oaiStreamLedgerSnap,
  });
  const oaiStreamMsgCounts = countMessageRoles(normalizedRequest.messages as Array<{ role: string; content: unknown }>);
  pushDiagnostic({
    timestamp: Date.now(), sessionKey, path: "/v1/chat/completions (stream)", requestId: reqId,
    ...oaiStreamMsgCounts,
    toolDefinitionCount: effectiveTools.length,
    artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
    knowledgeToolInjected: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
    reducedToolResults: reducedOpenAI.reducedCount,
    finishReason, tokensIn: oaiStreamUsage.inputTokens, tokensOut: oaiStreamUsage.outputTokens,
    policyDecision: policyPrecheck.matchedRules.join(","), latencyMs: oaiStreamLatency,
    recallRouting: lastRecallOaiStream?.routing,
    recallConfidence: lastRecallOaiStream?.resolution?.confidence,
    verificationRound: vStateOaiStream.round > 0 ? vStateOaiStream.round : undefined,
    verificationFindings: vStateOaiStream.round > 0 ? vStateOaiStream.findings.length : undefined,
    verificationStalled: vStateOaiStream.stalled || undefined,
    decisionPath: orchestration.decisionPath,
    decisionEscalated: orchestration.escalated || undefined,
    sensemakingTriggered: oaiSensemakingResult?.triggered || undefined,
    sensemakingReason: oaiSensemakingResult?.reason,
    evidencePrefetchHit: oaiPrefetchResult?.matched && (oaiPrefetchResult?.confidence ?? 0) > 0 || undefined,
    evidencePrefetchConfidence: oaiPrefetchResult?.confidence || undefined,
    evidencePrefetchMs: oaiPrefetchResult ? Math.round(oaiPrefetchResult.latencyMs) : undefined,
    promptProfileIds: oaiEnriched.promptProfileIds,
    promptProfileHashes: oaiEnriched.promptProfileHashes,
    prefixHash: oaiEnriched.prefixHash,
    prefixChangeReasons: oaiEnriched.prefixChangeReasons,
    completionGateApplied: oaiStreamGateApplied || undefined,
    missingMustRequirements: oaiStreamMissingMust || undefined,
    missingShouldRequirements: oaiStreamMissingShould || undefined,
    requirementChecklistMust: oaiRequirementChecklist?.must.length || undefined,
    requirementChecklistShould: oaiRequirementChecklist?.should.length || undefined,
    contextAdmissionDecision: oaiContextAdmission.decision,
    contextAdmissionReason: oaiContextAdmission.reason,
      contextAdmissionEstimatedTokens: oaiContextAdmission.estimatedTokens,
    contextAdmissionEstimatedChars: oaiContextAdmission.estimatedChars,
    requestForensicsSummary: openAiStreamForensicsDone?.summary,
    requestForensicsLcpRatio: openAiStreamForensicsDone?.lcpRatio,
    requestForensicsFirstChangedSection: openAiStreamForensicsDone?.firstChangedSection,
    requestForensicsTokenEstimate: openAiStreamForensicsDone?.tokenEstimate,
    cacheStrategy: oaiCacheStrategy !== "none" ? oaiCacheStrategy : undefined,
    prefixFingerprint: oaiPrefixFingerprint,
  });
  return reply;
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

  const claudeRateResult = userRateLimiter.check(claudeAuthUser.userId);
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
  const parsed = ClaudeMessagesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      type: "error",
      error: { type: "invalid_request_error", message: parsed.error.message }
    });
  }
  const body: ClaudeMessagesRequest = parsed.data;
  const traceReqId = resolveRequestId(req.headers as Record<string, unknown>);
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
  // Merge top-level `system` into the message list (parity with Anthropic SDK)
  const claudeSystemMsg = claudeSystemToMessage(body.system);
  const rawOpenAIMessages = withSpan("yarn.enrichment", { "yarn.path": "claude" }, () =>
    claudeMessagesToOpenAI(body.messages as never),
  );
  // Enforce Vercel tool protocol invariants (assistant tool_call -> tool_result adjacency/order)
  // on Claude-converted histories to prevent resume-time MissingToolResultsError class failures.
  const sanitizedOpenAIMessages = sanitizeToolCalls(rawOpenAIMessages as never);
  const openAIMessages = claudeSystemMsg ? [claudeSystemMsg, ...sanitizedOpenAIMessages] : sanitizedOpenAIMessages;

  // Tool-search policy: strip defer_loading / tool_reference in disable mode
  const toolSearchResult = applyToolSearchPolicy(
    body.tools as Array<Record<string, unknown>> | undefined,
    config.SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE
  );
  const processedTools = config.SYNESIS_YARN_SORTED_TOOLS_ENABLED
    ? sortToolSchemas(toolSearchResult.tools)
    : toolSearchResult.tools;

  const reducedClaude = config.SYNESIS_YARN_GOVERNANCE_DISABLED
    ? { messages: openAIMessages as never, reducedCount: 0 }
    : enrichmentPool.isAvailable()
      ? await withSpanAsync("yarn.enrichment", { "yarn.path": "claude" }, () =>
          toolResultReduction.reduceMessagesAsync(openAIMessages as never, enrichmentPool, claudeTaskCue, claudePeekWatermark),
        )
      : withSpan("yarn.enrichment", { "yarn.path": "claude" }, () =>
          toolResultReduction.reduceMessages(openAIMessages as never, claudeTaskCue, claudePeekWatermark),
        );
  const claudeToolResultCount = (openAIMessages as Array<{ role: string }>).filter((m) => m.role === "tool").length;
  const normalizedFromClaude = await validationNormalization.normalizeMessagesAsync(
    reducedClaude.messages as never,
    runValidationTierCFallback,
  );
  if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const prunedClaude = transcriptPruning.prune(
      normalizedFromClaude.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>,
    );
    if (prunedClaude.pruned) {
      normalizedFromClaude.messages = prunedClaude.messages as never;
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
  const claudeIdentity: SessionIdentity = {
    userId: claudeAuthUser.userId,
    orgId: claudeAuthUser.orgId,
    conversationId: claudeConversationId,
    clientKind: claudeClientKind,
    displayName: claudeAuthUser.displayName,
  };
  const claudeSessionKey = await getSessionKey(claudeIdentity);
  if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
    app.log.debug({ sessionKey: claudeSessionKey, source: claudeConversationId ? "metadata" : "fallback", conversationId: claudeConversationId, clientKind: claudeClientKind }, "session_resolution");
  }
  const session = await getSessionState(claudeSessionKey, claudeIdentity);
  const claudeMsgCount = (body.messages as unknown[]).length;
  const claudeRecentExempt = Number(config.SYNESIS_YARN_TASK_PRUNING_RECENT_EXEMPT) || 0;
  session.pruningWatermark = Math.max(session.pruningWatermark, claudeMsgCount - claudeRecentExempt);
  // Claude protocol: tool results are sent as role:"user" with type:"tool_result" content
  // blocks. Only reset counters on genuine new user prompts (text content), not tool results.
  // A message that is ALL tool_result blocks is a tool-loop continuation; one with text is
  // a new user prompt.
  const claudeLastMsg = Array.isArray(body.messages) && body.messages.length > 0
    ? (body.messages as Array<{ role?: string; content?: unknown }>)[body.messages.length - 1]
    : undefined;
  const claudeIsToolResultOnly = claudeLastMsg?.role === "user"
    && Array.isArray(claudeLastMsg.content)
    && (claudeLastMsg.content as Array<{ type?: string }>).length > 0
    && (claudeLastMsg.content as Array<{ type?: string }>).every(
      (b) => b && typeof b === "object" && b.type === "tool_result",
    );
  const claudeIsNewUserPrompt = claudeLastMsg?.role === "user" && !claudeIsToolResultOnly;
  if (claudeIsNewUserPrompt) {
    session.consecutiveToolCalls = 0;
    session.stagnantToolCycles = 0;
    session.lastToolSignalHash = "";
    session.consecutiveRecoveryFires = 0;
    session.consecutiveEditContextMisses = 0;
    session.blockBroadVerificationUntilEdit = false;
    session.blockFailingVerificationUntilEdit = false;
    void distributedCounters.setConsecutiveToolCalls(claudeSessionKey, 0).catch(() => {});
  }
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
  const claudeToolFailures = collectToolExecutionFailureObservations(
    normalizedFromClaude.messages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>,
  );
  const claudeEditMissGuard = deriveEditContextMissGuardState(
    normalizedFromClaude.messages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>,
  );
  const claudeLatestToolProgress = classifyLatestToolProgress(
    (normalizedFromClaude.messages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown }>)
      .slice(findLastUserPromptIdx(normalizedFromClaude.messages as Array<{ role?: string; content?: unknown }>) + 1),
  );
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
  if (claudeLatestToolProgress.hasRecentWriteSuccess) {
    session.stagnantToolCycles = 0;
    session.lastToolSignalHash = "";
    session.consecutiveEditContextMisses = 0;
  } else if (claudeEditMissFailureCount > 0) {
    session.consecutiveEditContextMisses += 1;
  } else if (claudeLatestToolProgress.hasRecentFailure) {
    session.consecutiveEditContextMisses = 0;
  }
  if (claudeLatestToolProgress.hasRecentWriteSuccess && session.consecutiveRecoveryFires > 0) {
    session.consecutiveRecoveryFires = 0;
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
  const pendingClaudeWorkspaceToolId = String(session.record.metadata.workspace_context_tool_call_id ?? "");
  const claudeWorkspaceStatus = getHandshakeStatus(session.record.metadata);
  if (claudeWorkspaceStatus === "pending" && pendingClaudeWorkspaceToolId) {
    const toolResult = extractClaudeToolResult(body.messages as Array<{ role: string; content: unknown }>, pendingClaudeWorkspaceToolId);
    if (toolResult !== null) {
      const parsedCtx = parseWorkspaceContextOutput(toolResult);
      if (parsedCtx) {
        setSessionWorkspaceContext(session, "ready", traceReqId, {
          toolCallId: pendingClaudeWorkspaceToolId,
          cwd: parsedCtx.cwd,
          projectRoot: parsedCtx.projectRoot,
          shell: parsedCtx.shell,
          os: parsedCtx.os,
          arch: parsedCtx.arch,
        });
        recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "workspace_context_ready", "workspace-handshake", "Initializing workspace context completed", traceReqId);
      } else {
        setSessionWorkspaceContext(session, "unavailable", traceReqId, {
          toolCallId: pendingClaudeWorkspaceToolId,
          reason: "workspace context parse failed",
        });
        recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "workspace_context_fallback", "workspace-handshake", "Workspace context unavailable (parse failure)", traceReqId);
      }
    } else {
      setSessionWorkspaceContext(session, "unavailable", traceReqId, {
        toolCallId: pendingClaudeWorkspaceToolId,
        reason: "workspace context tool result not returned",
      });
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "workspace_context_fallback", "workspace-handshake", "Workspace context unavailable (tool result missing/denied)", traceReqId);
    }
  }
  let effectiveClaudePathCtx = mergeSessionPathHints(claudePathCtx, session);
  const effectiveClaudeAdapterBlock = (() => {
    const ctxBlock = toSessionExecutionContextSystemBlock(effectiveClaudePathCtx);
    if (!ctxBlock) return claudeAdapterBlock;
    return `${clientAdapterPacks.toSystemBlock(claudeAdapterProfile)}\n\n${ctxBlock}`;
  })();
  if (shouldStartWorkspaceHandshake(session, effectiveClaudePathCtx)) {
    if (!hasBashTool(body.tools as unknown[] | undefined)) {
      setSessionWorkspaceContext(session, "unavailable", traceReqId, { reason: "Bash tool not available for workspace handshake" });
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "workspace_context_fallback", "workspace-handshake", "Workspace context unavailable (Bash tool missing)", traceReqId);
    } else {
      const toolCallId = makeWorkspaceHandshakeToolCallId();
      session.record.metadata.workspace_context_attempts = getHandshakeAttempts(session.record.metadata) + 1;
      setSessionWorkspaceContext(session, "pending", traceReqId, { toolCallId, reason: "Initializing workspace context" });
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "workspace_context_init", "workspace-handshake", "Initializing workspace context", traceReqId);
      await casSessionSave(session);
      return sendClaudeWorkspaceHandshake(reply, body.model, !!body.stream, toolCallId);
    }
  }

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
  const claudeWorkingPhase: WorkflowPhase | undefined =
    claudeOrchestratorPhaseOverride
    ?? claudeFramePhase
    ?? governorPhaseToWorkflowPhase(claudeGovernorPreviewPhase);
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

  const claudeLastToolUseId = lastToolUseIdFromClaudeMessages(
    body.messages as Array<{ role: string; content: unknown }>,
  );
  const latestClaudeUserHash = hashTextSignal(latestClaudeUser?.content ?? "");
  const claudeUserIsRealAck = (() => {
    if (!latestClaudeUser) return false;
    const content = latestClaudeUser.content;
    if (typeof content === "string") return content.trim().length > 0;
    if (!Array.isArray(content)) return false;
    return (content as Array<{ type?: string }>).some(
      (b) => b.type === "text",
    );
  })();
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
  let claudeExecutionGovernor = config.SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED && !config.SYNESIS_YARN_GOVERNANCE_DISABLED
    ? withSpan("yarn.execution_governor.evaluate", {}, (govSpan) => {
      const decision = evaluateExecutionGovernor(
        normalizedFromClaude.messages as Array<GovernorInputMessage>,
        {
          profile: config.SYNESIS_YARN_GOVERNANCE_PROFILE,
          activePlanStage: claudePlanGraph?.activeStage ?? null,
          editContextMissActive:
            claudeEditMissGuard?.active === true
            || claudeLatestToolProgress.hasRecentEditContextMiss
            || claudeToolFailures.some((failure) => failure.reason === "edit_context_miss"),
        },
      );
      govSpan.setAttribute("governor.pause", decision.pause);
      govSpan.setAttribute("governor.reason", decision.reason ?? "");
      govSpan.setAttribute("governor.matched_rules", decision.matchedRules.join(","));
      govSpan.setAttribute("governor.phase", decision.telemetry.phase);
      govSpan.setAttribute("governor.trailing_verification_run", decision.telemetry.trailingVerificationRunLength);
      govSpan.setAttribute("governor.no_edit_evidence", decision.telemetry.noEditEvidence);
      return decision;
    })
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
    claudeExecutionGovernor.matchedRules.includes("verification_fail_repeat_block")
    || claudeExecutionGovernor.matchedRules.includes("verification_same_failure_signature_replay")
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
  const claudeLoopObs = deriveGovernorLoopObservability(
    normalizedFromClaude.messages as Array<{ role: string; tool_calls?: unknown }>,
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
      telemetry: claudeExecutionGovernor.telemetry,
    },
  );
  const claudeAggressiveRepeatGuard =
    (claudeCommandLoop.commandRepeatCount >= 2 && Boolean(claudeCommandLoop.failureSignatureHash))
    || claudeCommandLoop.broadDiscoveryRepeatCount >= 4;
  const claudeRepeatAwarePivot = claudeAggressiveRepeatGuard
    ? Math.max(3, Math.min(config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT, 6))
    : config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT;
  const claudeRepeatAwareHardReject = claudeAggressiveRepeatGuard
    ? Math.max(3, Math.min(config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER, 4))
    : config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER;
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
    consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
    consecutiveToolCallsPivot: claudeRepeatAwarePivot,
    toolProgressState: claudeLatestToolProgress.hasRecentWriteSuccess
      ? "progress"
      : (claudeLatestToolProgress.hasRecentFailure ? "stagnant" : claudeToolProgress.state),
    stagnantToolCycles: claudeLatestToolProgress.hasRecentWriteSuccess
      ? 0
      : (claudeLatestToolProgress.hasRecentFailure ? Math.max(session.stagnantToolCycles, 1) : session.stagnantToolCycles),
    stagnantToolCyclesLimit: config.SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT,
    toolLoopNoUserAckCount: session.toolLoopNoUserAckCount,
    toolLoopNoUserAckHardLimit: config.SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT,
    hardRejectAfter: claudeRepeatAwareHardReject,
    governanceRules: governanceClient?.getRules(),
  }));
  if (!claudePolicyPrecheck.allow) {
    logAndPersistSafetyEvent(claudePolicyPrecheck, claudeSessionKey, session.record.totalTokensIn);
    if (config.SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED && claudePolicyPrecheck.softFailClass === "tool_loop") {
      const started = Date.now();
      const content = toolLoopSoftFailMessage(claudePolicyPrecheck);
      const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
      session.awaitingToolLoopUserAck = true;
      session.toolLoopAckAnchorUserHash = latestClaudeUserHash;
      session.toolLoopNoUserAckCount = 0;
      session.history.push({ role: "assistant", content });
      persistSessionAndUsage(
        session,
        traceReqId,
        claudeOrchestration.selectedModel,
        usage,
        Date.now() - started,
        "end_turn",
        0
      );
      maybeCheckpoint(session);
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "tool_loop_soft_fail",
        "deterministic-policy",
        claudePolicyPrecheck.rejectReason ?? "Tool loop soft fail",
        traceReqId
      );
      return sendClaudeSoftFail(reply, claudeOrchestration.selectedModel, content, !!body.stream);
    }
    if (claudePolicyPrecheck.matchedRules.includes("repeat_loop_hard_reject")) {
      const started = Date.now();
      const content = repeatLoopSoftFailMessage(claudePolicyPrecheck);
      const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
      session.history.push({ role: "assistant", content });
      persistSessionAndUsage(
        session,
        traceReqId,
        claudeOrchestration.selectedModel,
        usage,
        Date.now() - started,
        "end_turn",
        0,
      );
      maybeCheckpoint(session);
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "repeat_loop_soft_fail",
        "deterministic-policy",
        claudePolicyPrecheck.rejectReason ?? "Repeat loop soft fail",
        traceReqId,
      );
      return sendClaudeSoftFail(reply, claudeOrchestration.selectedModel, content, !!body.stream);
    }
    return reply.code(400).send(policyRejectClaudeBody(claudePolicyPrecheck));
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
  const claudeGovernorWorkflowPhase = governorPhaseToWorkflowPhase(claudeGovernorPhase);
  if (claudeWorkingPhase && claudeWorkingPhase !== claudeGovernorWorkflowPhase) {
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "governor_orchestrator_phase_mismatch",
      "execution-governor",
      `working=${claudeWorkingPhase} governor=${claudeGovernorWorkflowPhase}`,
      traceReqId,
      {
        governor_phase: claudeGovernorPhase,
        governor_workflow_phase: claudeGovernorWorkflowPhase,
        orchestrator_working_phase: claudeWorkingPhase,
        orchestrator_phase_override: claudeOrchestratorPhaseOverride ?? null,
      },
    );
  }
  if (session.lastGovernorPhase && claudeGovernorPhase !== session.lastGovernorPhase) {
    session.consecutiveRecoveryFires = 0;
    recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "governor_phase_transition", "execution-governor",
      `${session.lastGovernorPhase} → ${claudeGovernorPhase}`, traceReqId);
  }
  session.lastGovernorPhase = claudeGovernorPhase;
  if (claudeExecutionGovernor.pause && config.SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED) {
    const claudeTerminalRules = new Set([
      "finalize_action_required",
      "verification_after_completion_claim",
      "completion_claim_requires_task_update",
      "repeat_user_prompt_loop",
      "edit_failure_replay",
      "consecutive_edit_failures",
    ]);
    const claudeSuppressCompletionClaimTerminal =
      claudeEditMissGuard?.active === true
      || claudeLatestToolProgress.hasRecentEditContextMiss
      || claudeToolFailures.some((failure) => failure.reason === "edit_context_miss");
    const claudeTerminalMatchedRules = claudeExecutionGovernor.matchedRules.filter((rule) =>
      !(claudeSuppressCompletionClaimTerminal && rule === "completion_claim_requires_task_update"),
    );
    const claudeHasTerminalRule = claudeTerminalMatchedRules.some((rule) => claudeTerminalRules.has(rule));
    const claudeHasBlockingToolFailure = claudeToolFailures.some((failure) => failure.reason !== "edit_already_applied");
    const claudeHasConcreteProgress =
      claudeLatestToolProgress.hasRecentWriteSuccess
      || (
        claudeToolProgress.state === "progress"
        && !claudeLatestToolProgress.hasRecentFailure
        && !claudeHasBlockingToolFailure
        && claudeEditMissGuard?.active !== true
        && !(claudeSuppressCompletionClaimTerminal && claudeExecutionGovernor.matchedRules.includes("source_file_stale_reread"))
      );
    const claudeShouldHoldRecoveryFire =
      claudeLatestToolProgress.hasRecentEditContextMiss
      && claudeExecutionGovernor.matchedRules.length === 1
      && claudeExecutionGovernor.matchedRules[0] === "source_file_stale_reread"
      && (claudeEditMissGuard?.missCount ?? 0) <= 1;
    if (claudeShouldHoldRecoveryFire) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "execution_governor_recovery_hold",
        "execution-governor",
        "Holding recovery streak increment due to edit context miss; allow focused retry",
        traceReqId,
        {
          reason: "edit_context_miss",
          matched_rules: claudeExecutionGovernor.matchedRules,
          toolName: claudeLatestToolProgress.toolName || null,
          toolCallId: claudeLatestToolProgress.toolCallId || null,
        },
      );
    } else if (claudeHasConcreteProgress) {
      session.consecutiveRecoveryFires = Math.max(0, session.consecutiveRecoveryFires - 1);
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "execution_governor_recovery_reset",
        "execution-governor",
        "Decremented recovery streak due to concrete progress evidence",
        traceReqId,
        {
          matched_rules: claudeExecutionGovernor.matchedRules,
          progress_state: claudeToolProgress.state,
          has_recent_write_success: claudeLatestToolProgress.hasRecentWriteSuccess,
          has_recent_failure: claudeLatestToolProgress.hasRecentFailure,
          has_blocking_tool_failure: claudeHasBlockingToolFailure,
          edit_miss_guard_active: claudeEditMissGuard?.active === true,
          consecutive_recovery_fires: session.consecutiveRecoveryFires,
        },
      );
    } else {
      session.consecutiveRecoveryFires += 1;
    }
    const HARD_STOP_THRESHOLD = 7;
    if (session.consecutiveRecoveryFires >= HARD_STOP_THRESHOLD && claudeHasTerminalRule) {
      const claudeHardStopDedup = getContentDedup(claudeSessionKey);
      const claudeHardStopFilesList = claudeHardStopDedup.generateFilesSummaryBlock() ?? "";
      const pauseEnvelope = buildExecutionGovernorPauseEnvelope({
        matchedRules: claudeExecutionGovernor.matchedRules,
        consecutiveRecoveryFires: session.consecutiveRecoveryFires,
        hardStopThreshold: HARD_STOP_THRESHOLD,
      });
      const hardStopContent = [
        buildExecutionGovernorHardStopUserMessage({
          consecutiveRecoveryFires: session.consecutiveRecoveryFires,
          matchedRules: claudeExecutionGovernor.matchedRules,
        }),
        ...(claudeHardStopFilesList ? ["", claudeHardStopFilesList] : []),
      ].join("\n");
      session.consecutiveRecoveryFires = 0;
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "execution_governor_hard_stop",
        "execution-governor",
        `Hard stop phase=${claudeGovernorPhase} after ${HARD_STOP_THRESHOLD} consecutive recovery fires (${claudeExecutionGovernor.matchedRules.join(",")})`,
        traceReqId,
        {
          phase: claudeGovernorPhase,
          matched_rules: claudeExecutionGovernor.matchedRules,
          has_run_test: claudeLoopObs.hasRunTest,
          last_assistant_tool_calls: claudeLoopObs.lastAssistantToolCalls,
          assistant_tool_calls_since_latest_user: claudeLoopObs.assistantToolCallsSinceLatestUser,
          blocked_before_first_tool_call: claudeLoopObs.assistantToolCallsSinceLatestUser === 0,
        },
      );
      maybeCheckpoint(session);
      return sendClaudeSoftFail(reply, claudeOrchestration.selectedModel, hardStopContent, !!body.stream, pauseEnvelope);
    }
    if (session.consecutiveRecoveryFires >= HARD_STOP_THRESHOLD && !claudeHasTerminalRule) {
      session.consecutiveRecoveryFires = HARD_STOP_THRESHOLD - 1;
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "execution_governor_hard_stop_deferred",
        "execution-governor",
        `Deferred hard stop because only advisory rules fired (${claudeExecutionGovernor.matchedRules.join(",")})`,
        traceReqId,
        {
          phase: claudeGovernorPhase,
          matched_rules: claudeExecutionGovernor.matchedRules,
          consecutive_recovery_fires: session.consecutiveRecoveryFires,
        },
      );
    }
    let recovery = executionGovernorRecoveryRewriteBlock(claudeExecutionGovernor);
    const claudeDedup = getContentDedup(claudeSessionKey);
    const claudeFilesSummary = claudeDedup.generateFilesSummaryBlock();
    if (claudeFilesSummary) recovery += "\n" + claudeFilesSummary;
    const claudeMsgs = normalizedFromClaude.messages as Array<{ role: string; content: unknown }>;
    const claudeLastUserPromptIdx = findLastUserPromptIdx(claudeMsgs as Array<{ role?: string; content?: unknown }>);
    const claudeTailIdx = claudeLastUserPromptIdx >= 0 ? claudeLastUserPromptIdx + 1 : claudeMsgs.length;
    claudeMsgs.splice(claudeTailIdx, 0, { role: "system", content: recovery });
    const claudePureExploration = claudeGovernorPhase === "edit"
      && !claudeExecutionGovernor.matchedRules.includes("completion_claim_requires_task_update")
      && !claudeExecutionGovernor.matchedRules.includes("source_file_stale_reread")
      && !claudeExecutionGovernor.matchedRules.includes("no_progress_loop");
    const restricted = applyExecutionGovernorToolRestrictions(
      body.tools as unknown[] | undefined,
      claudeExecutionGovernor.matchedRules,
      {
        pureExploration: claudePureExploration,
        preserveReadTools: claudeEditMissGuard?.active === true,
      },
    );
    body.tools = restricted.tools as never;
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "execution_governor_recovery_rewrite",
      "execution-governor",
      `Rewrote loop path (${claudeExecutionGovernor.matchedRules.join(",")}); phase=${claudeGovernorPhase}; removed_tools=${restricted.removed.join(",") || "none"} (fire ${session.consecutiveRecoveryFires}/${HARD_STOP_THRESHOLD}); files_seen=${claudeDedup.getTrackedFileCount()}`,
      traceReqId,
    );
  } else if (!claudeExecutionGovernor.pause) {
    session.consecutiveRecoveryFires = 0;
  }

  const claudeRole = TIER_TO_ROLE[claudeOrchestration.tier];
  const claudeBackendModel = roleAssignmentRegistry.get(claudeRole)?.backendModel ?? "";
  const claudePromptContext = {
    tier: claudeOrchestration.tier,
    role: claudeRole,
    modelFamily: inferModelFamily(claudeBackendModel),
  };
  const claudeSeedDirs = await getCachedTopLevelDirs(effectiveClaudePathCtx.projectRoot ?? effectiveClaudePathCtx.shellCwd);
  const claudeMemoryTracker = getMemoryGovernor(claudeSessionKey);
  const claudeStructIdx = getStructuralIndex(claudeSessionKey);
  if (claudeStructIdx) {
    claudeMemoryTracker.setIndexAvailable(claudeStructIdx.getStats().fileCount > 0);
  }
  claudeMemoryTracker.setFindingsCount(getSessionMemoryCount(claudeSessionKey));
  const claudeMemRules = evaluateMemoryRules(claudeMemoryTracker.getSignals());
  const claudeMemBlocks = claudeMemRules.filter((r) => r.fired).map((r) =>
    `<MEMORY_GUIDANCE rule="${r.rule}">\n${r.message}\n</MEMORY_GUIDANCE>`
  );
  const claudeEnriched = enrichWithFrameAndManifest(
    normalizedFromClaude.messages as never,
    claudeSessionKey,
    effectiveClaudeAdapterBlock,
    claudePromptContext,
    { projectRoot: effectiveClaudePathCtx.projectRoot, shellCwd: effectiveClaudePathCtx.shellCwd },
    [
      ...(claudeTaskIntake ? [formatTaskIntakeBlock(claudeTaskIntake)] : []),
      ...(claudePlanGraph ? [formatPlanProgressBlock(claudePlanGraph)] : []),
      ...claudeMemBlocks,
    ],
    claudeSeedDirs,
    session,
  );
  let enrichedClaudeMsgs = config.SYNESIS_YARN_GOVERNANCE_DISABLED
    ? claudeEnriched.messages as Array<{ role: string; content: unknown }>
    : appendCriticBlock(
        claudeEnriched.messages as Array<{ role: string; content: unknown }>,
        claudeRequirementChecklist,
      );

  // Sensemaking is intentionally disabled for regular coding sessions to avoid
  // adding volatile system blocks that degrade prefix cacheability.
  let claudeSensemakingResult: SensemakingResult | undefined;

  if (config.SYNESIS_YARN_JITTER_BUFFER_ENABLED && !config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const { stableMessages, jitterBlock } = splitJitter(enrichedClaudeMsgs);
    enrichedClaudeMsgs = applyJitter(stableMessages, jitterBlock) as typeof enrichedClaudeMsgs;
  }

  const claudeTrustResult = applyTrustPackets(enrichedClaudeMsgs, config, {
    requestId: traceReqId,
    sessionKey: claudeSessionKey,
    userId: claudeIdentity.userId,
    orgId: claudeIdentity.orgId,
  }, securityIngestConfig, app.log as never);
  if (claudeTrustResult.blocked) {
    recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "trust_block", "transcript-trust", claudeTrustResult.blockDetail ?? "Content blocked", traceReqId);
    const claudeTrustCategory = claudeTrustResult.blockDetail?.match(/Injection detected: (\S+)/)?.[1] ?? "content_policy";
    return reply.code(400).send({
      type: "error",
      error: { type: "invalid_request_error", message: `Request blocked by content safety policy (${claudeTrustCategory}). Rephrase and retry.` }
    });
  }
  enrichedClaudeMsgs = claudeTrustResult.messages as typeof enrichedClaudeMsgs;

  const openAIShape: OpenAIChatCompletionRequest = {
    model: claudeOrchestration.selectedModel,
    messages: enrichedClaudeMsgs as never,
    stream: body.stream,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
  };
  session.toolCallsSinceCheckpoint += claudeToolResultCount;
  const reqId = traceReqId;
  if (claudePolicyPrecheck.pivotPrompt) {
    session.history.push({ role: "system", content: claudePolicyPrecheck.pivotPrompt });
  }

  if (latestClaudeUser?.content) {
    session.history.push({ role: "user", content: String(latestClaudeUser.content) });
  }

  openAIShape.messages = injectSessionContext(
    openAIShape.messages as Array<{ role: string; content: unknown }>,
    session
  ) as never;

  if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const claudeBlocks: string[] = [];
    if (claudePrefetchResult) {
      const claudeEvBlock = formatEvidenceBlock(claudePrefetchResult);
      if (claudeEvBlock) claudeBlocks.push(claudeEvBlock);
    }
    if (claudePatternResult) {
      const claudePtBlock = formatPatternBlock(claudePatternResult);
      if (claudePtBlock) claudeBlocks.push(claudePtBlock);
    }
    if (claudeBlocks.length > 0) {
      const combined = claudeBlocks.join("\n\n");
      const claudeMsgs = openAIShape.messages as Array<{ role: string; content: unknown }>;
      // Keep user-authored steering blocks intact. Inject provider-side guidance
      // as a dedicated system turn rather than mutating existing system content.
      claudeMsgs.push({ role: "system", content: combined });
      openAIShape.messages = claudeMsgs as never;
    }
  }

  if (prefixOptimizer) {
    try {
      tierRegistry.setCurrentSessionKey(claudeSessionKey);
      const optimized = prefixOptimizer.optimize(
        openAIShape.messages as never,
        openAIShape.tools as never,
        claudeSessionKey,
      );
      openAIShape.messages = optimized.messages as never;
      if (optimized.tools) {
        openAIShape.tools = optimized.tools as never;
      }

      const cm = optimized.clientMetadata;
      if (cm && (!effectiveClaudePathCtx.projectRoot || !effectiveClaudePathCtx.shellCwd)) {
        const patched: typeof effectiveClaudePathCtx = {
          ...effectiveClaudePathCtx,
          projectRoot: effectiveClaudePathCtx.projectRoot ?? cm.projectRoot,
          shellCwd: effectiveClaudePathCtx.shellCwd ?? cm.shellCwd,
          shell: effectiveClaudePathCtx.shell ?? cm.shell ?? undefined,
          platform: effectiveClaudePathCtx.platform ?? cm.platform ?? undefined,
          osVersion: effectiveClaudePathCtx.osVersion ?? cm.osVersion ?? undefined,
        };
        effectiveClaudePathCtx = patched;

        if (cm.projectRoot || cm.shellCwd) {
          setSessionWorkspaceContext(session, "ready", traceReqId, {
            reason: "Extracted from client system message",
            projectRoot: cm.projectRoot ?? undefined,
            cwd: cm.shellCwd ?? undefined,
            shell: cm.shell ?? undefined,
            os: cm.platform ?? undefined,
          });
          app.log.info(
            { sessionKey: claudeSessionKey, projectRoot: cm.projectRoot, shellCwd: cm.shellCwd, shell: cm.shell, platform: cm.platform },
            "prefix_optimizer_metadata_backfill",
          );
        }
      }
    } catch (err) {
      app.log.warn({ err, sessionKey: claudeSessionKey }, "prefix_optimizer_claude_error");
    }
  }

  const claudeResolveResult = runOpenAIRequest(openAIShape);
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
  let claudeRawTools = (processedTools as unknown[]) ?? [];

  const claudeToolBudget = adjustToolSchemaBudgetForSession(
    resolveToolSchemaBudget(
      claudeAdapter.maxEffectiveTools,
      config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED && isOpenClawProfile(claudeAdapterProfile)
        ? Math.max(1, config.SYNESIS_YARN_OPENCLAW_TOOL_SCHEMA_CAP)
        : claudeAdapterProfile.features.toolSchemaBudgetCap,
    ),
    claudeOrchestration.phase,
    claudeClientKind,
  );
  const claudeRecentCallsForSteering = extractRecentToolCallDetails(
    normalizedFromClaude.messages as Array<{ role: string; content: unknown }>,
  );
  const qwenLoopRiskClaude =
    claudeAdapter.family === "qwen3-coder" && detectQwenLoopRisk(claudeRecentCallsForSteering);
  const prunedClaudeTools = pruneToolSchemas(
    claudeRawTools,
    claudeToolBudget,
    extractRecentToolNames(normalizedFromClaude.messages as Array<{ role: string; content: unknown }>),
    extractRequestedToolNames(String(latestClaudeUser?.content ?? ""), claudeRawTools),
  );
  toolSchemaPruningStats.requestsConsidered += 1;
  if (prunedClaudeTools.pruned) {
    toolSchemaPruningStats.requestsPruned += 1;
    toolSchemaPruningStats.toolsPrunedTotal += prunedClaudeTools.prunedCount;
  }
  const prioritizedClaudeTools = prioritizeWriteCapableTools(prunedClaudeTools.tools, qwenLoopRiskClaude);
  let effectiveClaudeTools = enrichToolSchemasForAdapter(prioritizedClaudeTools, claudeAdapter);
  const clientClaudeToolChoice = mapToolChoice(body.tool_choice);
  if (body.tool_choice !== undefined && clientClaudeToolChoice === undefined) {
    return reply.code(400).send({
      error: {
        type: "invalid_request_error",
        message: "Invalid tool_choice. Expected auto|none|required|any or object form {type:\"tool\",name:\"...\"}.",
      },
    });
  }
  const sdkStop = body.stop_sequences && body.stop_sequences.length > 0 ? body.stop_sequences : undefined;

  const claudeModelToolPrompt = mergeToolSystemPrompts(
    claudeAdapter.toolSystemPrompt?.(effectiveClaudeTools.length),
    buildRetrievalPolicyToolPromptFragment(effectiveClaudeTools as unknown[]),
  );
  let claudeModelMessages = claudeModelToolPrompt
    ? ([{ role: "system" as const, content: claudeModelToolPrompt }, ...messages] as typeof messages)
    : messages;
  if (claudePolicyPrecheck.pivotPrompt) {
    claudeModelMessages = [...claudeModelMessages, { role: "system" as const, content: claudePolicyPrecheck.pivotPrompt }] as typeof claudeModelMessages;
  }
  if (claudeEditMissGuard?.active) {
    claudeModelMessages = appendSystemMessageAndNormalize(
      claudeModelMessages as Array<{ role: string; content?: unknown }>,
      buildEditContextMissGuardPrompt(claudeEditMissGuard.filePath, claudeEditMissGuard.missCount),
    ) as typeof claudeModelMessages;
  }

  // Adapter-specific early pivot and same-tool dampening (Claude path).
  // Skip when the execution governor already injected a recovery block.
  const claudeGovernorAlreadyIntervened = claudeExecutionGovernor.pause && config.SYNESIS_YARN_EXECUTION_GOVERNOR_SOFT_FAIL_ENABLED;
  if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED && !claudePolicyPrecheck.pivotPrompt && !claudeGovernorAlreadyIntervened && claudeAdapter.family === "qwen3-coder") {
    const claudeRecentCalls = claudeRecentCallsForSteering;
    const claudeRecentAssistantText = extractRecentAssistantText(
      normalizedFromClaude.messages as Array<{ role: string; content: unknown }>,
    );
    const claudeRecentToolResultText = extractRecentToolResultText(
      normalizedFromClaude.messages as Array<{ role: string; content: unknown }>,
    );
    const turnMarker = nextQwenInterventionTurn(claudeSessionKey);
    if (claudeAdapter.getEarlyPivotPrompt) {
      const earlyPivot = claudeAdapter.getEarlyPivotPrompt(claudeRecentCalls, {
        recentAssistantText: claudeRecentAssistantText,
        recentUserPrompt: claudeTaskCue,
        recentToolResultText: claudeRecentToolResultText,
        stagnationWindow: config.SYNESIS_YARN_QWEN_STAGNATION_WINDOW,
        stagnationThreshold: config.SYNESIS_YARN_QWEN_STAGNATION_THRESHOLD,
        planNoActionLimit: config.SYNESIS_YARN_QWEN_PLAN_NO_ACTION_LIMIT,
        editRetryLimit: config.SYNESIS_YARN_QWEN_EDIT_RETRY_LIMIT,
      });
      if (earlyPivot) {
        const pivotKind = classifyQwenPivotEvent(earlyPivot, claudeRecentCalls, "early");
        const decision = shouldSuppressQwenIntervention(claudeSessionKey, turnMarker, pivotKind);
        if (decision === "hard_stop") {
          app.log.warn(
            { sessionKey: claudeSessionKey, family: claudeAdapter.family, turnMarker, pivotKind },
            "adapter_qwen_ignored_pivot_hard_stop",
          );
          const forcedRecovery = `${earlyPivot}\nCRITICAL: Do not ask the user for guidance. Continue autonomously by taking exactly one concrete action now: apply one focused Edit/Write that advances the requested task, then run one narrow verification command.`;
          claudeModelMessages = appendSystemMessageAndNormalize(
            claudeModelMessages as Array<{ role: string; content?: unknown }>,
            forcedRecovery,
          ) as typeof claudeModelMessages;
          markQwenIntervention(claudeSessionKey, turnMarker, pivotKind);
          recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "adapter_pivot_auto_recover", "adapter", `${pivotKind}: forced continue after ignored pivots`, traceReqId);
        } else if (decision === "suppress") {
          app.log.info(
            { sessionKey: claudeSessionKey, family: claudeAdapter.family, turnMarker },
            "adapter_qwen_cooldown_suppressed",
          );
        } else {
          claudeModelMessages = appendSystemMessageAndNormalize(
            claudeModelMessages as Array<{ role: string; content?: unknown }>,
            earlyPivot,
          ) as typeof claudeModelMessages;
          markQwenIntervention(claudeSessionKey, turnMarker, pivotKind);
          app.log.info(
            { sessionKey: claudeSessionKey, family: claudeAdapter.family, pivotLen: earlyPivot.length },
            pivotKind,
          );
        }
      }
    }
    if (claudeAdapter.dampenConsecutiveSameTools) {
      const claudeToolNames = claudeRecentCalls.map((c) => c.toolName);
      const dampening = claudeAdapter.dampenConsecutiveSameTools(claudeToolNames);
      if (dampening) {
        const dampeningPivotKind = classifyQwenPivotEvent(dampening, claudeRecentCalls, "dampening");
        const decision = shouldSuppressQwenIntervention(claudeSessionKey, turnMarker, dampeningPivotKind);
        if (decision === "hard_stop") {
          app.log.warn(
            { sessionKey: claudeSessionKey, family: claudeAdapter.family, turnMarker, pivotKind: dampeningPivotKind },
            "adapter_qwen_ignored_pivot_hard_stop",
          );
          const forcedRecovery = `${dampening}\nCRITICAL: Do not ask the user for guidance. Continue autonomously by taking exactly one concrete action now: apply one focused Edit/Write that advances the requested task, then run one narrow verification command.`;
          claudeModelMessages = appendSystemMessageAndNormalize(
            claudeModelMessages as Array<{ role: string; content?: unknown }>,
            forcedRecovery,
          ) as typeof claudeModelMessages;
          markQwenIntervention(claudeSessionKey, turnMarker, dampeningPivotKind);
          recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "adapter_pivot_auto_recover", "adapter", "dampening: forced continue after ignored pivots", traceReqId);
        } else if (decision === "suppress") {
          app.log.info(
            { sessionKey: claudeSessionKey, family: claudeAdapter.family, turnMarker },
            "adapter_qwen_cooldown_suppressed",
          );
        } else {
          claudeModelMessages = appendSystemMessageAndNormalize(
            claudeModelMessages as Array<{ role: string; content?: unknown }>,
            dampening,
          ) as typeof claudeModelMessages;
          markQwenIntervention(claudeSessionKey, turnMarker, dampeningPivotKind);
          app.log.info({ sessionKey: claudeSessionKey, family: claudeAdapter.family, dampenLen: dampening.length }, "adapter_dampening_claude");
        }
      }
    }
  }

  claudeModelMessages = normalizeSystemMessageOrdering(claudeModelMessages as Array<{ role: string }>) as typeof claudeModelMessages;

  const adapterClaudeProviderOptions = claudeAdapter.providerOptions?.();
  const providerOptions = body.thinking
    ? { openai: { thinking: body.thinking, ...(adapterClaudeProviderOptions?.openai ?? {}) }, ...(adapterClaudeProviderOptions ? Object.fromEntries(Object.entries(adapterClaudeProviderOptions).filter(([k]) => k !== "openai")) : {}) }
    : adapterClaudeProviderOptions;
  const claudePhasePolicy = derivePhaseExecutionPolicy({
    enabled: config.SYNESIS_YARN_PHASE_EXECUTION_POLICY_ENABLED,
    adapterFamily: claudeAdapter.family,
    enabledFamilies: config.SYNESIS_YARN_PHASE_EXECUTION_POLICY_FAMILIES,
    phase: claudeGovernorPhase,
    matchedRules: claudeExecutionGovernor.matchedRules,
    stream: !!body.stream,
    editContextMissActive: claudeEditMissGuard?.active === true,
  });
  const claudePhaseFiltered = filterToolsByPhasePolicy(effectiveClaudeTools as unknown[], claudePhasePolicy);
  effectiveClaudeTools = claudePhaseFiltered.tools;
  let effectiveClaudeToolChoice = resolvePhaseToolChoice(
    clientClaudeToolChoice as PhaseAwareToolChoice | undefined,
    claudePhasePolicy,
  );
  if (claudeEditMissGuard?.active) {
    // Guard fires regardless of phase policy. When both fire together (source_file_stale_reread
    // forces write-only tools AND the model has stale anchors), we added Read back to the
    // phase policy's allowed list via editContextMissActive above. In standalone mode (no phase
    // policy), strip write tools entirely and force Read. In both modes, force tool_choice=Read
    // to break the loop.
    const guardMode = claudePhasePolicy.active ? "alongside_phase_policy" : "standalone";
    const gated = guardMode === "standalone"
      ? applyEditContextMissReadGate(effectiveClaudeTools as unknown[])
      : { tools: effectiveClaudeTools as unknown[], removed: [] as string[], forcedReadToolName: findPreferredReadToolName(effectiveClaudeTools as unknown[]) };
    if (guardMode === "standalone") effectiveClaudeTools = gated.tools ?? effectiveClaudeTools;
    let forcedReadToolName = gated.forcedReadToolName;
    const ensuredRead = ensureReadToolAvailabilityForEditMissGuard(
      effectiveClaudeTools as unknown[] | undefined,
      claudeClientToolInventory,
    );
    effectiveClaudeTools = ensuredRead.tools ?? effectiveClaudeTools;
    if (!forcedReadToolName && ensuredRead.readToolName) {
      forcedReadToolName = ensuredRead.readToolName;
    }
    if (ensuredRead.rehydrated) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "edit_context_miss_guard_rehydrated_read",
        "execution-governor",
        `Reintroduced read tool for edit-context recovery file=${claudeEditMissGuard.filePath}`,
        traceReqId,
        {
          filePath: claudeEditMissGuard.filePath,
          read_tool: ensuredRead.readToolName ?? null,
        },
      );
    }
    if (!ensuredRead.available) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "edit_context_miss_guard_read_missing",
        "execution-governor",
        `Invariant violation: no read-capable tool available while edit-context guard is active for ${claudeEditMissGuard.filePath}`,
        traceReqId,
        {
          filePath: claudeEditMissGuard.filePath,
          matched_rules: claudeExecutionGovernor.matchedRules,
          phase: claudeGovernorPhase,
        },
      );
    }
    if (gated.removed.length > 0 || forcedReadToolName || ensuredRead.rehydrated || !ensuredRead.available) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "edit_context_miss_guard_enforced",
        "execution-governor",
        `mode=${guardMode} removed_write_tools=${gated.removed.length} file=${claudeEditMissGuard.filePath}`,
        traceReqId,
        {
          filePath: claudeEditMissGuard.filePath,
          missCount: claudeEditMissGuard.missCount,
          removed_tools: gated.removed,
          forced_read_tool: forcedReadToolName ?? null,
          guard_mode: guardMode,
          read_rehydrated: ensuredRead.rehydrated,
          read_available: ensuredRead.available,
        },
      );
    }
    if (forcedReadToolName) {
      effectiveClaudeToolChoice = { type: "tool", toolName: forcedReadToolName };
    }
  }
  const sdkTools = claudeToolsToSDK(effectiveClaudeTools as never);
  const claudeForensicsPhasePolicy: RequestForensicsRecord["phasePolicy"] = {
    enabled: claudePhasePolicy.active,
    source: clientClaudeToolChoice !== undefined ? "client" : (effectiveClaudeToolChoice !== undefined ? "phase_policy" : "none"),
    phase: claudeGovernorPhase,
    effectiveToolChoice: typeof effectiveClaudeToolChoice === "string" ? effectiveClaudeToolChoice : effectiveClaudeToolChoice ? "tool" : undefined,
    filteredToolCount: claudePhaseFiltered.removed.length,
    downgradedForStreaming: !!claudePhasePolicy.downgradedForStreaming,
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
      },
    );
  }
  const claudeAdapterSampling = claudeAdapter.defaultSamplingParams?.();
  const claudeEffectiveTemp = body.temperature ?? claudeAdapterSampling?.temperature;
  const claudeEffectiveTopP = claudeAdapterSampling?.top_p;
  const claudeNativeWebSearchRequested = hasClaudeNativeWebSearchTool(body.tools as unknown[] | undefined);
  const claudeForceNonStreamKickoff =
    !!body.stream && claudePhasePolicy.active && claudePhasePolicy.toolChoice === "required" && !!claudePhasePolicy.enforceNonStreaming;
  const claudeContextAdmission = evaluateContextAdmission(
    claudeModelMessages as Array<{ role: string; content: unknown }>,
    effectiveClaudeTools as unknown[],
    config.SYNESIS_YARN_CONTEXT_ADMISSION_MODE,
    config.SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS,
    config.SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS,
  );
  contextAdmissionStats.checked += 1;
  contextAdmissionStats.byPath.claude += 1;
  if (claudeContextAdmission.decision === "warn") {
    contextAdmissionStats.warned += 1;
    app.log.warn(
      {
        requestId: req.id,
        estimatedTokens: claudeContextAdmission.estimatedTokens,
        estimatedChars: claudeContextAdmission.estimatedChars,
        reason: claudeContextAdmission.reason,
      },
      "context_admission_warn_claude",
    );
    const compacted = await forceCheckpoint(session);
    if (compacted) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "auto_compaction",
        "context-admission",
        `Auto compacting after warn (${claudeContextAdmission.reason ?? "warn"})`,
        traceReqId,
      );
    }
  }
  if (claudeContextAdmission.decision === "reject") {
    contextAdmissionStats.rejected += 1;
    app.log.warn(
      {
        requestId: req.id,
        estimatedTokens: claudeContextAdmission.estimatedTokens,
        estimatedChars: claudeContextAdmission.estimatedChars,
        reason: claudeContextAdmission.reason,
      },
      "context_admission_reject_claude",
    );
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
        streamedResult = await generateText({
          model: resolved.model as never,
          messages: currentMessages,
          maxOutputTokens: clampMaxOutputTokensForSafety(Math.max(claudeOrchestration.maxOutputTokens, body.max_tokens ?? 0)),
          ...(claudeEffectiveTemp !== undefined ? { temperature: claudeEffectiveTemp } : {}),
    ...(claudeEffectiveTopP !== undefined ? { topP: claudeEffectiveTopP } : {}),
          ...(sdkStop ? { stopSequences: sdkStop } : {}),
          ...(sdkTools ? { tools: sdkTools } : {}),
          ...(effectiveClaudeToolChoice ? { toolChoice: effectiveClaudeToolChoice } : {}),
          ...(providerOptions ? { providerOptions: providerOptions as never } : {})
        });

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
            streamedResult = await generateText({
              model: resolved.model as never,
              messages: currentMessages,
              maxOutputTokens: clampMaxOutputTokensForSafety(Math.max(claudeOrchestration.maxOutputTokens, body.max_tokens ?? 0)),
              ...(claudeEffectiveTemp !== undefined ? { temperature: claudeEffectiveTemp } : {}),
              ...(claudeEffectiveTopP !== undefined ? { topP: claudeEffectiveTopP } : {}),
              ...(sdkStop ? { stopSequences: sdkStop } : {}),
              ...(sdkTools ? { tools: sdkTools } : {}),
              ...(effectiveClaudeToolChoice ? { toolChoice: effectiveClaudeToolChoice } : {}),
              ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
            });
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
              streamedResult = await generateText({
                model: resolved.model as never,
                messages: currentMessages,
                maxOutputTokens: clampMaxOutputTokensForSafety(Math.max(claudeOrchestration.maxOutputTokens, body.max_tokens ?? 0)),
                ...(claudeEffectiveTemp !== undefined ? { temperature: claudeEffectiveTemp } : {}),
                ...(claudeEffectiveTopP !== undefined ? { topP: claudeEffectiveTopP } : {}),
                ...(sdkStop ? { stopSequences: sdkStop } : {}),
                ...(sdkTools ? { tools: sdkTools } : {}),
                ...(effectiveClaudeToolChoice ? { toolChoice: effectiveClaudeToolChoice } : {}),
                ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
              });
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
      );
      const finalResult = streamedResult ?? await generateText({
        model: resolved.model as never,
        messages: currentMessages,
        maxOutputTokens: clampMaxOutputTokensForSafety(Math.max(claudeOrchestration.maxOutputTokens, body.max_tokens ?? 0)),
        ...(claudeEffectiveTemp !== undefined ? { temperature: claudeEffectiveTemp } : {}),
    ...(claudeEffectiveTopP !== undefined ? { topP: claudeEffectiveTopP } : {}),
        ...(sdkStop ? { stopSequences: sdkStop } : {}),
        ...(sdkTools ? { tools: sdkTools } : {}),
        ...(effectiveClaudeToolChoice ? { toolChoice: effectiveClaudeToolChoice } : {}),
        ...(providerOptions ? { providerOptions: providerOptions as never } : {})
      });

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
        evidencePrefetched: claudePrefetchResult?.matched,
        evidenceConfidence: claudePrefetchResult?.confidence,
        evidenceAuthoritative: claudePrefetchResult?.authoritative,
        evidencePrefetchLatencyMs: claudePrefetchResult ? Math.round(claudePrefetchResult.latencyMs) : undefined,
        isStreaming: true,
        sensemakingTriggered: claudeSensemakingResult?.triggered,
        sensemakingReason: claudeSensemakingResult?.reason,
        governorDecision: claudeExecutionGovernor,
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
    if (!claudeAdmission.admitted) {
      app.log.warn({ reason: claudeAdmission.reason, queueStats: streamAdmission.getStats() }, "stream_admission_rejected_claude");
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "stream_admission_reject", "stream-admission",
        claudeAdmission.reason ?? "stream admission rejected", traceReqId);
      reply.header("Retry-After", String(claudeAdmission.retryAfterSeconds ?? 5));
      return reply.code(503).send({ type: "error", error: { type: "overloaded_error", message: "Server at capacity. Try again shortly." } });
    }

    if (!circuitBreakers.allowRequest(resolved.resolvedModelId, claudeIdentity.orgId)) {
      claudeAdmission.release!();
      app.log.warn({ model: resolved.resolvedModelId, orgId: claudeIdentity.orgId }, "circuit_breaker_open_claude_stream");
      recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "breaker_open_reject", "circuit-breaker",
        `Circuit breaker open for ${resolved.resolvedModelId} (claude stream)`, traceReqId, { model: resolved.resolvedModelId });
      reply.header("Retry-After", "30");
      return reply.code(503).send({ type: "error", error: { type: "overloaded_error", message: "Model provider temporarily unavailable. Try again shortly." } });
    }
    const claudeStreamSpan = getTracer().startSpan("yarn.claude.stream", { model: resolved.resolvedModelId, sessionKey: claudeSessionKey });
    const started = Date.now();
    const claudeStreamForensics = captureRequestForensics(
      claudeSessionKey,
      traceReqId,
      "/v1/messages (stream)",
      resolved.resolvedModelId,
      true,
      claudeModelMessages as Array<{ role: string; content: unknown }>,
      effectiveClaudeTools as unknown[],
      effectiveClaudeToolChoice,
      providerOptions,
      claudeForensicsPhasePolicy,
    );
    const streamed = streamText({
      model: resolved.model as never,
      messages: claudeModelMessages,
      maxOutputTokens: clampMaxOutputTokensForSafety(Math.max(claudeOrchestration.maxOutputTokens, body.max_tokens ?? 0)),
      ...(claudeEffectiveTemp !== undefined ? { temperature: claudeEffectiveTemp } : {}),
    ...(claudeEffectiveTopP !== undefined ? { topP: claudeEffectiveTopP } : {}),
      ...(sdkStop ? { stopSequences: sdkStop } : {}),
      ...(sdkTools ? { tools: sdkTools } : {}),
      ...(effectiveClaudeToolChoice ? { toolChoice: effectiveClaudeToolChoice } : {}),
      ...(providerOptions ? { providerOptions: providerOptions as never } : {})
    });
    reply.raw.writeHead(200, sseHeadersWithClarification(session.record.metadata));
    const claudeHeartbeat = startSseHeartbeat({
      raw: reply.raw,
      intervalMs: config.SYNESIS_YARN_SSE_HEARTBEAT_INTERVAL_MS,
      longWaitEventMs: config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS,
      onLongWait: (elapsedMs) => {
        recordSessionEvent(
          claudeSessionKey,
          claudeIdentity.userId,
          claudeIdentity.orgId,
          "stream_long_wait",
          "stream-heartbeat",
          `Claude stream exceeded ${config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS}ms without finishing`,
          traceReqId,
          { elapsedMs, model: resolved.resolvedModelId },
        );
      },
    });
    const msgId = `msg_${crypto.randomUUID()}`;
    safeSse(reply, "message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: resolved.resolvedModelId, content: [], usage: { input_tokens: 0, output_tokens: 0 } } });

    let blockIdx = 0;
    let inTextBlock = false;
    let claudeStreamingTextOpen = false;
    let stopReason = "end_turn";
    let claudeStreamGateApplied = false;
    let claudeStreamMissingMust = 0;
    let claudeStreamMissingShould = 0;
    let claudeStreamGateBlockedVerification = false;
    let claudeStreamCriticBlocked = false;
    const pendingClaudeTextDeltas: string[] = [];
    const claudeToolBuffer = new Map<string, { toolName: string; toolCallId: string; chunks: string[] }>();
    const claudeStreamGuardrailAccepted: GuardrailToolCall[] = [];
    const claudeStreamBlockedDetails: BlockedDiscoveryDetail[] = [];
    let claudeStreamEmittedToolCalls = 0;
    let claudeStreamRecoveryPreviewEntries = 0;
    let claudeStreamRecoveryMode: DiscoveryRecoverySnapshot["recoveryMode"] | null = null;
    let claudeStreamBlockedBroadDiscovery = 0;
    let claudeStreamCollapsedBroadDiscovery = 0;
    const claudeStreamToolSequence: string[] = [];
    const resolvedTier = tierRegistry.getTierConfig(resolved.resolvedModelId);
    const isLocalLikeBaseUrl =
      !!resolvedTier?.baseUrl &&
      (
        resolvedTier.baseUrl.includes(".svc.cluster.local")
        || resolvedTier.baseUrl.includes("localhost")
        || resolvedTier.baseUrl.includes("127.0.0.1")
      );
    const claudeCacheStrategy = detectCacheStrategy(
      resolvedTier?.baseUrl ?? "",
      resolvedTier?.backendModel ?? resolved.resolvedModelId,
    );
    const claudePrefixFingerprint = computePrefixFingerprint(
      claudeModelMessages as Array<{ role: string; content: unknown }>,
    );
    let requestToolValidationFailures = 0;
    let requestToolRepairs = 0;
    const emitClaudeTextDelta = (delta: string): void => {
      if (!delta) return;
      if (!claudeStreamingTextOpen) {
        safeSse(reply, "content_block_start", {
          type: "content_block_start",
          index: blockIdx,
          content_block: { type: "text", text: "" },
        });
        claudeStreamingTextOpen = true;
        inTextBlock = true;
      }
      safeSse(reply, "content_block_delta", {
        type: "content_block_delta",
        index: blockIdx,
        delta: { type: "text_delta", text: delta },
      });
    };

    const closeClaudeStreamingTextBlock = (): void => {
      if (!claudeStreamingTextOpen) return;
      safeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
      blockIdx++;
      claudeStreamingTextOpen = false;
      inTextBlock = false;
    };

    const flushClaudeTextBlock = (text: string): void => {
      if (!text) return;
      safeSse(reply, "content_block_start", {
        type: "content_block_start",
        index: blockIdx,
        content_block: { type: "text", text: "" },
      });
      safeSse(reply, "content_block_delta", {
        type: "content_block_delta",
        index: blockIdx,
        delta: { type: "text_delta", text },
      });
      safeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
      blockIdx++;
      inTextBlock = false;
    };

    try {
      for await (const part of streamed.fullStream) {
        if (part.type === "text-delta") {
          const delta = (part as unknown as { text?: string }).text ?? "";
          pendingClaudeTextDeltas.push(delta);
          emitClaudeTextDelta(delta);
        } else if (part.type === "reasoning-start") {
          if (pendingClaudeTextDeltas.length > 0) {
            closeClaudeStreamingTextBlock();
            pendingClaudeTextDeltas.length = 0;
          }
          const text = (part as unknown as { text?: string }).text ?? "";
          safeSse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "thinking", thinking: "" } });
          if (text) {
            safeSse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "thinking_delta", thinking: text } });
          }
        } else if (part.type === "reasoning-delta") {
          const text = (part as unknown as { textDelta?: string }).textDelta ?? "";
          safeSse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "thinking_delta", thinking: text } });
        } else if (part.type === "reasoning-end") {
          safeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
          blockIdx++;
        } else if (part.type === "tool-input-start") {
          const tc = part as unknown as { toolCallId?: string; toolName?: string };
          if (pendingClaudeTextDeltas.length > 0) {
            closeClaudeStreamingTextBlock();
            pendingClaudeTextDeltas.length = 0;
          }
          claudeToolBuffer.set(tc.toolCallId ?? "", { toolName: tc.toolName ?? "", toolCallId: tc.toolCallId ?? "", chunks: [] });
          stopReason = "tool_use";
        } else if (part.type === "tool-input-delta") {
          const td = part as unknown as { toolCallId?: string; inputTextDelta?: string };
          const tdId = td.toolCallId ?? "";
          const buf = claudeToolBuffer.get(tdId);
          if (buf) {
            buf.chunks.push(td.inputTextDelta ?? "");
          }
        } else if (part.type === "tool-call") {
          const tcFull = part as unknown as { toolCallId?: string; toolName?: string; input?: unknown };
          const buf = claudeToolBuffer.get(tcFull.toolCallId ?? "");
          const rawToolInput = (tcFull.input ?? {}) as Record<string, unknown>;
          const hard = applyAdapterToolHardening(
            claudeAdapter,
            tcFull.toolName ?? "",
            rawToolInput,
            buf?.toolName,
          );
          if (hard.remapped) toolArgHardeningStats.remappedArgsCount += 1;
          if (hard.repairedWrite) {
            toolArgHardeningStats.repairedWriteCount += 1;
            requestToolRepairs += 1;
            app.log.warn({
              reqId: traceReqId,
              originalTool: tcFull.toolName,
              rewrittenTo: "Bash",
              filePath: rawToolInput.file_path ?? rawToolInput.path,
            }, "write_tool_repaired_to_bash_heredoc");
          }
          if (hard.repairedBash) {
            toolArgHardeningStats.repairedBashCount += 1;
            requestToolRepairs += 1;
            app.log.warn(
              { reqId: traceReqId, toolName: hard.toolName, bashRepaired: true },
              "bash_tool_args_repaired",
            );
          }
          let emitToolName = hard.toolName;
          let finalInput = hard.input;
          if (isWriteCapableToolName(emitToolName)) {
            session.blockBroadVerificationUntilEdit = false;
            session.blockFailingVerificationUntilEdit = false;
          }

          const governed = governToolCall({
            toolName: emitToolName,
            input: finalInput,
            projectRoot: effectiveClaudePathCtx.projectRoot,
            shellCwd: effectiveClaudePathCtx.shellCwd,
            enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
            blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
            strictBashBlock: claudeOpenClawStrictGovernance,
            blockWriteCapableTools: claudeOpenClawStrictGovernance,
            clientKind: claudeClientKind,
            restrictDiscoveryForPlanWork: shouldRestrictDiscoveryForPlanWork(claudeTaskCue),
            blockBroadVerificationForGreen: session.blockBroadVerificationUntilEdit,
            blockVerificationForFailure: session.blockFailingVerificationUntilEdit,
            planContentShadow: deserializeShadow(session.record.metadata.plan_content_shadow as Record<string, unknown>),
          });
          emitToolName = governed.toolName;
          finalInput = governed.input;
          trackGovernedHardening(governed);
          if (governed.planWriteAudit) {
            emitPlanWriteAuditEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, traceReqId, governed.planWriteAudit);
          }
          maybeLogEnvelopeUnwrapSample(app.log as never, traceReqId, emitToolName, claudeClientKind, governed, tcFull.toolCallId ?? undefined);
          if (governed.constrainedToRoot) {
            app.log.info(
              { reqId: traceReqId, toolName: emitToolName, toolCallId: tcFull.toolCallId },
              "file_tool_path_constrained_to_project_root",
            );
          }
          if (governed.blockedBashDrift) {
            app.log.warn(
              { reqId: traceReqId, toolName: emitToolName, toolCallId: tcFull.toolCallId },
              "bash_path_drift_blocked",
            );
          }
          if (governed.blockedUnsafeShell) {
            app.log.warn(
              { reqId: traceReqId, toolName: emitToolName, toolCallId: tcFull.toolCallId },
              "unsafe_shell_command_blocked",
            );
          }
          if (governed.blockedWriteCapable) {
            app.log.warn(
              { reqId: traceReqId, toolName: emitToolName, toolCallId: tcFull.toolCallId },
              "write_capable_tool_blocked",
            );
          }

          if (governed.validationMissing.length > 0) {
            requestToolValidationFailures += 1;
            app.log.warn(
              {
                reqId: traceReqId,
                toolName: emitToolName,
                missing: governed.validationMissing,
                argsPreview: JSON.stringify(finalInput).slice(0, 220),
              },
              "tool_args_validation_failed",
            );
          }
          if (claudeOpenClawStrictGovernance && isWriteCapableToolName(tcFull.toolName ?? "") && governed.toolName === "Bash") {
            openClawProfileStats.strictGovernanceRewrites += 1;
          }

          if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
            app.log.debug({
              reqId: traceReqId, toolName: emitToolName, toolCallId: tcFull.toolCallId,
              argsLen: JSON.stringify(finalInput).length,
              argsPreview: JSON.stringify(finalInput).slice(0, 300),
              remapped: hard.remapped,
              repairedWrite: hard.repairedWrite,
              repairedBash: hard.repairedBash,
              adapterFamily: claudeAdapter.family,
            }, "claude_tool_call_streamed");
          }
          let candidateCall: GuardrailToolCall = {
            toolCallId: tcFull.toolCallId ?? "",
            toolName: emitToolName,
            input: finalInput,
          };
          const claudeStreamTopDirs = await getCachedTopLevelDirs(effectiveClaudePathCtx.projectRoot ?? effectiveClaudePathCtx.shellCwd);
          const streamGuarded = applyDiscoveryToolGuardrail([...claudeStreamGuardrailAccepted, candidateCall], claudeStreamTopDirs);
          if (streamGuarded.redirectedCount > 0) {
            claudeStreamBlockedBroadDiscovery += streamGuarded.redirectedCount;
            recordBlockedDiscovery(claudeSessionKey, streamGuarded.redirectedCount);
            const redirectedCall = streamGuarded.calls[streamGuarded.calls.length - 1];
            if (redirectedCall) {
              candidateCall = redirectedCall as GuardrailToolCall;
              finalInput = redirectedCall.input;
            }
          }
          if (streamGuarded.calls.length === claudeStreamGuardrailAccepted.length) {
            claudeStreamBlockedBroadDiscovery += streamGuarded.blockedCount;
            claudeStreamCollapsedBroadDiscovery += streamGuarded.collapsedCount;
            const blockedToolCallId = tcFull.toolCallId ?? "";
            if (blockedToolCallId) {
              claudeToolBuffer.delete(blockedToolCallId);
            }
            if (streamGuarded.blockedCount > 0) {
              const recovery = await buildBlockedDiscoveryRecoverySnapshot(
                resolved.resolvedModelId,
                streamGuarded.blockedDetails,
                effectiveClaudePathCtx.projectRoot,
              );
              claudeStreamBlockedDetails.push(...streamGuarded.blockedDetails);
              claudeStreamRecoveryPreviewEntries += recovery.entryCount;
              claudeStreamRecoveryMode = recovery.recoveryMode;
              safeSse(reply, "content_block_start", {
                type: "content_block_start",
                index: blockIdx,
                content_block: { type: "text", text: "" },
              });
              safeSse(reply, "content_block_delta", {
                type: "content_block_delta",
                index: blockIdx,
                delta: { type: "text_delta", text: `\n${recovery.text}\n` },
              });
              safeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
              blockIdx++;
            }
            continue;
          }
          claudeStreamGuardrailAccepted.push(candidateCall);
          claudeStreamToolSequence.push(emitToolName);

          const toolCallId = tcFull.toolCallId ?? "";
          const normalizedJson = JSON.stringify(finalInput);

          safeSse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "tool_use", id: toolCallId, name: emitToolName } });
          safeSse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: normalizedJson } });
          safeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
          blockIdx++;
          claudeToolBuffer.delete(toolCallId);
          claudeStreamEmittedToolCalls += 1;
          stopReason = "tool_use";
        } else if ((part as any).type === "error") {
          throw (part as any).error;
        } else if ((part as any).type === "finish") {
          const fr = (part as any).finishReason;
          if (fr === "length") stopReason = "max_tokens";
          else if (fr === "stop" && claudeToolBuffer.size > 0) stopReason = "end_turn";
        }
      }
      if (
        claudeAdapter.family === "qwen3-coder"
        && isLocalLikeBaseUrl
        && requestToolValidationFailures > 0
        && requestToolRepairs >= 2
      ) {
        toolArgHardeningStats.qwenParserMismatchSuspectCount += 1;
        app.log.warn(
          {
            reqId: traceReqId,
            resolvedModel: resolved.resolvedModelId,
            baseUrl: resolvedTier?.baseUrl,
            validationFailures: requestToolValidationFailures,
            repairs: requestToolRepairs,
          },
          "qwen3_parser_mismatch_suspected: repeated tool arg repairs/validation failures on local endpoint; verify vLLM uses --tool-call-parser=qwen3_coder",
        );
      }
      stopReason = normalizeClaudeStreamStopReason(stopReason, claudeStreamEmittedToolCalls);
      if (claudeStreamBlockedBroadDiscovery > 0) {
        recordBlockedDiscovery(claudeSessionKey, claudeStreamBlockedBroadDiscovery);
        recordSessionEvent(
          claudeSessionKey,
          claudeIdentity.userId,
          claudeIdentity.orgId,
          "tool_call_blocked_broad_discovery",
          "tool-guardrails",
          `blocked=${claudeStreamBlockedBroadDiscovery};sessionTotal=${getBlockedDiscoveryCount(claudeSessionKey)}`,
          traceReqId,
          {
            blockedDetails: claudeStreamBlockedDetails.slice(0, 5),
            recoveryMode: claudeStreamRecoveryMode,
            topLevelPreview: claudeStreamRecoveryPreviewEntries,
            sessionBlockedTotal: getBlockedDiscoveryCount(claudeSessionKey),
          },
        );
        recordSessionEvent(
          claudeSessionKey,
          claudeIdentity.userId,
          claudeIdentity.orgId,
          "blocked_broad_discovery_then_recovery",
          "tool-guardrails",
          `mode=${claudeStreamRecoveryMode ?? "unknown"};top_level_preview=${claudeStreamRecoveryPreviewEntries}`,
          traceReqId,
          { recoveryMode: claudeStreamRecoveryMode, topLevelPreview: claudeStreamRecoveryPreviewEntries },
        );
      }
      if (claudeStreamCollapsedBroadDiscovery > 0) {
        recordSessionEvent(
          claudeSessionKey,
          claudeIdentity.userId,
          claudeIdentity.orgId,
          "duplicate_broad_call_collapsed",
          "tool-guardrails",
          `collapsed=${claudeStreamCollapsedBroadDiscovery}`,
          traceReqId,
        );
      }
    } catch (streamErr) {
      const upstream = extractUpstreamErrorDiagnostics(streamErr);
      circuitBreakers.recordFailure(resolved.resolvedModelId, claudeIdentity.orgId);
      claudeStreamSpan.setStatus("error", upstream.userMessage);
      app.log.error(
        {
          err: streamErr,
          reqId: traceReqId,
          model: resolved.resolvedModelId,
          upstream_error_name: upstream.errorName,
          upstream_error_code: upstream.errorCode,
          upstream_http_status: upstream.httpStatus,
          upstream_vercel_ai_sdk_error: upstream.isVercelAiSdkError,
          upstream_missing_tool_results: upstream.isMissingToolResults,
          upstream_raw_message: upstream.rawMessage.slice(0, 600),
        },
        `Claude stream error: ${upstream.rawMessage.slice(0, 500)}`,
      );
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "stream_error",
        "streamText",
        upstream.userMessage,
        traceReqId,
        {
          model: resolved.resolvedModelId,
          error_name: upstream.errorName ?? "",
          error_code: upstream.errorCode ?? "",
          error_status: upstream.httpStatus ?? 0,
          vercel_ai_sdk_error: upstream.isVercelAiSdkError,
          missing_tool_results: upstream.isMissingToolResults,
        },
      );
      if (!claudeStreamingTextOpen) {
        safeSse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "text", text: "" } });
        claudeStreamingTextOpen = true;
        inTextBlock = true;
      }
      safeSse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "text_delta", text: `\n\n[Upstream provider error — retrying may help]` } });
      stopReason = "end_turn";
    }

    claudeAdmission.release!();

    if (stopReason !== "end_turn" || !inTextBlock) {
      circuitBreakers.recordSuccess(resolved.resolvedModelId, claudeIdentity.orgId);
      claudeStreamSpan.setStatus("ok");
    }
    claudeStreamSpan.end();

    if (stopReason !== "tool_use" && pendingClaudeTextDeltas.length > 0) {
      const rawText = pendingClaudeTextDeltas.join("");
      const finalized = await finalizeCompletionText({
        requestId: traceReqId,
        sessionKey: claudeSessionKey,
        userId: claudeIdentity.userId,
        orgId: claudeIdentity.orgId,
        assistantText: rawText,
        checklist: claudeRequirementChecklist,
        traceRootPrompt: getMetadataString(session.record.metadata, "trace_root_prompt"),
        latestUserPrompt: getMetadataString(session.record.metadata, "latest_user_prompt"),
        verification: claudeVerificationAssessment,
        recentToolNames: extractRecentToolNames(openAIShape.messages as Array<{ role: string; content: unknown }>),
        nonActionableEventDetail: "claude stream stop had non-actionable text; emitted deterministic fallback",
        planGraph: claudePlanGraph,
      });
      claudeStreamGateApplied = finalized.applied;
      claudeStreamMissingMust = finalized.missingMust;
      claudeStreamMissingShould = finalized.missingShould;
      claudeStreamGateBlockedVerification = finalized.blockedByVerification;
      claudeStreamCriticBlocked = finalized.criticBlocked;
      const gateText = finalized.finalText;
      const guarded = applyMarkdownGuardrail(
        gateText,
        config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
      );
      if (claudeStreamingTextOpen) {
        if (guarded !== rawText) {
          if (guarded.startsWith(rawText)) {
            emitClaudeTextDelta(guarded.slice(rawText.length));
          } else {
            closeClaudeStreamingTextBlock();
            flushClaudeTextBlock(guarded);
          }
        } else {
          closeClaudeStreamingTextBlock();
        }
      } else {
        flushClaudeTextBlock(guarded);
      }
      pendingClaudeTextDeltas.length = 0;
    }

    closeClaudeStreamingTextBlock();

    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
    try { usage = readUsage(await streamed.totalUsage as unknown); } catch { /* stream aborted */ }
    const claudeStreamForensicsDone = finalizeRequestForensics(session, reqId, claudeStreamForensics, usage);
    safeSse(reply, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }
    });
    safeSse(reply, "message_stop", { type: "message_stop" });
    safeEnd(reply.raw);
    claudeHeartbeat.stop();

    let claudeStreamedText = "";
    try { claudeStreamedText = await streamed.text; } catch { /* stream aborted */ }
    if (claudeStreamedText) {
      const finalized = finalizePostStreamText({
        requestId: reqId,
        sessionKey: claudeSessionKey,
        userId: claudeIdentity.userId,
        orgId: claudeIdentity.orgId,
        assistantText: claudeStreamedText,
        applyGate: claudeStreamGateApplied,
        checklist: claudeRequirementChecklist,
        traceRootPrompt: getMetadataString(session.record.metadata, "trace_root_prompt"),
        latestUserPrompt: getMetadataString(session.record.metadata, "latest_user_prompt"),
        verification: claudeVerificationAssessment,
        toolStopReason: stopReason === "tool_use",
        nonActionableEventDetail: "claude streamed text was non-actionable; emitted deterministic fallback",
        planGraph: claudePlanGraph,
      });
      claudeStreamedText = finalized.finalText;
      claudeStreamMissingMust = finalized.missingMust;
      claudeStreamMissingShould = finalized.missingShould;
      claudeStreamGateBlockedVerification = finalized.blockedByVerification;
      session.history.push({ role: "assistant", content: claudeStreamedText });
    }
    const claudeStreamLatency = Date.now() - started;
    const claudeStreamSaved = toolResultReduction.getPerRequestDelta() + validationNormalization.getPerRequestDelta();
    const claudeStreamGuidedTrimmed = toolResultReduction.getPerRequestGuidedTruncationDelta();
    const claudeStreamTaskPruned = toolResultReduction.getPerRequestTaskPrunedDelta();
    if (claudeStreamGuidedTrimmed > 0) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "tool_output_truncated_guided",
        "tool-guardrails",
        `count=${claudeStreamGuidedTrimmed}`,
        reqId,
      );
    }
    if (claudeStreamTaskPruned > 0) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "task_conditioned_prune_applied",
        "tool-reducer",
        `count=${claudeStreamTaskPruned}`,
        reqId,
      );
    }
    const lastRecallClaudeStream = toolResultReduction.getLastRecallDecision();
    const vStateClaudeStream = toolResultReduction.getVerificationTracker().getState();
    const claudeStreamSnapshot = buildDecisionSnapshot({
      orchestration: claudeOrchestration,
      recallDecision: lastRecallClaudeStream,
      verificationState: vStateClaudeStream,
      policyMatchedRules: claudePolicyPrecheck.matchedRules,
      reducedToolResults: claudeToolResultCount,
      tokensSavedByReduction: claudeStreamSaved,
      evidencePrefetched: claudePrefetchResult?.matched,
      evidenceConfidence: claudePrefetchResult?.confidence,
      evidenceAuthoritative: claudePrefetchResult?.authoritative,
      evidencePrefetchLatencyMs: claudePrefetchResult ? Math.round(claudePrefetchResult.latencyMs) : undefined,
      isStreaming: true,
      sensemakingTriggered: claudeSensemakingResult?.triggered,
      sensemakingReason: claudeSensemakingResult?.reason,
      governorDecision: claudeExecutionGovernor,
    });
    persistAndEmitDecisionTelemetry({
      state: session,
      requestId: reqId,
      resolvedModelId: resolved.resolvedModelId,
      usage,
      latencyMs: claudeStreamLatency,
      finishReason: stopReason,
      tokensSavedByReduction: claudeStreamSaved,
      escalated: claudeOrchestration.escalated,
      snapshot: claudeStreamSnapshot,
      trajectory: {
        toolSequence: claudeStreamToolSequence,
        verificationSteps: inferVerificationSteps(claudeStreamToolSequence),
        diagnostics: claudeTrajectoryDiagnostics,
        completionGateBlocked: claudeStreamGateBlockedVerification,
        criticBlocked: claudeStreamCriticBlocked,
        outcomeState: (claudeStreamGateBlockedVerification || claudeStreamCriticBlocked) ? "partial" : undefined,
        failureStage: claudeStreamGateBlockedVerification ? "verification" : undefined,
      },
      sessionKey: claudeSessionKey,
      userId: claudeIdentity.userId,
      orgId: claudeIdentity.orgId,
    });
    const claudeStreamMsgCounts = countMessageRoles(openAIShape.messages as Array<{ role: string; content: unknown }>);
    pushDiagnostic({
      timestamp: Date.now(), sessionKey: claudeSessionKey, path: "/v1/messages (stream)", requestId: reqId,
      ...claudeStreamMsgCounts,
      toolDefinitionCount: effectiveClaudeTools.length,
      artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
      knowledgeToolInjected: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
      reducedToolResults: claudeToolResultCount,
      finishReason: stopReason, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens,
      policyDecision: claudePolicyPrecheck.matchedRules.join(","), latencyMs: claudeStreamLatency,
      recallRouting: lastRecallClaudeStream?.routing,
      recallConfidence: lastRecallClaudeStream?.resolution?.confidence,
      verificationRound: vStateClaudeStream.round > 0 ? vStateClaudeStream.round : undefined,
      verificationFindings: vStateClaudeStream.round > 0 ? vStateClaudeStream.findings.length : undefined,
      verificationStalled: vStateClaudeStream.stalled || undefined,
      decisionPath: claudeOrchestration.decisionPath,
      decisionEscalated: claudeOrchestration.escalated || undefined,
      sensemakingTriggered: claudeSensemakingResult?.triggered || undefined,
      sensemakingReason: claudeSensemakingResult?.reason,
      evidencePrefetchHit: claudePrefetchResult?.matched && (claudePrefetchResult?.confidence ?? 0) > 0 || undefined,
      evidencePrefetchConfidence: claudePrefetchResult?.confidence || undefined,
      evidencePrefetchMs: claudePrefetchResult ? Math.round(claudePrefetchResult.latencyMs) : undefined,
      promptProfileIds: claudeEnriched.promptProfileIds,
      promptProfileHashes: claudeEnriched.promptProfileHashes,
      prefixHash: claudeEnriched.prefixHash,
      prefixChangeReasons: claudeEnriched.prefixChangeReasons,
      completionGateApplied: claudeStreamGateApplied || undefined,
      missingMustRequirements: claudeStreamMissingMust || undefined,
      missingShouldRequirements: claudeStreamMissingShould || undefined,
      requirementChecklistMust: claudeRequirementChecklist?.must.length || undefined,
      requirementChecklistShould: claudeRequirementChecklist?.should.length || undefined,
      contextAdmissionDecision: claudeContextAdmission.decision,
      contextAdmissionReason: claudeContextAdmission.reason,
      contextAdmissionEstimatedTokens: claudeContextAdmission.estimatedTokens,
      contextAdmissionEstimatedChars: claudeContextAdmission.estimatedChars,
      requestForensicsSummary: claudeStreamForensicsDone?.summary,
      requestForensicsLcpRatio: claudeStreamForensicsDone?.lcpRatio,
      requestForensicsFirstChangedSection: claudeStreamForensicsDone?.firstChangedSection,
      requestForensicsTokenEstimate: claudeStreamForensicsDone?.tokenEstimate,
      cacheStrategy: claudeCacheStrategy !== "none" ? claudeCacheStrategy : undefined,
      prefixFingerprint: claudePrefixFingerprint,
    });
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
  const claudeServerWebSearchEvents: ClaudeServerWebSearchEvent[] = [];
  let result: Awaited<ReturnType<typeof generateText>> | null = null;
  let lastClaudeNonStreamForensics: RequestForensicsRecord | undefined;
  try {
    let currentMessages = claudeModelMessages;
    let requiredValidationCompleted = false;
    for (let round = 0; round < 3; round++) {
      const roundForensics = captureRequestForensics(
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
      );
      result = await generateText({
        model: resolved.model as never,
        messages: currentMessages,
        maxOutputTokens: clampMaxOutputTokensForSafety(Math.max(claudeOrchestration.maxOutputTokens, body.max_tokens ?? 0)),
        ...(claudeEffectiveTemp !== undefined ? { temperature: claudeEffectiveTemp } : {}),
    ...(claudeEffectiveTopP !== undefined ? { topP: claudeEffectiveTopP } : {}),
        ...(sdkStop ? { stopSequences: sdkStop } : {}),
        ...(sdkTools ? { tools: sdkTools } : {}),
        ...(effectiveClaudeToolChoice ? { toolChoice: effectiveClaudeToolChoice } : {}),
        ...(providerOptions ? { providerOptions: providerOptions as never } : {})
      });
      const roundUsage = readUsage((result as unknown as { usage?: unknown }).usage);
      lastClaudeNonStreamForensics = finalizeRequestForensics(session, reqId, roundForensics, roundUsage);

      let allCalls = (result as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
      if (!requiredValidationCompleted && claudePhasePolicy.toolChoice === "required") {
        requiredValidationCompleted = true;
        let validation = validateRequiredToolCalls(allCalls, claudePhasePolicy);
        if (!validation.valid) {
          recordSessionEvent(
            claudeSessionKey,
            claudeIdentity.userId,
            claudeIdentity.orgId,
            "phase_required_validation_retry",
            "execution-governor",
            `reasons=${validation.reasons.join(",") || "unknown"}`,
            reqId,
          );
          currentMessages = appendSystemMessageAndNormalize(
            currentMessages as Array<{ role: string; content?: unknown }>,
            buildRequiredRepairPrompt(claudeGovernorPhase, claudePhasePolicy.allowedCanonicalTools),
          ) as typeof currentMessages;
          const repairForensics = captureRequestForensics(
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
          );
          result = await generateText({
            model: resolved.model as never,
            messages: currentMessages,
            maxOutputTokens: clampMaxOutputTokensForSafety(Math.max(claudeOrchestration.maxOutputTokens, body.max_tokens ?? 0)),
            ...(claudeEffectiveTemp !== undefined ? { temperature: claudeEffectiveTemp } : {}),
            ...(claudeEffectiveTopP !== undefined ? { topP: claudeEffectiveTopP } : {}),
            ...(sdkStop ? { stopSequences: sdkStop } : {}),
            ...(sdkTools ? { tools: sdkTools } : {}),
            ...(effectiveClaudeToolChoice ? { toolChoice: effectiveClaudeToolChoice } : {}),
            ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
          });
          const repairUsage = readUsage((result as unknown as { usage?: unknown }).usage);
          lastClaudeNonStreamForensics = finalizeRequestForensics(session, reqId, repairForensics, repairUsage);
          allCalls = (result as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
          validation = validateRequiredToolCalls(allCalls, claudePhasePolicy);
          if (!validation.valid) {
            recordSessionEvent(
              claudeSessionKey,
              claudeIdentity.userId,
              claudeIdentity.orgId,
              "phase_required_validation_fallback",
              "execution-governor",
              `fallback_after_retry reasons=${validation.reasons.join(",") || "unknown"}`,
              reqId,
            );
            effectiveClaudeToolChoice = "auto";
            currentMessages = appendSystemMessageAndNormalize(
              currentMessages as Array<{ role: string; content?: unknown }>,
              "Phase execution policy fallback: required tool-call contract failed after retry. Continue with tool_choice=auto and recover safely.",
            ) as typeof currentMessages;
            const fallbackForensics = captureRequestForensics(
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
            );
            result = await generateText({
              model: resolved.model as never,
              messages: currentMessages,
              maxOutputTokens: clampMaxOutputTokensForSafety(Math.max(claudeOrchestration.maxOutputTokens, body.max_tokens ?? 0)),
              ...(claudeEffectiveTemp !== undefined ? { temperature: claudeEffectiveTemp } : {}),
              ...(claudeEffectiveTopP !== undefined ? { topP: claudeEffectiveTopP } : {}),
              ...(sdkStop ? { stopSequences: sdkStop } : {}),
              ...(sdkTools ? { tools: sdkTools } : {}),
              ...(effectiveClaudeToolChoice ? { toolChoice: effectiveClaudeToolChoice } : {}),
              ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
            });
            const fallbackUsage = readUsage((result as unknown as { usage?: unknown }).usage);
            lastClaudeNonStreamForensics = finalizeRequestForensics(session, reqId, fallbackForensics, fallbackUsage);
            allCalls = (result as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];
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
      if (result.text) assistantParts.push({ type: "text", text: result.text });
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
        const searchPayload = isObjectRecord(searchOutput) ? searchOutput : { error: "invalid_server_tool_payload" };
        claudeServerWebSearchEvents.push(
          toClaudeServerWebSearchEvent(call.toolCallId, call.toolName, input, searchPayload),
        );
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
          output: { type: "text", value: JSON.stringify(searchPayload) },
        });
      }

      if (assistantParts.length === 0) assistantParts.push({ type: "text", text: "" });
      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: assistantParts } as never,
        { role: "tool", content: toolResults } as never,
      ];
    }
    if (!result) {
      throw new Error("empty_generation_result");
    }
  } catch (err) {
    const upstream = extractUpstreamErrorDiagnostics(err);
    circuitBreakers.recordFailure(resolved.resolvedModelId, claudeIdentity.orgId);
    claudeNonStreamSpan.setStatus("error", upstream.userMessage);
    claudeNonStreamSpan.end();
    app.log.error(
      {
        err,
        reqId,
        model: resolved.resolvedModelId,
        upstream_error_name: upstream.errorName,
        upstream_error_code: upstream.errorCode,
        upstream_http_status: upstream.httpStatus,
        upstream_vercel_ai_sdk_error: upstream.isVercelAiSdkError,
        upstream_missing_tool_results: upstream.isMissingToolResults,
        upstream_raw_message: upstream.rawMessage.slice(0, 600),
      },
      "Claude non-stream generateText failed",
    );
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "upstream_error",
      "generateText",
      upstream.userMessage,
      reqId,
      {
        model: resolved.resolvedModelId,
        error_name: upstream.errorName ?? "",
        error_code: upstream.errorCode ?? "",
        error_status: upstream.httpStatus ?? 0,
        vercel_ai_sdk_error: upstream.isVercelAiSdkError,
        missing_tool_results: upstream.isMissingToolResults,
      },
    );
    return reply.code(502).send({
      type: "error",
      error: { type: "upstream_error", message: upstream.userMessage }
    });
  }
  circuitBreakers.recordSuccess(resolved.resolvedModelId, claudeIdentity.orgId);
  claudeNonStreamSpan.setStatus("ok");
  claudeNonStreamSpan.end();
  let allToolCalls = (result as unknown as { toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }).toolCalls ?? [];

  let externalClaudeToolCalls = allToolCalls.map((tc) => {
      const rawInput =
        typeof tc.input === "object" && tc.input !== null && !Array.isArray(tc.input)
          ? (tc.input as Record<string, unknown>)
          : {};
      const hard = applyAdapterToolHardening(claudeAdapter, tc.toolName, rawInput);
      if (hard.remapped) toolArgHardeningStats.remappedArgsCount += 1;
      if (hard.repairedWrite) {
        toolArgHardeningStats.repairedWriteCount += 1;
        app.log.warn(
          {
            reqId,
            originalTool: tc.toolName,
            rewrittenTo: "Bash",
            filePath: rawInput.file_path ?? rawInput.path,
          },
          "write_tool_repaired_to_bash_heredoc",
        );
      }
      if (hard.repairedBash) {
        toolArgHardeningStats.repairedBashCount += 1;
        app.log.warn({ reqId, toolName: hard.toolName, bashRepaired: true }, "bash_tool_args_repaired");
      }
      if (isWriteCapableToolName(hard.toolName)) {
        session.blockBroadVerificationUntilEdit = false;
        session.blockFailingVerificationUntilEdit = false;
      }
      const governed = governToolCall({
        toolName: hard.toolName,
        input: hard.input,
        projectRoot: effectiveClaudePathCtx.projectRoot,
        shellCwd: effectiveClaudePathCtx.shellCwd,
        enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
        blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
        strictBashBlock: claudeOpenClawStrictGovernance,
        blockWriteCapableTools: claudeOpenClawStrictGovernance,
        clientKind: claudeClientKind,
        restrictDiscoveryForPlanWork: shouldRestrictDiscoveryForPlanWork(claudeTaskCue),
        blockBroadVerificationForGreen: session.blockBroadVerificationUntilEdit,
        blockVerificationForFailure: session.blockFailingVerificationUntilEdit,
        planContentShadow: deserializeShadow(session.record.metadata.plan_content_shadow as Record<string, unknown>),
      });
      trackGovernedHardening(governed);
      if (governed.planWriteAudit) {
        emitPlanWriteAuditEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, reqId, governed.planWriteAudit);
      }
      maybeLogEnvelopeUnwrapSample(app.log as never, reqId, governed.toolName, claudeClientKind, governed, tc.toolCallId);
      if (governed.validationMissing.length > 0) {
        app.log.warn(
          { reqId, toolName: governed.toolName, missing: governed.validationMissing },
          "tool_args_validation_failed",
        );
      }
      if (claudeOpenClawStrictGovernance && isWriteCapableToolName(tc.toolName) && governed.toolName === "Bash") {
        openClawProfileStats.strictGovernanceRewrites += 1;
      }
      return {
        toolCallId: tc.toolCallId,
        toolName: governed.toolName,
        input: governed.input,
      };
    });
  let claudeBlockedBroadDiscovery = 0;
  let claudeRedirectedBroadDiscovery = 0;
  let claudeCollapsedBroadDiscovery = 0;
  const claudeTopLevelDirs = await getCachedTopLevelDirs(effectiveClaudePathCtx.projectRoot ?? effectiveClaudePathCtx.shellCwd);
  const claudeGuarded = applyDiscoveryToolGuardrail(externalClaudeToolCalls, claudeTopLevelDirs);
  externalClaudeToolCalls = claudeGuarded.calls;
  claudeBlockedBroadDiscovery = claudeGuarded.blockedCount;
  claudeRedirectedBroadDiscovery = claudeGuarded.redirectedCount;
  claudeCollapsedBroadDiscovery = claudeGuarded.collapsedCount;
  const reasoning = (result as unknown as { reasoning?: string }).reasoning;
  const usage = readUsage((result as unknown as { usage?: unknown }).usage);
  let stopReason = externalClaudeToolCalls.length > 0 ? "tool_use" : "end_turn";
  let finalClaudeText = result.text ?? "";
  if (claudeRedirectedBroadDiscovery > 0) {
    recordBlockedDiscovery(claudeSessionKey, claudeRedirectedBroadDiscovery);
    recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "broad_discovery_redirected", "tool-guardrails",
      `redirected=${claudeRedirectedBroadDiscovery};sessionTotal=${getBlockedDiscoveryCount(claudeSessionKey)}`, reqId,
      { redirectedDetails: claudeGuarded.redirectedDetails.slice(0, 5), sessionBlockedTotal: getBlockedDiscoveryCount(claudeSessionKey) });
  }
  if (claudeBlockedBroadDiscovery > 0) {
    const claudeSessionBlockedTotal = recordBlockedDiscovery(claudeSessionKey, claudeBlockedBroadDiscovery);
    const recovery = await buildBlockedDiscoveryRecoverySnapshot(
      resolved.resolvedModelId,
      claudeGuarded.blockedDetails,
      effectiveClaudePathCtx.projectRoot,
    );
    finalClaudeText = [
      finalClaudeText.trim(),
      recovery.text,
    ].filter(Boolean).join("\n\n");
    if (claudeSessionBlockedTotal >= 2) {
      finalClaudeText += "\n\nCRITICAL: Glob has been blocked multiple times in this session. The Glob tool will be removed from your available tools. Use Read and Grep instead.";
    }
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "tool_call_blocked_broad_discovery",
      "tool-guardrails",
      `blocked=${claudeBlockedBroadDiscovery};sessionTotal=${claudeSessionBlockedTotal}`,
      reqId,
      { blockedDetails: claudeGuarded.blockedDetails.slice(0, 5), recoveryMode: recovery.recoveryMode, sessionBlockedTotal: claudeSessionBlockedTotal },
    );
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "blocked_broad_discovery_then_recovery",
      "tool-guardrails",
      `mode=${recovery.recoveryMode};top_level_preview=${recovery.entryCount}`,
      reqId,
      { recoveryMode: recovery.recoveryMode, topLevelPreview: recovery.entryCount },
    );
  }
  if (claudeCollapsedBroadDiscovery > 0) {
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "duplicate_broad_call_collapsed",
      "tool-guardrails",
      `collapsed=${claudeCollapsedBroadDiscovery}`,
      reqId,
    );
  }
  const claudeLegacyGuarded = applyDiscoveryToolGuardrail(externalClaudeToolCalls, claudeTopLevelDirs);
  externalClaudeToolCalls = claudeLegacyGuarded.calls;
  if (claudeLegacyGuarded.redirectedCount > 0) {
    claudeRedirectedBroadDiscovery += claudeLegacyGuarded.redirectedCount;
    recordBlockedDiscovery(claudeSessionKey, claudeLegacyGuarded.redirectedCount);
    recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "broad_discovery_redirected", "tool-guardrails",
      `redirected=${claudeLegacyGuarded.redirectedCount};sessionTotal=${getBlockedDiscoveryCount(claudeSessionKey)}`, reqId,
      { redirectedDetails: claudeLegacyGuarded.redirectedDetails.slice(0, 5), sessionBlockedTotal: getBlockedDiscoveryCount(claudeSessionKey) });
  }
  if (claudeLegacyGuarded.blockedCount > 0) {
    const claudeLegacyBlockedTotal = recordBlockedDiscovery(claudeSessionKey, claudeLegacyGuarded.blockedCount);
    const recovery = await buildBlockedDiscoveryRecoverySnapshot(
      resolved.resolvedModelId,
      claudeLegacyGuarded.blockedDetails,
      effectiveClaudePathCtx.projectRoot,
    );
    finalClaudeText = [
      finalClaudeText.trim(),
      recovery.text,
    ].filter(Boolean).join("\n\n");
    if (claudeLegacyBlockedTotal >= 2) {
      finalClaudeText += "\n\nCRITICAL: Glob has been blocked multiple times in this session. The Glob tool will be removed from your available tools. Use Read and Grep instead.";
    }
    stopReason = externalClaudeToolCalls.length > 0 ? "tool_use" : "end_turn";
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "tool_call_blocked_broad_discovery",
      "tool-guardrails",
      `blocked=${claudeLegacyGuarded.blockedCount};sessionTotal=${claudeLegacyBlockedTotal}`,
      reqId,
      { blockedDetails: claudeLegacyGuarded.blockedDetails.slice(0, 5), sessionBlockedTotal: claudeLegacyBlockedTotal },
    );
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "blocked_broad_discovery_then_recovery",
      "tool-guardrails",
      `mode=${recovery.recoveryMode};top_level_preview=${recovery.entryCount}`,
      reqId,
      { recoveryMode: recovery.recoveryMode, topLevelPreview: recovery.entryCount },
    );
  }
  if (claudeLegacyGuarded.collapsedCount > 0) {
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "duplicate_broad_call_collapsed",
      "tool-guardrails",
      `collapsed=${claudeLegacyGuarded.collapsedCount}`,
      reqId,
    );
  }
  let claudeGateApplied = false;
  let claudeMissingMust = 0;
  let claudeMissingShould = 0;
  let claudeGateBlockedVerification = false;
  let claudeCriticBlocked = false;
  if (stopReason === "end_turn") {
    const finalized = await finalizeCompletionText({
      requestId: reqId,
      sessionKey: claudeSessionKey,
      userId: claudeIdentity.userId,
      orgId: claudeIdentity.orgId,
      assistantText: finalClaudeText,
      checklist: claudeRequirementChecklist,
      traceRootPrompt: getMetadataString(session.record.metadata, "trace_root_prompt"),
      latestUserPrompt: getMetadataString(session.record.metadata, "latest_user_prompt"),
      verification: claudeVerificationAssessment,
      recentToolNames: extractRecentToolNames(openAIShape.messages as Array<{ role: string; content: unknown }>),
      nonActionableEventDetail: "terminal end_turn had non-actionable text; emitted deterministic fallback",
      planGraph: claudePlanGraph,
    });
    finalClaudeText = finalized.finalText;
    claudeGateApplied = finalized.applied;
    claudeMissingMust = finalized.missingMust;
    claudeMissingShould = finalized.missingShould;
    claudeGateBlockedVerification = finalized.blockedByVerification;
    claudeCriticBlocked = finalized.criticBlocked;
  }
  finalClaudeText = applyMarkdownGuardrail(
    finalClaudeText,
    config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
  );
  if (finalClaudeText) {
    session.history.push({ role: "assistant", content: finalClaudeText });
  }
  const claudeNonStreamLatency = Date.now() - started;
  const claudeNonStreamSaved = toolResultReduction.getPerRequestDelta() + validationNormalization.getPerRequestDelta();
  const claudeNonStreamGuidedTrimmed = toolResultReduction.getPerRequestGuidedTruncationDelta();
  const claudeNonStreamTaskPruned = toolResultReduction.getPerRequestTaskPrunedDelta();
  if (claudeNonStreamGuidedTrimmed > 0) {
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "tool_output_truncated_guided",
      "tool-guardrails",
      `count=${claudeNonStreamGuidedTrimmed}`,
      reqId,
    );
  }
  if (claudeNonStreamTaskPruned > 0) {
    recordSessionEvent(
      claudeSessionKey,
      claudeIdentity.userId,
      claudeIdentity.orgId,
      "task_conditioned_prune_applied",
      "tool-reducer",
      `count=${claudeNonStreamTaskPruned}`,
      reqId,
    );
  }
  const lastRecallClaudeNonStream = toolResultReduction.getLastRecallDecision();
  const vStateClaudeNonStream = toolResultReduction.getVerificationTracker().getState();
  const claudeNonStreamSnapshot = buildDecisionSnapshot({
    orchestration: claudeOrchestration,
    recallDecision: lastRecallClaudeNonStream,
    verificationState: vStateClaudeNonStream,
    policyMatchedRules: claudePolicyPrecheck.matchedRules,
    reducedToolResults: claudeToolResultCount,
    tokensSavedByReduction: claudeNonStreamSaved,
    evidencePrefetched: claudePrefetchResult?.matched,
    evidenceConfidence: claudePrefetchResult?.confidence,
    evidenceAuthoritative: claudePrefetchResult?.authoritative,
    evidencePrefetchLatencyMs: claudePrefetchResult ? Math.round(claudePrefetchResult.latencyMs) : undefined,
    isStreaming: false,
    sensemakingTriggered: claudeSensemakingResult?.triggered,
    sensemakingReason: claudeSensemakingResult?.reason,
    governorDecision: claudeExecutionGovernor,
  });
  persistAndEmitDecisionTelemetry({
    state: session,
    requestId: reqId,
    resolvedModelId: resolved.resolvedModelId,
    usage,
    latencyMs: claudeNonStreamLatency,
    finishReason: stopReason,
    tokensSavedByReduction: claudeNonStreamSaved,
    escalated: claudeOrchestration.escalated,
    snapshot: claudeNonStreamSnapshot,
    trajectory: {
      toolSequence: externalClaudeToolCalls.map((tc) => tc.toolName),
      verificationSteps: inferVerificationSteps(externalClaudeToolCalls.map((tc) => tc.toolName)),
      diagnostics: claudeTrajectoryDiagnostics,
      completionGateBlocked: claudeGateBlockedVerification,
      criticBlocked: claudeCriticBlocked,
      outcomeState: (claudeGateBlockedVerification || claudeCriticBlocked) ? "partial" : undefined,
      failureStage: claudeGateBlockedVerification ? "verification" : undefined,
    },
    sessionKey: claudeSessionKey,
    userId: claudeIdentity.userId,
    orgId: claudeIdentity.orgId,
  });
  const claudeNonStreamMsgCounts = countMessageRoles(openAIShape.messages as Array<{ role: string; content: unknown }>);
  pushDiagnostic({
    timestamp: Date.now(), sessionKey: claudeSessionKey, path: "/v1/messages", requestId: reqId,
    ...claudeNonStreamMsgCounts,
    toolDefinitionCount: effectiveClaudeTools.length,
    artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
    knowledgeToolInjected: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
    reducedToolResults: claudeToolResultCount,
    finishReason: stopReason, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens,
    policyDecision: claudePolicyPrecheck.matchedRules.join(","), latencyMs: claudeNonStreamLatency,
    recallRouting: lastRecallClaudeNonStream?.routing,
    recallConfidence: lastRecallClaudeNonStream?.resolution?.confidence,
    verificationRound: vStateClaudeNonStream.round > 0 ? vStateClaudeNonStream.round : undefined,
    verificationFindings: vStateClaudeNonStream.round > 0 ? vStateClaudeNonStream.findings.length : undefined,
    verificationStalled: vStateClaudeNonStream.stalled || undefined,
    decisionPath: claudeOrchestration.decisionPath,
    decisionEscalated: claudeOrchestration.escalated || undefined,
    sensemakingTriggered: claudeSensemakingResult?.triggered || undefined,
    sensemakingReason: claudeSensemakingResult?.reason,
    evidencePrefetchHit: claudePrefetchResult?.matched && (claudePrefetchResult?.confidence ?? 0) > 0 || undefined,
    evidencePrefetchConfidence: claudePrefetchResult?.confidence || undefined,
    evidencePrefetchMs: claudePrefetchResult ? Math.round(claudePrefetchResult.latencyMs) : undefined,
    promptProfileIds: claudeEnriched.promptProfileIds,
    promptProfileHashes: claudeEnriched.promptProfileHashes,
    prefixHash: claudeEnriched.prefixHash,
    prefixChangeReasons: claudeEnriched.prefixChangeReasons,
    completionGateApplied: claudeGateApplied || undefined,
    missingMustRequirements: claudeMissingMust || undefined,
    missingShouldRequirements: claudeMissingShould || undefined,
    requirementChecklistMust: claudeRequirementChecklist?.must.length || undefined,
    requirementChecklistShould: claudeRequirementChecklist?.should.length || undefined,
    contextAdmissionDecision: claudeContextAdmission.decision,
    contextAdmissionReason: claudeContextAdmission.reason,
    contextAdmissionEstimatedTokens: claudeContextAdmission.estimatedTokens,
    contextAdmissionEstimatedChars: claudeContextAdmission.estimatedChars,
    requestForensicsSummary: lastClaudeNonStreamForensics?.summary,
    requestForensicsLcpRatio: lastClaudeNonStreamForensics?.lcpRatio,
    requestForensicsFirstChangedSection: lastClaudeNonStreamForensics?.firstChangedSection,
    requestForensicsTokenEstimate: lastClaudeNonStreamForensics?.tokenEstimate,
  });

  const content: Array<Record<string, unknown>> = [];
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (claudeServerWebSearchEvents.length > 0) {
    for (const evt of claudeServerWebSearchEvents) {
      content.push({
        type: "server_tool_use",
        id: evt.toolUseId,
        name: evt.toolName,
        input: evt.input,
      });
      if (evt.errorCode) {
        content.push({
          type: "web_search_tool_result",
          tool_use_id: evt.toolUseId,
          content: {
            type: "web_search_tool_result_error",
            error_code: evt.errorCode,
          },
        });
      } else {
        content.push({
          type: "web_search_tool_result",
          tool_use_id: evt.toolUseId,
          content: evt.results,
        });
      }
    }
  }
  if (finalClaudeText) {
    content.push({ type: "text", text: finalClaudeText });
  }
  if (externalClaudeToolCalls.length > 0) {
    for (const tc of sdkToolCallsToClaude(externalClaudeToolCalls)) {
      content.push({ ...tc });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  applyClarificationRoundResponseHeader(reply, session.record.metadata);
  return reply.send({
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: resolved.resolvedModelId,
    content,
    stop_reason: stopReason,
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }
  });
});

await refreshTierRegistry();
const tierPollTimer = setInterval(() => {
  void refreshTierRegistry();
}, config.SYNESIS_YARN_TIER_POLL_INTERVAL * 1000);

await app.listen({ port: config.PORT, host: config.HOST });
