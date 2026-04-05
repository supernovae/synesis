import crypto from "node:crypto";
import Fastify from "fastify";
import { Registry } from "prom-client";
import { generateText, streamText } from "ai";
import {
  createServiceMetrics,
  recordUsageMetrics,
  computeCost,
  emitTrace,
  type LlmUsage as TelemetryLlmUsage,
  type PricingSource,
  type TraceRecord,
} from "@synesis/telemetry";
import { loadConfig } from "./config.js";
import {
  ClaudeMessagesRequestSchema,
  OpenAIChatCompletionRequestSchema,
  type ClaudeMessagesRequest,
  type OpenAIChatCompletionRequest
} from "./schemas.js";
import {
  fetchTierRegistrySnapshot,
  TIER_TO_ROLE,
  type PromptSnapshot,
  type RoleAssignmentConfig,
} from "./providers/admin-tier-registry.js";
import { SynesisProviderRegistry } from "./providers/synesis-provider.js";
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
import { DedupeLayer } from "./dedupe/DedupeLayer.js";
import { ToolPrefixCache } from "./tool-prefix-cache/ToolPrefixCache.js";
import {
  registerToolCollapseRoutes,
  ToolCallInterceptor,
  planToSyntheticToolCalls,
  defaultShellAllowlistFromEnv,
} from "./tool-collapse/index.js";
import { DeterministicPolicyEngine, type PolicyDecision } from "./policy/deterministic-policy-engine.js";
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
import { AttentionPositioningService } from "./context/attention-positioning.js";
import { SessionContinuityService } from "./context/session-continuity.js";
import { applyMarkdownGuardrail, buildResponseStyleBlock } from "./response-style.js";
import {
  openAIToolsToSDK,
  claudeToolsToSDK,
  mapToolChoice,
  parseLegacyInlineToolCall,
  sdkToolCallsToOpenAI,
  sdkToolCallsToClaude,
  claudeMessagesToOpenAI,
  openAIMessagesToModelMessages,
  sanitizeToolCalls
} from "./tool-mapping.js";
import { applyToolSearchPolicy } from "./compat/tool-search-policy.js";
import { splitJitter, applyJitter } from "./compat/jitter-buffer.js";
import { sortToolSchemas } from "./compat/sorted-tools.js";
import {
  extractToolSchemaName,
  pruneToolSchemas,
} from "./compat/tool-schema-pruning.js";
import { applyTrustPackets } from "./security/transcript-trust.js";
import { CircuitBreakerRegistry } from "./providers/circuit-breaker.js";
import { UserRateLimiter } from "./middleware/user-rate-limit.js";
import { initOtel, getTracer, withSpan, withSpanAsync } from "./telemetry/otel.js";
import { startEventLoopMonitor, getEventLoopStats } from "./telemetry/event-loop-monitor.js";
import { buildDecisionSnapshot, snapshotToTraceFields, type DecisionSnapshot } from "./telemetry/decision-snapshot.js";
import {
  analyzeGaps,
  shouldTriggerSensemaking,
  buildExplorationPlan,
  formatExplorationPlanBlock,
  createEmptySensemakingStats,
  type SensemakingResult,
  type GapAnalysisContext,
  type SensemakingStats,
} from "./sensemaking/index.js";
import { DistributedCounterService } from "./state/distributed-counters.js";
import { StreamAdmissionController } from "./middleware/stream-admission.js";
import { EnrichmentPool } from "./workers/pool.js";
import type { TierCFallbackContext, TierCFallbackResult } from "./validation/normalizer.js";

type SessionState = {
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  toolCallsSinceCheckpoint: number;
  consecutiveToolCalls: number;
  stagnantToolCycles: number;
  lastToolSignalHash: string;
  awaitingToolLoopUserAck: boolean;
  toolLoopAckAnchorUserHash: string;
  toolLoopNoUserAckCount: number;
  record: SessionRecord;
};

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
    if (name === "apply_patch") patchOps += 1;
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
  if (report.missingMust.length === 0) {
    return {
      finalText: originalText,
      applied: false,
      missingMust: 0,
      missingShould: report.missingShould.length,
      blockedByVerification: false,
      blockingVerificationFailures: 0,
      suggestedNextActions: [],
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
    suggestedNextActions: ["continue implementation to close missing must-have requirements"],
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
  const next = [...messages];
  const sysIdx = next.findIndex((m) => m.role === "system" && typeof m.content === "string");
  if (sysIdx >= 0) {
    next[sysIdx] = { ...next[sysIdx], content: `${String(next[sysIdx].content)}\n\n${block}` };
  } else {
    next.unshift({ role: "system", content: block });
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
    || n === "apply_patch"
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
  completionGateApplied?: boolean;
  missingMustRequirements?: number;
  missingShouldRequirements?: number;
  requirementChecklistMust?: number;
  requirementChecklistShould?: number;
}

const diagnosticRing: RequestDiagnostic[] = [];
let DIAGNOSTIC_RING_MAX = 20;
const toolArgHardeningStats = {
  normalizedPathCount: 0,
  projectRootConstrainedCount: 0,
  blockedBashPathDriftCount: 0,
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

const yarnDedupeLayer =
  config.SYNESIS_YARN_TOOL_COLLAPSE_ENABLED && config.SYNESIS_YARN_DEDUPE_ENABLED
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
const roleAssignmentRegistry = new Map<string, RoleAssignmentConfig>();
let promptSnapshotRegistry: PromptSnapshot | null = null;
const sawtooth = new SawtoothContextManager(config.SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS, config.SYNESIS_YARN_COMPACTION_FALLBACK_MAX_CHARS);
const sessions = new Map<string, SessionState>();
const sessionStore = new SessionStore(config);
const diagnosticStore = new DiagnosticStore(config);
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
const validationNormalization = new ValidationNormalizationService(config, artifactStore);
const toolResultReduction = new ToolResultReductionService(config, artifactStore);
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
}

function inferModelFamily(backendModel: string): string {
  const m = (backendModel || "").toLowerCase();
  if (/qwen3.*coder/.test(m)) return "qwen3-coder";
  if (/deepseek/.test(m)) return "deepseek";
  if (/kimi|moonshot/.test(m)) return "kimi";
  return "generic";
}

function enrichWithFrameAndManifest(
  messages: Array<{ role: string; content: unknown }>,
  sessionKey: string,
  adapterBlock?: string,
  promptContext?: { tier?: string; role?: string; modelFamily?: string; node?: string },
  pathHints?: { projectRoot: string | null; shellCwd: string | null } | null,
): EnrichResult {
  const out = [...messages];
  let detectedPhase: WorkflowPhase | undefined;
  let detectedGoal: string | undefined;

  const partition = config.SYNESIS_YARN_STABLE_PREFIX_ENABLED
    ? stablePrefixService.partition(sessionKey, adapterBlock, promptSnapshotRegistry, promptContext)
    : {
      stablePrefix: "You are an AI coding assistant provided by Synesis.",
      promptProfileIds: [],
      promptProfileHashes: [],
    };
  const systemPrefix = partition.stablePrefix;

  const volatileBlocks: Array<{ role: string; content: string }> = [];

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
        volatileBlocks.push({ role: "system", content: workingFrameService.toSystemBlock(frame, wfPathHints) });
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
              volatileBlocks.push({
                role: "system",
                content: `<STRUCTURAL_CRITIC>\n${critique.summary}\n</STRUCTURAL_CRITIC>`,
              });
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
        volatileBlocks.push({ role: "system", content: workingFrameService.toRichSystemBlock(richFrame, wfPathHints) });
      }
    } else {
      const frame = workingFrameService.build(out);
      detectedPhase = phaseFromFrame(frame.currentPhase);
      detectedGoal = frame.goal;
      volatileBlocks.push({ role: "system", content: workingFrameService.toSystemBlock(frame, wfPathHints) });
    }
  }

  if (config.SYNESIS_YARN_PROJECT_MANIFEST_ENABLED) {
    const manifest = projectManifestService.build(out);
    volatileBlocks.push({ role: "system", content: projectManifestService.toSystemBlock(manifest) });
  }

  if (config.SYNESIS_YARN_VERIFICATION_PLAN_ENABLED) {
    const detectedLangs = detectLanguagesFromMessages(out);
    if (detectedLangs.length > 0) {
      const vPlan = buildVerificationPlan(
        detectedLangs,
        getLanguagePackRegistry(),
        config.SYNESIS_YARN_VERIFICATION_MAX_ROUNDS,
        config.SYNESIS_YARN_VERIFICATION_BUDGET_MS,
      );
      const vBlock = formatVerificationPlanBlock(vPlan);
      if (vBlock) {
        volatileBlocks.push({ role: "system", content: vBlock });
      }
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
  if (responseStyleBlock) {
    volatileBlocks.push({ role: "system", content: responseStyleBlock });
  }

  const enriched: Array<{ role: string; content: unknown }> = [
    { role: "system", content: systemPrefix },
    ...volatileBlocks,
    ...out
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
  };
}

function phaseFromFrame(currentPhase: "explore" | "planning" | "implementation" | "validation"): WorkflowPhase {
  if (currentPhase === "explore") return "explore";
  if (currentPhase === "planning") return "planning";
  if (currentPhase === "validation") return "validation";
  return "implementation";
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
  const history: SessionState["history"] = [];

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
    record
  };
  sessions.set(key, state);
  return state;
}


