import type { SnapshotInputs } from "../telemetry/decision-snapshot.js";
import type { StreamRouteScope } from "./stream-route-scope.js";

export interface StreamTelemetryReductions {
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

export interface StreamTelemetryContextAdmission {
  decision: "allow" | "warn" | "reject";
  reason?: string;
  estimatedTokens?: number;
  estimatedChars?: number;
}

export interface StreamTelemetryRouteBaseInput {
  scope: StreamRouteScope;
  startedAtMs: number;
  resolvedModelId: string;
  clientRequestedModel: string;
  reductions: StreamTelemetryReductions;
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
  normalizedMessages: Array<{ role: string; content: unknown }>;
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
  contextAdmission?: StreamTelemetryContextAdmission;
  cacheStrategy?: string;
  prefixFingerprint?: string;
  countMessageRoles(messages: Array<{ role: string; content: unknown }>): {
    systemMessageCount: number;
    userMessageCount: number;
    toolMessageCount: number;
    totalInputChars: number;
  };
  pushDiagnostic(diagnostic: Record<string, unknown>): void;
}

export type StreamTelemetryRouteBase = Omit<StreamTelemetryRouteBaseInput, "scope"> & StreamRouteScope;

export function createStreamTelemetryRouteBase(
  input: StreamTelemetryRouteBaseInput,
): StreamTelemetryRouteBase {
  return {
    requestId: input.scope.requestId,
    sessionKey: input.scope.sessionKey,
    userId: input.scope.userId,
    orgId: input.scope.orgId,
    startedAtMs: input.startedAtMs,
    resolvedModelId: input.resolvedModelId,
    clientRequestedModel: input.clientRequestedModel,
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
    normalizedMessages: input.normalizedMessages,
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
    countMessageRoles: input.countMessageRoles,
    pushDiagnostic: input.pushDiagnostic,
  };
}
