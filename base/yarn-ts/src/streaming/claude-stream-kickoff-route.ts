import type { FastifyReply, FastifyRequest } from "fastify";

import type { AuthUser } from "../auth.js";
import type { FastPathResult, PatternPrefetchResult } from "../evidence/fast-path.js";
import { buildEvidenceTraceSummary } from "../evidence/fast-path.js";
import type { ExecutionGovernorDecision, SessionPhase } from "../governance/execution-governor.js";
import type { PhaseExecutionPolicyDecision } from "../governance/phase-execution-policy.js";
import type { OrchestratorDecision } from "../orchestration/phase-model-orchestrator.js";
import type { MessageRoleCounts } from "../pipeline/context-admission.js";
import { isClaudeWebSearchToolName, toClaudeServerWebSearchEvent } from "../protocol/claude-messages-helpers.js";
import type { ClaudeMessagesRequest } from "../schemas.js";
import type { DecisionTelemetryPayload } from "../state/decision-telemetry-persister.js";
import { cacheShapeDiagnosticFields } from "../telemetry/cache-shape-diagnostics.js";
import type { OptimizationCacheDiagnostics } from "../telemetry/optimization-ledger.js";
import { buildDecisionSnapshot } from "../telemetry/decision-snapshot.js";
import type { RequestDiagnostic } from "../telemetry/request-diagnostics.js";
import type { RequestForensicsBuildResult, RequestForensicsRecord } from "../telemetry/request-forensics.js";
import {
  runClaudeStreamKickoffPipeline,
} from "./claude-stream-kickoff-pipeline.js";
import type {
  ClaudeNonStreamProviderMessage,
  ClaudeNonStreamProviderResultLike,
  ClaudeNonStreamProviderServerWebSearchContext,
  ClaudeNonStreamProviderToolCall,
} from "./claude-nonstream-provider-executor.js";
import type { StreamTokenUsage } from "./openai-stream-finalizer.js";
import type { StreamTelemetryReductions } from "./stream-telemetry-route-base.js";

interface KickoffSession {
  record: {
    metadata: Record<string, unknown>;
    conversationId?: string | null;
  };
  history: Array<{ role: string; content: unknown }>;
}

interface RouteLoggerDeps {
  crypto: { randomUUID(): string };
  safeEnd(raw: FastifyReply["raw"]): void;
  safeSse(reply: FastifyReply, event: string, data: unknown): boolean;
  sseHeadersWithClarification(metadata: Record<string, unknown>): Record<string, string>;
}

interface ServerWebSearchDeps {
  webSearch: {
    resolve(input: Record<string, unknown>, context: unknown): Promise<unknown>;
  };
  webSearchResolveContext(
    authUser: AuthUser,
    request: FastifyRequest,
    context: ClaudeNonStreamProviderServerWebSearchContext,
  ): unknown;
}

