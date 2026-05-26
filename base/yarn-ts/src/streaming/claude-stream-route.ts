import type { FastifyReply } from "fastify";

import type { FastPathResult, PatternPrefetchResult } from "../evidence/fast-path.js";
import { buildEvidenceTraceSummary } from "../evidence/fast-path.js";
import type { ExecutionGovernorDecision } from "../governance/execution-governor.js";
import type { ToolArgHardeningStats } from "../governance/tool-call-observability.js";
import type { GovernToolCallOptions, GovernedToolCall, PlanWriteAuditRecord } from "../path-governance/tool-call-governance.js";
import type { PathSandboxPolicy } from "../path-governance/path-sandbox.js";
import type { PlanContentShadow } from "../planning/plan-content-shadow.js";
import type { OrchestratorDecision } from "../orchestration/phase-model-orchestrator.js";
import type { ModelAdapter } from "../providers/model-adapter.js";
import type { MessageRoleCounts } from "../pipeline/context-admission.js";
import type { ClaudeMessagesRequest } from "../schemas.js";
import type { DecisionTelemetryPayload } from "../state/decision-telemetry-persister.js";
import type { SessionPathHints } from "../state/workspace-session-boundary.js";
import type { ClientTaskCapabilities, TaskLedger } from "../task-ledger/index.js";
import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import type { GuardrailToolCall } from "../tools/tool-call-availability.js";
import type { RequestForensicsBuildResult, RequestForensicsRecord } from "../telemetry/request-forensics.js";
import type { YarnUpperHarnessContext } from "../upper-harness/bridge.js";
import {
  createClaudeStreamRouteContext,
} from "./claude-stream-route-context.js";
import {
  runClaudeStreamRouteFromInput,
} from "./claude-stream-route-facade-input.js";
import {
  prepareClaudeStreamRoute,
} from "./claude-stream-route-prepare.js";
import type { ClaudeStreamProviderMessage } from "./claude-stream-provider-request.js";
import type { RequirementChecklistShape } from "./claude-stream-route-completion-input.js";
import type { ClaudeStreamRouteStartedStream } from "./claude-stream-route-start.js";
import type { OpenAIStreamHeartbeat, OpenAIStreamSseRaw } from "./openai-stream-runtime.js";
import type { OpenAIStreamDiscoveryGuardrailResult, OpenAIStreamToolCallRecovery } from "./openai-stream-tool-call-handler.js";
import type { OpenAIStreamFinalizerTextResult, StreamTokenUsage } from "./openai-stream-finalizer.js";
import type { OpenAIStreamLifecycleCircuitBreaker, OpenAIStreamUpstreamErrorDiagnostics } from "./openai-stream-lifecycle.js";
import type { StreamTelemetryReductions } from "./stream-telemetry-route-base.js";
import type { StreamAdmissionQueue, StreamRouteSpan } from "./stream-route-start.js";
import type { RouteToolCallSideEffects, StrictGovernanceRewriteStats } from "./route-tool-call-side-effects.js";

interface ClaudeStreamSession {
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  gitInspectionBlockCount: number;
  blockBroadVerificationUntilEdit: boolean;
  blockFailingVerificationUntilEdit: boolean;
  artifactEditTurns: Map<string, number>;
  skipToolIdStabilization: boolean;
  taskCapabilities: ClientTaskCapabilities | null;
  taskLedger: TaskLedger | null;
  record: {
    requestCount: number;
    sessionKey: string;
    metadata: Record<string, unknown> & {
      plan_content_shadow?: unknown;
    };
  };
}

interface RouteLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

interface RouteRuntimeDeps {
  crypto: { randomUUID(): string };
  getTracer(): {
    startSpan(name: string, attributes: Record<string, string | number | boolean>): StreamRouteSpan;
  };
  safeEnd(raw: FastifyReply["raw"]): void;
  safeSse(reply: FastifyReply, event: string, data: unknown): boolean;
  startSseHeartbeat(input: {
    raw: OpenAIStreamSseRaw;
    intervalMs: number;
    longWaitEventMs: number;
    onLongWait?: (elapsedMs: number) => void;
  }): OpenAIStreamHeartbeat;
  sseHeadersWithClarification(metadata: Record<string, unknown>): Record<string, string>;
}

interface StreamInfrastructureDeps {
  streamAdmission: StreamAdmissionQueue;
  circuitBreakers: OpenAIStreamLifecycleCircuitBreaker & {
    allowRequest(modelId: string, orgId: string): boolean;
  };
}

