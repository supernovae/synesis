import type { SessionIdentity } from "../session/session-key.js";
import type { OpenAIChatCompletionsRouteDependencies } from "../index.js";
import { finalizeOpenAIProviderRequestForRoute } from "./openai-route-provider-finalization.js";
import { prepareOpenAIChatProviderRuntime } from "./openai-chat-provider-preparation.js";
import type { OpenAIChatPipelineResult } from "./openai-chat-results.js";

type Deps = Pick<
  OpenAIChatCompletionsRouteDependencies,
  | "adapterUsesToolLoopSteering"
  | "app"
  | "applyEditContextMissReadGate"
  | "applyMarkdownGuardrail"
  | "artifactRetrieval"
  | "artifactStore"
  | "buildDefaultPolicy"
  | "buildEditContextMissForcedReadPrompt"
  | "buildEditContextMissGuardPrompt"
  | "buildEvidenceTraceSummary"
  | "buildStateRegroundReadPrompt"
  | "config"
  | "contextAdmissionStats"
  | "deserializeShadow"
  | "ensureReadToolAvailabilityForEditMissGuard"
  | "evaluateCachePolicyForSession"
  | "finalizeCompletionText"
  | "findPreferredReadToolName"
  | "forceCheckpoint"
  | "formatEvidenceBlock"
  | "formatPatternBlock"
  | "getMetadataString"
  | "inferVerificationSteps"
  | "injectSessionContext"
  | "isOpenClawProfile"
  | "isWriteCapableToolName"
  | "knowledgeSearch"
  | "loadProviderCachePolicyWindow"
  | "markerBackendForRequest"
  | "prefixOptimizer"
  | "pushDiagnostic"
  | "recordSessionEvent"
  | "recordUpperHarnessDecision"
  | "resolveEndpointCapabilityId"
  | "runOpenAIRequest"
  | "sessionPersistenceRunner"
  | "setSessionWorkspaceContext"
  | "shouldRestrictDiscoveryForPlanWork"
  | "shouldSampleBySeed"
  | "tierRegistry"
  | "toolArgHardeningStats"
  | "transcriptPruning"
  | "webSearch"
>;

type SessionState = Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["getSessionState"]>>;
type RequestLike = Record<string, unknown> & {
  model: string;
  messages: unknown[];
  stream?: unknown;
};
type NormalizedOpenAI = { messages: unknown[] };
type PathContext = ReturnType<OpenAIChatCompletionsRouteDependencies["mergeSessionPathHints"]>;

interface PrepareOpenAIProviderRuntimeInput {
  deps: Deps;
  request: RequestLike;
  normalizedOpenAI: NormalizedOpenAI;
  enrichedMessages: Array<{ role: string; content: unknown; [key: string]: unknown }>;
  toolResultCount: number;
  session: SessionState;
  sessionKey: string;
  requestId: string;
  identity: SessionIdentity;
  pathContext: PathContext;
  selectedModel: string;
  prefetchResult: unknown;
  patternResult: unknown;
  sensemakingBlock: string | null;
  policyPrecheck: { pivotPrompt?: string | null; matchedRules: string[] };
  latestUserText: { role: string; content: unknown } | undefined;
  runtimePreferences: unknown;
  enriched: {
    prefixHash?: string;
    prefixChangeReasons?: string[];
    promptProfileIds?: number[];
    promptProfileHashes?: string[];
  };
  normalizedRequestContext: {
    clientToolCapabilities: ReturnType<OpenAIChatCompletionsRouteDependencies["detectClientToolCapabilities"]>;
    clientTaskCue: string;
    clientKind: string;
    orchestration: ReturnType<OpenAIChatCompletionsRouteDependencies["phaseOrchestrator"]["decide"]>;
    adapterProfile: ReturnType<OpenAIChatCompletionsRouteDependencies["clientAdapterPacks"]["resolve"]>;
    openClawStrictGovernance: boolean;
    phasePolicyEnabledByMatrix: boolean;
    governorPhase: ReturnType<OpenAIChatCompletionsRouteDependencies["inferGovernorPhaseFromMessages"]>;
    executionGovernor: { matchedRules: string[] };
    editMissGuard: unknown;
    needsStateReground: boolean;
    stateConfidence: { recommendedReadPath?: string | null; reasons?: string[] };
    clientToolInventory: unknown[];
    workspaceInspection: unknown;
    latestReadRefresh: { filePath?: string | null };
    promptIntake: { systemBlock?: string | null };
    sensemakingDecision?: { responseLevel?: string; shouldPause?: boolean; shouldRestrictDiscovery?: boolean } | null;
    chatState: unknown;
    fileState: unknown;
    compactionOptions: { backendModelHint?: string };
    reductions: {
      toolResultReduction: unknown;
      validationNormalization: unknown;
    };
    reducedToolResults: number;
    evidencePrefetched: boolean;
    evidenceConfidence?: number;
    sensemakingResult?: { triggered?: boolean; reason?: string } | null;
    governorSummaries: {
      chat?: unknown;
      file?: unknown;
    };
    trajectoryDiagnostics: unknown;
    requirementChecklist: { must: unknown[]; should: unknown[] } | null;
    verificationAssessment: unknown;
    planGraph: unknown;
    artifactShadows: unknown;
  };
  optimizationLedger: {
    recordCacheDiagnostics(record: Record<string, unknown>): void;
  };
}

