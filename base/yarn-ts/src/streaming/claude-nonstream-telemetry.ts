import type { DecisionSnapshot, SnapshotInputs } from "../telemetry/decision-snapshot.js";
import { buildDecisionSnapshot } from "../telemetry/decision-snapshot.js";
import {
  buildCacheShapeOutcomeDiagnostics,
  cacheShapeDiagnosticFields,
} from "../telemetry/cache-shape-diagnostics.js";
import type { OptimizationCacheDiagnostics } from "../telemetry/optimization-ledger.js";
import type { StreamTokenUsage } from "./openai-stream-finalizer.js";

export interface ClaudeNonStreamTelemetryReductions {
  toolResultReduction: {
    getPerRequestDelta(): number;
    getPerRequestGuidedTruncationDelta(): number;
    getPerRequestTaskPrunedDelta(): number;
    getLastRecallDecision(): SnapshotInputs["recallDecision"];
    getVerificationTracker(): { getState(): SnapshotInputs["verificationState"] };
  };
  validationNormalization: {
    getPerRequestDelta(): number;
  };
}

export interface ClaudeNonStreamGateTelemetry {
  applied: boolean;
  missingMust: number;
  missingShould: number;
  blockedVerification: boolean;
  criticBlocked: boolean;
}

export interface ClaudeNonStreamRequestForensicsResult {
  summary?: string;
  lcpRatio?: number;
  firstChangedSection?: string;
  tokenEstimate?: number;
}

export interface ClaudeNonStreamRequestDiagnostic {
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
  cacheShapeMessageCount?: number;
  cacheShapeStablePrefixHash?: string;
  cacheShapeStablePrefixBytes?: number;
  cacheShapeToolCount?: number;
  cacheShapeToolSchemaHash?: string;
  cacheShapeToolSchemaBytes?: number;
  cacheShapeProviderOptionsHash?: string;
  cacheShapeProviderOptionsBytes?: number;
}

export interface ClaudeNonStreamTelemetryInput {
  requestId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  startedAtMs: number;
  finishReason: string;
  resolvedModelId: string;
  clientRequestedModel: string;
  usage: StreamTokenUsage;
  reductions: ClaudeNonStreamTelemetryReductions;
  reducedToolResults: number;
  orchestration: SnapshotInputs["orchestration"];
  policyMatchedRules: string[];
  evidencePrefetched?: boolean;
  evidencePrefetchHit?: boolean;
  evidenceConfidence?: number;
  evidenceAuthoritative?: boolean;
  evidencePrefetchLatencyMs?: number;
  evidenceQuality?: Record<string, unknown>;
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
  governorDecision?: SnapshotInputs["governorDecision"];
  governorChatStateSummary?: Record<string, unknown>;
  governorFileStateSummary?: Record<string, unknown>;
  normalizedMessages: Array<{ role: string; content: unknown }>;
  toolNames: string[];
  inferVerificationSteps(toolNames: string[]): string[];
  trajectoryDiagnostics?: Record<string, unknown>;
  gate: ClaudeNonStreamGateTelemetry;
  toolDefinitionCount: number;
  artifactToolInjected: boolean;
  knowledgeToolInjected: boolean;
  promptProfileIds?: number[];
  promptProfileHashes?: string[];
  prefixHash?: string;
  prefixChangeReasons?: string[];
  requirementChecklistMust?: number;
  requirementChecklistShould?: number;
  contextAdmission?: {
    decision: "allow" | "warn" | "reject";
    reason?: string;
    estimatedTokens?: number;
    estimatedChars?: number;
  };
  requestForensicsDone?: ClaudeNonStreamRequestForensicsResult;
  cacheShapeDiagnostics?: OptimizationCacheDiagnostics;
  recordSessionEvent(event: {
    eventKind: string;
    component: string;
    detail: string;
  }): void;
  persistDecisionTelemetry(input: {
    usage: StreamTokenUsage;
    latencyMs: number;
    finishReason: string;
    tokensSavedByReduction: number;
    escalated: boolean;
    snapshot: DecisionSnapshot;
    trajectory: {
      toolSequence: string[];
      verificationSteps: string[];
      diagnostics?: Record<string, unknown>;
      completionGateBlocked?: boolean;
      criticBlocked?: boolean;
      outcomeState?: "partial";
      failureStage?: "verification";
    };
  }): void;
  countMessageRoles(messages: Array<{ role: string; content: unknown }>): {
    systemMessageCount: number;
    userMessageCount: number;
    toolMessageCount: number;
    totalInputChars: number;
  };
  pushDiagnostic(diagnostic: ClaudeNonStreamRequestDiagnostic): void;
}

export interface ClaudeNonStreamTelemetryResult {
  latencyMs: number;
  tokensSavedByReduction: number;
  snapshot: DecisionSnapshot;
}