interface RouteToolSideEffectDeps {
  strictGovernanceStats: StrictGovernanceRewriteStats;
  updateDiffAccumulator(session: ClaudeStreamSession, governed: GovernedToolCall): void;
  maybeUpdateTaskLedgerFromToolCall(
    session: ClaudeStreamSession,
    toolName: string,
    input: Record<string, unknown>,
    requestCount: number,
  ): void;
  emitPlanWriteAuditEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    audit: PlanWriteAuditRecord,
  ): void;
  maybeLogEnvelopeUnwrapSample(
    logger: { info(obj: Record<string, unknown>, msg?: string): void },
    requestId: string,
    toolName: string,
    clientKind: string,
    governed: GovernedToolCall,
    toolCallId?: string,
  ): void;
  recordUpperHarnessDecision(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    component: string,
    decision: Parameters<RouteToolCallSideEffects["recordUpperHarnessDecision"]>[0],
  ): void;
}

interface ClaudeStreamToolDeps {
  stats: ToolArgHardeningStats;
  isWriteCapableToolName(name: string): boolean;
  shouldRestrictDiscoveryForPlanWork(taskCue: unknown): boolean;
  deserializePlanShadow(data: unknown): PlanContentShadow | null;
  buildPathSandboxPolicy(root: string): PathSandboxPolicy;
  getTopLevelDirs(root?: string | null): Promise<string[]>;
  applyDiscoveryGuardrail(calls: GuardrailToolCall[], topLevelDirs: string[]): OpenAIStreamDiscoveryGuardrailResult;
  recordBlockedDiscovery(sessionKey: string, count: number): void;
  getBlockedDiscoveryCount(sessionKey: string): number;
  buildBlockedDiscoveryRecoverySnapshot(
    model: string,
    blockedDetails: BlockedDiscoveryDetail[],
    projectRoot?: string | null,
  ): Promise<OpenAIStreamToolCallRecovery>;
}

interface ClaudeStreamTelemetryDeps {
  readUsage(usage: unknown): StreamTokenUsage;
  getMetadataString(metadata: unknown, key: string): string;
  extractRecentToolNames(messages: Array<{ role: string; content: unknown }>): string[];
  inferVerificationSteps(toolNames: string[]): string[];
  countMessageRoles(messages: Array<{ role: string; content: unknown }>): MessageRoleCounts;
  pushDiagnostic(diagnostic: Record<string, unknown>): void;
  persistDecisionTelemetry(input: DecisionTelemetryPayload): void;
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
}

interface ClaudeStreamProviderDeps {
  streamText(options: unknown): ClaudeStreamRouteStartedStream;
  clampMaxOutputTokens(tokens: number): number;
  computePrefixFingerprint(messages: Array<{ role: string; content: unknown }>): string | undefined;
  captureRequestForensics(
    sessionKey: string,
    requestId: string,
    path: string,
    providerModel: string,
    stream: boolean,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[] | undefined,
    toolChoice: unknown,
    providerOptions: unknown,
    phasePolicy?: RequestForensicsRecord["phasePolicy"],
    capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"],
  ): RequestForensicsBuildResult | null;
  finalizeRequestForensics(
    session: ClaudeStreamSession,
    requestId: string,
    forensics: RequestForensicsBuildResult | null | undefined,
    usage: StreamTokenUsage,
  ): RequestForensicsRecord | undefined;
  extractUpstreamErrorDiagnostics(error: unknown): OpenAIStreamUpstreamErrorDiagnostics;
  getTierConfig(modelId: string): { baseUrl?: string; backendModel?: string } | undefined;
}

interface ClaudeStreamFinalizerDeps {
  applyMarkdownGuardrail(text: string, mode: string): string;
  finalizeCompletionText(input: {
    requestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
    assistantText: string;
    checklist: RequirementChecklistShape | null;
    traceRootPrompt: string;
    latestUserPrompt: string;
    verification: unknown;
    recentToolNames: string[];
    nonActionableEventDetail: string;
    planGraph?: unknown;
    session?: ClaudeStreamSession | null;
  }): Promise<OpenAIStreamFinalizerTextResult>;
  finalizePostStreamText(input: {
    requestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
    assistantText: string;
    applyGate: boolean;
    checklist: RequirementChecklistShape | null;
    traceRootPrompt: string;
    latestUserPrompt: string;
    verification: unknown;
    toolStopReason: boolean;
    nonActionableEventDetail: string;
    planGraph?: unknown;
  }): OpenAIStreamFinalizerTextResult;
}