export interface ClaudeStreamKickoffRouteInput {
  request: FastifyRequest;
  reply: FastifyReply;
  authUser: AuthUser;
  runtime: RouteLoggerDeps;
  webSearch: ServerWebSearchDeps;
  body: ClaudeMessagesRequest;
  session: KickoffSession;
  sessionKey: string;
  userId: string;
  orgId: string;
  traceRequestId: string;
  responseRequestId: string;
  resolvedModelId: string;
  model: unknown;
  messages: ClaudeNonStreamProviderMessage[];
  orchestration: OrchestratorDecision;
  samplingOptions?: Record<string, unknown>;
  stopSequences?: unknown;
  sdkTools?: unknown;
  toolChoice?: unknown;
  providerOptions?: unknown;
  phasePolicy: PhaseExecutionPolicyDecision;
  governorPhase: SessionPhase;
  nativeWebSearchRequested: boolean;
  forceNonStreamKickoff: boolean;
  effectiveTools: unknown[];
  forensicsPhasePolicy?: RequestForensicsRecord["phasePolicy"];
  forensicsCapabilityMatrix?: RequestForensicsRecord["capabilityMatrix"];
  cacheShapeDiagnostics: OptimizationCacheDiagnostics;
  onProviderComplete?(): void;
  getStageTimingsMs?(): Record<string, number>;
  normalizedMessages: Array<{ role: string; content: unknown }>;
  toolResultCount: number;
  policyMatchedRules: string[];
  evidencePrefetched?: boolean;
  evidenceConfidence?: number;
  prefetchResult?: FastPathResult;
  patternResult?: PatternPrefetchResult;
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
  governorDecision?: ExecutionGovernorDecision;
  governorChatStateSummary?: Record<string, unknown>;
  governorFileStateSummary?: Record<string, unknown>;
  trajectoryDiagnostics?: Record<string, unknown>;
  artifactToolInjected: boolean;
  knowledgeToolInjected: boolean;
  toolResultReduction: StreamTelemetryReductions["toolResultReduction"];
  validationNormalization: StreamTelemetryReductions["validationNormalization"];
  clampMaxOutputTokens(tokens: number): number;
  generateText(options: Record<string, unknown>): Promise<ClaudeNonStreamProviderResultLike>;
  readUsage(usage: unknown): StreamTokenUsage;
  captureRequestForensics(
    sessionKey: string,
    requestId: string,
    path: string,
    resolvedModelId: string,
    stream: boolean,
    messages: Array<{ role: string; content: unknown }>,
    tools: unknown[],
    toolChoice: unknown,
    providerOptions: unknown,
    phasePolicy?: RequestForensicsRecord["phasePolicy"],
    capabilityMatrix?: RequestForensicsRecord["capabilityMatrix"],
  ): RequestForensicsBuildResult | null;
  finalizeRequestForensics(
    session: KickoffSession,
    requestId: string,
    forensics: RequestForensicsBuildResult | null,
    usage: StreamTokenUsage,
  ): RequestForensicsRecord | undefined;
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
  persistDecisionTelemetry(input: DecisionTelemetryPayload): void;
  inferVerificationSteps(toolNames: string[]): string[] | undefined;
  countMessageRoles(messages: Array<{ role: string; content: unknown }>): MessageRoleCounts;
  pushDiagnostic(diagnostic: RequestDiagnostic): void;
}

export async function runClaudeStreamKickoffRoute(input: ClaudeStreamKickoffRouteInput): Promise<void> {
  const started = Date.now();
  if (input.forceNonStreamKickoff) {
    input.recordSessionEvent(
      input.sessionKey,
      input.userId,
      input.orgId,
      "phase_non_stream_kickoff",
      "execution-governor",
      `Forcing non-stream kickoff turn in phase=${input.governorPhase} with tool_choice=required`,
      input.traceRequestId,
    );
  }

  const kickoffResult = await runClaudeStreamKickoffPipeline({
    model: input.resolvedModelId,
    headers: input.runtime.sseHeadersWithClarification(input.session.record.metadata),
    providerInput: {
      initialMessages: input.messages,
      model: input.model,
      resolvedModelId: input.resolvedModelId,
      orchestrationMaxOutputTokens: input.orchestration.maxOutputTokens,
      requestMaxTokens: input.body.max_tokens,
      samplingOptions: input.samplingOptions,
      stopSequences: input.stopSequences,
      tools: input.sdkTools,
      initialToolChoice: input.toolChoice,
      providerOptions: input.providerOptions,
      phasePolicy: input.phasePolicy,
      governorPhase: input.governorPhase,
      nativeWebSearchRequested: input.nativeWebSearchRequested,
      clampMaxOutputTokens: input.clampMaxOutputTokens,
      generateText: input.generateText,
      readUsage: input.readUsage,
      captureForensics: (messages, toolChoice) => input.captureRequestForensics(
        input.sessionKey,
        input.responseRequestId,
        "/v1/messages",
        input.resolvedModelId,
        false,
        messages as Array<{ role: string; content: unknown }>,
        input.effectiveTools,
        toolChoice,
        input.providerOptions,
        input.forensicsPhasePolicy,
        input.forensicsCapabilityMatrix,
      ),
      finalizeForensics: (forensics, usage) => input.finalizeRequestForensics(
        input.session,
        input.responseRequestId,
        forensics,
        usage,
      ),
      recordSessionEvent: (event) => input.recordSessionEvent(
        input.sessionKey,
        input.userId,
        input.orgId,
        event.eventKind,
        event.component,
        event.detail,
        input.traceRequestId,
        event.metadataJson,
      ),
      isServerWebSearchTool: isClaudeWebSearchToolName,
      resolveServerWebSearch: (serverInput) => input.webSearch.webSearch.resolve(
        serverInput,
        input.webSearch.webSearchResolveContext(input.authUser, input.request, {
          requestId: input.responseRequestId,
          sessionKey: input.sessionKey,
          conversationId: input.session.record.conversationId || undefined,
          traceId: input.responseRequestId,
          sourceSurface: "yarn_chat",
          toolName: "web_search",
        }),
      ),
      toServerWebSearchEvent: toClaudeServerWebSearchEvent,
    },
    response: {
      writeHead: (statusCode, headers) => input.reply.raw.writeHead(statusCode, headers),
      sendSse: (event, data) => input.runtime.safeSse(input.reply, event, data),
      end: () => input.runtime.safeEnd(input.reply.raw),
      createMessageId: () => `msg_${input.runtime.crypto.randomUUID()}`,
    },
    onAssistantText: (text) => {
      input.session.history.push({ role: "assistant", content: text });
    },
  });

  input.onProviderComplete?.();
  const usage = kickoffResult.usage;
  const stopReason = kickoffResult.stopReason;
  const externalCalls = kickoffResult.externalToolCalls;
  const requestForensicsDone = kickoffResult.requestForensicsDone;
  recordClaudeStreamKickoffTelemetry(input, {
    started,
    usage,
    stopReason,
    externalCalls,
    requestForensicsDone,
  });
}

