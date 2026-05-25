import type { DecisionSnapshot, SnapshotInputs } from "../telemetry/decision-snapshot.js";
import { buildDecisionSnapshot } from "../telemetry/decision-snapshot.js";
import {
  buildCacheShapeOutcomeDiagnostics,
  cacheShapeDiagnosticFields,
} from "../telemetry/cache-shape-diagnostics.js";
import type { OptimizationCacheDiagnostics } from "../telemetry/optimization-ledger.js";
import type { OpenAIStreamFinalizerResult, StreamTokenUsage } from "./openai-stream-finalizer.js";

export interface OpenAIStreamTelemetryReductions {
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

export interface OpenAIStreamTelemetryLedger {
  startStage?(stage: string): () => void;
  recordCacheDiagnostics?(diagnostics: OptimizationCacheDiagnostics): void;
  setUpstreamCachedTokens(tokens: number): void;
  recordFinal(messages: Array<{ content?: unknown }>): void;
  finalize(): unknown;
  toLogRecord(): Record<string, unknown>;
}

export interface OpenAIStreamTelemetryInput {
  requestId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  startedAtMs: number;
  finishReason: string;
  resolvedModelId: string;
  clientRequestedModel: string;
  streamFinalized: OpenAIStreamFinalizerResult;
  reductions: OpenAIStreamTelemetryReductions;
  reducedToolResults: number;
  orchestration: SnapshotInputs["orchestration"];
  policyMatchedRules: string[];
  evidencePrefetched?: boolean;
  evidenceConfidence?: number;
  evidenceAuthoritative?: boolean;
  evidencePrefetchLatencyMs?: number;
  evidenceQuality?: Record<string, unknown>;
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
  cacheStrategy?: string;
  prefixFingerprint?: string;
  cacheShapeDiagnostics?: OptimizationCacheDiagnostics;
  finalizeRequestForensics(usage: StreamTokenUsage): {
    summary?: string;
    lcpRatio?: number;
    firstChangedSection?: string;
    tokenEstimate?: number;
  } | undefined;
  recordSessionEvent(event: {
    eventKind: string;
    component: string;
    detail: string;
  }): void;
  persistDecisionTelemetry(input: {
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

export type OpenAIStreamTelemetryInputBuilder = (args: {
  finishReason: string;
  finalized: OpenAIStreamFinalizerResult;
}) => OpenAIStreamTelemetryInput;

export interface OpenAIStreamTelemetryBuilderInput {
  requestId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  startedAtMs: number;
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
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
  governorDecision?: SnapshotInputs["governorDecision"];
  governorChatStateSummary?: Record<string, unknown>;
  governorFileStateSummary?: Record<string, unknown>;
  optimizationLedger: OpenAIStreamTelemetryLedger;
  normalizedMessages: Array<{ role: string; content: unknown }>;
  getToolNames(): string[];
  inferVerificationSteps(toolNames: string[]): string[];
  trajectoryDiagnostics?: Record<string, unknown>;
  toolDefinitionCount: number;
  artifactToolInjected: boolean;
  knowledgeToolInjected: boolean;
  promptProfileIds?: number[];
  promptProfileHashes?: string[];
  prefixHash?: string;
  prefixChangeReasons?: string[];
  requirementChecklistMust?: number;
  requirementChecklistShould?: number;
  contextAdmission?: OpenAIStreamTelemetryInput["contextAdmission"];
  cacheStrategy?: string;
  prefixFingerprint?: string;
  cacheShapeDiagnostics?: OptimizationCacheDiagnostics;
  finalizeRequestForensics: OpenAIStreamTelemetryInput["finalizeRequestForensics"];
  recordSessionEvent: OpenAIStreamTelemetryInput["recordSessionEvent"];
  persistDecisionTelemetry(input: {
    finishReason: string;
    telemetry: Parameters<OpenAIStreamTelemetryInput["persistDecisionTelemetry"]>[0];
  }): void;
  countMessageRoles: OpenAIStreamTelemetryInput["countMessageRoles"];
  pushDiagnostic: OpenAIStreamTelemetryInput["pushDiagnostic"];
  logOptimizationLedger: OpenAIStreamTelemetryInput["logOptimizationLedger"];
}

export function createOpenAIStreamTelemetryInputBuilder(
  input: OpenAIStreamTelemetryBuilderInput,
): OpenAIStreamTelemetryInputBuilder {
  return ({ finishReason, finalized }) => ({
    requestId: input.requestId,
    sessionKey: input.sessionKey,
    userId: input.userId,
    orgId: input.orgId,
    startedAtMs: input.startedAtMs,
    finishReason,
    resolvedModelId: input.resolvedModelId,
    clientRequestedModel: input.clientRequestedModel,
    streamFinalized: finalized,
    reductions: input.reductions,
    reducedToolResults: input.reducedToolResults,
    orchestration: input.orchestration,
    policyMatchedRules: input.policyMatchedRules,
    evidencePrefetched: input.evidencePrefetched,
    evidenceConfidence: input.evidenceConfidence,
    evidenceAuthoritative: input.evidenceAuthoritative,
    evidencePrefetchLatencyMs: input.evidencePrefetchLatencyMs,
    evidenceQuality: input.evidenceQuality,
    sensemakingTriggered: input.sensemakingTriggered,
    sensemakingReason: input.sensemakingReason,
    governorDecision: input.governorDecision,
    governorChatStateSummary: input.governorChatStateSummary,
    governorFileStateSummary: input.governorFileStateSummary,
    optimizationLedger: input.optimizationLedger,
    normalizedMessages: input.normalizedMessages,
    toolNames: input.getToolNames(),
    inferVerificationSteps: input.inferVerificationSteps,
    trajectoryDiagnostics: input.trajectoryDiagnostics,
    toolDefinitionCount: input.toolDefinitionCount,
    artifactToolInjected: input.artifactToolInjected,
    knowledgeToolInjected: input.knowledgeToolInjected,
    promptProfileIds: input.promptProfileIds,
    promptProfileHashes: input.promptProfileHashes,
    prefixHash: input.prefixHash,
    prefixChangeReasons: input.prefixChangeReasons,
    requirementChecklistMust: input.requirementChecklistMust,
    requirementChecklistShould: input.requirementChecklistShould,
    contextAdmission: input.contextAdmission,
    cacheStrategy: input.cacheStrategy,
    prefixFingerprint: input.prefixFingerprint,
    cacheShapeDiagnostics: input.cacheShapeDiagnostics,
    finalizeRequestForensics: input.finalizeRequestForensics,
    recordSessionEvent: input.recordSessionEvent,
    persistDecisionTelemetry: (telemetry) => input.persistDecisionTelemetry({
      finishReason,
      telemetry,
    }),
    countMessageRoles: input.countMessageRoles,
    pushDiagnostic: input.pushDiagnostic,
    logOptimizationLedger: input.logOptimizationLedger,
  });
}

export interface OpenAIStreamTelemetryResult {
  latencyMs: number;
  usage: StreamTokenUsage;
  tokensSavedByReduction: number;
  snapshot: DecisionSnapshot;
  optimizationLedger: unknown;
}

export function runOpenAIStreamTelemetry(
  input: OpenAIStreamTelemetryInput,
): OpenAIStreamTelemetryResult {
  const usage = input.streamFinalized.usage;
  const latencyMs = Date.now() - input.startedAtMs;
  const requestForensicsDone = input.finalizeRequestForensics(usage);
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
    isStreaming: true,
    sensemakingTriggered: input.sensemakingTriggered,
    sensemakingReason: input.sensemakingReason,
    governorDecision: input.governorDecision,
    governorChatStateSummary: input.governorChatStateSummary,
    governorFileStateSummary: input.governorFileStateSummary,
  });

  input.optimizationLedger.setUpstreamCachedTokens(usage.cachedTokens ?? 0);
  input.optimizationLedger.recordCacheDiagnostics?.(buildCacheShapeOutcomeDiagnostics(usage));
  input.optimizationLedger.recordFinal(input.normalizedMessages);
  const optimizationLedger = input.optimizationLedger.finalize();

  const completionGateBlocked = input.streamFinalized.gateBlockedVerification;
  const criticBlocked = input.streamFinalized.criticBlocked;
  const endPersistenceStage = input.optimizationLedger.startStage?.("persistence");
  input.persistDecisionTelemetry({
    usage,
    latencyMs,
    tokensSavedByReduction,
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
    optimizationLedger,
  });
  endPersistenceStage?.();
  input.logOptimizationLedger(input.optimizationLedger.toLogRecord());

  const messageCounts = input.countMessageRoles(input.normalizedMessages);
  input.pushDiagnostic({
    timestamp: Date.now(),
    sessionKey: input.sessionKey,
    path: "/v1/chat/completions (stream)",
    requestId: input.requestId,
    ...messageCounts,
    toolDefinitionCount: input.toolDefinitionCount,
    artifactToolInjected: input.artifactToolInjected,
    knowledgeToolInjected: input.knowledgeToolInjected,
    reducedToolResults: input.reducedToolResults,
    finishReason: input.finishReason,
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
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
    evidencePrefetchHit: input.evidencePrefetched && (input.evidenceConfidence ?? 0) > 0 || undefined,
    evidencePrefetchConfidence: input.evidenceConfidence || undefined,
    evidencePrefetchMs: input.evidencePrefetchLatencyMs,
    evidenceQuality: input.evidenceQuality,
    promptProfileIds: input.promptProfileIds,
    promptProfileHashes: input.promptProfileHashes,
    prefixHash: input.prefixHash,
    prefixChangeReasons: input.prefixChangeReasons,
    completionGateApplied: input.streamFinalized.gateApplied || undefined,
    missingMustRequirements: input.streamFinalized.missingMust || undefined,
    missingShouldRequirements: input.streamFinalized.missingShould || undefined,
    requirementChecklistMust: input.requirementChecklistMust,
    requirementChecklistShould: input.requirementChecklistShould,
    contextAdmissionDecision: input.contextAdmission?.decision,
    contextAdmissionReason: input.contextAdmission?.reason,
    contextAdmissionEstimatedTokens: input.contextAdmission?.estimatedTokens,
    contextAdmissionEstimatedChars: input.contextAdmission?.estimatedChars,
    requestForensicsSummary: requestForensicsDone?.summary,
    requestForensicsLcpRatio: requestForensicsDone?.lcpRatio,
    requestForensicsFirstChangedSection: requestForensicsDone?.firstChangedSection,
    requestForensicsTokenEstimate: requestForensicsDone?.tokenEstimate,
    cacheStrategy: input.cacheStrategy,
    prefixFingerprint: input.prefixFingerprint,
    ...cacheShapeDiagnosticFields(input.cacheShapeDiagnostics),
    ...cacheShapeDiagnosticFields(buildCacheShapeOutcomeDiagnostics(usage)),
  });

  return {
    latencyMs,
    usage,
    tokensSavedByReduction,
    snapshot,
    optimizationLedger,
  };
}
