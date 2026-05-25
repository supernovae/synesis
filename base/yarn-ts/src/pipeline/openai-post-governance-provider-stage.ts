import type { AuthUser } from "../auth.js";
import type { SessionIdentity } from "../session/session-key.js";
import type { OpenAIChatCompletionsRouteDependencies } from "../index.js";
import type { OpenAIChatCompletionRequest } from "../schemas.js";
import type { OpenAIChatPipelineResult } from "./openai-chat-results.js";
import type { OpenAIGovernedStageResult } from "./openai-governed-stage.js";
import { prepareOpenAIEnrichment } from "./openai-enrichment-preparation.js";
import { prepareOpenAIProviderRuntimeForRoute } from "./openai-provider-runtime-preparation.js";
import { executeOpenAIProviderForRoute } from "./openai-provider-route-execution.js";

type Deps = Pick<
  OpenAIChatCompletionsRouteDependencies,
  | "ARTIFACT_TOOL_NAME"
  | "DEV_DOCS_TOOL_NAME"
  | "KNOWLEDGE_TOOL_NAME"
  | "TIER_TO_ROLE"
  | "WEB_SEARCH_TOOL_ALIAS"
  | "WEB_SEARCH_TOOL_NAME"
  | "adapterUsesToolLoopSteering"
  | "app"
  | "applyDiscoveryToolGuardrail"
  | "applyEditContextMissReadGate"
  | "applyMarkdownGuardrail"
  | "applyWorkspaceMetadataPrebackfill"
  | "artifactRetrieval"
  | "artifactStore"
  | "buildBlockedDiscoveryRecoverySnapshot"
  | "buildDefaultPolicy"
  | "buildEditContextMissForcedReadPrompt"
  | "buildEditContextMissGuardPrompt"
  | "buildEvidenceTraceSummary"
  | "buildRouteGovernanceBlocks"
  | "buildStateRegroundReadPrompt"
  | "captureRequestForensics"
  | "circuitBreakers"
  | "clampMaxOutputTokensForSafety"
  | "computePrefixFingerprint"
  | "config"
  | "contextAdmissionStats"
  | "deserializeShadow"
  | "emitPlanWriteAuditEvent"
  | "ensureReadToolAvailabilityForEditMissGuard"
  | "enrichWithFrameAndManifest"
  | "evaluateCachePolicyForSession"
  | "extractMetadataFromMessages"
  | "extractUpstreamErrorDiagnostics"
  | "finalizeCompletionText"
  | "finalizePostEnrichmentMessages"
  | "finalizePostStreamText"
  | "finalizeRequestForensics"
  | "findPreferredReadToolName"
  | "forceCheckpoint"
  | "formatEvidenceBlock"
  | "formatPatternBlock"
  | "generateText"
  | "getBlockedDiscoveryCount"
  | "getCachedTopLevelDirs"
  | "getMemoryGovernor"
  | "getMetadataString"
  | "getSessionMemoryCount"
  | "getStructuralIndex"
  | "getTracer"
  | "inferModelFamily"
  | "inferVerificationSteps"
  | "injectSessionContext"
  | "isOpenClawProfile"
  | "isWriteCapableToolName"
  | "knowledgeResolveContext"
  | "knowledgeSearch"
  | "loadProviderCachePolicyWindow"
  | "markerBackendForRequest"
  | "maybeLogEnvelopeUnwrapSample"
  | "maybeUpdateTaskLedgerFromToolCall"
  | "openAiChatPipeline"
  | "openClawProfileStats"
  | "prefixOptimizer"
  | "pushDiagnostic"
  | "readUsage"
  | "recordBlockedDiscovery"
  | "recordSessionEvent"
  | "recordUpperHarnessDecision"
  | "resolveEndpointCapabilityId"
  | "roleAssignmentRegistry"
  | "runOpenAIRequest"
  | "safeEnd"
  | "safeWrite"
  | "securityIngestConfig"
  | "sessionPersistenceRunner"
  | "setSessionWorkspaceContext"
  | "shouldRestrictDiscoveryForPlanWork"
  | "shouldSampleBySeed"
  | "sseHeadersWithClarification"
  | "startSseHeartbeat"
  | "streamAdmission"
  | "streamText"
  | "tierRegistry"
  | "toolResultReduction"
  | "toolArgHardeningStats"
  | "transcriptPruning"
  | "updateDiffAccumulator"
  | "validationNormalization"
  | "webSearch"
  | "webSearchResolveContext"
  | "yarnDedupeLayer"
  | "yarnToolPrefixCache"