export async function prepareOpenAIProviderRuntimeForRoute(
  input: PrepareOpenAIProviderRuntimeInput,
): Promise<
  | {
      ok: false;
      pathContext: PathContext;
      result: OpenAIChatPipelineResult;
    }
  | {
      ok: true;
      pathContext: PathContext;
      normalizedRequest: unknown;
      resolved: unknown;
      messages: unknown;
      providerPreparation: Extract<ReturnType<typeof prepareOpenAIChatProviderRuntime>, { ok: true }>;
    }
> {
  const { deps, request, session, sessionKey, requestId, identity } = input;
  const {
    adapterUsesToolLoopSteering,
    app,
    applyEditContextMissReadGate,
    applyMarkdownGuardrail,
    artifactRetrieval,
    artifactStore,
    buildDefaultPolicy,
    buildEditContextMissForcedReadPrompt,
    buildEditContextMissGuardPrompt,
    buildEvidenceTraceSummary,
    buildStateRegroundReadPrompt,
    config,
    contextAdmissionStats,
    deserializeShadow,
    ensureReadToolAvailabilityForEditMissGuard,
    evaluateCachePolicyForSession,
    finalizeCompletionText,
    findPreferredReadToolName,
    forceCheckpoint,
    formatEvidenceBlock,
    formatPatternBlock,
    getMetadataString,
    inferVerificationSteps,
    injectSessionContext,
    isOpenClawProfile,
    isWriteCapableToolName,
    knowledgeSearch,
    loadProviderCachePolicyWindow,
    markerBackendForRequest,
    prefixOptimizer,
    pushDiagnostic,
    recordSessionEvent,
    recordUpperHarnessDecision,
    resolveEndpointCapabilityId,
    runOpenAIRequest,
    sessionPersistenceRunner,
    setSessionWorkspaceContext,
    shouldRestrictDiscoveryForPlanWork,
    shouldSampleBySeed,
    tierRegistry,
    toolArgHardeningStats,
    transcriptPruning,
    webSearch,
  } = deps;
  const ctx = input.normalizedRequestContext;

  const providerFinalization = await finalizeOpenAIProviderRequestForRoute({
    request: request as never,
    selectedModel: input.selectedModel,
    enrichedMessages: input.enrichedMessages,
    toolResultCount: input.toolResultCount,
    session,
    sessionKey,
    requestId,
    identity,
    pathContext: input.pathContext,
    governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    volatileSystemBlocks: [
      input.prefetchResult ? formatEvidenceBlock(input.prefetchResult as never) ?? "" : "",
      input.patternResult ? formatPatternBlock(input.patternResult as never) ?? "" : "",
      input.sensemakingBlock ?? "",
    ],
    policyPivotPrompt: input.policyPrecheck.pivotPrompt,
    latestUserContent: input.latestUserText?.content,
    runtimePreferences: input.runtimePreferences as never,
    configuredCompactionMode: config.SYNESIS_YARN_CONTEXT_BUDGET_COMPACTION_MODE,
    defaultTier: config.SYNESIS_YARN_DEFAULT_TIER,
    prefixHash: input.enriched.prefixHash,
    prefixChangeReasons: input.enriched.prefixChangeReasons,
    prefixOptimizer,
    optimizationLedger: input.optimizationLedger as never,
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
    clientRequestedModel: request.model,
    transcriptTransformLogSampleRate: config.SYNESIS_YARN_TRANSCRIPT_TRANSFORM_LOG_SAMPLE_RATE,
    shouldSampleBySeed,
    persistDecisionTelemetry: sessionPersistenceRunner.persistAndEmitDecisionTelemetry,
  });
  const pathContext = providerFinalization.pathContext as PathContext;
  if (!providerFinalization.ok) {
    return {
      ok: false,
      pathContext,
      result: providerFinalization.result,
    };
  }

  const normalizedRequest = providerFinalization.normalizedRequest;
  const cachePolicy = providerFinalization.cachePolicy;
  const { resolved, messages } = providerFinalization.resolveResult;
  const routePersistence = providerFinalization.routePersistence;
  const providerPreparation = prepareOpenAIChatProviderRuntime({
    config,
    logger: app.log,
    request,
    normalizedRequest,
    normalizedOpenAI: input.normalizedOpenAI,
    resolved,
    messages,
    session,
    sessionKey,
    identity,
    requestId,
    routePersistence,
    cachePolicy,
    clientToolCapabilities: ctx.clientToolCapabilities,
    clientTaskCue: ctx.clientTaskCue,
    clientKind: ctx.clientKind,
    orchestration: ctx.orchestration,
    adapterProfile: ctx.adapterProfile,
    openClawStrictGovernance: ctx.openClawStrictGovernance,
    phasePolicyEnabledByMatrix: ctx.phasePolicyEnabledByMatrix,
    governorPhase: ctx.governorPhase,
    executionGovernor: ctx.executionGovernor,
    editMissGuard: ctx.editMissGuard,
    needsStateReground: ctx.needsStateReground,
    stateConfidence: ctx.stateConfidence,
    clientToolInventory: ctx.clientToolInventory,
    workspaceInspection: ctx.workspaceInspection,
    latestUserText: input.latestUserText,
    policyPrecheck: input.policyPrecheck,
    latestReadRefresh: ctx.latestReadRefresh,
    promptIntake: ctx.promptIntake,
    sensemakingDecision: ctx.sensemakingDecision,
    taskCue: ctx.clientTaskCue,
    tierRegistry,
    resolveEndpointCapabilityId,
    chatState: ctx.chatState,
    fileState: ctx.fileState,
    artifactStore,
    contextAdmissionStats,
    compactionOptions: ctx.compactionOptions,
    transcriptPruning,
    forceCheckpoint: () => { void forceCheckpoint(session); },
    recordUpperHarnessDecision: (label, decision, options) =>
      recordUpperHarnessDecision(sessionKey, identity.userId, identity.orgId, requestId, label, decision as never, options as never),
    optimizationLedger: input.optimizationLedger,
    reductions: ctx.reductions,
    reducedToolResults: ctx.reducedToolResults,
    evidence: {
      prefetched: ctx.evidencePrefetched,
      confidence: ctx.evidenceConfidence,
      prefetchResult: input.prefetchResult as never,
      patternResult: input.patternResult,
    },
    sensemakingResult: ctx.sensemakingResult,
    governorSummaries: ctx.governorSummaries,
    inferVerificationSteps,
    trajectoryDiagnostics: ctx.trajectoryDiagnostics,
    enriched: input.enriched,
    requirementChecklist: ctx.requirementChecklist,
    pushDiagnostic: (diagnostic) => pushDiagnostic(diagnostic as never),
    getMetadataString,
    verificationAssessment: ctx.verificationAssessment,
    planGraph: ctx.planGraph,
    effectivePathContext: pathContext,
    artifactShadows: ctx.artifactShadows,
    toolArgHardeningStats,
    applyMarkdownGuardrail,
    finalizeCompletionText,
    isOpenClawProfile,
    adapterUsesToolLoopSteering,
    isWriteCapableToolName,
    applyEditContextMissReadGate,
    findPreferredReadToolName,
    ensureReadToolAvailabilityForEditMissGuard,
    buildEditContextMissGuardPrompt,
    buildEditContextMissForcedReadPrompt,
    buildStateRegroundReadPrompt,
    shouldRestrictDiscoveryForPlanWork,
    deserializeShadow,
    buildDefaultPolicy,
    buildEvidenceTraceSummary,
  });
  if (!providerPreparation.ok) {
    return {
      ok: false,
      pathContext,
      result: providerPreparation.result,
    };
  }

  return {
    ok: true,
    pathContext,
    normalizedRequest,
    resolved,
    messages,
    providerPreparation,
  };
}
