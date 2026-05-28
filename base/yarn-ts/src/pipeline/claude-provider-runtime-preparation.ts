import type { ClaudeMessagesRouteDependencies } from "../server/route-dependencies.js";
import type { ClientToolCapabilities } from "../adapters/client-tool-capabilities.js";
import type { SessionPhase } from "../governance/execution-governor.js";
import type { SessionIdentity } from "../session/session-key.js";
import type { ClaudeMessagesRequest, OpenAIChatCompletionRequest } from "../schemas.js";
import type { SessionPathHints } from "../state/workspace-session-boundary.js";
import { setSessionWorkspaceContext } from "../state/workspace-session-boundary.js";
import { formatEvidenceBlock, formatPatternBlock } from "../evidence/fast-path.js";
import { finalizeOpenAIProviderRequest } from "./openai-route-provider-finalization.js";
import { runClaudeMessagesEnrichment, type ClaudeMessagesEnrichmentResult } from "./claude-messages-enrichment.js";
import {
  prepareClaudeMessagesProviderRuntime,
  type ClaudeMessagesProviderPreparationResult,
} from "./claude-messages-provider-preparation.js";

type SessionState = Awaited<ReturnType<ClaudeMessagesRouteDependencies["session"]["getSessionState"]>>;
type ProviderRuntimeDeps = Pick<
  ClaudeMessagesRouteDependencies,
  | "runtime"
  | "session"
  | "workspace"
  | "reduction"
  | "tools"
  | "governance"
  | "planning"
  | "provider"
  | "evidence"
  | "telemetry"
>;
type ProviderPreparationSuccess = Extract<ClaudeMessagesProviderPreparationResult, { ok: true }>;

interface PrepareClaudeProviderRuntimeForRouteInput {
  deps: ProviderRuntimeDeps;
  body: ClaudeMessagesRequest;
  headers?: Record<string, unknown> | null;
  processedTools: unknown[] | undefined;
  normalizedMessages: unknown[];
  scopedMessages: unknown[];
  session: SessionState;
  sessionKey: string;
  requestId: string;
  logRequestId: string;
  identity: SessionIdentity;
  pathContext: SessionPathHints;
  adapterBlock: string | undefined;
  buildAdapterBlock(pathContext: SessionPathHints): string | undefined;
  orchestration: ReturnType<ClaudeMessagesRouteDependencies["governance"]["phaseOrchestrator"]["decide"]>;
  toolResultCount: number;
  clientToolCapabilities: ClientToolCapabilities;
  clientKind: string;
  taskIntake: unknown;
  planGraph: unknown;
  prefetchResult: unknown;
  patternResult: unknown;
  objectiveScope: {
    relevantEvidenceBlock?: string | null;
    artifactBridgeBlock?: string | null;
  };
  stateConfidenceBlock?: string | null;
  governorPauseResumeBlock?: string | null;
  plannerTodoPacketBlock?: string | null;
  chatStateBlock?: string | null;
  fileStateBlock?: string | null;
  requirementChecklist: unknown;
  sensemakingBlock?: string | null;
  policyPrecheck: { pivotPrompt?: string | null };
  latestUser?: { content: unknown };
  runtimePreferences: unknown;
  adapterProfile: ReturnType<ClaudeMessagesRouteDependencies["adapter"]["clientAdapterPacks"]["resolve"]>;
  phasePolicyEnabledByMatrix: boolean;
  governorPhase: SessionPhase;
  executionGovernor: { matchedRules: string[] };
  editMissGuard: unknown;
  needsStateReground: boolean;
  stateConfidence: { recommendedReadPath?: string | null; reasons?: string[] };
  clientToolInventory: unknown[];
  workspaceInspection: unknown;
  latestReadRefresh: { filePath?: string | null };
  promptIntake: { systemBlock?: string | null };
  sensemakingDecision?: { responseLevel?: string; shouldPause?: boolean } | null;
  taskCue: unknown;
  chatState: unknown;
  fileState: unknown;
  compactionOptions: { backendModelHint?: string };
}

export type ClaudeProviderRuntimeRouteResult =
  | {
      ok: false;
      statusCode: number;
      body: Record<string, unknown>;
      pathContext: SessionPathHints;
    }
  | {
      ok: true;
      pathContext: SessionPathHints;
      openAIShape: OpenAIChatCompletionRequest;
      resolved: Extract<ReturnType<ClaudeMessagesRouteDependencies["provider"]["runOpenAIRequest"]>, { ok: true }>["resolved"];
      messages: Extract<ReturnType<ClaudeMessagesRouteDependencies["provider"]["runOpenAIRequest"]>, { ok: true }>["messages"];
      enriched: ClaudeMessagesEnrichmentResult;
      providerPreparation: ProviderPreparationSuccess;
    };

