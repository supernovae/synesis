import type { AuthUser } from "../auth.js";
import type { SessionIdentity } from "../session/session-key.js";
import type { OpenAIChatCompletionsRouteDependencies } from "../server/route-dependencies.js";
import type { OpenAIChatPipelineResult } from "./openai-chat-results.js";

type Deps = Pick<
  OpenAIChatCompletionsRouteDependencies,
  | "ARTIFACT_TOOL_NAME"
  | "DEV_DOCS_TOOL_NAME"
  | "KNOWLEDGE_TOOL_NAME"
  | "WEB_SEARCH_TOOL_ALIAS"
  | "WEB_SEARCH_TOOL_NAME"
  | "app"
  | "applyDiscoveryToolGuardrail"
  | "artifactRetrieval"
  | "buildBlockedDiscoveryRecoverySnapshot"
  | "captureRequestForensics"
  | "circuitBreakers"
  | "clampMaxOutputTokensForSafety"
  | "computePrefixFingerprint"
  | "emitPlanWriteAuditEvent"
  | "extractUpstreamErrorDiagnostics"
  | "finalizePostStreamText"
  | "finalizeRequestForensics"
  | "generateText"
  | "getBlockedDiscoveryCount"
  | "getCachedTopLevelDirs"
  | "getTracer"
  | "knowledgeResolveContext"
  | "knowledgeSearch"
  | "maybeLogEnvelopeUnwrapSample"
  | "maybeUpdateTaskLedgerFromToolCall"
  | "openAiChatPipeline"
  | "openClawProfileStats"
  | "readUsage"
  | "recordBlockedDiscovery"
  | "recordSessionEvent"
  | "recordUpperHarnessDecision"
  | "safeEnd"
  | "safeWrite"
  | "sseHeadersWithClarification"
  | "startSseHeartbeat"
  | "streamAdmission"
  | "streamText"
  | "tierRegistry"
  | "toolArgHardeningStats"
  | "updateDiffAccumulator"
  | "webSearch"
  | "webSearchResolveContext"
  | "yarnDedupeLayer"
  | "yarnToolPrefixCache"
>;

type SessionState = Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["getSessionState"]>>;
type PathContext = ReturnType<OpenAIChatCompletionsRouteDependencies["mergeSessionPathHints"]>;

interface ExecuteOpenAIProviderForRouteInput {
  deps: Deps;
  authUser: AuthUser;
  requestHeaders: Record<string, string | string[] | undefined>;
  rawReply: unknown;
  session: SessionState;
  identity: SessionIdentity;
  config: OpenAIChatCompletionsRouteDependencies["config"];
  sessionKey: string;
  requestId: string;
  normalizedRequest: unknown;
  request: Record<string, unknown>;
  resolved: unknown;
  providerPreparation: {
    adapter: unknown;
    modelMessages: unknown;
    effectiveTools: unknown[];
    sdkTools: unknown;
    effectiveToolChoice: unknown;
    providerOptions: unknown;
    structuredOutput: unknown;
    samplingOptions: unknown;
    phasePolicy: unknown;
    forensicsPhasePolicy: unknown;
    toolHandlingRouteBase: unknown;
    finalizerRouteBase: unknown;
    telemetryRouteBase: unknown;
    persistDecisionTelemetry(input: unknown): unknown;
  };
  governorPhase: unknown;
  forensicsCapabilityMatrix: unknown;
  orchestration: ReturnType<OpenAIChatCompletionsRouteDependencies["phaseOrchestrator"]["decide"]>;
  optimizationLedger: unknown;
  pathContext: PathContext;
  bodyMetadata: Record<string, unknown> | null;
  prefetchResult: unknown;
  clientKind: string;
}

