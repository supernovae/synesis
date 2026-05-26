import type { FastifyReply, FastifyRequest } from "fastify";

import type { AuthUser } from "../auth.js";
import type { ClaudeMessagesRouteDependencies } from "../index.js";
import type { ClaudeMessagesRequest } from "../schemas.js";
import type { RequestDiagnostic } from "../telemetry/request-diagnostics.js";
import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import type { ClaudeProviderRuntimeRouteResult } from "./claude-provider-runtime-preparation.js";
import { countMessageRoles } from "./context-admission.js";
import { extractRecentToolNames } from "./route-tool-preparation.js";
import { buildDefaultPolicy } from "../path-governance/path-sandbox.js";
import { runClaudeNonStreamRoute } from "../streaming/claude-nonstream-route.js";
import { runClaudeStreamKickoffRoute } from "../streaming/claude-stream-kickoff-route.js";
import { runClaudeStreamRoute } from "../streaming/claude-stream-route.js";

type SessionState = Awaited<ReturnType<ClaudeMessagesRouteDependencies["session"]["getSessionState"]>>;
type DispatchDeps = Pick<
  ClaudeMessagesRouteDependencies,
  | "runtime"
  | "protocol"
  | "session"
  | "reduction"
  | "tools"
  | "governance"
  | "planning"
  | "provider"
  | "evidence"
  | "telemetry"
>;
type PreparedRuntime = Extract<ClaudeProviderRuntimeRouteResult, { ok: true }>;

interface ClaudeMessagesDispatchInput {
  deps: DispatchDeps;
  request: FastifyRequest;
  reply: FastifyReply;
  authUser: AuthUser;
  body: ClaudeMessagesRequest;
  session: SessionState;
  sessionKey: string;
  userId: string;
  orgId: string;
  traceRequestId: string;
  clientKind: string;
  providerRuntime: PreparedRuntime;
  normalizedMessages: Array<{ role: string; content: unknown }>;
  toolResultCount: number;
  policyMatchedRules: string[];
  evidencePrefetched: boolean;
  evidenceConfidence?: number;
  prefetchResult: unknown;
  patternResult: unknown;
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
  governorDecision: unknown;
  governorPhase: Parameters<typeof runClaudeStreamKickoffRoute>[0]["governorPhase"];
  governorChatStateSummary?: Record<string, unknown>;
  governorFileStateSummary?: Record<string, unknown>;
  trajectoryDiagnostics?: Record<string, unknown>;
  artifactShadows: unknown;
  requirementChecklist: { must: unknown[]; should: unknown[] } | null;
  verificationAssessment: unknown;
  planGraph: unknown;
  strictGovernance: boolean;
  clientPlanModeRequested: boolean;
  restrictDiscoveryForPlanWork?: boolean;
  taskCue: unknown;
  orchestration: Parameters<typeof runClaudeStreamKickoffRoute>[0]["orchestration"];
  forensicsCapabilityMatrix?: RequestForensicsRecord["capabilityMatrix"];
}

