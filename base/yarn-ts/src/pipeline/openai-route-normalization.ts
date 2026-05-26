import type { AuthUser } from "../auth.js";
import type { SessionIdentity } from "../session/session-key.js";
import type { OpenAIChatCompletionsRouteDependencies } from "../server/route-dependencies.js";
import type { OpenAIChatCompletionRequest } from "../schemas.js";
import { prepareOpenAIRouteRequestSetup } from "./openai-route-request-setup.js";
import { prepareOpenAIRouteTranscript } from "./openai-route-transcript-prep.js";

type Deps = Pick<
  OpenAIChatCompletionsRouteDependencies,
  | "app"
  | "appendPathContextToAdapterBlock"
  | "applyIngressCapToToolMessages"
  | "assessVerificationSignals"
  | "clientAdapterPacks"
  | "config"
  | "debugProtocolLog"
  | "enrichmentPool"
  | "extractLatestUserPromptFromMessages"
  | "governanceClient"
  | "inferTrajectoryDiagnosticsFromMessages"
  | "isOpenClawProfile"
  | "openClawProfileStats"
  | "parseSessionExecutionContext"
  | "projectManifestService"
  | "resolveCompactionBackendModelHintFromRequestModel"
  | "runValidationTierCFallback"
  | "sessions"
  | "toolResultReduction"
  | "transcriptPruning"
  | "validationNormalization"
>;

interface PrepareOpenAIRouteNormalizationInput {
  deps: Deps;
  request: OpenAIChatCompletionRequest;
  requestId: string;
  authUser: AuthUser;
  identity: Pick<SessionIdentity, "userId" | "orgId" | "conversationId" | "clientKind" | "displayName">;
  canonicalRequest: { protocol: string };
  pipelineMode: string;
  bodyMetadata: Record<string, unknown> | null;
  headers: Record<string, string | string[] | undefined>;
  optimizationLedger: {
    recordOriginal(messages: Array<{ content?: unknown }>): void;
    recordAfterNormalization(messages: Array<{ content?: unknown }>): void;
    startStage(stage: string): () => void;
  };
}

export async function prepareOpenAIRouteNormalization(input: PrepareOpenAIRouteNormalizationInput) {
  const {
    deps,
    request,
    requestId,
    authUser,
    identity,
    canonicalRequest,
    pipelineMode,
    bodyMetadata,
    headers,
    optimizationLedger,
  } = input;
  const {
    app,
    appendPathContextToAdapterBlock,
    applyIngressCapToToolMessages,
    assessVerificationSignals,
    clientAdapterPacks,
    config,
    debugProtocolLog,
    enrichmentPool,
    extractLatestUserPromptFromMessages,
    governanceClient,
    inferTrajectoryDiagnosticsFromMessages,
    isOpenClawProfile,
    openClawProfileStats,
    parseSessionExecutionContext,
    projectManifestService,
    resolveCompactionBackendModelHintFromRequestModel,
    runValidationTierCFallback,
    sessions,
    toolResultReduction,
    transcriptPruning,
    validationNormalization,
  } = deps;

  const requestSetup = prepareOpenAIRouteRequestSetup({
    deps: {
      app,
      applyIngressCapToToolMessages,
      config,
      extractLatestUserPromptFromMessages,
      sessions,
    },
    request,
    requestId,
    identity: {
      userId: identity.userId,
      orgId: authUser.orgId,
      conversationId: identity.conversationId,
      clientKind: identity.clientKind,
      displayName: identity.displayName,
    },
    optimizationLedger,
  });
  const taskCue = requestSetup.taskCue;
  const endNormalizationStage = optimizationLedger.startStage("normalization");
  const transcriptPrep = await prepareOpenAIRouteTranscript({
    request,
    requestId,
    taskCue,
    backendModelHint: resolveCompactionBackendModelHintFromRequestModel(request.model),
    pruningWatermark: requestSetup.pruningWatermark,
    config,
    capabilityMatrix: governanceClient?.getCapabilityMatrix() ?? null,
    enrichmentPool,
    toolResultReduction,
    validationNormalization,
    transcriptPruning,
    validationTierCFallback: runValidationTierCFallback,
    optimizationLedger: optimizationLedger as never,
    endNormalizationStage,
    startPruningStage: () => optimizationLedger.startStage("pruning"),
    logger: app.log,
  });
  const trajectoryDiagnostics = inferTrajectoryDiagnosticsFromMessages(
    request.messages as Array<{ role: string; content: unknown }>,
  );
  const verificationAssessment = assessVerificationSignals(
    request.messages as Array<{ role: string; content: unknown; name?: string }>,
  );
  const adapterProfile = clientAdapterPacks.resolve(
    identity.clientKind,
    String((headers["x-synesis-mode"] as string | undefined) ?? ""),
  );
  const openClawStrictGovernance =
    config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED
    && config.SYNESIS_YARN_OPENCLAW_STRICT_GOVERNANCE_ENABLED
    && isOpenClawProfile(adapterProfile);
  if (isOpenClawProfile(adapterProfile)) {
    openClawProfileStats.requestsObserved += 1;
  }
  const pathContext = parseSessionExecutionContext(headers, bodyMetadata);
  const adapterBlock = appendPathContextToAdapterBlock(
    clientAdapterPacks.toSystemBlock(adapterProfile),
    headers,
    bodyMetadata,
    identity.clientKind,
    { gitPolicyMode: config.SYNESIS_YARN_GIT_POLICY_MODE },
  );
  const latestUserText = [...(transcriptPrep.normalizedOpenAI.messages as Array<{ role: string; content: unknown }>)]
    .reverse()
    .find((m) => m.role === "user");
  const preManifest = projectManifestService.build(transcriptPrep.normalizedOpenAI.messages as never);

  debugProtocolLog(app.log as never, requestId, "/v1/chat/completions", {
    protocol: canonicalRequest.protocol,
    pipelineMode,
    model: request.model,
    messageCount: request.messages.length,
    hasTools: Boolean(request.tools?.length),
    stream: request.stream,
    client: adapterProfile.client,
    temperature: request.temperature,
    top_p: request.top_p,
  });

  return {
    taskCue,
    transcriptPrep,
    compactionOpts: transcriptPrep.compactionOpts,
    matrixModelPath: transcriptPrep.matrixModelPath,
    matrixModelId: transcriptPrep.matrixModelId,
    matrixFamily: transcriptPrep.matrixFamily,
    capabilityResolution: transcriptPrep.capabilityResolution,
    phasePolicyEnabledByMatrix: transcriptPrep.phasePolicyEnabledByMatrix,
    contentDedupeEnabled: transcriptPrep.contentDedupeEnabled,
    responseDedupeEnabled: transcriptPrep.responseDedupeEnabled,
    historicalNormalizeEnabled: transcriptPrep.historicalNormalizeEnabled,
    reducedOpenAI: transcriptPrep.reducedOpenAI,
    normalizedOpenAI: transcriptPrep.normalizedOpenAI,
    toolResultCount: transcriptPrep.toolResultCount,
    endPruningStage: transcriptPrep.endPruningStage,
    trajectoryDiagnostics,
    verificationAssessment,
    adapterProfile,
    openClawStrictGovernance,
    pathContext,
    adapterBlock,
    latestUserText,
    preManifest,
  };
}