export async function prepareClaudeProviderRuntimeForRoute(
  input: PrepareClaudeProviderRuntimeForRouteInput,
): Promise<ClaudeProviderRuntimeRouteResult> {
  const {
    runtime: { app, config },
    session: {
      createRoutePersistenceScope,
      evaluateCachePolicyForSession,
      forceCheckpoint,
      loadProviderCachePolicyWindow,
      recordSessionEvent,
      securityIngestConfig,
      sessionPersistenceRunner,
    },
    workspace: {
      enrichWithFrameAndManifest,
      injectSessionContext,
    },
    reduction: {
      getMemoryGovernor,
      getStructuralIndex,
      transcriptPruning,
    },
    tools: {
      applyEditContextMissReadGate,
      buildEditContextMissForcedReadPrompt,
      buildEditContextMissGuardPrompt,
      buildStateRegroundReadPrompt,
      ensureReadToolAvailabilityForEditMissGuard,
      findPreferredReadToolName,
      getCachedTopLevelDirs,
      isWriteCapableToolName,
      toolSchemaPruningStats,
    },
    governance: {
      adapterUsesToolLoopSteering,
      inferModelFamily,
      isOpenClawProfile,
    },
    planning: {
      recordUpperHarnessDecision,
    },
    provider: {
      markerBackendForRequest,
      prefixOptimizer,
      extractMetadataFromMessages,
      resolveEndpointCapabilityId,
      roleAssignmentRegistry,
      runOpenAIRequest,
      shouldSampleBySeed,
      TIER_TO_ROLE,
      tierRegistry,
    },
    evidence: {
      artifactStore,
      getSessionMemoryCount,
    },
    telemetry: {
      contextAdmissionStats,
    },
  } = input.deps;

  const role = TIER_TO_ROLE[input.orchestration.tier];
  const backendModel = roleAssignmentRegistry.get(role)?.backendModel ?? "";
  const promptContext = {
    tier: input.orchestration.tier,
    role,
    modelFamily: inferModelFamily(backendModel),
  };

  const enrichment = await runClaudeMessagesEnrichment({
    config,
    logger: app.log as never,
    securityIngestConfig,
    session: input.session,
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    identity: input.identity,
    pathContext: input.pathContext,
    adapterBlock: input.adapterBlock,
    normalizedMessages: input.normalizedMessages,
    scopedMessages: input.scopedMessages,
    promptContext,
    backendModel,
    bodyMetadata: input.body.metadata ?? null,
    headers: input.headers ?? null,
    runtimePreferences: input.runtimePreferences as never,
    clientToolCapabilities: input.clientToolCapabilities as never,
    taskIntake: input.taskIntake,
    planGraph: input.planGraph,
    relevantEvidenceBlock: input.objectiveScope.relevantEvidenceBlock,
    artifactBridgeBlock: input.objectiveScope.artifactBridgeBlock,
    stateConfidenceBlock: input.stateConfidenceBlock,
    governorPauseResumeBlock: input.governorPauseResumeBlock,
    plannerTodoPacketBlock: input.plannerTodoPacketBlock,
    chatStateBlock: input.chatStateBlock,
    fileStateBlock: input.fileStateBlock,
    requirementChecklist: input.requirementChecklist as never,
    extractMetadataFromMessages: (messages) => extractMetadataFromMessages(messages as never),
    buildAdapterBlock: input.buildAdapterBlock,
    setWorkspaceContext: setSessionWorkspaceContext,
    getCachedTopLevelDirs,
    getMemoryGovernor,
    getStructuralIndex,
    getSessionMemoryCount,
    enrichWithFrameAndManifest: (messages, requestSessionKey, adapterBlock, context, pathContext, governanceBlocks, seedDirs, requestSession, stateBlocks) =>
      enrichWithFrameAndManifest(
        messages as never,
        requestSessionKey,
        adapterBlock,
        context,
        pathContext,
        governanceBlocks,
        seedDirs,
        requestSession as typeof input.session,
        stateBlocks,
      ),
    recordSessionEvent,
  });
  if (!enrichment.ok) {
    return {
      ok: false,
      statusCode: enrichment.statusCode,
      body: enrichment.body,
      pathContext: input.pathContext,
    };
  }

  const claudeOpenAIShape: OpenAIChatCompletionRequest = {
    model: input.orchestration.selectedModel,
    messages: enrichment.messages as never,
    stream: input.body.stream,
    ...(input.body.temperature !== undefined ? { temperature: input.body.temperature } : {}),
  };

  const providerFinalization = await finalizeOpenAIProviderRequest({
    request: claudeOpenAIShape,
    selectedModel: input.orchestration.selectedModel,
    enrichedMessages: enrichment.messages,
    toolResultCount: input.toolResultCount,
    session: input.session,
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    identity: input.identity,
    pathContext: enrichment.pathContext,
    governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    volatileSystemBlocks: [
      input.prefetchResult ? formatEvidenceBlock(input.prefetchResult as never) ?? "" : "",
      input.patternResult ? formatPatternBlock(input.patternResult as never) ?? "" : "",
      input.sensemakingBlock ?? "",
    ],
    policyPivotPrompt: input.policyPrecheck.pivotPrompt,
    latestUserContent: input.latestUser?.content,
    runtimePreferences: input.runtimePreferences as never,
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
  const pathContext = providerFinalization.pathContext;
  const resolveResult = providerFinalization.resolveResult;
  if (!resolveResult.ok) {
    recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "resolve_failure",
      "tier-registry",
      resolveResult.error,
      input.requestId,
    );
    return {
      ok: false,
      statusCode: 503,
      pathContext,
      body: {
        type: "error",
        error: { type: "service_unavailable", message: resolveResult.error },
      },
    };
  }

  const routePersistence = createRoutePersistenceScope({
    state: input.session,
    requestId: input.requestId,
    resolvedModelId: resolveResult.resolved.resolvedModelId,
    sessionKey: input.sessionKey,
    userId: input.identity.userId,
    orgId: input.identity.orgId,
    clientRequestedModel: input.body.model,
    recordSessionEvent,
    persistDecisionTelemetry: sessionPersistenceRunner.persistAndEmitDecisionTelemetry,
  });

  const transforms = resolveResult.transforms;
  if (
    (transforms.systemMessagesReordered || transforms.toolCallsSanitized)
    && shouldSampleBySeed(
      `${input.sessionKey}:${input.requestId}:claude-transform`,
      config.SYNESIS_YARN_TRANSCRIPT_TRANSFORM_LOG_SAMPLE_RATE,
    )
  ) {
    recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "transcript_transform_applied",
      "request-normalizer",
      `system_reordered=${transforms.systemMessagesReordered} tool_sanitized=${transforms.toolCallsSanitized} delta=${transforms.messageCountDelta}`,
      input.requestId,
      {
        path: "claude",
        system_messages_reordered: transforms.systemMessagesReordered,
        tool_calls_sanitized: transforms.toolCallsSanitized,
        message_count_delta: transforms.messageCountDelta,
      },
    );
  }

  const providerPreparation = prepareClaudeMessagesProviderRuntime({
    config,
    logger: app.log,
    body: input.body,
    headers: input.headers ?? null,
    processedTools: input.processedTools ?? [],
    normalizedMessages: input.normalizedMessages as Array<{ role: string; content: unknown }>,
    resolved: resolveResult.resolved,
    messages: resolveResult.messages,
    session: input.session,
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    logRequestId: input.logRequestId,
    routePersistence,
    cachePolicy: providerFinalization.cachePolicy,
    clientToolCapabilities: input.clientToolCapabilities as never,
    clientKind: input.clientKind,
    orchestration: input.orchestration,
    adapterProfile: input.adapterProfile,
    phasePolicyEnabledByMatrix: input.phasePolicyEnabledByMatrix,
    governorPhase: input.governorPhase,
    executionGovernor: input.executionGovernor,
    editMissGuard: input.editMissGuard,
    needsStateReground: input.needsStateReground,
    stateConfidence: input.stateConfidence,
    clientToolInventory: input.clientToolInventory,
    workspaceInspection: input.workspaceInspection,
    latestUserContent: input.latestUser?.content,
    policyPrecheck: input.policyPrecheck,
    latestReadRefresh: input.latestReadRefresh,
    promptIntake: input.promptIntake,
    sensemakingDecision: input.sensemakingDecision,
    taskCue: input.taskCue,
    tierRegistry,
    resolveEndpointCapabilityId,
    chatState: input.chatState,
    fileState: input.fileState,
    artifactStore,
    contextAdmissionStats,
    compactionOptions: input.compactionOptions,
    transcriptPruning,
    forceCheckpoint: () => { void forceCheckpoint(input.session); },
    recordUpperHarnessDecision: (label, decision, options) =>
      recordUpperHarnessDecision(input.sessionKey, input.identity.userId, input.identity.orgId, input.requestId, label, decision, options),
    isOpenClawProfile,
    adapterUsesToolLoopSteering,
    isWriteCapableToolName,
    applyEditContextMissReadGate,
    findPreferredReadToolName,
    ensureReadToolAvailabilityForEditMissGuard,
    buildEditContextMissGuardPrompt,
    buildEditContextMissForcedReadPrompt,
    buildStateRegroundReadPrompt,
    toolSchemaPruningStats,
  });
  if (!providerPreparation.ok) {
    return {
      ok: false,
      statusCode: providerPreparation.statusCode,
      body: providerPreparation.body,
      pathContext,
    };
  }

  return {
    ok: true,
    pathContext,
    openAIShape: providerFinalization.normalizedRequest,
    resolved: resolveResult.resolved,
    messages: resolveResult.messages,
    enriched: enrichment.enriched,
    providerPreparation,
  };
}