export async function executeOpenAIProviderForRoute(
  input: ExecuteOpenAIProviderForRouteInput,
): Promise<{
  result: OpenAIChatPipelineResult;
  applyClarificationHeader: boolean;
}> {
  const {
    deps,
    authUser,
    requestHeaders,
    rawReply,
    session,
    identity,
    config,
    sessionKey,
    requestId,
    normalizedRequest,
    request,
    resolved,
    providerPreparation,
    governorPhase,
    forensicsCapabilityMatrix,
    orchestration,
    optimizationLedger,
    pathContext,
    bodyMetadata,
    prefetchResult,
    clientKind,
  } = input;
  const {
    ARTIFACT_TOOL_NAME,
    DEV_DOCS_TOOL_NAME,
    KNOWLEDGE_TOOL_NAME,
    WEB_SEARCH_TOOL_ALIAS,
    WEB_SEARCH_TOOL_NAME,
    app,
    applyDiscoveryToolGuardrail,
    artifactRetrieval,
    buildBlockedDiscoveryRecoverySnapshot,
    captureRequestForensics,
    circuitBreakers,
    clampMaxOutputTokensForSafety,
    computePrefixFingerprint,
    emitPlanWriteAuditEvent,
    extractUpstreamErrorDiagnostics,
    finalizePostStreamText,
    finalizeRequestForensics,
    generateText,
    getBlockedDiscoveryCount,
    getCachedTopLevelDirs,
    getTracer,
    knowledgeResolveContext,
    knowledgeSearch,
    maybeLogEnvelopeUnwrapSample,
    maybeUpdateTaskLedgerFromToolCall,
    openAiChatPipeline,
    openClawProfileStats,
    readUsage,
    recordBlockedDiscovery,
    recordSessionEvent,
    recordUpperHarnessDecision,
    safeEnd,
    safeWrite,
    sseHeadersWithClarification,
    startSseHeartbeat,
    streamAdmission,
    streamText,
    tierRegistry,
    toolArgHardeningStats,
    updateDiffAccumulator,
    webSearch,
    webSearchResolveContext,
    yarnDedupeLayer,
    yarnToolPrefixCache,
  } = deps;

  return openAiChatPipeline.executePreparedProviderCall({
    scope: {
      sessionKey,
      userId: identity.userId,
      orgId: identity.orgId,
      requestId,
    },
    authUser,
    req: { headers: requestHeaders },
    rawReply,
    session,
    identity,
    config,
    logger: app.log,
    normalizedRequest: normalizedRequest as never,
    request: request as never,
    resolved: resolved as never,
    adapter: providerPreparation.adapter,
    modelMessages: providerPreparation.modelMessages,
    effectiveTools: providerPreparation.effectiveTools,
    sdkTools: providerPreparation.sdkTools,
    effectiveToolChoice: providerPreparation.effectiveToolChoice,
    providerOptions: providerPreparation.providerOptions,
    structuredOutput: providerPreparation.structuredOutput,
    samplingOptions: providerPreparation.samplingOptions,
    phasePolicy: providerPreparation.phasePolicy,
    governorPhase: governorPhase as never,
    forensicsPhasePolicy: providerPreparation.forensicsPhasePolicy as never,
    forensicsCapabilityMatrix: forensicsCapabilityMatrix as never,
    orchestration,
    toolHandlingRouteBase: providerPreparation.toolHandlingRouteBase as never,
    finalizerRouteBase: providerPreparation.finalizerRouteBase as never,
    telemetryRouteBase: providerPreparation.telemetryRouteBase as never,
    optimizationLedger: optimizationLedger as never,
    pathContext,
    bodyMetadata,
    prefetchResult: prefetchResult as never,
    clientKind,
    openClawProfileStats,
    circuitBreakers,
    streamAdmission,
    toolArgHardeningStats,
    yarnDedupeLayer,
    yarnToolPrefixCache,
    tierRegistry,
    getTracer,
    extractUpstreamErrorDiagnostics,
    clampMaxOutputTokensForSafety,
    generateText: (options) => generateText(options as never),
    streamText: (options) => streamText(options as never),
    readUsage,
    recordSessionEvent,
    persistDecisionTelemetry: providerPreparation.persistDecisionTelemetry,
    captureRequestForensics,
    finalizeRequestForensics: (state, nextRequestId, forensics, usage) =>
      finalizeRequestForensics(state as never, nextRequestId, forensics as never, usage as never),
    getCachedTopLevelDirs,
    applyDiscoveryToolGuardrail,
    buildBlockedDiscoveryRecoverySnapshot,
    recordBlockedDiscovery,
    getBlockedDiscoveryCount,
    updateDiffAccumulator,
    maybeUpdateTaskLedgerFromToolCall,
    emitPlanWriteAuditEvent,
    maybeLogEnvelopeUnwrapSample,
    recordUpperHarnessDecision,
    artifactToolName: ARTIFACT_TOOL_NAME,
    knowledgeToolName: KNOWLEDGE_TOOL_NAME,
    devDocsToolName: DEV_DOCS_TOOL_NAME,
    webSearchToolName: WEB_SEARCH_TOOL_NAME,
    webSearchToolAlias: WEB_SEARCH_TOOL_ALIAS,
    artifactRetrieval,
    knowledgeSearch,
    webSearch,
    knowledgeResolveContext,
    webSearchResolveContext,
    safeWrite,
    safeEnd,
    computePrefixFingerprint,
    startSseHeartbeat,
    sseHeadersWithClarification,
    finalizePostStreamText,
    responseHeadersNeedClarification: true,
  });
}