async function casSessionSave(state: SessionState): Promise<void> {
  try {
    if (state.history.length > 2 && state.record.userId !== "anon") {
      const continuity = sessionContinuity.extract(state.history);
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
        const remoteCost = Number(reloaded.metadata.total_cost_usd ?? 0);
        const localCost = Number(state.record.metadata.total_cost_usd ?? 0);
        reloaded.metadata.total_cost_usd = Math.max(remoteCost, localCost);
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

function injectSessionContext(
  messages: Array<{ role: string; content: unknown }>,
  state: SessionState
): Array<{ role: string; content: unknown }> {
  const compacted = state.history.find(
    (m) => m.role === "system" && m.content.includes("<ARCHITECTURAL_STATE>")
  );
  if (!compacted) return messages;
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

import type { ModelAdapter } from "./providers/model-adapter.js";
import {
  repairBashToolCall,
  repairWriteToolCall,
} from "./providers/model-adapter.js";
import { governToolCall } from "./path-governance/tool-call-governance.js";
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
  | { ok: true; resolved: { model: unknown; resolvedModelId: string; adapter: ModelAdapter }; messages: ReturnType<typeof openAIMessagesToModelMessages> }
  | { ok: false; error: string };

function runOpenAIRequest(request: OpenAIChatCompletionRequest): ResolveResult {
  try {
    const resolved = tierRegistry.resolve(request.model, config.SYNESIS_YARN_DEFAULT_TIER);
    const sanitized = sanitizeToolCalls(request.messages as never);
    const messages = openAIMessagesToModelMessages(sanitized);
    return { ok: true, resolved, messages };
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

function persistSessionAndUsage(
  state: SessionState,
  requestId: string,
  resolvedModelId: string,
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number },
  latencyMs: number,
  finishReason: string,
  tokensSavedByReduction = 0,
  escalated = false,
  snapshot?: DecisionSnapshot,
  trajectory?: RequestTrajectoryInput,
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
  let computedCostUsd: number;
  if (usage.costUsd > 0) {
    computedCostUsd = usage.costUsd;
    pricingSource = "provider";
  } else {
    const result = computeCost(
      {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
        cached_prompt_tokens: usage.cachedTokens,
        estimated_cost_usd: 0,
        actual_cost_usd: 0,
      },
      tierRates,
    );
    computedCostUsd = result.estimated_cost_usd;
    pricingSource = result.pricing_source;
  }
  const normalizedCostUsd = Number.isFinite(computedCostUsd) ? Math.max(0, computedCostUsd) : 0;
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
  const prevCost = Number(state.record.metadata.total_cost_usd ?? 0);
  state.record.metadata.total_cost_usd = prevCost + normalizedCostUsd;
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
    costUsd: normalizedCostUsd,
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
    },
  });

  const telemetryUsage: TelemetryLlmUsage = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    cached_prompt_tokens: usage.cachedTokens,
    estimated_cost_usd: normalizedCostUsd,
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
      estimated_usd: normalizedCostUsd,
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
      turn_index: state.record.requestCount,
      root_user_prompt: rootPromptSnippet || undefined,
      latest_user_prompt: latestPromptSnippet || undefined,
      parent_trace_id: parentTraceId,
      root_trace_id: rootTraceId,
    },
    has_error: finishReason === "error" || undefined,
  };
  emitTrace(trace, traceEmitterConfig, app.log);
  persistSpan.setStatus("ok");
  persistSpan.end();
}

function readUsage(input: unknown): { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number } {
  const obj = (input ?? {}) as Record<string, unknown>;

  if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
    app.log.debug({ rawUsage: obj }, "raw_usage_from_sdk");
  }

  const prompt = Number(obj.inputTokens ?? obj.promptTokens ?? obj.input_tokens ?? 0);
  const completion = Number(obj.outputTokens ?? obj.completionTokens ?? obj.output_tokens ?? 0);

  let cached = Number(obj.cachedInputTokens ?? obj.cached_tokens ?? 0);
  if (!cached) {
    const details = obj.prompt_tokens_details as Record<string, unknown> | undefined;
    if (details) {
      cached = Number(details.cached_tokens ?? 0);
    }
  }
  if (!cached) {
    const cacheRead = obj.cache_read_input_tokens as number | undefined;
    if (cacheRead) cached = Number(cacheRead);
  }
  if (!cached) {
    const inputTokenDetails = obj.inputTokenDetails as Record<string, unknown> | undefined;
    if (inputTokenDetails) {
      cached = Number(inputTokenDetails.cacheReadTokens ?? inputTokenDetails.cachedTokens ?? 0);
    }
  }

  const cost = Number(obj.costUsd ?? obj.cost_usd ?? obj.estimated_cost ?? 0);
  return {
    inputTokens: Number.isFinite(prompt) ? prompt : 0,
    outputTokens: Number.isFinite(completion) ? completion : 0,
    cachedTokens: Number.isFinite(cached) ? cached : 0,
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
    return { blocked: true, findings, suggestedNextActions: next, source: "deterministic" };
  }
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3500);
    const prompt = [
      "You are a strict pre-finalization critic for coding tasks.",
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
      suggestedNextActions: next,
      source: "llm_fallback",
    };
  } catch {
    return { blocked: true, findings, suggestedNextActions: next, source: "deterministic" };
  }
}

type ToolProgressState = "stagnant" | "progress" | "unknown";

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

