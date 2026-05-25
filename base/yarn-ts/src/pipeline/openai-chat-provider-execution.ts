import type { AuthUser } from "../auth.js";
import type { AppConfig } from "../config.js";
import type { SessionPhase } from "../governance/execution-governor.js";
import type { PhaseAwareToolChoice } from "../governance/phase-execution-policy.js";
import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import type { OpenAIChatPipelineResult } from "./openai-chat-results.js";
import type { PipelineStageTelemetry } from "./types.js";
import {
  createOpenAIChatNonStreamRoutePipelineInput,
  runOpenAIChatNonStreamPipeline,
} from "./openai-chat-nonstream-pipeline.js";
import { runOpenAIChatStreamPipeline } from "./openai-chat-stream-pipeline.js";
import {
  createOpenAINonStreamCollapseRouteInput,
  createOpenAINonStreamDiscoveryRouteInput,
} from "./openai-route-inputs.js";
import {
  createOpenAINonStreamProviderForensics,
  createOpenAINonStreamServerSideToolResolvers,
} from "./openai-nonstream-provider-executor.js";
import { createOpenAINonStreamRouteScope } from "./openai-nonstream-route-scope.js";

type RouteLogger = {
  info(record: Record<string, unknown>, message?: string): void;
  warn(record: Record<string, unknown>, message?: string): void;
  error(record: Record<string, unknown>, message?: string): void;
};

type RouteRequest = {
  headers: Record<string, string | string[] | undefined>;
};

type RouteSession = {
  record: {
    metadata: Record<string, unknown>;
    conversationId?: string | null;
  };
  skipToolIdStabilization?: boolean;
};

type RouteIdentity = {
  userId: string;
  orgId: string;
};

type NormalizedOpenAIRequest = {
  stream?: boolean;
  stream_options?: unknown;
  messages: unknown[];
  tools?: unknown[];
  tool_choice?: unknown;
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
};

type OpenAIRequest = {
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  stream_options?: unknown;
};

type ResolvedOpenAIModel = {
  resolvedModelId: string;
  model: unknown;
};

type RouteTierRegistry = {
  getTierConfig(modelId: string): unknown;
};

type OpenAIChatProviderExecutionConfig = Pick<
  AppConfig,
  | "SYNESIS_YARN_TOOL_COLLAPSE_ENABLED"
  | "SYNESIS_YARN_TOOL_COLLAPSE_REWRITE_NON_STREAM"
  | "SYNESIS_YARN_TOOL_COLLAPSE_SHELL_ALLOWLIST"
  | "SYNESIS_YARN_DEBUG_PROTOCOL"
  | "SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS"
  | "SYNESIS_YARN_SSE_STREAM_HARD_TIMEOUT_MS"
  | "SYNESIS_YARN_SSE_HEARTBEAT_INTERVAL_MS"
>;