export interface ClaudeStreamRouteInput {
  reply: FastifyReply;
  runtime: RouteRuntimeDeps;
  infrastructure: StreamInfrastructureDeps;
  logger: RouteLogger;
  body: ClaudeMessagesRequest;
  session: ClaudeStreamSession;
  sessionKey: string;
  userId: string;
  orgId: string;
  traceRequestId: string;
  responseRequestId: string;
  resolvedModelId: string;
  model: unknown;
  adapter: ModelAdapter;
  messages: ClaudeStreamProviderMessage[];
  recentMessages: Array<{ role: string; content: unknown }>;
  normalizedMessages: Array<{ role: string }>;
  pathContext: SessionPathHints;
  clientKind: string;
  debugProtocol: boolean;
  strictGovernance: boolean;
  upperHarness?: YarnUpperHarnessContext;
  taskCue: unknown;
  clientPlanModeRequested: boolean;
  sensemakingRestrictDiscovery?: boolean;
  enforcePathRoot: boolean;
  blockBashPathDrift: boolean;
  pathSandboxEnabled: boolean;
  artifactShadows: GovernToolCallOptions["artifactShadows"];
  recentCalls: Array<{ toolName: string }>;
  requirementChecklist?: RequirementChecklistShape | null;
  verificationAssessment: unknown;
  planGraph: unknown;
  responseStyleMode: string;
  orchestration: OrchestratorDecision;
  samplingOptions?: Record<string, unknown>;
  stopSequences?: unknown;
  sdkTools?: unknown;
  effectiveTools: unknown[];
  toolChoice?: unknown;
  providerOptions?: unknown;
  forensicsPhasePolicy?: RequestForensicsRecord["phasePolicy"];
  forensicsCapabilityMatrix?: RequestForensicsRecord["capabilityMatrix"];
  prefetchResult?: FastPathResult;
  patternResult?: PatternPrefetchResult;
  evidencePrefetched?: boolean;
  evidenceConfidence?: number;
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
  governorDecision?: ExecutionGovernorDecision;
  governorChatStateSummary?: Record<string, unknown>;
  governorFileStateSummary?: Record<string, unknown>;
  trajectoryDiagnostics?: Record<string, unknown>;
  toolResultReduction: StreamTelemetryReductions["toolResultReduction"];
  validationNormalization: StreamTelemetryReductions["validationNormalization"];
  toolResultCount: number;
  policyMatchedRules: string[];
  promptProfileIds?: number[];
  promptProfileHashes?: string[];
  prefixHash?: string;
  prefixChangeReasons?: string[];
  contextAdmission: {
    decision: "allow" | "warn" | "reject";
    reason?: string;
    estimatedTokens: number;
    estimatedChars: number;
  };
  onProviderComplete?(): void;
  getStageTimingsMs?(): Record<string, number>;
  artifactToolInjected: boolean;
  knowledgeToolInjected: boolean;
  transport: {
    heartbeatIntervalMs: number;
    longWaitEventMs: number;
    hardTimeoutMs: number;
  };
  provider: ClaudeStreamProviderDeps;
  tools: ClaudeStreamToolDeps;
  sideEffects: RouteToolSideEffectDeps;
  telemetry: ClaudeStreamTelemetryDeps;
  finalizer: ClaudeStreamFinalizerDeps;
}

export type ClaudeStreamRouteResult =
  | { kind: "started" }
  | { kind: "rejected"; retryAfter: string; statusCode: number; payload: unknown };