>;

type SessionState = Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["getSessionState"]>>;
type NormalizedOpenAI = { messages: unknown[] };
type GovernedOk = Extract<OpenAIGovernedStageResult, { kind: "ok" }>;

interface RunOpenAIPostGovernanceProviderStageInput {
  deps: Deps;
  authUser: AuthUser;
  requestHeaders: Record<string, string | string[] | undefined>;
  rawReply: unknown;
  session: SessionState;
  sessionKey: string;
  identity: SessionIdentity;
  requestId: string;
  request: OpenAIChatCompletionRequest;
  normalizedOpenAI: NormalizedOpenAI;
  governedStage: GovernedOk;
  clientToolCapabilities: ReturnType<OpenAIChatCompletionsRouteDependencies["detectClientToolCapabilities"]>;
  clientTaskCue: string;
  clientKind: string;
  adapterProfile: ReturnType<OpenAIChatCompletionsRouteDependencies["clientAdapterPacks"]["resolve"]>;
  openClawStrictGovernance: boolean;
  phasePolicyEnabledByMatrix: boolean;
  workspaceInspection: Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["applyWorkspaceBoundary"]>>;
  compactionOptions: { backendModelHint?: string };
  reducedOpenAI: { reducedCount: number };
  toolResultCount: number;
  runtimePreferences: unknown;
  latestUserText: { role: string; content: unknown } | undefined;
  freshImplicitSessionNotice: string | null;
  trajectoryDiagnostics: unknown;
  verificationAssessment: unknown;
  forensicsCapabilityMatrix: unknown;
  bodyMetadata: Record<string, unknown> | null;
  optimizationLedger: {
    recordCacheDiagnostics(record: Record<string, unknown>): void;
    startStage(stage: string): () => void;
  };
}