export interface PreparedOpenAIChatProviderExecutionInput {
  scope: {
    sessionKey: string;
    userId: string;
    orgId: string;
    requestId: string;
  };
  authUser: AuthUser;
  req: RouteRequest;
  rawReply: unknown;
  session: RouteSession;
  identity: RouteIdentity;
  config: OpenAIChatProviderExecutionConfig;
  logger: RouteLogger;
  normalizedRequest: NormalizedOpenAIRequest;
  request: OpenAIRequest;
  resolved: ResolvedOpenAIModel;
  adapter: unknown;
  modelMessages: unknown;
  effectiveTools: unknown[];
  sdkTools: unknown;
  effectiveToolChoice: unknown;
  providerOptions: unknown;
  structuredOutput: unknown;
  samplingOptions: unknown;
  phasePolicy: unknown;
  governorPhase: SessionPhase;
  forensicsPhasePolicy: RequestForensicsRecord["phasePolicy"];
  forensicsCapabilityMatrix: RequestForensicsRecord["capabilityMatrix"];
  orchestration: {
    maxOutputTokens: number;
    escalated?: boolean;
  };
  toolHandlingRouteBase: Record<string, unknown> & {
    planModeRequested?: boolean;
  };
  finalizerRouteBase: Record<string, unknown>;
  telemetryRouteBase: Record<string, unknown>;
  optimizationLedger: {
    startStage: PipelineStageTelemetry["startStage"];
  };
  pathContext: {
    projectRoot?: string | null;
    shellCwd?: string | null;
  };
  bodyMetadata: Record<string, unknown> | null;
  prefetchResult?: {
    matched?: boolean;
    confidence?: number;
  };
  clientKind: string;
  openClawProfileStats: unknown;
  circuitBreakers: unknown;
  streamAdmission: unknown;
  toolArgHardeningStats: unknown;
  yarnDedupeLayer: unknown;
  yarnToolPrefixCache: unknown;
  tierRegistry: RouteTierRegistry;
  getTracer(): {
    startSpan(name: string, attributes?: Record<string, unknown>): unknown;
  };
  extractUpstreamErrorDiagnostics(error: unknown): unknown;
  clampMaxOutputTokensForSafety(...args: unknown[]): unknown;
  generateText(options: unknown): unknown;
  streamText(options: unknown): unknown;
  readUsage(...args: unknown[]): unknown;
  recordSessionEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    eventKind: string,
    component: string,
    detail: string,
    requestId?: string,
    metadataJson?: Record<string, unknown>,
  ): void;
  persistDecisionTelemetry(input: unknown): unknown;
  captureRequestForensics: unknown;
  finalizeRequestForensics(session: RouteSession, requestId: string, forensics: unknown, usage: unknown): unknown;
  getCachedTopLevelDirs(path?: string): Promise<string[]>;
  applyDiscoveryToolGuardrail(...args: unknown[]): unknown;
  buildBlockedDiscoveryRecoverySnapshot(modelId: string, blockedDetails: unknown, projectRoot?: string): unknown;
  recordBlockedDiscovery(...args: unknown[]): unknown;
  getBlockedDiscoveryCount(...args: unknown[]): unknown;
  updateDiffAccumulator(...args: unknown[]): unknown;
  maybeUpdateTaskLedgerFromToolCall(...args: unknown[]): unknown;
  emitPlanWriteAuditEvent(...args: unknown[]): unknown;
  maybeLogEnvelopeUnwrapSample(...args: unknown[]): unknown;
  recordUpperHarnessDecision(...args: unknown[]): unknown;
  artifactToolName: string;
  knowledgeToolName: string;
  devDocsToolName: string;
  webSearchToolName: string;
  webSearchToolAlias: string;
  artifactRetrieval: {
    retrieve(handle: unknown, query: unknown): unknown;
  };
  knowledgeSearch: {
    resolve(input: unknown, context: unknown): unknown;
    resolveDevDocs(input: unknown, context: unknown): unknown;
  };
  webSearch: {
    resolve(input: unknown, context: unknown): unknown;
  };
  knowledgeResolveContext(authUser: AuthUser, req: RouteRequest): unknown;
  webSearchResolveContext(
    authUser: AuthUser,
    req: RouteRequest,
    context: Record<string, unknown>,
  ): unknown;
  safeWrite(...args: unknown[]): unknown;
  safeEnd: unknown;
  computePrefixFingerprint(...args: unknown[]): unknown;
  startSseHeartbeat(...args: unknown[]): unknown;
  sseHeadersWithClarification(metadata: Record<string, unknown>): Record<string, string>;
  finalizePostStreamText: unknown;
  responseHeadersNeedClarification: boolean;
}

export interface PreparedOpenAIChatProviderExecutionResult {
  result: OpenAIChatPipelineResult;
  applyClarificationHeader: boolean;
}