function detectToolProgress(
  session: SessionState,
  messages: Array<{ role: string; content: unknown }>
): { state: ToolProgressState; signalHash: string | null } {
  const toolMessages = [...messages].reverse().filter((m) => m.role === "tool");
  if (toolMessages.length === 0) {
    return { state: "unknown", signalHash: null };
  }
  const latest = toolMessages[0];
  const signal = stableSignalString(latest.content).slice(0, 4000);
  const hash = crypto.createHash("sha256").update(signal).digest("hex");
  if (!session.lastToolSignalHash) {
    session.lastToolSignalHash = hash;
    session.stagnantToolCycles = 0;
    return { state: "progress", signalHash: hash };
  }
  if (session.lastToolSignalHash === hash) {
    session.stagnantToolCycles += 1;
    return { state: "stagnant", signalHash: hash };
  }
  session.lastToolSignalHash = hash;
  session.stagnantToolCycles = 0;
  return { state: "progress", signalHash: hash };
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
  stream: boolean
): import("fastify").FastifyReply {
  if (!stream) {
    return reply.send({
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
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
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  })}\n\n`);
  safeWrite(reply.raw, `data: ${JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: ts,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
  })}\n\n`);
  safeWrite(reply.raw, "data: [DONE]\n\n");
  safeEnd(reply.raw);
  return reply;
}

function sendClaudeSoftFail(
  reply: import("fastify").FastifyReply,
  model: string,
  content: string,
  stream: boolean
): import("fastify").FastifyReply {
  if (!stream) {
    return reply.send({
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 }
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
  await Promise.all([sessionStore.close(), usageWriter.close(), authResolver.close(), distributedCounters.close(), diagnosticStore.close(), enrichmentPool.close()]);
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
    toolArgHardening: { ...toolArgHardeningStats },
    toolSchemaPruning: { ...toolSchemaPruningStats },
    openClawProfile: { ...openClawProfileStats },
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
  return { diagnostics: [...diagnosticRing], count: diagnosticRing.length };
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

  // Sorted tools for cache stability
  if (config.SYNESIS_YARN_SORTED_TOOLS_ENABLED && request.tools) {
    request.tools = sortToolSchemas(request.tools) as never;
  }

  const reducedOpenAI = enrichmentPool.isAvailable()
    ? await withSpanAsync("yarn.enrichment", { "yarn.path": "openai" }, () =>
        toolResultReduction.reduceMessagesAsync(request.messages as never, enrichmentPool),
      )
    : withSpan("yarn.enrichment", { "yarn.path": "openai" }, () =>
        toolResultReduction.reduceMessages(request.messages as never),
      );
  const toolResultCount = (request.messages as Array<{ role: string }>).filter((m) => m.role === "tool").length;
  const normalizedOpenAI = await validationNormalization.normalizeMessagesAsync(
    reducedOpenAI.messages as never,
    runValidationTierCFallback,
  );
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
  mergeSynesisClarificationFromRequestMetadata(session.record.metadata, oaiBodyMeta ?? undefined);
  const priorOaiChecklistHash = getChecklistSourceHash(session.record.metadata);
  if (latestUserText && typeof latestUserText.content === "string") {
    updateTracePromptMetadata(session, latestUserText.content);
  }
  const oaiRequirementChecklist = refreshRequirementChecklist(session);
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
  const effectiveOaiPathCtx = mergeSessionPathHints(oaiPathCtx, session);
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
  const oaiWorkingPhase: WorkflowPhase | undefined =
    oaiOrchestratorPhaseOverride ?? (oaiPreFrame ? phaseFromFrame(oaiPreFrame.currentPhase) : undefined);
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
    } else {
      session.toolLoopNoUserAckCount += 1;
    }
  }
  const oaiToolProgress = detectToolProgress(
    session,
    normalizedOpenAI.messages as Array<{ role: string; content: unknown }>
  );
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
      },
      fsFingerprint: `${oaiLastToolId || "none"}:${request.messages.length}:${latestOpenAIUserHash || "none"}`,
    },
    sessionKey,
    sessionTokensIn: session.record.totalTokensIn,
    maxInputTokens: config.SYNESIS_YARN_SESSION_SOFT_MAX_INPUT_TOKENS,
    hardMaxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
    sessionBudgetMode: config.SYNESIS_YARN_SESSION_BUDGET_MODE,
    consecutiveToolCalls: session.consecutiveToolCalls,
    consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
    consecutiveToolCallsPivot: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT,
    toolProgressState: oaiToolProgress.state,
    stagnantToolCycles: session.stagnantToolCycles,
    stagnantToolCyclesLimit: config.SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT,
    toolLoopNoUserAckCount: session.toolLoopNoUserAckCount,
    toolLoopNoUserAckHardLimit: config.SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT,
    hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER,
    governanceRules: governanceClient?.getRules(),
  }));
  if (!policyPrecheck.allow) {
    logAndPersistSafetyEvent(policyPrecheck, sessionKey, session.record.totalTokensIn);
    if (config.SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED && policyPrecheck.softFailClass === "tool_loop") {
      const started = Date.now();
      const content = toolLoopSoftFailMessage(policyPrecheck);
      const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
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
      const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
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
  const oaiRole = TIER_TO_ROLE[orchestration.tier];
  const oaiBackendModel = roleAssignmentRegistry.get(oaiRole)?.backendModel ?? "";
  const oaiPromptContext = {
    tier: orchestration.tier,
    role: oaiRole,
    modelFamily: inferModelFamily(oaiBackendModel),
  };
  const oaiEnriched = enrichWithFrameAndManifest(
    normalizedOpenAI.messages as never,
    sessionKey,
    effectiveOaiAdapterBlock,
    oaiPromptContext,
    { projectRoot: effectiveOaiPathCtx.projectRoot, shellCwd: effectiveOaiPathCtx.shellCwd },
  );
  let oaiEnrichedMsgs = appendCriticBlock(
    oaiEnriched.messages as Array<{ role: string; content: unknown }>,
    oaiRequirementChecklist,
  );

  let oaiSensemakingResult: SensemakingResult | undefined;
  if (config.SYNESIS_YARN_SENSEMAKING_ENABLED) {
    const gapCtx: GapAnalysisContext = {
      recallDecision: oaiRecallDecision,
      verificationState: oaiVerifState,
      evidenceConfidence: oaiPrefetchResult?.confidence,
      evidenceAuthoritative: oaiPrefetchResult?.authoritative,
      evidencePrefetched: oaiPrefetchResult?.matched,
      phase: orchestration.phase,
      decisionPath: orchestration.decisionPath,
      consecutiveFailedVerifications: session.record.consecutiveFailedVerifications,
      languages: preManifest.languages ?? [],
      userText: String(latestUserText?.content ?? ""),
      workingFrameGoal: oaiWorkingFrameGoal,
    };
    const gaps = analyzeGaps(gapCtx);
    const trigger = shouldTriggerSensemaking(gaps, orchestration, session.record.consecutiveFailedVerifications, config.SYNESIS_YARN_SENSEMAKING_GAP_THRESHOLD);
    if (trigger.trigger) {
      const plan = buildExplorationPlan(gaps, gapCtx);
      oaiSensemakingResult = { triggered: true, reason: trigger.reason, gaps, plan };
      sensemakingStats.triggeredCount += 1;
      sensemakingStats.byReason[trigger.reason ?? "unknown"] = (sensemakingStats.byReason[trigger.reason ?? "unknown"] ?? 0) + 1;
      sensemakingStats.plansGenerated += 1;
      sensemakingStats.actionsGenerated += plan.forwardPath.length;
    } else {
      oaiSensemakingResult = { triggered: false, gaps };
      sensemakingStats.skippedCount += 1;
    }
    const total = gaps.known.length + gaps.unknown.length + gaps.knowBetter.length;
    sensemakingStats.totalGapsClassified += total;
    sensemakingStats.knownCount += gaps.known.length;
    sensemakingStats.unknownCount += gaps.unknown.length;
    sensemakingStats.knowBetterCount += gaps.knowBetter.length;
  }

  const oaiExplorationBlock = oaiSensemakingResult?.triggered ? formatExplorationPlanBlock(oaiSensemakingResult) : "";
  if (oaiExplorationBlock) {
    const sysIdx = oaiEnrichedMsgs.findIndex((m) => m.role === "system");
    if (sysIdx >= 0 && typeof oaiEnrichedMsgs[sysIdx].content === "string") {
      oaiEnrichedMsgs[sysIdx] = { ...oaiEnrichedMsgs[sysIdx], content: `${oaiEnrichedMsgs[sysIdx].content}\n\n${oaiExplorationBlock}` };
    } else {
      oaiEnrichedMsgs.unshift({ role: "system", content: oaiExplorationBlock });
    }
  } else if (orchestration.uncertaintyFraming) {
    const sysIdx = oaiEnrichedMsgs.findIndex((m) => m.role === "system");
    if (sysIdx >= 0 && typeof oaiEnrichedMsgs[sysIdx].content === "string") {
      oaiEnrichedMsgs[sysIdx] = { ...oaiEnrichedMsgs[sysIdx], content: `${oaiEnrichedMsgs[sysIdx].content}\n\n${orchestration.uncertaintyFraming}` };
    } else {
      oaiEnrichedMsgs.unshift({ role: "system", content: orchestration.uncertaintyFraming });
    }
  }

  if (config.SYNESIS_YARN_JITTER_BUFFER_ENABLED) {
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
    return reply.code(400).send({ error: { type: "invalid_request_error", message: "Request could not be processed." } });
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

  {
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
      const sysIdx = msgs.findIndex((m) => m.role === "system");
      if (sysIdx >= 0 && typeof msgs[sysIdx].content === "string") {
        msgs[sysIdx] = { ...msgs[sysIdx], content: `${msgs[sysIdx].content}\n\n${combined}` };
      } else {
        msgs.unshift({ role: "system", content: combined });
      }
      normalizedRequest.messages = msgs as never;
    }
  }

  const resolveResult = runOpenAIRequest(normalizedRequest);
  if (!resolveResult.ok) {
    recordSessionEvent(sessionKey, identity.userId, identity.orgId, "resolve_failure", "tier-registry", resolveResult.error, reqId);
    return reply.code(503).send({ error: { type: "service_unavailable", message: resolveResult.error } });
  }
  const { resolved, messages } = resolveResult;
  const { adapter } = resolved;
  const rawTools = ((normalizedRequest.tools as unknown[]) ?? []);
  const toolBudget = resolveToolSchemaBudget(
    adapter.maxEffectiveTools,
    config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED && isOpenClawProfile(adapterProfile)
      ? Math.max(1, config.SYNESIS_YARN_OPENCLAW_TOOL_SCHEMA_CAP)
      : adapterProfile.features.toolSchemaBudgetCap,
  );
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
  const effectiveTools = prunedTools.tools;
  const sdkTools = openAIToolsToSDK(effectiveTools as never);
  const sdkToolChoice = mapToolChoice(normalizedRequest.tool_choice);

  const modelToolPrompt = adapter.toolSystemPrompt?.(effectiveTools.length);
  const modelMessages = modelToolPrompt
    ? ([{ role: "system" as const, content: modelToolPrompt }, ...messages] as typeof messages)
    : messages;
  const adapterProviderOptions = adapter.providerOptions?.() as Record<string, Record<string, unknown>> | undefined;

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
    try {
      let currentMessages = modelMessages;
      finalResult = await generateText({
        model: resolved.model as never,
        messages: currentMessages,
        maxOutputTokens: clampMaxOutputTokensForSafety(orchestration.maxOutputTokens),
        ...(sdkTools ? { tools: sdkTools } : {}),
        ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {}),
        ...(adapterProviderOptions ? { providerOptions: adapterProviderOptions as never } : {})
      });

      const SERVER_SIDE_TOOLS = new Set([ARTIFACT_TOOL_NAME, KNOWLEDGE_TOOL_NAME, WEB_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_ALIAS]);
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

        finalResult = await generateText({
          model: resolved.model as never,
          messages: currentMessages,
          maxOutputTokens: clampMaxOutputTokensForSafety(orchestration.maxOutputTokens),
          ...(sdkTools ? { tools: sdkTools } : {}),
          ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {})
        });
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
        });
        if (governed.normalizedPath) toolArgHardeningStats.normalizedPathCount += 1;
        if (governed.constrainedToRoot) toolArgHardeningStats.projectRootConstrainedCount += 1;
        if (governed.blockedBashDrift) toolArgHardeningStats.blockedBashPathDriftCount += 1;
        if (governed.validationMissing.length > 0) {
          toolArgHardeningStats.validationFailedCount += 1;
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
    let finalAssistantText = finalResult.text;
    if (externalToolCalls.length === 0 && finalAssistantText) {
      const parsedLegacy = parseLegacyInlineToolCall(finalAssistantText);
      if (parsedLegacy) {
        const legacyHard = applyAdapterToolHardening(adapter, parsedLegacy.toolName, parsedLegacy.input);
        if (legacyHard.remapped) toolArgHardeningStats.remappedArgsCount += 1;
        if (legacyHard.repairedWrite) toolArgHardeningStats.repairedWriteCount += 1;
        if (legacyHard.repairedBash) toolArgHardeningStats.repairedBashCount += 1;
        const legacyGoverned = governToolCall({
          toolName: legacyHard.toolName,
          input: legacyHard.input,
          projectRoot: effectiveOaiPathCtx.projectRoot,
          shellCwd: effectiveOaiPathCtx.shellCwd,
          enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
          blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
          strictBashBlock: openClawStrictGovernance,
          blockWriteCapableTools: openClawStrictGovernance,
          clientKind: oaiClientKind,
        });
        externalToolCalls = [{
          toolCallId: `legacy_${Date.now().toString(36)}`,
          toolName: legacyGoverned.toolName,
          input: legacyGoverned.input,
        }];
        if (openClawStrictGovernance && isWriteCapableToolName(parsedLegacy.toolName) && legacyGoverned.toolName === "Bash") {
          openClawProfileStats.strictGovernanceRewrites += 1;
        }
        finalAssistantText = parsedLegacy.cleanText;
        app.log.warn({ reqId, toolName: legacyGoverned.toolName }, "recovered_legacy_inline_tool_call_non_stream");
      }
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
      const gate = applyCompletionGate(
        oaiRequirementChecklist,
        finalAssistantText,
        getMetadataString(session.record.metadata, "trace_root_prompt"),
        getMetadataString(session.record.metadata, "latest_user_prompt"),
        oaiVerificationAssessment,
      );
      finalAssistantText = gate.finalText;
      oaiGateApplied = gate.applied;
      oaiMissingMust = gate.missingMust;
      oaiMissingShould = gate.missingShould;
      oaiGateBlockedVerification = gate.blockedByVerification;
      if (gate.applied) {
        recordSessionEvent(
          sessionKey,
          identity.userId,
          identity.orgId,
          gate.blockedByVerification ? "completion_blocked_quality_gate" : "completion_gap",
          "completion-gate",
          gate.blockedByVerification
            ? `Blocking verification failures (${gate.blockingVerificationFailures})`
            : `Missing must-have requirements (${gate.missingMust})`,
          reqId,
        );
      } else if (oaiRequirementChecklist) {
        recordSessionEvent(
          sessionKey,
          identity.userId,
          identity.orgId,
          "completion_pass",
          "completion-gate",
          "No missing must-have requirements detected",
          reqId,
        );
      }
      if (!gate.applied && config.SYNESIS_YARN_PREFINALIZE_CRITIC_ENABLED) {
        const critic = await runPreFinalizeCritic({
          requestId: reqId,
          assistantText: finalAssistantText,
          verification: oaiVerificationAssessment,
          recentToolNames: extractRecentToolNames(normalizedRequest.messages as Array<{ role: string; content: unknown }>),
        });
        if (critic.blocked) {
          oaiCriticBlocked = true;
          finalAssistantText = [
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
            sessionKey,
            identity.userId,
            identity.orgId,
            "pre_finalize_critic_block",
            "completion-gate",
            `critic_source=${critic.source}`,
            reqId,
          );
        }
      }
      const nonSilent = enforceNonSilentFinalizeText(finalAssistantText);
      if (nonSilent.applied) {
        finalAssistantText = nonSilent.text;
        recordSessionEvent(
          sessionKey,
          identity.userId,
          identity.orgId,
          "completion_non_actionable_fallback",
          "completion-gate",
          "terminal stop had non-actionable text; emitted deterministic fallback",
          reqId,
        );
      }
    }
    session.history.push({ role: "assistant", content: finalAssistantText });
    const usage = readUsage((finalResult as unknown as { usage?: unknown }).usage);
    const oaiLatency = Date.now() - started;
    const oaiSaved = toolResultReduction.getPerRequestDelta() + validationNormalization.getPerRequestDelta();
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
    });
    persistSessionAndUsage(
      session,
      reqId,
      resolved.resolvedModelId,
      usage,
      oaiLatency,
      finishReason,
      oaiSaved,
      orchestration.escalated,
      oaiSnapshot,
      {
        toolSequence: externalToolCalls.map((tc) => tc.toolName),
        verificationSteps: inferVerificationSteps(externalToolCalls.map((tc) => tc.toolName)),
        diagnostics: oaiTrajectoryDiagnostics,
        completionGateBlocked: oaiGateBlockedVerification,
        criticBlocked: oaiCriticBlocked,
        outcomeState: (oaiGateBlockedVerification || oaiCriticBlocked) ? "partial" : undefined,
        failureStage: oaiGateBlockedVerification ? "verification" : undefined,
      },
    );
    maybeCheckpoint(session);
    emitDecisionEvents(sessionKey, identity.userId, identity.orgId, reqId, oaiSnapshot);

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
      completionGateApplied: oaiGateApplied || undefined,
      missingMustRequirements: oaiMissingMust || undefined,
      missingShouldRequirements: oaiMissingShould || undefined,
      requirementChecklistMust: oaiRequirementChecklist?.must.length || undefined,
      requirementChecklistShould: oaiRequirementChecklist?.should.length || undefined,
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
      choices: [{ index: 0, message, finish_reason: finishReason }]
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
  const streamed = streamText({
    model: resolved.model as never,
    messages: modelMessages,
    maxOutputTokens: clampMaxOutputTokensForSafety(orchestration.maxOutputTokens),
    ...(sdkTools ? { tools: sdkTools } : {}),
    ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {}),
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
          });
          if (governed.normalizedPath) toolArgHardeningStats.normalizedPathCount += 1;
          if (governed.constrainedToRoot) toolArgHardeningStats.projectRootConstrainedCount += 1;
          if (governed.blockedBashDrift) toolArgHardeningStats.blockedBashPathDriftCount += 1;
          if (governed.validationMissing.length > 0) {
            toolArgHardeningStats.validationFailedCount += 1;
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
          const existing = pendingToolCalls.find((p) => p.id === tc.toolCallId);
          if (existing) {
            existing.name = governed.toolName;
            safeWrite(reply.raw, `data: ${JSON.stringify({
              id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
              choices: [{ index: 0, delta: { tool_calls: [{ index: existing.index, function: { arguments: argsStr } }] }, finish_reason: null }]
            })}\n\n`);
          } else {
            safeWrite(reply.raw, `data: ${JSON.stringify({
              id: reqId, object: "chat.completion.chunk", created: ts, model: resolved.resolvedModelId,
              choices: [{ index: 0, delta: { tool_calls: [{ index: pendingToolCalls.length, id: tc.toolCallId, type: "function", function: { name: governed.toolName, arguments: argsStr } }] }, finish_reason: null }]
            })}\n\n`);
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
    const parsedLegacy = parseLegacyInlineToolCall(rawText);
    if (parsedLegacy) {
      const legacyHard = applyAdapterToolHardening(adapter, parsedLegacy.toolName, parsedLegacy.input);
      if (legacyHard.remapped) toolArgHardeningStats.remappedArgsCount += 1;
      if (legacyHard.repairedWrite) toolArgHardeningStats.repairedWriteCount += 1;
      if (legacyHard.repairedBash) toolArgHardeningStats.repairedBashCount += 1;
      const legacyGoverned = governToolCall({
        toolName: legacyHard.toolName,
        input: legacyHard.input,
        projectRoot: effectiveOaiPathCtx.projectRoot,
        shellCwd: effectiveOaiPathCtx.shellCwd,
        enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
        blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
        strictBashBlock: openClawStrictGovernance,
        blockWriteCapableTools: openClawStrictGovernance,
        clientKind: oaiClientKind,
      });
      if (parsedLegacy.cleanText) {
        const guarded = applyMarkdownGuardrail(
          parsedLegacy.cleanText,
          config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
        );
        flushOpenAIText(guarded);
      }
      safeWrite(reply.raw, `data: ${JSON.stringify({
        id: reqId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: resolved.resolvedModelId,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `legacy_${Date.now().toString(36)}`, type: "function", function: { name: legacyGoverned.toolName, arguments: JSON.stringify(legacyGoverned.input) } }] }, finish_reason: null }],
      })}\n\n`);
      if (openClawStrictGovernance && isWriteCapableToolName(parsedLegacy.toolName) && legacyGoverned.toolName === "Bash") {
        openClawProfileStats.strictGovernanceRewrites += 1;
      }
      finishReason = "tool_calls";
      pendingTextDeltas.length = 0;
      app.log.warn({ reqId, toolName: legacyGoverned.toolName }, "recovered_legacy_inline_tool_call_stream");
    } else {
      const gate = applyCompletionGate(
        oaiRequirementChecklist,
        rawText,
        getMetadataString(session.record.metadata, "trace_root_prompt"),
        getMetadataString(session.record.metadata, "latest_user_prompt"),
        oaiVerificationAssessment,
      );
      oaiStreamGateApplied = gate.applied;
      oaiStreamMissingMust = gate.missingMust;
      oaiStreamMissingShould = gate.missingShould;
      oaiStreamGateBlockedVerification = gate.blockedByVerification;
      if (gate.applied) {
        recordSessionEvent(
          sessionKey,
          identity.userId,
          identity.orgId,
          gate.blockedByVerification ? "completion_blocked_quality_gate" : "completion_gap",
          "completion-gate",
          gate.blockedByVerification
            ? `Blocking verification failures (${gate.blockingVerificationFailures})`
            : `Missing must-have requirements (${gate.missingMust})`,
          reqId,
        );
      } else if (oaiRequirementChecklist) {
        recordSessionEvent(
          sessionKey,
          identity.userId,
          identity.orgId,
          "completion_pass",
          "completion-gate",
          "No missing must-have requirements detected",
          reqId,
        );
      }
      let gateText = gate.finalText;
      if (!gate.applied && config.SYNESIS_YARN_PREFINALIZE_CRITIC_ENABLED) {
        const critic = await runPreFinalizeCritic({
          requestId: reqId,
          assistantText: gateText,
          verification: oaiVerificationAssessment,
          recentToolNames: extractRecentToolNames(normalizedRequest.messages as Array<{ role: string; content: unknown }>),
        });
        if (critic.blocked) {
          oaiStreamCriticBlocked = true;
          gateText = [
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
            sessionKey,
            identity.userId,
            identity.orgId,
            "pre_finalize_critic_block",
            "completion-gate",
            `critic_source=${critic.source}`,
            reqId,
          );
        }
      }
      const nonSilent = enforceNonSilentFinalizeText(gateText);
      if (nonSilent.applied) {
        gateText = nonSilent.text;
        recordSessionEvent(
          sessionKey,
          identity.userId,
          identity.orgId,
          "completion_non_actionable_fallback",
          "completion-gate",
          "stream stop had non-actionable text; emitted deterministic fallback",
          reqId,
        );
      }
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
  }

  safeWrite(reply.raw, `data: ${JSON.stringify({
    id: reqId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: resolved.resolvedModelId,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
  })}\n\n`);
  safeWrite(reply.raw, "data: [DONE]\n\n");
  safeEnd(reply.raw);
  oaiHeartbeat.stop();

  let oaiStreamUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
  let streamedText = "";
  try { oaiStreamUsage = readUsage(await streamed.totalUsage as unknown); } catch { /* stream aborted */ }
  try { streamedText = await streamed.text; } catch { /* stream aborted */ }
  if (streamedText) {
    const parsedLegacy = parseLegacyInlineToolCall(streamedText);
    if (parsedLegacy) streamedText = parsedLegacy.cleanText;
    if (oaiStreamGateApplied && finishReason !== "tool_calls") {
      const gate = applyCompletionGate(
        oaiRequirementChecklist,
        streamedText,
        getMetadataString(session.record.metadata, "trace_root_prompt"),
        getMetadataString(session.record.metadata, "latest_user_prompt"),
        oaiVerificationAssessment,
      );
      streamedText = gate.finalText;
      oaiStreamMissingMust = gate.missingMust;
      oaiStreamMissingShould = gate.missingShould;
      oaiStreamGateBlockedVerification = gate.blockedByVerification;
    }
    streamedText = applyMarkdownGuardrail(
      streamedText,
      config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
    );
    if (finishReason !== "tool_calls") {
      const nonSilent = enforceNonSilentFinalizeText(streamedText);
      if (nonSilent.applied) {
        streamedText = nonSilent.text;
        recordSessionEvent(
          sessionKey,
          identity.userId,
          identity.orgId,
          "completion_non_actionable_fallback",
          "completion-gate",
          "streamed text was non-actionable; emitted deterministic fallback",
          reqId,
        );
      }
    }
    session.history.push({ role: "assistant", content: streamedText });
  }
  const oaiStreamLatency = Date.now() - started;
  const oaiStreamSaved = toolResultReduction.getPerRequestDelta() + validationNormalization.getPerRequestDelta();
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
  });
  persistSessionAndUsage(
    session,
    reqId,
    resolved.resolvedModelId,
    oaiStreamUsage,
    oaiStreamLatency,
    finishReason,
    oaiStreamSaved,
    orchestration.escalated,
    oaiStreamSnapshot,
    {
      toolSequence: pendingToolCalls.map((tc) => tc.name),
      verificationSteps: inferVerificationSteps(pendingToolCalls.map((tc) => tc.name)),
      diagnostics: oaiTrajectoryDiagnostics,
      completionGateBlocked: oaiStreamGateBlockedVerification,
      criticBlocked: oaiStreamCriticBlocked,
      outcomeState: (oaiStreamGateBlockedVerification || oaiStreamCriticBlocked) ? "partial" : undefined,
      failureStage: oaiStreamGateBlockedVerification ? "verification" : undefined,
    },
  );
  maybeCheckpoint(session);
  emitDecisionEvents(sessionKey, identity.userId, identity.orgId, reqId, oaiStreamSnapshot);
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
      completionGateApplied: oaiStreamGateApplied || undefined,
      missingMustRequirements: oaiStreamMissingMust || undefined,
      missingShouldRequirements: oaiStreamMissingShould || undefined,
      requirementChecklistMust: oaiRequirementChecklist?.must.length || undefined,
      requirementChecklistShould: oaiRequirementChecklist?.should.length || undefined,
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

  // Merge top-level `system` into the message list (parity with Anthropic SDK)
  const claudeSystemMsg = claudeSystemToMessage(body.system);
  const rawOpenAIMessages = withSpan("yarn.enrichment", { "yarn.path": "claude" }, () =>
    claudeMessagesToOpenAI(
      body.messages as never,
      (content, toolName) => toolResultReduction.reduceStandaloneToolResult(content, toolName)
    ),
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

  const claudeToolResultCount = (body.messages as Array<{ role: string }>).filter((m) => m.role === "tool_result" || m.role === "tool").length;
  const normalizedFromClaude = await validationNormalization.normalizeMessagesAsync(
    openAIMessages as never,
    runValidationTierCFallback,
  );
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
  );
  const latestClaudeUser = [...(normalizedFromClaude.messages as Array<{ role: string; content: unknown }>)].reverse().find((m) => m.role === "user");
  const claudeManifest = projectManifestService.build(normalizedFromClaude.messages as never);
  const claudeClientKind = String((req.headers["x-synesis-client"] as string | undefined) ?? "claude-code");
  const claudeConversationId = resolveClaudeConversationId(body.metadata, req.headers as Record<string, unknown>);
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
  mergeSynesisClarificationFromRequestMetadata(session.record.metadata, body.metadata ?? undefined);
  const priorClaudeChecklistHash = getChecklistSourceHash(session.record.metadata);
  if (latestClaudeUser && typeof latestClaudeUser.content === "string") {
    updateTracePromptMetadata(session, latestClaudeUser.content);
  }
  const claudeRequirementChecklist = refreshRequirementChecklist(session);
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
  const effectiveClaudePathCtx = mergeSessionPathHints(claudePathCtx, session);
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
  const claudeWorkingPhase: WorkflowPhase | undefined =
    claudeOrchestratorPhaseOverride ?? (claudePreFrame ? phaseFromFrame(claudePreFrame.currentPhase) : undefined);
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
  if (session.awaitingToolLoopUserAck) {
    if (latestClaudeUserHash && latestClaudeUserHash !== session.toolLoopAckAnchorUserHash) {
      session.awaitingToolLoopUserAck = false;
      session.toolLoopNoUserAckCount = 0;
      session.toolLoopAckAnchorUserHash = "";
    } else {
      session.toolLoopNoUserAckCount += 1;
    }
  }
  const claudeToolProgress = detectToolProgress(
    session,
    normalizedFromClaude.messages as Array<{ role: string; content: unknown }>
  );
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
      },
      // Include transcript length so tool loops advance the fingerprint even if tool_use_id extraction fails.
      fsFingerprint: `${claudeLastToolUseId || "none"}:${body.messages.length}:${latestClaudeUserHash || "none"}`,
    },
    sessionKey: claudeSessionKey,
    sessionTokensIn: session.record.totalTokensIn,
    maxInputTokens: config.SYNESIS_YARN_SESSION_SOFT_MAX_INPUT_TOKENS,
    hardMaxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
    sessionBudgetMode: config.SYNESIS_YARN_SESSION_BUDGET_MODE,
    consecutiveToolCalls: session.consecutiveToolCalls,
    consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
    consecutiveToolCallsPivot: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT,
    toolProgressState: claudeToolProgress.state,
    stagnantToolCycles: session.stagnantToolCycles,
    stagnantToolCyclesLimit: config.SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT,
    toolLoopNoUserAckCount: session.toolLoopNoUserAckCount,
    toolLoopNoUserAckHardLimit: config.SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT,
    hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER,
    governanceRules: governanceClient?.getRules(),
  }));
  if (!claudePolicyPrecheck.allow) {
    logAndPersistSafetyEvent(claudePolicyPrecheck, claudeSessionKey, session.record.totalTokensIn);
    if (config.SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED && claudePolicyPrecheck.softFailClass === "tool_loop") {
      const started = Date.now();
      const content = toolLoopSoftFailMessage(claudePolicyPrecheck);
      const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
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
      const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
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

  const claudeRole = TIER_TO_ROLE[claudeOrchestration.tier];
  const claudeBackendModel = roleAssignmentRegistry.get(claudeRole)?.backendModel ?? "";
  const claudePromptContext = {
    tier: claudeOrchestration.tier,
    role: claudeRole,
    modelFamily: inferModelFamily(claudeBackendModel),
  };
  const claudeEnriched = enrichWithFrameAndManifest(
    normalizedFromClaude.messages as never,
    claudeSessionKey,
    effectiveClaudeAdapterBlock,
    claudePromptContext,
    { projectRoot: effectiveClaudePathCtx.projectRoot, shellCwd: effectiveClaudePathCtx.shellCwd },
  );
  let enrichedClaudeMsgs = appendCriticBlock(
    claudeEnriched.messages as Array<{ role: string; content: unknown }>,
    claudeRequirementChecklist,
  );

  let claudeSensemakingResult: SensemakingResult | undefined;
  if (config.SYNESIS_YARN_SENSEMAKING_ENABLED) {
    const claudeGapCtx: GapAnalysisContext = {
      recallDecision: claudeRecallDecision,
      verificationState: claudeVerifState,
      evidenceConfidence: claudePrefetchResult?.confidence,
      evidenceAuthoritative: claudePrefetchResult?.authoritative,
      evidencePrefetched: claudePrefetchResult?.matched,
      phase: claudeOrchestration.phase,
      decisionPath: claudeOrchestration.decisionPath,
      consecutiveFailedVerifications: session.record.consecutiveFailedVerifications,
      languages: claudeManifest.languages ?? [],
      userText: String(latestClaudeUser?.content ?? ""),
      workingFrameGoal: claudeWorkingFrameGoal,
    };
    const claudeGaps = analyzeGaps(claudeGapCtx);
    const claudeTrigger = shouldTriggerSensemaking(claudeGaps, claudeOrchestration, session.record.consecutiveFailedVerifications, config.SYNESIS_YARN_SENSEMAKING_GAP_THRESHOLD);
    if (claudeTrigger.trigger) {
      const claudePlan = buildExplorationPlan(claudeGaps, claudeGapCtx);
      claudeSensemakingResult = { triggered: true, reason: claudeTrigger.reason, gaps: claudeGaps, plan: claudePlan };
      sensemakingStats.triggeredCount += 1;
      sensemakingStats.byReason[claudeTrigger.reason ?? "unknown"] = (sensemakingStats.byReason[claudeTrigger.reason ?? "unknown"] ?? 0) + 1;
      sensemakingStats.plansGenerated += 1;
      sensemakingStats.actionsGenerated += claudePlan.forwardPath.length;
    } else {
      claudeSensemakingResult = { triggered: false, gaps: claudeGaps };
      sensemakingStats.skippedCount += 1;
    }
    const claudeTotal = claudeGaps.known.length + claudeGaps.unknown.length + claudeGaps.knowBetter.length;
    sensemakingStats.totalGapsClassified += claudeTotal;
    sensemakingStats.knownCount += claudeGaps.known.length;
    sensemakingStats.unknownCount += claudeGaps.unknown.length;
    sensemakingStats.knowBetterCount += claudeGaps.knowBetter.length;
  }

  const claudeExplorationBlock = claudeSensemakingResult?.triggered ? formatExplorationPlanBlock(claudeSensemakingResult) : "";
  if (claudeExplorationBlock) {
    const sysIdx = enrichedClaudeMsgs.findIndex((m) => m.role === "system");
    if (sysIdx >= 0 && typeof enrichedClaudeMsgs[sysIdx].content === "string") {
      enrichedClaudeMsgs[sysIdx] = { ...enrichedClaudeMsgs[sysIdx], content: `${enrichedClaudeMsgs[sysIdx].content}\n\n${claudeExplorationBlock}` };
    } else {
      enrichedClaudeMsgs.unshift({ role: "system", content: claudeExplorationBlock });
    }
  } else if (claudeOrchestration.uncertaintyFraming) {
    const sysIdx = enrichedClaudeMsgs.findIndex((m) => m.role === "system");
    if (sysIdx >= 0 && typeof enrichedClaudeMsgs[sysIdx].content === "string") {
      enrichedClaudeMsgs[sysIdx] = { ...enrichedClaudeMsgs[sysIdx], content: `${enrichedClaudeMsgs[sysIdx].content}\n\n${claudeOrchestration.uncertaintyFraming}` };
    } else {
      enrichedClaudeMsgs.unshift({ role: "system", content: claudeOrchestration.uncertaintyFraming });
    }
  }

  if (config.SYNESIS_YARN_JITTER_BUFFER_ENABLED) {
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
    return reply.code(400).send({
      type: "error",
      error: { type: "invalid_request_error", message: "Request could not be processed." }
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

  {
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
      const claudeSysIdx = claudeMsgs.findIndex((m) => m.role === "system");
      if (claudeSysIdx >= 0 && typeof claudeMsgs[claudeSysIdx].content === "string") {
        claudeMsgs[claudeSysIdx] = { ...claudeMsgs[claudeSysIdx], content: `${claudeMsgs[claudeSysIdx].content}\n\n${combined}` };
      } else {
        claudeMsgs.unshift({ role: "system", content: combined });
      }
      openAIShape.messages = claudeMsgs as never;
    }
  }

  // Server-side tools are NOT supported in the Claude endpoint (no loop implemented)
  // if (config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED && !body.stream) {
  //   openAIShape.tools = artifactRetrieval.injectToolOpenAI(openAIShape.tools as unknown[]) as never;
  // }
  // if (config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED && !body.stream) {
  //   openAIShape.tools = knowledgeSearch.injectToolOpenAI(openAIShape.tools as unknown[]) as never;
  // }
  // if (config.SYNESIS_YARN_WEB_SEARCH_ENABLED && !body.stream) {
  //   openAIShape.tools = webSearch.injectToolOpenAI(openAIShape.tools as unknown[]) as never;
  // }

  const claudeResolveResult = runOpenAIRequest(openAIShape);
  if (!claudeResolveResult.ok) {
    recordSessionEvent(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, "resolve_failure", "tier-registry", claudeResolveResult.error, traceReqId);
    return reply.code(503).send({
      type: "error",
      error: { type: "service_unavailable", message: claudeResolveResult.error }
    });
  }
  const { resolved, messages } = claudeResolveResult;
  const { adapter: claudeAdapter } = resolved;
  let claudeRawTools = (processedTools as unknown[]) ?? [];
  // Server-side tools are NOT supported in the Claude endpoint (no loop implemented)
  // if (config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED && !body.stream) {
  //   claudeRawTools = artifactRetrieval.injectToolClaude(claudeRawTools) as never;
  // }
  // if (config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED && !body.stream) {
  //   claudeRawTools = knowledgeSearch.injectToolClaude(claudeRawTools) as never;
  // }
  // if (config.SYNESIS_YARN_WEB_SEARCH_ENABLED && !body.stream) {
  //   claudeRawTools = webSearch.injectToolClaude(claudeRawTools) as never;
  // }

  const claudeToolBudget = resolveToolSchemaBudget(
    claudeAdapter.maxEffectiveTools,
    config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED && isOpenClawProfile(claudeAdapterProfile)
      ? Math.max(1, config.SYNESIS_YARN_OPENCLAW_TOOL_SCHEMA_CAP)
      : claudeAdapterProfile.features.toolSchemaBudgetCap,
  );
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
  const effectiveClaudeTools = prunedClaudeTools.tools;
  const sdkTools = claudeToolsToSDK(effectiveClaudeTools as never);
  const sdkToolChoice = mapToolChoice(body.tool_choice);
  const sdkStop = body.stop_sequences && body.stop_sequences.length > 0 ? body.stop_sequences : undefined;

  const claudeModelToolPrompt = claudeAdapter.toolSystemPrompt?.(effectiveClaudeTools.length);
  const claudeModelMessages = claudeModelToolPrompt
    ? ([{ role: "system" as const, content: claudeModelToolPrompt }, ...messages] as typeof messages)
    : messages;

  const adapterClaudeProviderOptions = claudeAdapter.providerOptions?.();
  const providerOptions = body.thinking
    ? { openai: { thinking: body.thinking, ...(adapterClaudeProviderOptions?.openai ?? {}) }, ...(adapterClaudeProviderOptions ? Object.fromEntries(Object.entries(adapterClaudeProviderOptions).filter(([k]) => k !== "openai")) : {}) }
    : adapterClaudeProviderOptions;

  if (body.stream) {
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
    const streamed = streamText({
      model: resolved.model as never,
      messages: claudeModelMessages,
      maxOutputTokens: clampMaxOutputTokensForSafety(claudeOrchestration.maxOutputTokens),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(sdkStop ? { stopSequences: sdkStop } : {}),
      ...(sdkTools ? { tools: sdkTools } : {}),
      ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {}),
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
    const claudeStreamToolSequence: string[] = [];
    const resolvedTier = tierRegistry.getTierConfig(resolved.resolvedModelId);
    const isLocalLikeBaseUrl =
      !!resolvedTier?.baseUrl &&
      (
        resolvedTier.baseUrl.includes(".svc.cluster.local")
        || resolvedTier.baseUrl.includes("localhost")
        || resolvedTier.baseUrl.includes("127.0.0.1")
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
          });
          emitToolName = governed.toolName;
          finalInput = governed.input;
          if (governed.normalizedPath) toolArgHardeningStats.normalizedPathCount += 1;
          if (governed.constrainedToRoot) {
            toolArgHardeningStats.projectRootConstrainedCount += 1;
            app.log.info(
              { reqId: traceReqId, toolName: emitToolName, toolCallId: tcFull.toolCallId },
              "file_tool_path_constrained_to_project_root",
            );
          }
          if (governed.blockedBashDrift) {
            toolArgHardeningStats.blockedBashPathDriftCount += 1;
            app.log.warn(
              { reqId: traceReqId, toolName: emitToolName, toolCallId: tcFull.toolCallId },
              "bash_path_drift_blocked",
            );
          }

          if (governed.validationMissing.length > 0) {
            requestToolValidationFailures += 1;
            toolArgHardeningStats.validationFailedCount += 1;
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
          claudeStreamToolSequence.push(emitToolName);

          const toolCallId = tcFull.toolCallId ?? "";
          const normalizedJson = JSON.stringify(finalInput);

          safeSse(reply, "content_block_start", { type: "content_block_start", index: blockIdx, content_block: { type: "tool_use", id: toolCallId, name: emitToolName } });
          safeSse(reply, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: normalizedJson } });
          safeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
          blockIdx++;
          claudeToolBuffer.delete(toolCallId);
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
      const parsedLegacy = parseLegacyInlineToolCall(rawText);
      if (parsedLegacy) {
        const legacyHard = applyAdapterToolHardening(claudeAdapter, parsedLegacy.toolName, parsedLegacy.input);
        if (legacyHard.remapped) toolArgHardeningStats.remappedArgsCount += 1;
        if (legacyHard.repairedWrite) toolArgHardeningStats.repairedWriteCount += 1;
        if (legacyHard.repairedBash) toolArgHardeningStats.repairedBashCount += 1;
        const legacyGoverned = governToolCall({
          toolName: legacyHard.toolName,
          input: legacyHard.input,
          projectRoot: effectiveClaudePathCtx.projectRoot,
          shellCwd: effectiveClaudePathCtx.shellCwd,
          enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
          blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
          strictBashBlock: claudeOpenClawStrictGovernance,
          blockWriteCapableTools: claudeOpenClawStrictGovernance,
          clientKind: claudeClientKind,
        });
        const legacyToolCallId = `legacy_${Date.now().toString(36)}`;
        const normalizedJson = JSON.stringify(legacyGoverned.input);
        if (claudeStreamingTextOpen) closeClaudeStreamingTextBlock();
        safeSse(reply, "content_block_start", {
          type: "content_block_start",
          index: blockIdx,
          content_block: { type: "tool_use", id: legacyToolCallId, name: legacyGoverned.toolName },
        });
        safeSse(reply, "content_block_delta", {
          type: "content_block_delta",
          index: blockIdx,
          delta: { type: "input_json_delta", partial_json: normalizedJson },
        });
        safeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIdx });
        blockIdx++;
        if (claudeOpenClawStrictGovernance && isWriteCapableToolName(parsedLegacy.toolName) && legacyGoverned.toolName === "Bash") {
          openClawProfileStats.strictGovernanceRewrites += 1;
        }
        stopReason = "tool_use";
        pendingClaudeTextDeltas.length = 0;
        app.log.warn({ reqId: traceReqId, toolName: legacyGoverned.toolName }, "recovered_legacy_inline_tool_call_claude_stream");
      } else {
      const gate = applyCompletionGate(
        claudeRequirementChecklist,
        rawText,
        getMetadataString(session.record.metadata, "trace_root_prompt"),
        getMetadataString(session.record.metadata, "latest_user_prompt"),
        claudeVerificationAssessment,
      );
      claudeStreamGateApplied = gate.applied;
      claudeStreamMissingMust = gate.missingMust;
      claudeStreamMissingShould = gate.missingShould;
      claudeStreamGateBlockedVerification = gate.blockedByVerification;
      if (gate.applied) {
        recordSessionEvent(
          claudeSessionKey,
          claudeIdentity.userId,
          claudeIdentity.orgId,
          gate.blockedByVerification ? "completion_blocked_quality_gate" : "completion_gap",
          "completion-gate",
          gate.blockedByVerification
            ? `Blocking verification failures (${gate.blockingVerificationFailures})`
            : `Missing must-have requirements (${gate.missingMust})`,
          traceReqId,
        );
      } else if (claudeRequirementChecklist) {
        recordSessionEvent(
          claudeSessionKey,
          claudeIdentity.userId,
          claudeIdentity.orgId,
          "completion_pass",
          "completion-gate",
          "No missing must-have requirements detected",
          traceReqId,
        );
      }
      let gateText = gate.finalText;
      if (!gate.applied && config.SYNESIS_YARN_PREFINALIZE_CRITIC_ENABLED) {
        const critic = await runPreFinalizeCritic({
          requestId: traceReqId,
          assistantText: gateText,
          verification: claudeVerificationAssessment,
          recentToolNames: extractRecentToolNames(openAIShape.messages as Array<{ role: string; content: unknown }>),
        });
        if (critic.blocked) {
          claudeStreamCriticBlocked = true;
          gateText = [
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
            claudeSessionKey,
            claudeIdentity.userId,
            claudeIdentity.orgId,
            "pre_finalize_critic_block",
            "completion-gate",
            `critic_source=${critic.source}`,
            traceReqId,
          );
        }
      }
      const nonSilent = enforceNonSilentFinalizeText(gateText);
      if (nonSilent.applied) {
        gateText = nonSilent.text;
        recordSessionEvent(
          claudeSessionKey,
          claudeIdentity.userId,
          claudeIdentity.orgId,
          "completion_non_actionable_fallback",
          "completion-gate",
          "claude stream stop had non-actionable text; emitted deterministic fallback",
          traceReqId,
        );
      }
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
    }

    closeClaudeStreamingTextBlock();

    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
    try { usage = readUsage(await streamed.totalUsage as unknown); } catch { /* stream aborted */ }
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
      if (claudeStreamGateApplied && stopReason !== "tool_use") {
        const gate = applyCompletionGate(
          claudeRequirementChecklist,
          claudeStreamedText,
          getMetadataString(session.record.metadata, "trace_root_prompt"),
          getMetadataString(session.record.metadata, "latest_user_prompt"),
          claudeVerificationAssessment,
        );
        claudeStreamedText = gate.finalText;
        claudeStreamMissingMust = gate.missingMust;
        claudeStreamMissingShould = gate.missingShould;
        claudeStreamGateBlockedVerification = gate.blockedByVerification;
      }
      claudeStreamedText = applyMarkdownGuardrail(
        claudeStreamedText,
        config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
      );
      if (stopReason !== "tool_use") {
        const nonSilent = enforceNonSilentFinalizeText(claudeStreamedText);
        if (nonSilent.applied) {
          claudeStreamedText = nonSilent.text;
          recordSessionEvent(
            claudeSessionKey,
            claudeIdentity.userId,
            claudeIdentity.orgId,
            "completion_non_actionable_fallback",
            "completion-gate",
            "claude streamed text was non-actionable; emitted deterministic fallback",
            reqId,
          );
        }
      }
      session.history.push({ role: "assistant", content: claudeStreamedText });
    }
    const claudeStreamLatency = Date.now() - started;
    const claudeStreamSaved = toolResultReduction.getPerRequestDelta() + validationNormalization.getPerRequestDelta();
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
    });
    persistSessionAndUsage(
      session,
      reqId,
      resolved.resolvedModelId,
      usage,
      claudeStreamLatency,
      stopReason,
      claudeStreamSaved,
      claudeOrchestration.escalated,
      claudeStreamSnapshot,
      {
        toolSequence: claudeStreamToolSequence,
        verificationSteps: inferVerificationSteps(claudeStreamToolSequence),
        diagnostics: claudeTrajectoryDiagnostics,
        completionGateBlocked: claudeStreamGateBlockedVerification,
        criticBlocked: claudeStreamCriticBlocked,
        outcomeState: (claudeStreamGateBlockedVerification || claudeStreamCriticBlocked) ? "partial" : undefined,
        failureStage: claudeStreamGateBlockedVerification ? "verification" : undefined,
      },
    );
    maybeCheckpoint(session);
    emitDecisionEvents(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, reqId, claudeStreamSnapshot);
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
      completionGateApplied: claudeStreamGateApplied || undefined,
      missingMustRequirements: claudeStreamMissingMust || undefined,
      missingShouldRequirements: claudeStreamMissingShould || undefined,
      requirementChecklistMust: claudeRequirementChecklist?.must.length || undefined,
      requirementChecklistShould: claudeRequirementChecklist?.should.length || undefined,
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
  let result;
  try {
    result = await generateText({
      model: resolved.model as never,
      messages: claudeModelMessages,
      maxOutputTokens: clampMaxOutputTokensForSafety(claudeOrchestration.maxOutputTokens),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(sdkStop ? { stopSequences: sdkStop } : {}),
      ...(sdkTools ? { tools: sdkTools } : {}),
      ...(sdkToolChoice ? { toolChoice: sdkToolChoice } : {}),
      ...(providerOptions ? { providerOptions: providerOptions as never } : {})
    });
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
      });
      if (governed.normalizedPath) toolArgHardeningStats.normalizedPathCount += 1;
      if (governed.constrainedToRoot) toolArgHardeningStats.projectRootConstrainedCount += 1;
      if (governed.blockedBashDrift) toolArgHardeningStats.blockedBashPathDriftCount += 1;
      if (governed.validationMissing.length > 0) {
        toolArgHardeningStats.validationFailedCount += 1;
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
  const reasoning = (result as unknown as { reasoning?: string }).reasoning;
  const usage = readUsage((result as unknown as { usage?: unknown }).usage);
  let stopReason = externalClaudeToolCalls.length > 0 ? "tool_use" : "end_turn";
  let finalClaudeText = result.text ?? "";
  if (externalClaudeToolCalls.length === 0 && finalClaudeText) {
    const parsedLegacy = parseLegacyInlineToolCall(finalClaudeText);
    if (parsedLegacy) {
      const legacyHard = applyAdapterToolHardening(claudeAdapter, parsedLegacy.toolName, parsedLegacy.input);
      if (legacyHard.remapped) toolArgHardeningStats.remappedArgsCount += 1;
      if (legacyHard.repairedWrite) toolArgHardeningStats.repairedWriteCount += 1;
      if (legacyHard.repairedBash) toolArgHardeningStats.repairedBashCount += 1;
      const legacyGoverned = governToolCall({
        toolName: legacyHard.toolName,
        input: legacyHard.input,
        projectRoot: effectiveClaudePathCtx.projectRoot,
        shellCwd: effectiveClaudePathCtx.shellCwd,
        enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
        blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
        strictBashBlock: claudeOpenClawStrictGovernance,
        blockWriteCapableTools: claudeOpenClawStrictGovernance,
        clientKind: claudeClientKind,
      });
      externalClaudeToolCalls = [{
        toolCallId: `legacy_${Date.now().toString(36)}`,
        toolName: legacyGoverned.toolName,
        input: legacyGoverned.input,
      }];
      if (claudeOpenClawStrictGovernance && isWriteCapableToolName(parsedLegacy.toolName) && legacyGoverned.toolName === "Bash") {
        openClawProfileStats.strictGovernanceRewrites += 1;
      }
      finalClaudeText = parsedLegacy.cleanText;
      stopReason = "tool_use";
      app.log.warn({ reqId, toolName: legacyGoverned.toolName }, "recovered_legacy_inline_tool_call_claude_non_stream");
    }
  }
  let claudeGateApplied = false;
  let claudeMissingMust = 0;
  let claudeMissingShould = 0;
  let claudeGateBlockedVerification = false;
  let claudeCriticBlocked = false;
  if (stopReason === "end_turn") {
    const gate = applyCompletionGate(
      claudeRequirementChecklist,
      finalClaudeText,
      getMetadataString(session.record.metadata, "trace_root_prompt"),
      getMetadataString(session.record.metadata, "latest_user_prompt"),
      claudeVerificationAssessment,
    );
    finalClaudeText = gate.finalText;
    claudeGateApplied = gate.applied;
    claudeMissingMust = gate.missingMust;
    claudeMissingShould = gate.missingShould;
    claudeGateBlockedVerification = gate.blockedByVerification;
    if (gate.applied) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        gate.blockedByVerification ? "completion_blocked_quality_gate" : "completion_gap",
        "completion-gate",
        gate.blockedByVerification
          ? `Blocking verification failures (${gate.blockingVerificationFailures})`
          : `Missing must-have requirements (${gate.missingMust})`,
        reqId,
      );
    } else if (claudeRequirementChecklist) {
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "completion_pass",
        "completion-gate",
        "No missing must-have requirements detected",
        reqId,
      );
    }
    if (!gate.applied && config.SYNESIS_YARN_PREFINALIZE_CRITIC_ENABLED) {
      const critic = await runPreFinalizeCritic({
        requestId: reqId,
        assistantText: finalClaudeText,
        verification: claudeVerificationAssessment,
        recentToolNames: extractRecentToolNames(openAIShape.messages as Array<{ role: string; content: unknown }>),
      });
      if (critic.blocked) {
        claudeCriticBlocked = true;
        finalClaudeText = [
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
          claudeSessionKey,
          claudeIdentity.userId,
          claudeIdentity.orgId,
          "pre_finalize_critic_block",
          "completion-gate",
          `critic_source=${critic.source}`,
          reqId,
        );
      }
    }
    const nonSilent = enforceNonSilentFinalizeText(finalClaudeText);
    if (nonSilent.applied) {
      finalClaudeText = nonSilent.text;
      recordSessionEvent(
        claudeSessionKey,
        claudeIdentity.userId,
        claudeIdentity.orgId,
        "completion_non_actionable_fallback",
        "completion-gate",
        "terminal end_turn had non-actionable text; emitted deterministic fallback",
        reqId,
      );
    }
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
  });
  persistSessionAndUsage(
    session,
    reqId,
    resolved.resolvedModelId,
    usage,
    claudeNonStreamLatency,
    stopReason,
    claudeNonStreamSaved,
    claudeOrchestration.escalated,
    claudeNonStreamSnapshot,
    {
      toolSequence: externalClaudeToolCalls.map((tc) => tc.toolName),
      verificationSteps: inferVerificationSteps(externalClaudeToolCalls.map((tc) => tc.toolName)),
      diagnostics: claudeTrajectoryDiagnostics,
      completionGateBlocked: claudeGateBlockedVerification,
      criticBlocked: claudeCriticBlocked,
      outcomeState: (claudeGateBlockedVerification || claudeCriticBlocked) ? "partial" : undefined,
      failureStage: claudeGateBlockedVerification ? "verification" : undefined,
    },
  );
  maybeCheckpoint(session);
  emitDecisionEvents(claudeSessionKey, claudeIdentity.userId, claudeIdentity.orgId, reqId, claudeNonStreamSnapshot);
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
    completionGateApplied: claudeGateApplied || undefined,
    missingMustRequirements: claudeMissingMust || undefined,
    missingShouldRequirements: claudeMissingShould || undefined,
    requirementChecklistMust: claudeRequirementChecklist?.must.length || undefined,
    requirementChecklistShould: claudeRequirementChecklist?.should.length || undefined,
  });

  const content: Array<Record<string, unknown>> = [];
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
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