export async function runOpenAIPostGovernanceProviderStage(
  input: RunOpenAIPostGovernanceProviderStageInput,
): Promise<{
  result: OpenAIChatPipelineResult;
  applyClarificationHeader: boolean;
}> {
  const { deps, governedStage } = input;
  const endEnrichmentStage = input.optimizationLedger.startStage("enrichment");
  const enrichment = await prepareOpenAIEnrichment({
    deps: {
      app: deps.app,
      applyWorkspaceMetadataPrebackfill: deps.applyWorkspaceMetadataPrebackfill,
      buildRouteGovernanceBlocks: deps.buildRouteGovernanceBlocks,
      config: deps.config,
      enrichWithFrameAndManifest: deps.enrichWithFrameAndManifest,
      extractMetadataFromMessages: deps.extractMetadataFromMessages,
      finalizePostEnrichmentMessages: deps.finalizePostEnrichmentMessages,
      getCachedTopLevelDirs: deps.getCachedTopLevelDirs,
      getMemoryGovernor: deps.getMemoryGovernor,
      getSessionMemoryCount: deps.getSessionMemoryCount,
      getStructuralIndex: deps.getStructuralIndex,
      inferModelFamily: deps.inferModelFamily,
      recordSessionEvent: deps.recordSessionEvent,
      roleAssignmentRegistry: deps.roleAssignmentRegistry,
      securityIngestConfig: deps.securityIngestConfig,
      setSessionWorkspaceContext: deps.setSessionWorkspaceContext,
      TIER_TO_ROLE: deps.TIER_TO_ROLE,
    },
    session: input.session,
    sessionKey: input.sessionKey,
    identity: input.identity,
    requestId: input.requestId,
    pathContext: governedStage.effectivePathContext,
    adapterBlock: governedStage.effectiveAdapterBlock,
    buildAdapterBlock: governedStage.buildEffectiveAdapterBlock,
    scopedMessages: governedStage.scopedMessages,
    normalizedMessages: input.normalizedOpenAI.messages,
    orchestration: governedStage.orchestration,
    clientToolCapabilities: input.clientToolCapabilities,
    taskIntake: governedStage.taskIntake,
    planGraph: governedStage.planGraph,
    objectiveScope: governedStage.objectiveScope as { relevantEvidenceBlock?: string | null; artifactBridgeBlock?: string | null },
    stateConfidenceBlock: governedStage.stateConfidenceBlock,
    freshImplicitSessionNotice: input.freshImplicitSessionNotice,
    governorPauseResumeBlock: governedStage.governorPauseResumeBlock,
    plannerTodoPacketBlock: governedStage.plannerTodoPacketBlock,
    chatStateBlock: governedStage.chatStateBlock,
    fileStateBlock: governedStage.fileStateBlock,
    requirementChecklist: governedStage.requirementChecklist,
  });
  if (!enrichment.ok) {
    return { result: enrichment.result, applyClarificationHeader: false };
  }
  endEnrichmentStage();

  const endProviderRequestStage = input.optimizationLedger.startStage("provider_request");
  const providerRuntime = await prepareOpenAIProviderRuntimeForRoute({
    deps: {
      adapterUsesToolLoopSteering: deps.adapterUsesToolLoopSteering,
      app: deps.app,
      applyEditContextMissReadGate: deps.applyEditContextMissReadGate,
      applyMarkdownGuardrail: deps.applyMarkdownGuardrail,
      artifactRetrieval: deps.artifactRetrieval,
      artifactStore: deps.artifactStore,
      buildDefaultPolicy: deps.buildDefaultPolicy,
      buildEditContextMissForcedReadPrompt: deps.buildEditContextMissForcedReadPrompt,
      buildEditContextMissGuardPrompt: deps.buildEditContextMissGuardPrompt,
      buildEvidenceTraceSummary: deps.buildEvidenceTraceSummary,
      buildStateRegroundReadPrompt: deps.buildStateRegroundReadPrompt,
      config: deps.config,
      contextAdmissionStats: deps.contextAdmissionStats,
      deserializeShadow: deps.deserializeShadow,
      ensureReadToolAvailabilityForEditMissGuard: deps.ensureReadToolAvailabilityForEditMissGuard,
      evaluateCachePolicyForSession: deps.evaluateCachePolicyForSession,
      finalizeCompletionText: deps.finalizeCompletionText,
      findPreferredReadToolName: deps.findPreferredReadToolName,
      forceCheckpoint: deps.forceCheckpoint,
      formatEvidenceBlock: deps.formatEvidenceBlock,
      formatPatternBlock: deps.formatPatternBlock,
      getMetadataString: deps.getMetadataString,
      inferVerificationSteps: deps.inferVerificationSteps,
      injectSessionContext: deps.injectSessionContext,
      isOpenClawProfile: deps.isOpenClawProfile,
      isWriteCapableToolName: deps.isWriteCapableToolName,
      knowledgeSearch: deps.knowledgeSearch,
      loadProviderCachePolicyWindow: deps.loadProviderCachePolicyWindow,
      markerBackendForRequest: deps.markerBackendForRequest,
      prefixOptimizer: deps.prefixOptimizer,
      pushDiagnostic: deps.pushDiagnostic,
      recordSessionEvent: deps.recordSessionEvent,
      recordUpperHarnessDecision: deps.recordUpperHarnessDecision,
      resolveEndpointCapabilityId: deps.resolveEndpointCapabilityId,
      runOpenAIRequest: deps.runOpenAIRequest,
      sessionPersistenceRunner: deps.sessionPersistenceRunner,
      setSessionWorkspaceContext: deps.setSessionWorkspaceContext,
      shouldRestrictDiscoveryForPlanWork: deps.shouldRestrictDiscoveryForPlanWork,
      shouldSampleBySeed: deps.shouldSampleBySeed,
      tierRegistry: deps.tierRegistry,
      toolArgHardeningStats: deps.toolArgHardeningStats,
      transcriptPruning: deps.transcriptPruning,
      webSearch: deps.webSearch,
    },
    request: input.request,
    normalizedOpenAI: input.normalizedOpenAI,
    enrichedMessages: enrichment.enrichedMessages,
    toolResultCount: input.toolResultCount,
    session: input.session,
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    identity: input.identity,
    pathContext: enrichment.pathContext,
    selectedModel: governedStage.orchestration.selectedModel,
    prefetchResult: governedStage.prefetchResult,
    patternResult: governedStage.patternResult,
    sensemakingBlock: governedStage.sensemakingBlock,
    policyPrecheck: governedStage.policyPrecheck as { pivotPrompt?: string | null; matchedRules: string[] },
    latestUserText: input.latestUserText,
    runtimePreferences: input.runtimePreferences,
    enriched: enrichment.enriched,
    normalizedRequestContext: {
      clientToolCapabilities: input.clientToolCapabilities,
      clientTaskCue: input.clientTaskCue,
      clientKind: input.clientKind,
      orchestration: governedStage.orchestration,
      adapterProfile: input.adapterProfile,
      openClawStrictGovernance: input.openClawStrictGovernance,
      phasePolicyEnabledByMatrix: input.phasePolicyEnabledByMatrix,
      governorPhase: governedStage.governorPhase as never,
      executionGovernor: governedStage.executionGovernor as { matchedRules: string[] },
      editMissGuard: governedStage.editMissGuard,
      needsStateReground: governedStage.needsStateReground,
      stateConfidence: governedStage.stateConfidence as { recommendedReadPath?: string | null; reasons?: string[] },
      clientToolInventory: governedStage.clientToolInventory,
      workspaceInspection: input.workspaceInspection,
      latestReadRefresh: governedStage.latestReadRefresh as { filePath?: string | null },
      promptIntake: governedStage.promptIntake,
      sensemakingDecision: governedStage.sensemakingDecision as { responseLevel?: string; shouldPause?: boolean; shouldRestrictDiscovery?: boolean } | null | undefined,
      chatState: governedStage.chatState,
      fileState: governedStage.fileState,
      compactionOptions: input.compactionOptions,
      reductions: {
        toolResultReduction: deps.toolResultReduction,
        validationNormalization: deps.validationNormalization,
      },
      reducedToolResults: input.reducedOpenAI.reducedCount,
      evidencePrefetched: governedStage.evidencePrefetched,
      evidenceConfidence: governedStage.combinedEvidenceConfidence || undefined,
      sensemakingResult: governedStage.sensemakingResult as { triggered?: boolean; reason?: string } | null | undefined,
      governorSummaries: {
        chat: governedStage.pauseChatSummary,
        file: governedStage.pauseFileSummary,
      },
      trajectoryDiagnostics: input.trajectoryDiagnostics,
      requirementChecklist: governedStage.requirementChecklist,
      verificationAssessment: input.verificationAssessment,
      planGraph: governedStage.planGraph,
      artifactShadows: governedStage.artifactShadows,
    },
    optimizationLedger: input.optimizationLedger,
  });
  if (!providerRuntime.ok) {
    return { result: providerRuntime.result, applyClarificationHeader: false };
  }
  endProviderRequestStage();

  return executeOpenAIProviderForRoute({
    deps: {
      ARTIFACT_TOOL_NAME: deps.ARTIFACT_TOOL_NAME,
      DEV_DOCS_TOOL_NAME: deps.DEV_DOCS_TOOL_NAME,
      KNOWLEDGE_TOOL_NAME: deps.KNOWLEDGE_TOOL_NAME,
      WEB_SEARCH_TOOL_ALIAS: deps.WEB_SEARCH_TOOL_ALIAS,
      WEB_SEARCH_TOOL_NAME: deps.WEB_SEARCH_TOOL_NAME,
      app: deps.app,
      applyDiscoveryToolGuardrail: deps.applyDiscoveryToolGuardrail,
      artifactRetrieval: deps.artifactRetrieval,
      buildBlockedDiscoveryRecoverySnapshot: deps.buildBlockedDiscoveryRecoverySnapshot,
      captureRequestForensics: deps.captureRequestForensics,
      circuitBreakers: deps.circuitBreakers,
      clampMaxOutputTokensForSafety: deps.clampMaxOutputTokensForSafety,
      computePrefixFingerprint: deps.computePrefixFingerprint,
      emitPlanWriteAuditEvent: deps.emitPlanWriteAuditEvent,
      extractUpstreamErrorDiagnostics: deps.extractUpstreamErrorDiagnostics,
      finalizePostStreamText: deps.finalizePostStreamText,
      finalizeRequestForensics: deps.finalizeRequestForensics,
      generateText: deps.generateText,
      getBlockedDiscoveryCount: deps.getBlockedDiscoveryCount,
      getCachedTopLevelDirs: deps.getCachedTopLevelDirs,
      getTracer: deps.getTracer,
      knowledgeResolveContext: deps.knowledgeResolveContext,
      knowledgeSearch: deps.knowledgeSearch,
      maybeLogEnvelopeUnwrapSample: deps.maybeLogEnvelopeUnwrapSample,
      maybeUpdateTaskLedgerFromToolCall: deps.maybeUpdateTaskLedgerFromToolCall,
      openAiChatPipeline: deps.openAiChatPipeline,
      openClawProfileStats: deps.openClawProfileStats,
      readUsage: deps.readUsage,
      recordBlockedDiscovery: deps.recordBlockedDiscovery,
      recordSessionEvent: deps.recordSessionEvent,
      recordUpperHarnessDecision: deps.recordUpperHarnessDecision,
      safeEnd: deps.safeEnd,
      safeWrite: deps.safeWrite,
      sseHeadersWithClarification: deps.sseHeadersWithClarification,
      startSseHeartbeat: deps.startSseHeartbeat,
      streamAdmission: deps.streamAdmission,
      streamText: deps.streamText,
      tierRegistry: deps.tierRegistry,
      toolArgHardeningStats: deps.toolArgHardeningStats,
      updateDiffAccumulator: deps.updateDiffAccumulator,
      webSearch: deps.webSearch,
      webSearchResolveContext: deps.webSearchResolveContext,
      yarnDedupeLayer: deps.yarnDedupeLayer,
      yarnToolPrefixCache: deps.yarnToolPrefixCache,
    },
    authUser: input.authUser,
    requestHeaders: input.requestHeaders,
    rawReply: input.rawReply,
    session: input.session,
    identity: input.identity,
    config: deps.config,
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    normalizedRequest: providerRuntime.normalizedRequest,
    request: input.request,
    resolved: providerRuntime.resolved,
    providerPreparation: providerRuntime.providerPreparation,
    governorPhase: governedStage.governorPhase,
    forensicsCapabilityMatrix: input.forensicsCapabilityMatrix,
    orchestration: governedStage.orchestration,
    optimizationLedger: input.optimizationLedger,
    pathContext: providerRuntime.pathContext,
    bodyMetadata: input.bodyMetadata,
    prefetchResult: governedStage.prefetchResult,
    clientKind: input.clientKind,
  });
}