export async function runClaudeMessagesDispatchForRoute(input: ClaudeMessagesDispatchInput): Promise<FastifyReply> {
  const {
    runtime: {
      app,
      config,
      crypto,
      getTracer,
      safeEnd,
      safeSse,
      startSseHeartbeat,
    },
    protocol: {
      applyClarificationRoundResponseHeader,
      sseHeadersWithClarification,
    },
    session: {
      getMetadataString,
      readUsage,
      recordSessionEvent,
    },
    reduction: {
      deserializeShadow,
      toolResultReduction,
      validationNormalization,
    },
    tools: {
      applyDiscoveryToolGuardrail,
      buildBlockedDiscoveryRecoverySnapshot,
      emitPlanWriteAuditEvent,
      getBlockedDiscoveryCount,
      getCachedTopLevelDirs,
      isWriteCapableToolName,
      maybeLogEnvelopeUnwrapSample,
      maybeUpdateTaskLedgerFromToolCall,
      recordBlockedDiscovery,
      toolArgHardeningStats,
      updateDiffAccumulator,
    },
    governance: {
      openClawProfileStats,
      shouldRestrictDiscoveryForPlanWork,
    },
    planning: {
      applyMarkdownGuardrail,
      finalizeCompletionText,
      finalizePostStreamText,
      inferVerificationSteps,
      recordUpperHarnessDecision,
    },
    provider: {
      captureRequestForensics,
      circuitBreakers,
      clampMaxOutputTokensForSafety,
      computePrefixFingerprint,
      extractUpstreamErrorDiagnostics,
      finalizeRequestForensics,
      generateText,
      streamAdmission,
      streamText,
      tierRegistry,
    },
    evidence: {
      webSearch,
      webSearchResolveContext,
    },
    telemetry: {
      pushDiagnostic,
    },
  } = input.deps;

  const providerPreparation = input.providerRuntime.providerPreparation;
  const resolved = input.providerRuntime.resolved;
  const openAIShape = input.providerRuntime.openAIShape;
  const pathContext = input.providerRuntime.pathContext;
  const enriched = input.providerRuntime.enriched;
  const responseRequestId = input.traceRequestId;
  const sdkStop = input.body.stop_sequences && input.body.stop_sequences.length > 0
    ? input.body.stop_sequences
    : undefined;
  const contextAdmission = providerPreparation.contextAdmission;
  const contextAdmissionTelemetry = {
    decision: contextAdmission.decision,
    reason: contextAdmission.reason,
    estimatedTokens: contextAdmission.estimatedTokens,
    estimatedChars: contextAdmission.estimatedChars,
  };

  if (input.body.stream) {
    if (providerPreparation.nativeWebSearchRequested || providerPreparation.forceNonStreamKickoff) {
      await runClaudeStreamKickoffRoute({
        request: input.request,
        reply: input.reply,
        authUser: input.authUser,
        runtime: {
          crypto,
          safeEnd,
          safeSse,
          sseHeadersWithClarification,
        },
        webSearch: {
          webSearch,
          webSearchResolveContext,
        },
        body: input.body,
        session: input.session,
        sessionKey: input.sessionKey,
        userId: input.userId,
        orgId: input.orgId,
        traceRequestId: input.traceRequestId,
        responseRequestId,
        resolvedModelId: resolved.resolvedModelId,
        model: resolved.model,
        messages: providerPreparation.modelMessages as Array<{ role: string; content?: unknown }>,
        orchestration: input.orchestration,
        samplingOptions: providerPreparation.samplingOptions,
        stopSequences: sdkStop,
        sdkTools: providerPreparation.sdkTools,
        toolChoice: providerPreparation.effectiveToolChoice,
        providerOptions: providerPreparation.providerOptions,
        phasePolicy: providerPreparation.phasePolicy,
        governorPhase: input.governorPhase,
        nativeWebSearchRequested: providerPreparation.nativeWebSearchRequested,
        forceNonStreamKickoff: providerPreparation.forceNonStreamKickoff,
        effectiveTools: providerPreparation.effectiveTools as unknown[],
        forensicsPhasePolicy: providerPreparation.forensicsPhasePolicy,
        forensicsCapabilityMatrix: input.forensicsCapabilityMatrix,
        cacheShapeDiagnostics: providerPreparation.cacheShapeDiagnostics,
        normalizedMessages: input.normalizedMessages,
        toolResultCount: input.toolResultCount,
        policyMatchedRules: input.policyMatchedRules,
        evidencePrefetched: input.evidencePrefetched,
        evidenceConfidence: input.evidenceConfidence,
        prefetchResult: input.prefetchResult as never,
        patternResult: input.patternResult as never,
        sensemakingTriggered: input.sensemakingTriggered,
        sensemakingReason: input.sensemakingReason,
        governorDecision: input.governorDecision as never,
        governorChatStateSummary: input.governorChatStateSummary,
        governorFileStateSummary: input.governorFileStateSummary,
        trajectoryDiagnostics: input.trajectoryDiagnostics,
        artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
        knowledgeToolInjected: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
        toolResultReduction,
        validationNormalization,
        clampMaxOutputTokens: clampMaxOutputTokensForSafety,
        generateText: (options) => generateText(options as never),
        readUsage,
        captureRequestForensics,
        finalizeRequestForensics: (requestSession, requestId, forensics, usage) => finalizeRequestForensics(
          requestSession as typeof input.session,
          requestId,
          forensics,
          usage,
        ),
        recordSessionEvent,
        persistDecisionTelemetry: providerPreparation.persistDecisionTelemetry,
        inferVerificationSteps,
        countMessageRoles,
        pushDiagnostic,
      });
      return input.reply;
    }

    const claudeStreamResult = await runClaudeStreamRoute({
      reply: input.reply,
      runtime: {
        crypto,
        getTracer,
        safeEnd,
        safeSse,
        startSseHeartbeat,
        sseHeadersWithClarification,
      },
      infrastructure: {
        streamAdmission,
        circuitBreakers,
      },
      logger: app.log,
      body: input.body,
      session: input.session,
      sessionKey: input.sessionKey,
      userId: input.userId,
      orgId: input.orgId,
      traceRequestId: input.traceRequestId,
      responseRequestId,
      resolvedModelId: resolved.resolvedModelId,
      model: resolved.model,
      adapter: providerPreparation.adapter,
      messages: providerPreparation.modelMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }>,
      recentMessages: openAIShape.messages as Array<{ role: string; content: unknown }>,
      normalizedMessages: input.normalizedMessages,
      pathContext,
      clientKind: input.clientKind,
      debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
      strictGovernance: input.strictGovernance,
      upperHarness: providerPreparation.upperHarness,
      taskCue: input.taskCue,
      clientPlanModeRequested: input.clientPlanModeRequested,
      sensemakingRestrictDiscovery: input.restrictDiscoveryForPlanWork,
      enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
      blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
      pathSandboxEnabled: config.SYNESIS_YARN_PATH_SANDBOX_ENABLED,
      artifactShadows: input.artifactShadows as never,
      recentCalls: providerPreparation.recentCallsForSteering,
      requirementChecklist: input.requirementChecklist,
      verificationAssessment: input.verificationAssessment,
      planGraph: input.planGraph,
      responseStyleMode: config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
      orchestration: input.orchestration,
      samplingOptions: providerPreparation.samplingOptions,
      stopSequences: sdkStop,
      sdkTools: providerPreparation.sdkTools,
      effectiveTools: providerPreparation.effectiveTools as unknown[],
      toolChoice: providerPreparation.effectiveToolChoice,
      providerOptions: providerPreparation.providerOptions,
      forensicsPhasePolicy: providerPreparation.forensicsPhasePolicy,
      forensicsCapabilityMatrix: input.forensicsCapabilityMatrix,
      prefetchResult: input.prefetchResult as never,
      patternResult: input.patternResult as never,
      evidencePrefetched: input.evidencePrefetched,
      evidenceConfidence: input.evidenceConfidence,
      sensemakingTriggered: input.sensemakingTriggered,
      sensemakingReason: input.sensemakingReason,
      governorDecision: input.governorDecision as never,
      governorChatStateSummary: input.governorChatStateSummary,
      governorFileStateSummary: input.governorFileStateSummary,
      trajectoryDiagnostics: input.trajectoryDiagnostics,
      toolResultReduction,
      validationNormalization,
      toolResultCount: input.toolResultCount,
      policyMatchedRules: input.policyMatchedRules,
      promptProfileIds: enriched.promptProfileIds,
      promptProfileHashes: enriched.promptProfileHashes,
      prefixHash: enriched.prefixHash,
      prefixChangeReasons: enriched.prefixChangeReasons,
      contextAdmission,
      artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
      knowledgeToolInjected: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
      transport: {
        heartbeatIntervalMs: config.SYNESIS_YARN_SSE_HEARTBEAT_INTERVAL_MS,
        longWaitEventMs: config.SYNESIS_YARN_SSE_LONG_WAIT_EVENT_MS,
        hardTimeoutMs: config.SYNESIS_YARN_SSE_STREAM_HARD_TIMEOUT_MS,
      },
      provider: {
        streamText: (options) => streamText(options as never),
        clampMaxOutputTokens: clampMaxOutputTokensForSafety,
        computePrefixFingerprint,
        captureRequestForensics,
        finalizeRequestForensics: (requestSession, requestId, forensics, usage) => finalizeRequestForensics(
          requestSession as typeof input.session,
          requestId,
          forensics as { record: RequestForensicsRecord; serialized: string } | null,
          usage,
        ),
        extractUpstreamErrorDiagnostics,
        getTierConfig: (modelId) => tierRegistry.getTierConfig(modelId),
      },
      tools: {
        stats: toolArgHardeningStats,
        isWriteCapableToolName,
        shouldRestrictDiscoveryForPlanWork,
        deserializePlanShadow: deserializeShadow,
        buildPathSandboxPolicy: buildDefaultPolicy,
        getTopLevelDirs: getCachedTopLevelDirs,
        applyDiscoveryGuardrail: applyDiscoveryToolGuardrail,
        recordBlockedDiscovery,
        getBlockedDiscoveryCount,
        buildBlockedDiscoveryRecoverySnapshot,
      },
      sideEffects: {
        strictGovernanceStats: openClawProfileStats,
        updateDiffAccumulator,
        maybeUpdateTaskLedgerFromToolCall,
        emitPlanWriteAuditEvent,
        maybeLogEnvelopeUnwrapSample,
        recordUpperHarnessDecision,
      },
      telemetry: {
        readUsage,
        getMetadataString,
        extractRecentToolNames,
        inferVerificationSteps,
        countMessageRoles,
        pushDiagnostic: (diagnostic) => pushDiagnostic(diagnostic as unknown as RequestDiagnostic),
        persistDecisionTelemetry: providerPreparation.persistDecisionTelemetry,
        recordSessionEvent,
      },
      finalizer: {
        applyMarkdownGuardrail,
        finalizeCompletionText,
        finalizePostStreamText,
      },
    });
    if (claudeStreamResult.kind === "rejected") {
      input.reply.header("Retry-After", claudeStreamResult.retryAfter);
      return input.reply.code(claudeStreamResult.statusCode).send(claudeStreamResult.payload);
    }
    return input.reply;
  }

  const claudeNonStreamResult = await runClaudeNonStreamRoute({
    body: input.body,
    session: input.session,
    sessionKey: input.sessionKey,
    userId: input.userId,
    orgId: input.orgId,
    requestId: responseRequestId,
    resolvedModelId: resolved.resolvedModelId,
    model: resolved.model,
    adapter: providerPreparation.adapter,
    messages: providerPreparation.modelMessages as Array<{ role: string; content?: unknown }>,
    recentMessages: openAIShape.messages as Array<{ role: string; content: unknown }>,
    normalizedMessages: input.normalizedMessages,
    samplingOptions: providerPreparation.samplingOptions,
    stopSequences: sdkStop,
    sdkTools: providerPreparation.sdkTools,
    toolChoice: providerPreparation.effectiveToolChoice,
    providerOptions: providerPreparation.providerOptions,
    phasePolicy: providerPreparation.phasePolicy,
    governorPhase: input.governorPhase,
    nativeWebSearchRequested: providerPreparation.nativeWebSearchRequested,
    effectiveTools: providerPreparation.effectiveTools as unknown[],
    forensicsPhasePolicy: providerPreparation.forensicsPhasePolicy,
    forensicsCapabilityMatrix: input.forensicsCapabilityMatrix,
    pathContext,
    clientKind: input.clientKind,
    strictGovernance: input.strictGovernance,
    upperHarness: providerPreparation.upperHarness,
    recentCalls: providerPreparation.recentCallsForSteering,
    enforcePathRoot: config.SYNESIS_YARN_FILE_TOOL_PROJECT_ROOT_ENFORCE,
    blockBashPathDrift: config.SYNESIS_YARN_BASH_PATH_DRIFT_BLOCK_ENABLED,
    pathSandboxEnabled: config.SYNESIS_YARN_PATH_SANDBOX_ENABLED,
    planModeRequested: input.clientPlanModeRequested,
    restrictDiscoveryForPlanWork: input.restrictDiscoveryForPlanWork,
    taskCue: input.taskCue,
    artifactShadows: input.artifactShadows as never,
    requirementChecklist: input.requirementChecklist,
    verificationAssessment: input.verificationAssessment,
    planGraph: input.planGraph,
    responseStyleMode: config.SYNESIS_YARN_RESPONSE_STYLE_MODE,
    orchestration: input.orchestration,
    policyMatchedRules: input.policyMatchedRules,
    evidencePrefetched: input.evidencePrefetched,
    evidencePrefetchHit: (input.prefetchResult as { matched?: boolean; confidence?: number } | null | undefined)?.matched
      && ((input.prefetchResult as { confidence?: number } | null | undefined)?.confidence ?? 0) > 0,
    evidenceConfidence: input.evidenceConfidence,
    prefetchResult: input.prefetchResult as never,
    patternResult: input.patternResult as never,
    sensemakingTriggered: input.sensemakingTriggered,
    sensemakingReason: input.sensemakingReason,
    governorDecision: input.governorDecision as never,
    governorChatStateSummary: input.governorChatStateSummary,
    governorFileStateSummary: input.governorFileStateSummary,
    trajectoryDiagnostics: input.trajectoryDiagnostics,
    promptProfileIds: enriched.promptProfileIds,
    promptProfileHashes: enriched.promptProfileHashes,
    prefixHash: enriched.prefixHash,
    prefixChangeReasons: enriched.prefixChangeReasons,
    contextAdmission: contextAdmissionTelemetry,
    cacheShapeDiagnostics: providerPreparation.cacheShapeDiagnostics,
    toolResultReduction,
    validationNormalization,
    toolResultCount: input.toolResultCount,
    artifactToolInjected: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
    knowledgeToolInjected: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
    logger: app.log,
    strictGovernanceStats: openClawProfileStats,
    toolArgHardeningStats,
    circuitBreakers,
    getTracer,
    extractUpstreamErrorDiagnostics,
    clampMaxOutputTokens: clampMaxOutputTokensForSafety,
    generateText: (options) => generateText(options as never),
    readUsage,
    captureRequestForensics,
    finalizeRequestForensics: (requestSession, requestId, forensics, usage) => finalizeRequestForensics(
      requestSession as typeof input.session,
      requestId,
      forensics,
      usage,
    ),
    recordSessionEvent,
    persistDecisionTelemetry: providerPreparation.persistDecisionTelemetry,
    updateDiffAccumulator,
    maybeUpdateTaskLedgerFromToolCall,
    emitPlanWriteAuditEvent,
    maybeLogEnvelopeUnwrapSample,
    recordUpperHarnessDecision,
    isWriteCapableToolName,
    shouldRestrictDiscoveryForPlanWork,
    deserializePlanShadow: deserializeShadow,
    buildPathSandboxPolicy: buildDefaultPolicy,
    getTopLevelDirs: getCachedTopLevelDirs,
    applyDiscoveryGuardrail: applyDiscoveryToolGuardrail,
    buildBlockedDiscoveryRecovery: buildBlockedDiscoveryRecoverySnapshot,
    recordBlockedDiscovery,
    getBlockedDiscoveryCount,
    getMetadataString,
    extractRecentToolNames,
    applyMarkdownGuardrail,
    finalizeCompletionText,
    inferVerificationSteps,
    countMessageRoles,
    pushDiagnostic: (diagnostic) => pushDiagnostic(diagnostic as unknown as RequestDiagnostic),
    resolveServerWebSearch: (serverInput, context) => webSearch.resolve(
      serverInput,
      webSearchResolveContext(input.authUser, input.request, context),
    ),
    createMessageId: () => `msg_${crypto.randomUUID()}`,
  });
  if (claudeNonStreamResult.kind === "error") {
    for (const [header, value] of Object.entries(claudeNonStreamResult.headers ?? {})) {
      input.reply.header(header, value);
    }
    return input.reply.code(claudeNonStreamResult.statusCode).send(claudeNonStreamResult.body);
  }
  applyClarificationRoundResponseHeader(input.reply, input.session.record.metadata);
  return input.reply.send(claudeNonStreamResult.body);
}