interface KickoffTelemetryInput {
  started: number;
  usage: StreamTokenUsage;
  stopReason: string;
  externalCalls: ClaudeNonStreamProviderToolCall[];
  requestForensicsDone?: RequestForensicsRecord;
}

function recordClaudeStreamKickoffTelemetry(
  input: ClaudeStreamKickoffRouteInput,
  telemetry: KickoffTelemetryInput,
): void {
  const reduced = input.toolResultReduction.getPerRequestDelta()
    + input.validationNormalization.getPerRequestDelta();
  const verificationState = input.toolResultReduction.getVerificationTracker().getState();
  const recallDecision = input.toolResultReduction.getLastRecallDecision();
  const snapshot = buildDecisionSnapshot({
    orchestration: input.orchestration,
    recallDecision,
    verificationState,
    policyMatchedRules: input.policyMatchedRules,
    reducedToolResults: input.toolResultCount,
    tokensSavedByReduction: reduced,
    evidencePrefetched: input.evidencePrefetched,
    evidenceConfidence: input.evidenceConfidence,
    evidenceAuthoritative: input.prefetchResult?.authoritative,
    evidencePrefetchLatencyMs: input.prefetchResult ? Math.round(input.prefetchResult.latencyMs) : undefined,
    evidenceQuality: buildEvidenceTraceSummary(input.prefetchResult, input.patternResult),
    isStreaming: true,
    sensemakingTriggered: input.sensemakingTriggered,
    sensemakingReason: input.sensemakingReason,
    governorDecision: input.governorDecision,
    governorChatStateSummary: input.governorChatStateSummary,
    governorFileStateSummary: input.governorFileStateSummary,
  });

  input.persistDecisionTelemetry({
    usage: telemetry.usage,
    latencyMs: Date.now() - telemetry.started,
    finishReason: telemetry.stopReason,
    tokensSavedByReduction: reduced,
    escalated: input.orchestration.escalated,
    snapshot,
    trajectory: {
      toolSequence: telemetry.externalCalls.map((call) => call.toolName),
      verificationSteps: input.inferVerificationSteps(telemetry.externalCalls.map((call) => call.toolName)),
      diagnostics: input.trajectoryDiagnostics,
    },
  });

  input.pushDiagnostic({
    timestamp: Date.now(),
    sessionKey: input.sessionKey,
    path: "/v1/messages",
    requestId: input.responseRequestId,
    ...input.countMessageRoles(input.normalizedMessages),
    toolDefinitionCount: input.effectiveTools.length,
    artifactToolInjected: input.artifactToolInjected,
    knowledgeToolInjected: input.knowledgeToolInjected,
    reducedToolResults: input.toolResultCount,
    finishReason: telemetry.stopReason,
    tokensIn: telemetry.usage.inputTokens,
    tokensOut: telemetry.usage.outputTokens,
    policyDecision: input.policyMatchedRules.join(","),
    latencyMs: Date.now() - telemetry.started,
    decisionPath: input.orchestration.decisionPath,
    decisionEscalated: input.orchestration.escalated || undefined,
    requestForensicsSummary: telemetry.requestForensicsDone?.summary,
    requestForensicsLcpRatio: telemetry.requestForensicsDone?.lcpRatio,
    requestForensicsFirstChangedSection: telemetry.requestForensicsDone?.firstChangedSection,
    requestForensicsTokenEstimate: telemetry.requestForensicsDone?.tokenEstimate,
    stageTimingsMs: input.getStageTimingsMs?.(),
    ...cacheShapeDiagnosticFields(input.cacheShapeDiagnostics),
  });
}