export async function runPreparedOpenAIChatProviderExecution(
  input: PreparedOpenAIChatProviderExecutionInput,
): Promise<PreparedOpenAIChatProviderExecutionResult> {
  const {
    scope,
    authUser,
    req,
    rawReply,
    session,
    config,
    logger,
    normalizedRequest,
    request,
    resolved,
    adapter,
    modelMessages,
    effectiveTools,
    sdkTools,
    effectiveToolChoice,
    providerOptions,
    structuredOutput,
    samplingOptions,
    phasePolicy,
    governorPhase,
    forensicsPhasePolicy,
    forensicsCapabilityMatrix,
    orchestration,
    toolHandlingRouteBase,
    finalizerRouteBase,
    telemetryRouteBase,
    optimizationLedger,
    pathContext,
    bodyMetadata,
    prefetchResult,
    clientKind,
    openClawProfileStats,
  } = input;

  if (!normalizedRequest.stream) {
    const started = Date.now();
    const nonStreamScope = createOpenAINonStreamRouteScope({
      sessionKey: scope.sessionKey,
      userId: scope.userId,
      orgId: scope.orgId,
      requestId: scope.requestId,
      recordSessionEvent: input.recordSessionEvent,
      persistDecisionTelemetry: input.persistDecisionTelemetry,
    });
    const nonStreamResult = await runOpenAIChatNonStreamPipeline(createOpenAIChatNonStreamRoutePipelineInput({
      scope: nonStreamScope,
      resolvedModelId: resolved.resolvedModelId,
      circuitBreakers: input.circuitBreakers as never,
      logger,
      startSpan: () => input.getTracer().startSpan("yarn.openai.generate", {
        model: resolved.resolvedModelId,
        sessionKey: scope.sessionKey,
      }) as never,
      extractUpstreamErrorDiagnostics: (error) => input.extractUpstreamErrorDiagnostics(error) as never,
      onMissingToolResults: () => {
        session.skipToolIdStabilization = true;
      },
      stageTelemetry: optimizationLedger,
      providerRouteInput: {
        scope: nonStreamScope,
        resolvedModelId: resolved.resolvedModelId,
        initialMessages: modelMessages as never,
        model: resolved.model as never,
        orchestrationMaxOutputTokens: orchestration.maxOutputTokens,
        requestMaxTokens: request.max_tokens ?? request.max_completion_tokens ?? 0,
        output: structuredOutput as never,
        samplingOptions: samplingOptions as never,
        tools: sdkTools as never,
        initialToolChoice: effectiveToolChoice as PhaseAwareToolChoice | undefined,
        providerOptions: providerOptions as never,
        phasePolicy: phasePolicy as never,
        governorPhase,
        clampMaxOutputTokens: input.clampMaxOutputTokensForSafety as never,
        generateText: (options) => input.generateText(options as never) as never,
        readUsage: input.readUsage as never,
        forensics: createOpenAINonStreamProviderForensics({
          path: "/v1/chat/completions",
          stream: false,
          tools: effectiveTools,
          phasePolicy: forensicsPhasePolicy,
          capabilityMatrix: forensicsCapabilityMatrix,
          captureRequestForensics: input.captureRequestForensics as never,
          finalizeRequestForensics: (forensics, usage) =>
            input.finalizeRequestForensics(session, scope.requestId, forensics, usage) as never,
        }),
        serverSideToolResolvers: createOpenAINonStreamServerSideToolResolvers({
          artifactToolName: input.artifactToolName,
          knowledgeToolName: input.knowledgeToolName,
          devDocsToolName: input.devDocsToolName,
          webSearchToolName: input.webSearchToolName,
          webSearchToolAlias: input.webSearchToolAlias,
          retrieveArtifact: (handle, query) => input.artifactRetrieval.retrieve(handle, query) as never,
          resolveKnowledge: (resolverInput) =>
            input.knowledgeSearch.resolve(resolverInput, input.knowledgeResolveContext(authUser, req)) as never,
          resolveDevDocs: (resolverInput) =>
            input.knowledgeSearch.resolveDevDocs(resolverInput, input.knowledgeResolveContext(authUser, req)) as never,
          resolveWebSearch: (resolverInput) => input.webSearch.resolve(
            resolverInput,
            input.webSearchResolveContext(authUser, req, {
              requestId: scope.requestId,
              sessionKey: scope.sessionKey,
              conversationId: session.record.conversationId || undefined,
              traceId: scope.requestId,
              sourceSurface: "yarn_chat",
              toolName: input.webSearchToolName,
            }),
          ) as never,
        }),
      },
      getTopLevelDirs: () => input.getCachedTopLevelDirs(pathContext.projectRoot ?? pathContext.shellCwd ?? undefined),
      postprocessRouteInput: {
        scope: nonStreamScope,
        responseModel: resolved.resolvedModelId,
        readUsage: input.readUsage as never,
        applyDiscoveryGuardrail: input.applyDiscoveryToolGuardrail as never,
        toolCallInput: {
          artifactToolName: input.artifactToolName,
          ...toolHandlingRouteBase,
          strictGovernanceStats: openClawProfileStats,
          recordUpperHarnessDecision: input.recordUpperHarnessDecision,
          updateDiffAccumulator: input.updateDiffAccumulator,
          maybeUpdateTaskLedgerFromToolCall: input.maybeUpdateTaskLedgerFromToolCall,
          emitPlanWriteAuditEvent: input.emitPlanWriteAuditEvent,
          maybeLogEnvelopeUnwrapSample: input.maybeLogEnvelopeUnwrapSample,
        } as never,
        discoveryInput: createOpenAINonStreamDiscoveryRouteInput({
          projectRoot: pathContext.projectRoot,
          buildBlockedDiscoveryRecovery: input.buildBlockedDiscoveryRecoverySnapshot as never,
          recordBlockedDiscovery: input.recordBlockedDiscovery as never,
          getBlockedDiscoveryCount: input.getBlockedDiscoveryCount as never,
        }),
        collapseInput: createOpenAINonStreamCollapseRouteInput({
          enabled: config.SYNESIS_YARN_TOOL_COLLAPSE_ENABLED,
          rewriteNonStream: config.SYNESIS_YARN_TOOL_COLLAPSE_REWRITE_NON_STREAM,
          collapseHeader: req.headers["x-synesis-tool-collapse"],
          headers: req.headers,
          bodyMetadata,
          shellAllowlistEnv: config.SYNESIS_YARN_TOOL_COLLAPSE_SHELL_ALLOWLIST,
          dedupeLayer: input.yarnDedupeLayer as never,
          toolPrefixCache: input.yarnToolPrefixCache as never,
          logger,
          requestId: scope.requestId,
        }),
        finalizerInput: finalizerRouteBase as never,
        telemetryInput: {
          startedAtMs: started,
          ...telemetryRouteBase,
          escalated: orchestration.escalated,
          diagnosticEvidencePrefetchHit: prefetchResult?.matched && (prefetchResult?.confidence ?? 0) > 0 || undefined,
          optimizationLedger,
          logOptimizationLedger: (record: Record<string, unknown>) =>
            logger.info({ reqId: scope.requestId, ...record }, "optimization_ledger"),
        } as never,
        responseInput: {
          effectiveTools,
          clientKind,
        },
      },
    }));
    return {
      result: nonStreamResult,
      applyClarificationHeader: input.responseHeadersNeedClarification,
    };
  }

  const streamGateScope = {
    sessionKey: scope.sessionKey,
    userId: scope.userId,
    orgId: scope.orgId,
    requestId: scope.requestId,
  };
  const {
    planModeRequested: streamPlanModeRequested,
    ...streamToolHandlingRouteBase
  } = toolHandlingRouteBase;
  const streamResult = await runOpenAIChatStreamPipeline({
    scope: streamGateScope,
    resolvedModelId: resolved.resolvedModelId,
    recordSessionEvent: input.recordSessionEvent,
    stageTelemetry: optimizationLedger,
    start: {
      logger,
      streamAdmission: input.streamAdmission as never,
      circuitBreakers: input.circuitBreakers as never,
      startSpan: (name, attributes) => input.getTracer().startSpan(name, attributes) as never,
    },
    provider: {
      path: "/v1/chat/completions (stream)",
      providerModel: resolved.model as never,
      messages: modelMessages as never,
      effectiveTools,
      sdkTools: sdkTools as never,
      toolChoice: effectiveToolChoice as never,
      providerOptions: providerOptions as never,
      output: structuredOutput as never,
      samplingOptions: samplingOptions as never,
      orchestrationMaxOutputTokens: orchestration.maxOutputTokens,
      requestMaxTokens: request.max_tokens,
      requestMaxCompletionTokens: request.max_completion_tokens,
      adapter: adapter as never,
      debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
      longWaitEventMs: config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS,
      hardTimeoutMs: config.SYNESIS_YARN_SSE_STREAM_HARD_TIMEOUT_MS,
      phasePolicy: forensicsPhasePolicy,
      capabilityMatrix: forensicsCapabilityMatrix,
      logger,
      clampMaxOutputTokens: input.clampMaxOutputTokensForSafety as never,
      captureForensics: input.captureRequestForensics as never,
      streamText: (options) => input.streamText(options as never) as never,
    },
    runtime: {
      raw: rawReply as never,
      headers: input.sseHeadersWithClarification(session.record.metadata),
      tierConfig: input.tierRegistry.getTierConfig(resolved.resolvedModelId) as never,
      write: input.safeWrite as never,
      computePrefixFingerprint: input.computePrefixFingerprint as never,
      heartbeatIntervalMs: config.SYNESIS_YARN_SSE_HEARTBEAT_INTERVAL_MS,
      longWaitEventMs: config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS,
      startHeartbeat: input.startSseHeartbeat as never,
      session: session as never,
      circuitBreakers: input.circuitBreakers as never,
      logger,
      extractUpstreamErrorDiagnostics: input.extractUpstreamErrorDiagnostics as never,
      adapter: adapter as never,
      stats: input.toolArgHardeningStats as never,
      recordBlockedDiscovery: input.recordBlockedDiscovery as never,
      getBlockedDiscoveryCount: input.getBlockedDiscoveryCount as never,
    },
    eventHandlers: {
      ...streamToolHandlingRouteBase,
      debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
      clientPlanModeRequested: streamPlanModeRequested,
      sideEffects: {
        updateDiffAccumulator: input.updateDiffAccumulator,
        maybeUpdateTaskLedgerFromToolCall: input.maybeUpdateTaskLedgerFromToolCall,
        emitPlanWriteAuditEvent: input.emitPlanWriteAuditEvent,
        maybeLogEnvelopeUnwrapSample: input.maybeLogEnvelopeUnwrapSample,
        recordUpperHarnessDecision: input.recordUpperHarnessDecision,
      },
      strictGovernanceStats: openClawProfileStats,
      recordBlockedDiscovery: input.recordBlockedDiscovery,
      getTopLevelDirs: input.getCachedTopLevelDirs,
      applyDiscoveryGuardrail: input.applyDiscoveryToolGuardrail,
      buildBlockedDiscoveryRecovery: (blockedDetails: unknown) => input.buildBlockedDiscoveryRecoverySnapshot(
        resolved.resolvedModelId,
        blockedDetails,
        pathContext.projectRoot ?? undefined,
      ),
    } as never,
    finalizer: {
      streamOptions: request.stream_options,
      readUsage: input.readUsage,
      ...finalizerRouteBase,
      finalizePostStreamText: input.finalizePostStreamText as never,
      endStream: () => (input.safeEnd as (raw: unknown) => unknown)(rawReply),
    } as never,
    telemetry: {
      routeBase: telemetryRouteBase as never,
      optimizationLedger,
      finalizeRequestForensics: (usage: unknown, forensics: unknown) =>
        input.finalizeRequestForensics(session, scope.requestId, forensics, usage) as never,
      persistDecisionTelemetry: ({ finishReason, telemetry }: { finishReason: unknown; telemetry: Record<string, unknown> }) =>
        input.persistDecisionTelemetry({
          ...telemetry,
          finishReason,
          escalated: orchestration.escalated,
        }),
      logOptimizationLedger: (record: Record<string, unknown>) =>
        logger.info({ reqId: scope.requestId, ...record }, "optimization_ledger"),
    } as never,
  });
  return {
    result: streamResult,
    applyClarificationHeader: false,
  };
}
