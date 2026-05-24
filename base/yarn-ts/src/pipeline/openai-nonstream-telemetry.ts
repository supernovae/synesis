import type { DecisionSnapshot, SnapshotInputs } from "../telemetry/decision-snapshot.js";
import { buildDecisionSnapshot } from "../telemetry/decision-snapshot.js";
import type {
  OpenAIStreamTelemetryLedger,
  OpenAIStreamTelemetryReductions,
} from "../streaming/openai-stream-telemetry.js";
import type { StreamTokenUsage } from "../streaming/openai-stream-finalizer.js";

export interface OpenAINonStreamTelemetryGate {
  gateApplied: boolean;
  missingMust: number;
  missingShould: number;
  gateBlockedVerification: boolean;
  criticBlocked: boolean;
}

export interface OpenAINonStreamRequestForensicsSummary {
  summary?: string;
  lcpRatio?: number;
  firstChangedSection?: string;
  tokenEstimate?: number;
}

export interface OpenAINonStreamTelemetryInput {
  requestId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  startedAtMs: number;
  finishReason: string;
  usage: StreamTokenUsage;
  resolvedModelId: string;
  clientRequestedModel: string;
  reductions: OpenAIStreamTelemetryReductions;
  reducedToolResults: number;
  orchestration: SnapshotInputs["orchestration"];
  policyMatchedRules: string[];
  evidencePrefetched?: boolean;
  evidenceConfidence?: number;
  evidenceAuthoritative?: boolean;
  evidencePrefetchLatencyMs?: number;
  evidenceQuality?: Record<string, unknown>;
  diagnosticEvidencePrefetchHit?: boolean;
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
  governorDecision?: SnapshotInputs["governorDecision"];
  governorChatStateSummary?: Record<string, unknown>;
  governorFileStateSummary?: Record<string, unknown>;
  optimizationLedger: OpenAIStreamTelemetryLedger;
  normalizedMessages: Array<{ role: string; content: unknown }>;
  toolNames: string[];
  inferVerificationSteps(toolNames: string[]): string[];
  trajectoryDiagnostics?: Record<string, unknown>;
  gate: OpenAINonStreamTelemetryGate;
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
  requestForensics?: OpenAINonStreamRequestForensicsSummary;
  recordSessionEvent(event: {
    eventKind: string;
    component: string;
    detail: string;
  }): void;
  persistDecisionTelemetry(input: {
    finishReason: string;
    usage: StreamTokenUsage;
    latencyMs: number;
    tokensSavedByReduction: number;
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
    optimizationLedger: unknown;
  }): void;
  countMessageRoles(messages: Array<{ role: string; content: unknown }>): {
    systemMessageCount: number;
    userMessageCount: number;
    toolMessageCount: number;
    totalInputChars: number;
  };
  pushDiagnostic(diagnostic: Record<string, unknown>): void;
  logOptimizationLedger(record: Record<string, unknown>): void;
}

export interface OpenAINonStreamTelemetryResult {
  latencyMs: number;
  tokensSavedByReduction: number;
  snapshot: DecisionSnapshot;
  optimizationLedger: unknown;
}

export function runOpenAINonStreamTelemetry(
  input: OpenAINonStreamTelemetryInput,
): OpenAINonStreamTelemetryResult {
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

  input.optimizationLedger.setUpstreamCachedTokens(input.usage.cachedTokens ?? 0);
  input.optimizationLedger.recordFinal(input.normalizedMessages);
  const optimizationLedger = input.optimizationLedger.finalize();
  input.logOptimizationLedger(input.optimizationLedger.toLogRecord());

  input.persistDecisionTelemetry({
    finishReason: input.finishReason,
    usage: input.usage,
    latencyMs,
    tokensSavedByReduction,
    snapshot,
    trajectory: {
      toolSequence: input.toolNames,
      verificationSteps: input.inferVerificationSteps(input.toolNames),
      diagnostics: input.trajectoryDiagnostics,
      completionGateBlocked: input.gate.gateBlockedVerification,
      criticBlocked: input.gate.criticBlocked,
      outcomeState: (input.gate.gateBlockedVerification || input.gate.criticBlocked) ? "partial" : undefined,
      failureStage: input.gate.gateBlockedVerification ? "verification" : undefined,
    },
    optimizationLedger,
  });

  const messageCounts = input.countMessageRoles(input.normalizedMessages);
  input.pushDiagnostic({
    timestamp: Date.now(),
    sessionKey: input.sessionKey,
    path: "/v1/chat/completions",
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
    evidencePrefetchHit: input.diagnosticEvidencePrefetchHit || undefined,
    evidencePrefetchConfidence: input.evidenceConfidence || undefined,
    evidencePrefetchMs: input.evidencePrefetchLatencyMs,
    evidenceQuality: input.evidenceQuality,
    promptProfileIds: input.promptProfileIds,
    promptProfileHashes: input.promptProfileHashes,
    prefixHash: input.prefixHash,
    prefixChangeReasons: input.prefixChangeReasons,
    completionGateApplied: input.gate.gateApplied || undefined,
    missingMustRequirements: input.gate.missingMust || undefined,
    missingShouldRequirements: input.gate.missingShould || undefined,
    requirementChecklistMust: input.requirementChecklistMust,
    requirementChecklistShould: input.requirementChecklistShould,
    contextAdmissionDecision: input.contextAdmission?.decision,
    contextAdmissionReason: input.contextAdmission?.reason,
    contextAdmissionEstimatedTokens: input.contextAdmission?.estimatedTokens,
    contextAdmissionEstimatedChars: input.contextAdmission?.estimatedChars,
    requestForensicsSummary: input.requestForensics?.summary,
    requestForensicsLcpRatio: input.requestForensics?.lcpRatio,
    requestForensicsFirstChangedSection: input.requestForensics?.firstChangedSection,
    requestForensicsTokenEstimate: input.requestForensics?.tokenEstimate,
  });

  return {
    latencyMs,
    tokensSavedByReduction,
    snapshot,
    optimizationLedger,
  };
}
