import type { StreamTelemetryRouteBaseInput } from "../streaming/stream-telemetry-route-base.js";

type RuntimeTelemetryFields = "scope" | "startedAtMs" | "resolvedModelId";

export type OpenAIChatRouteTelemetryBase = Omit<StreamTelemetryRouteBaseInput, RuntimeTelemetryFields>;

export function createOpenAIChatRouteTelemetryBase(
  input: OpenAIChatRouteTelemetryBase,
): OpenAIChatRouteTelemetryBase {
  return {
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
    countMessageRoles: input.countMessageRoles,
    pushDiagnostic: input.pushDiagnostic,
  };
}