export async function runClaudeStreamRoute(input: ClaudeStreamRouteInput): Promise<ClaudeStreamRouteResult> {
  const context = createClaudeStreamRouteContext({
    sessionKey: input.sessionKey,
    userId: input.userId,
    orgId: input.orgId,
    traceRequestId: input.traceRequestId,
    responseRequestId: input.responseRequestId,
    resolvedModelId: input.resolvedModelId,
    projectRoot: input.pathContext.projectRoot,
  });
  const prepared = await prepareClaudeStreamRoute({
    gates: {
      scope: context.streamScope,
      resolvedModelId: context.resolvedModelId,
      logger: input.logger,
      streamAdmission: input.infrastructure.streamAdmission,
      circuitBreakers: input.infrastructure.circuitBreakers,
      recordSessionEvent: input.telemetry.recordSessionEvent,
      startSpan: (name, attributes) => input.runtime.getTracer().startSpan(name, attributes),
    },
    runtime: {
      requestIds: context.requestIds,
      resolvedModelId: context.resolvedModelId,
      messages: input.messages,
      tools: input.effectiveTools,
      toolChoice: input.toolChoice,
      providerOptions: input.providerOptions,
      phasePolicy: input.forensicsPhasePolicy,
      capabilityMatrix: input.forensicsCapabilityMatrix,
      captureRequestForensics: input.provider.captureRequestForensics,
      sideEffects: {
        session: input.session,
        clientKind: input.clientKind,
        logger: input.logger,
        strictGovernanceStats: input.sideEffects.strictGovernanceStats,
        updateDiffAccumulator: input.sideEffects.updateDiffAccumulator,
        maybeUpdateTaskLedgerFromToolCall: input.sideEffects.maybeUpdateTaskLedgerFromToolCall,
        emitPlanWriteAuditEvent: input.sideEffects.emitPlanWriteAuditEvent,
        maybeLogEnvelopeUnwrapSample: input.sideEffects.maybeLogEnvelopeUnwrapSample,
        recordUpperHarnessDecision: input.sideEffects.recordUpperHarnessDecision,
      },
      abort: {
        longWaitEventMs: input.transport.longWaitEventMs,
        hardTimeoutMs: input.transport.hardTimeoutMs,
      },
    },
  });
  if (!prepared.ok) {
    return {
      kind: "rejected",
      retryAfter: prepared.rejection.retryAfter,
      statusCode: prepared.rejection.statusCode,
      payload: prepared.rejection.payload,
    };
  }

  const runtime = prepared.runtime;
  const streamForensics = runtime.streamForensics;
  const recordStreamEvent = runtime.recordStreamEvent;
  const streamToolSideEffects = runtime.streamToolSideEffects;
  const resolvedTier = input.provider.getTierConfig(context.resolvedModelId);

  await runClaudeStreamRouteFromInput({
    runtime,
    start: {
      recordSessionEvent: input.telemetry.recordSessionEvent,
      transport: {
        raw: input.reply.raw,
        headers: input.runtime.sseHeadersWithClarification(input.session.record.metadata),
        heartbeatIntervalMs: input.transport.heartbeatIntervalMs,
        longWaitEventMs: input.transport.longWaitEventMs,
        startHeartbeat: input.runtime.startSseHeartbeat,
        createMessageId: () => `msg_${input.runtime.crypto.randomUUID()}`,
        sendSse: (event, data) => input.runtime.safeSse(input.reply, event, data),
        streamText: input.provider.streamText,
      },
      provider: {
        requestId: context.requestIds.traceRequestId,
        model: input.model,
        messages: input.messages,
        adapter: input.adapter,
        orchestrationMaxOutputTokens: input.orchestration.maxOutputTokens,
        requestMaxTokens: input.body.max_tokens,
        samplingOptions: input.samplingOptions,
        stopSequences: input.stopSequences,
        tools: input.sdkTools,
        toolChoice: input.toolChoice,
        providerOptions: input.providerOptions,
        clampMaxOutputTokens: input.provider.clampMaxOutputTokens,
        logger: input.logger,
      },
      components: {
        tierConfig: resolvedTier,
        resolvedModelId: context.resolvedModelId,
        tools: input.effectiveTools,
        computePrefixFingerprint: input.provider.computePrefixFingerprint,
      },
    },
    eventHandlers: {
      base: {
        adapter: input.adapter,
        requestId: context.requestIds.traceRequestId,
        clientKind: input.clientKind,
        debugProtocol: input.debugProtocol,
        strictGovernance: input.strictGovernance,
        upperHarness: input.upperHarness,
        taskCue: input.taskCue,
        clientPlanModeRequested: input.clientPlanModeRequested,
        sensemakingRestrictDiscovery: input.sensemakingRestrictDiscovery,
        pathContext: input.pathContext,
        enforcePathRoot: input.enforcePathRoot,
        blockBashPathDrift: input.blockBashPathDrift,
        pathSandboxEnabled: input.pathSandboxEnabled,
        artifactShadows: input.artifactShadows,
        session: input.session,
        stats: input.tools.stats,
        logger: input.logger,
        isWriteCapableToolName: input.tools.isWriteCapableToolName,
        shouldRestrictDiscoveryForPlanWork: input.tools.shouldRestrictDiscoveryForPlanWork,
        deserializePlanShadow: input.tools.deserializePlanShadow,
        buildPathSandboxPolicy: input.tools.buildPathSandboxPolicy,
        getTopLevelDirs: input.tools.getTopLevelDirs,
        applyDiscoveryGuardrail: input.tools.applyDiscoveryGuardrail,
      },
      toolSideEffects: streamToolSideEffects,
      recentCalls: input.recentCalls,
      normalizedMessages: input.normalizedMessages,
      route: context.eventRoute,
      recordBlockedDiscovery: input.tools.recordBlockedDiscovery,
      buildBlockedDiscoveryRecoverySnapshot: input.tools.buildBlockedDiscoveryRecoverySnapshot,
    },
    pipelineSupport: {
      lifecycle: {
        session: input.session,
        circuitBreakers: input.infrastructure.circuitBreakers,
        logger: input.logger,
        extractUpstreamErrorDiagnostics: input.provider.extractUpstreamErrorDiagnostics,
        recordSessionEvent: recordStreamEvent,
      },
      afterEvents: {
        adapter: input.adapter,
        stats: input.tools.stats,
        logger: input.logger,
        recordBlockedDiscovery: input.tools.recordBlockedDiscovery,
        getBlockedDiscoveryCount: input.tools.getBlockedDiscoveryCount,
        recordSessionEvent: input.telemetry.recordSessionEvent,
      },
    },
    completion: {
      scope: context.completionScope,
      metadata: {
        source: input.session.record.metadata,
        getString: input.telemetry.getMetadataString,
      },
      recentMessages: input.recentMessages,
      extractRecentToolNames: input.telemetry.extractRecentToolNames,
      checklist: input.requirementChecklist,
      finalizer: {
        session: input.session,
        readUsage: input.telemetry.readUsage,
        finalizeRequestForensics: (usage) => input.provider.finalizeRequestForensics(
          input.session,
          context.requestIds.responseRequestId,
          streamForensics,
          usage,
        ),
        handlerInput: {
          session: input.session,
          verification: input.verificationAssessment,
          planGraph: input.planGraph,
          responseStyleMode: input.responseStyleMode,
          applyMarkdownGuardrail: input.finalizer.applyMarkdownGuardrail,
          finalizeCompletionText: input.finalizer.finalizeCompletionText,
          finalizePostStreamText: input.finalizer.finalizePostStreamText,
        },
        endStream: () => input.runtime.safeEnd(input.reply.raw),
        recordSessionEvent: input.telemetry.recordSessionEvent,
      },
      telemetry: {
        clientRequestedModel: input.body.model,
        reductions: {
          toolResultReduction: input.toolResultReduction,
          validationNormalization: input.validationNormalization,
        },
        reducedToolResults: input.toolResultCount,
        orchestration: input.orchestration,
        policyMatchedRules: input.policyMatchedRules,
        evidencePrefetched: input.evidencePrefetched,
        evidenceConfidence: input.evidenceConfidence,
        evidenceAuthoritative: input.prefetchResult?.authoritative,
        evidencePrefetchLatencyMs: input.prefetchResult ? Math.round(input.prefetchResult.latencyMs) : undefined,
        evidenceQuality: buildEvidenceTraceSummary(input.prefetchResult, input.patternResult),
        sensemakingTriggered: input.sensemakingTriggered,
        sensemakingReason: input.sensemakingReason,
        governorDecision: input.governorDecision,
        governorChatStateSummary: input.governorChatStateSummary,
        governorFileStateSummary: input.governorFileStateSummary,
        normalizedMessages: input.recentMessages,
        inferVerificationSteps: input.telemetry.inferVerificationSteps,
        trajectoryDiagnostics: input.trajectoryDiagnostics,
        toolDefinitionCount: input.effectiveTools.length,
        artifactToolInjected: input.artifactToolInjected,
        knowledgeToolInjected: input.knowledgeToolInjected,
        promptProfileIds: input.promptProfileIds,
        promptProfileHashes: input.promptProfileHashes,
        prefixHash: input.prefixHash,
        prefixChangeReasons: input.prefixChangeReasons,
        contextAdmission: input.contextAdmission,
        getStageTimingsMs: input.getStageTimingsMs,
        countMessageRoles: input.telemetry.countMessageRoles,
        pushDiagnostic: input.telemetry.pushDiagnostic,
        recordSessionEvent: input.telemetry.recordSessionEvent,
        persistDecisionTelemetry: input.telemetry.persistDecisionTelemetry,
      },
    },
    onProviderComplete: input.onProviderComplete,
  });

  return { kind: "started" };
}