export function runClaudeNonStreamTelemetry(
  input: ClaudeNonStreamTelemetryInput,
): ClaudeNonStreamTelemetryResult {
  const latencyMs = Date.now() - input.startedAtMs;
  const tokensSavedByReduction =
    input.reductions.toolResultReduction.getPerRequestDelta()
    + input.reductions.validationNormalization.getPerRequestDelta();
  const guidedTrimmed = input.reductions.toolResultReduction.getPerRequestGuidedTruncationDelta();
  const taskPruned = input.reductions.toolResultReduction.getPerRequestTaskPrunedDelta();
  if (guidedTrimmed > 0) {
    input.recordSessionEvent({
      eventKind: "tool_output_truncated_guided",
      component: "tool-guardrails",
      detail: `count=${guidedTrimmed}`,
    });
  }
  if (taskPruned > 0) {
    input.recordSessionEvent({
      eventKind: "task_conditioned_prune_applied",
      component: "tool-reducer",
      detail: `count=${taskPruned}`,
    });
  }

  const lastRecall = input.reductions.toolResultReduction.getLastRecallDecision();
  const verificationState = input.reductions.toolResultReduction.getVerificationTracker().getState();
  const snapshot = buildDecisionSnapshot({
    orchestration: input.orchestration,
    recallDecision: lastRecall,
    verificationState,
    policyMatchedRules: input.policyMatchedRules,
    reducedToolResults: input.reducedToolResults,
    tokensSavedByReduction,
    evidencePrefetched: input.evidencePrefetched,
    evidenceConfidence: input.evidenceConfidence,
    evidenceAuthoritative: input.evidenceAuthoritative,
    evidencePrefetchLatencyMs: input.evidencePrefetchLatencyMs,
    evidenceQuality: input.evidenceQuality,
    isStreaming: false,
    sensemakingTriggered: input.sensemakingTriggered,
    sensemakingReason: input.sensemakingReason,
    governorDecision: input.governorDecision,
    governorChatStateSummary: input.governorChatStateSummary,
    governorFileStateSummary: input.governorFileStateSummary,
  });

  const completionGateBlocked = input.gate.blockedVerification;
  const criticBlocked = input.gate.criticBlocked;
  input.persistDecisionTelemetry({
    usage: input.usage,
    latencyMs,
    finishReason: input.finishReason,
    tokensSavedByReduction,
    escalated: Boolean(input.orchestration.escalated),
    snapshot,
    trajectory: {
      toolSequence: input.toolNames,
      verificationSteps: input.inferVerificationSteps(input.toolNames),
      diagnostics: input.trajectoryDiagnostics,
      completionGateBlocked,
      criticBlocked,
      outcomeState: (completionGateBlocked || criticBlocked) ? "partial" : undefined,
      failureStage: completionGateBlocked ? "verification" : undefined,
    },
  });

  const messageCounts = input.countMessageRoles(input.normalizedMessages);
  input.pushDiagnostic({
    timestamp: Date.now(),
    sessionKey: input.sessionKey,
    path: "/v1/messages",
    requestId: input.requestId,
    ...messageCounts,
    toolDefinitionCount: input.toolDefinitionCount,
    artifactToolInjected: input.artifactToolInjected,
    knowledgeToolInjected: input.knowledgeToolInjected,
    reducedToolResults: input.reducedToolResults,
    finishReason: input.finishReason,
    tokensIn: input.usage.inputTokens,
    tokensOut: input.usage.outputTokens,
    policyDecision: input.policyMatchedRules.join(","),
    latencyMs,
    recallRouting: lastRecall?.routing,
    recallConfidence: lastRecall?.resolution?.confidence,
    verificationRound: verificationState.round > 0 ? verificationState.round : undefined,
    verificationFindings: verificationState.round > 0 ? verificationState.findings.length : undefined,
    verificationStalled: verificationState.stalled || undefined,
    decisionPath: input.orchestration.decisionPath,
    decisionEscalated: input.orchestration.escalated || undefined,
    sensemakingTriggered: input.sensemakingTriggered || undefined,
    sensemakingReason: input.sensemakingReason,
    evidencePrefetchHit: input.evidencePrefetchHit || undefined,
    evidencePrefetchConfidence: input.evidenceConfidence || undefined,
    evidencePrefetchMs: input.evidencePrefetchLatencyMs,
    evidenceQuality: input.evidenceQuality,
    promptProfileIds: input.promptProfileIds,
    promptProfileHashes: input.promptProfileHashes,
    prefixHash: input.prefixHash,
    prefixChangeReasons: input.prefixChangeReasons,
    completionGateApplied: input.gate.applied || undefined,
    missingMustRequirements: input.gate.missingMust || undefined,
    missingShouldRequirements: input.gate.missingShould || undefined,
    requirementChecklistMust: input.requirementChecklistMust,
    requirementChecklistShould: input.requirementChecklistShould,
    contextAdmissionDecision: input.contextAdmission?.decision,
    contextAdmissionReason: input.contextAdmission?.reason,
    contextAdmissionEstimatedTokens: input.contextAdmission?.estimatedTokens,
    contextAdmissionEstimatedChars: input.contextAdmission?.estimatedChars,
    requestForensicsSummary: input.requestForensicsDone?.summary,
    requestForensicsLcpRatio: input.requestForensicsDone?.lcpRatio,
    requestForensicsFirstChangedSection: input.requestForensicsDone?.firstChangedSection,
    requestForensicsTokenEstimate: input.requestForensicsDone?.tokenEstimate,
    ...cacheShapeDiagnosticFields(input.cacheShapeDiagnostics),
    ...cacheShapeDiagnosticFields(buildCacheShapeOutcomeDiagnostics(input.usage)),
  });

  return {
    latencyMs,
    tokensSavedByReduction,
    snapshot,
  };
}
