import { buildEvidenceTraceSummary } from "../evidence/fast-path.js";
import { isClaudeWebSearchToolName, toClaudeServerWebSearchEvent } from "../protocol/claude-messages-helpers.js";
import type { ClaudeMessagesRequest } from "../schemas.js";
import type { SessionPathHints } from "../state/workspace-session-boundary.js";
import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import type { ToolArgHardeningStats } from "../governance/tool-call-observability.js";
import {
  createClaudeNonStreamRoutePipelineInput,
  runClaudeNonStreamPipeline,
} from "./claude-nonstream-pipeline.js";
import { buildClaudeNonStreamMessageResponse } from "./claude-nonstream-response.js";
import { createClaudeNonStreamRouteScope } from "./claude-nonstream-route-scope.js";
import { createRouteToolCallSideEffects } from "./route-tool-call-side-effects.js";
import type { StrictGovernanceRewriteStats } from "./route-tool-call-side-effects.js";
import type { OpenAIStreamLifecycleSpan } from "./openai-stream-lifecycle.js";
import type { StreamTokenUsage } from "./openai-stream-finalizer.js";

interface ClaudeNonStreamSession {
  record: {
    conversationId?: string | null;
    metadata: Record<string, unknown>;
    requestCount: number;
  };
  history: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  blockBroadVerificationUntilEdit: boolean;
  blockFailingVerificationUntilEdit: boolean;
  gitInspectionBlockCount: number;
  artifactEditTurns: Map<string, number>;
}

interface ClaudeNonStreamLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ClaudeNonStreamRouteInput {
  body: ClaudeMessagesRequest;
  session: ClaudeNonStreamSession;
  sessionKey: string;
  userId: string;
  orgId: string;
  requestId: string;
  resolvedModelId: string;
  model: unknown;
  adapter: unknown;
  messages: Array<{ role: string; content?: unknown }>;
  recentMessages: Array<{ role: string; content: unknown }>;
  normalizedMessages: Array<{ role: string }>;
  samplingOptions?: Record<string, unknown>;
  stopSequences?: unknown;
  sdkTools?: unknown;
  toolChoice?: unknown;
  providerOptions?: unknown;
  phasePolicy: unknown;
  governorPhase: unknown;
  nativeWebSearchRequested: boolean;
  effectiveTools: unknown[];
  forensicsPhasePolicy?: RequestForensicsRecord["phasePolicy"];
  forensicsCapabilityMatrix?: RequestForensicsRecord["capabilityMatrix"];
  pathContext: SessionPathHints;
  clientKind: string;
  strictGovernance: boolean;
  upperHarness?: unknown;
  recentCalls: Array<{ toolName: string }>;
  enforcePathRoot: boolean;
  blockBashPathDrift: boolean;
  pathSandboxEnabled: boolean;
  planModeRequested: boolean;
  restrictDiscoveryForPlanWork?: boolean;
  taskCue: unknown;
  artifactShadows?: unknown;
  requirementChecklist?: { must: unknown[]; should: unknown[] } | null;
  verificationAssessment: unknown;
  planGraph: unknown;
  responseStyleMode: string;
  orchestration: unknown;
  policyMatchedRules: string[];
  evidencePrefetched?: boolean;
  evidencePrefetchHit?: boolean;
  evidenceConfidence?: number;
  prefetchResult?: { matched?: boolean; confidence?: number; authoritative?: boolean; latencyMs: number; quality?: unknown };
  patternResult?: { quality?: unknown };
  sensemakingTriggered?: boolean;
  sensemakingReason?: string;
  governorDecision?: unknown;
  governorChatStateSummary?: Record<string, unknown>;
  governorFileStateSummary?: Record<string, unknown>;
  trajectoryDiagnostics?: Record<string, unknown>;
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
  cacheShapeDiagnostics?: unknown;
  toolResultReduction: unknown;
  validationNormalization: unknown;
  toolResultCount: number;
  artifactToolInjected: boolean;
  knowledgeToolInjected: boolean;
  logger: ClaudeNonStreamLogger;
  strictGovernanceStats: StrictGovernanceRewriteStats;
  toolArgHardeningStats: ToolArgHardeningStats;
  circuitBreakers: {
    allowRequest(modelId: string, orgId: string): boolean;
    recordFailure(modelId: string, orgId: string): void;
    recordSuccess(modelId: string, orgId: string): void;
  };
  getTracer(): {
    startSpan(name: string, attributes?: Record<string, string | number | boolean>): OpenAIStreamLifecycleSpan;
  };
  extractUpstreamErrorDiagnostics(error: unknown): unknown;
  clampMaxOutputTokens(tokens: number): number;
  generateText(options: Record<string, unknown>): Promise<{ text?: string; reasoning?: unknown; usage?: unknown; toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }> }>;
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
  ): unknown;
  finalizeRequestForensics(
    session: ClaudeNonStreamSession,
    requestId: string,
    forensics: { record: RequestForensicsRecord; serialized: string } | null,
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
  persistDecisionTelemetry(input: unknown): void;
  updateDiffAccumulator(session: ClaudeNonStreamSession, governed: unknown): void;
  maybeUpdateTaskLedgerFromToolCall(
    session: ClaudeNonStreamSession,
    toolName: string,
    toolInput: Record<string, unknown>,
    requestCount: number,
  ): void;
  emitPlanWriteAuditEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    audit: unknown,
  ): void;
  maybeLogEnvelopeUnwrapSample(
    logger: ClaudeNonStreamLogger,
    requestId: string,
    toolName: string,
    clientKind: string,
    governed: unknown,
    toolCallId?: string,
  ): void;
  recordUpperHarnessDecision(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    component: string,
    decision: unknown,
  ): void;
  isWriteCapableToolName(name: string): boolean;
  shouldRestrictDiscoveryForPlanWork(taskCue: unknown): boolean;
  deserializePlanShadow(data: unknown): unknown;
  buildPathSandboxPolicy(root: string): unknown;
  getTopLevelDirs(projectRoot: string | null | undefined): Promise<string[]>;
  applyDiscoveryGuardrail(calls: Array<{ toolName: string; input: Record<string, unknown> }>, topLevelDirs: string[]): unknown;
  buildBlockedDiscoveryRecovery(
    resolvedModelId: string,
    blockedDetails: unknown[],
    projectRoot?: string | null,
  ): Promise<unknown>;
  recordBlockedDiscovery(sessionKey: string, count: number): number;
  getBlockedDiscoveryCount(sessionKey: string): number;
  getMetadataString(metadata: Record<string, unknown>, key: string): string;
  extractRecentToolNames(messages: Array<{ role: string; content: unknown }>): string[];
  applyMarkdownGuardrail(text: string, mode: string): string;
  finalizeCompletionText(input: unknown): Promise<unknown>;
  inferVerificationSteps(toolNames: string[]): string[];
  countMessageRoles(messages: Array<{ role: string; content: unknown }>): {
    systemMessageCount: number;
    userMessageCount: number;
    toolMessageCount: number;
    totalInputChars: number;
  };
  pushDiagnostic(diagnostic: Record<string, unknown>): void;
  resolveServerWebSearch(input: Record<string, unknown>, context: {
    requestId: string;
    sessionKey: string;
    conversationId?: string;
    traceId: string;
    sourceSurface: "yarn_chat" | "yarn_mcp_http";
    toolName: string;
  }): Promise<unknown>;
  createMessageId(): string;
}

export type ClaudeNonStreamRouteResult =
  | { kind: "success"; body: unknown }
  | { kind: "error"; statusCode: number; headers?: Record<string, string>; body: unknown };

export async function runClaudeNonStreamRoute(input: ClaudeNonStreamRouteInput): Promise<ClaudeNonStreamRouteResult> {
  const started = Date.now();
  const scope = createClaudeNonStreamRouteScope({
    sessionKey: input.sessionKey,
    userId: input.userId,
    orgId: input.orgId,
    requestId: input.requestId,
    recordSessionEvent: input.recordSessionEvent,
    persistDecisionTelemetry: input.persistDecisionTelemetry as never,
  });
  const sideEffects = createRouteToolCallSideEffects({
    session: input.session,
    sessionKey: input.sessionKey,
    userId: input.userId,
    orgId: input.orgId,
    requestId: input.requestId,
    clientKind: input.clientKind,
    upperHarnessComponent: "upper-harness:claude",
    logger: input.logger,
    strictGovernanceStats: input.strictGovernanceStats,
    updateDiffAccumulator: input.updateDiffAccumulator as never,
    maybeUpdateTaskLedgerFromToolCall: input.maybeUpdateTaskLedgerFromToolCall,
    emitPlanWriteAuditEvent: input.emitPlanWriteAuditEvent as never,
    maybeLogEnvelopeUnwrapSample: input.maybeLogEnvelopeUnwrapSample as never,
    recordUpperHarnessDecision: input.recordUpperHarnessDecision as never,
  });
  const result = await runClaudeNonStreamPipeline(createClaudeNonStreamRoutePipelineInput({
    scope,
    resolvedModelId: input.resolvedModelId,
    circuitBreakers: input.circuitBreakers,
    logger: input.logger,
    startSpan: () => input.getTracer().startSpan("yarn.claude.generate", {
      model: input.resolvedModelId,
      sessionKey: input.sessionKey,
    }),
    extractUpstreamErrorDiagnostics: input.extractUpstreamErrorDiagnostics as never,
    providerRouteInput: {
      initialMessages: input.messages,
      model: input.model,
      resolvedModelId: input.resolvedModelId,
      orchestrationMaxOutputTokens: (input.orchestration as { maxOutputTokens: number }).maxOutputTokens,
      requestMaxTokens: input.body.max_tokens,
      samplingOptions: input.samplingOptions,
      stopSequences: input.stopSequences,
      tools: input.sdkTools,
      initialToolChoice: input.toolChoice,
      providerOptions: input.providerOptions,
      phasePolicy: input.phasePolicy as never,
      governorPhase: input.governorPhase as never,
      nativeWebSearchRequested: input.nativeWebSearchRequested,
      clampMaxOutputTokens: input.clampMaxOutputTokens,
      generateText: input.generateText,
      readUsage: input.readUsage,
      scope,
      forensics: {
        path: "/v1/messages",
        stream: false,
        tools: input.effectiveTools,
        phasePolicy: input.forensicsPhasePolicy,
        capabilityMatrix: input.forensicsCapabilityMatrix,
        capture: (context) => input.captureRequestForensics(
          context.sessionKey,
          context.requestId,
          context.path,
          context.resolvedModelId,
          context.stream,
          context.messages as Array<{ role: string; content: unknown }>,
          context.tools as unknown[],
          context.toolChoice,
          context.providerOptions,
          context.phasePolicy,
          context.capabilityMatrix,
        ),
        finalize: (forensics, forensicUsage, context) => input.finalizeRequestForensics(
          input.session,
          context.requestId,
          forensics as { record: RequestForensicsRecord; serialized: string } | null,
          forensicUsage,
        ),
      },
      isServerWebSearchTool: isClaudeWebSearchToolName,
      serverWebSearch: {
        conversationId: input.session.record.conversationId || undefined,
        sourceSurface: "yarn_chat",
        toolName: "web_search",
        resolve: input.resolveServerWebSearch,
      },
      toServerWebSearchEvent: toClaudeServerWebSearchEvent,
    },
    postprocessRouteInput: {
      readUsage: input.readUsage,
      scope,
      resolvedModelId: input.resolvedModelId,
      clientRequestedModel: input.body.model,
      toolCallInput: {
        adapter: input.adapter as never,
        clientKind: input.clientKind,
        strictGovernance: input.strictGovernance,
        upperHarness: input.upperHarness as never,
        recentToolNames: input.recentCalls.map((call) => call.toolName),
        pathContext: input.pathContext,
        enforcePathRoot: input.enforcePathRoot,
        blockBashPathDrift: input.blockBashPathDrift,
        pathSandboxEnabled: input.pathSandboxEnabled,
        planModeRequested: input.planModeRequested,
        session: input.session,
        restrictDiscoveryForPlanWork: input.restrictDiscoveryForPlanWork,
        taskCue: input.taskCue,
        normalizedMessageCount: input.normalizedMessages.length,
        artifactShadows: input.artifactShadows as never,
        stats: input.toolArgHardeningStats,
        logger: input.logger,
        isWriteCapableToolName: input.isWriteCapableToolName,
        shouldRestrictDiscoveryForPlanWork: input.shouldRestrictDiscoveryForPlanWork,
        deserializePlanShadow: input.deserializePlanShadow as never,
        buildPathSandboxPolicy: input.buildPathSandboxPolicy as never,
        ...sideEffects,
      },
      discoveryInput: {
        projectRoot: input.pathContext.projectRoot ?? input.pathContext.shellCwd,
        getTopLevelDirs: input.getTopLevelDirs,
        applyDiscoveryGuardrail: input.applyDiscoveryGuardrail as never,
        buildBlockedDiscoveryRecovery: input.buildBlockedDiscoveryRecovery as never,
        recordBlockedDiscovery: input.recordBlockedDiscovery,
        getBlockedDiscoveryCount: input.getBlockedDiscoveryCount,
        recordSessionEvent: input.recordSessionEvent,
      },
      finalizerInput: {
        session: input.session,
        checklist: input.requirementChecklist,
        traceRootPrompt: input.getMetadataString(input.session.record.metadata, "trace_root_prompt"),
        latestUserPrompt: input.getMetadataString(input.session.record.metadata, "latest_user_prompt"),
        verification: input.verificationAssessment,
        recentToolNames: input.extractRecentToolNames(input.recentMessages),
        planGraph: input.planGraph,
        responseStyleMode: input.responseStyleMode,
        applyMarkdownGuardrail: input.applyMarkdownGuardrail,
        finalizeCompletionText: input.finalizeCompletionText as never,
        recordSessionEvent: input.recordSessionEvent,
      },
      telemetryInput: {
        startedAtMs: started,
        reductions: {
          toolResultReduction: input.toolResultReduction as never,
          validationNormalization: input.validationNormalization as never,
        },
        reducedToolResults: input.toolResultCount,
        orchestration: input.orchestration as never,
        policyMatchedRules: input.policyMatchedRules,
        evidencePrefetched: input.evidencePrefetched,
        evidencePrefetchHit: input.evidencePrefetchHit,
        evidenceConfidence: input.evidenceConfidence,
        evidenceAuthoritative: input.prefetchResult?.authoritative,
        evidencePrefetchLatencyMs: input.prefetchResult ? Math.round(input.prefetchResult.latencyMs) : undefined,
        evidenceQuality: buildEvidenceTraceSummary(input.prefetchResult as never, input.patternResult as never),
        sensemakingTriggered: input.sensemakingTriggered,
        sensemakingReason: input.sensemakingReason,
        governorDecision: input.governorDecision as never,
        governorChatStateSummary: input.governorChatStateSummary,
        governorFileStateSummary: input.governorFileStateSummary,
        normalizedMessages: input.recentMessages,
        inferVerificationSteps: input.inferVerificationSteps,
        trajectoryDiagnostics: input.trajectoryDiagnostics,
        toolDefinitionCount: input.effectiveTools.length,
        artifactToolInjected: input.artifactToolInjected,
        knowledgeToolInjected: input.knowledgeToolInjected,
        promptProfileIds: input.promptProfileIds,
        promptProfileHashes: input.promptProfileHashes,
        prefixHash: input.prefixHash,
        prefixChangeReasons: input.prefixChangeReasons,
        requirementChecklistMust: input.requirementChecklist?.must.length || undefined,
        requirementChecklistShould: input.requirementChecklist?.should.length || undefined,
        contextAdmission: input.contextAdmission,
        cacheShapeDiagnostics: input.cacheShapeDiagnostics as never,
        countMessageRoles: input.countMessageRoles,
        pushDiagnostic: input.pushDiagnostic as never,
      },
    },
  }));
  if (result.kind === "error") {
    return {
      kind: "error",
      statusCode: result.statusCode,
      headers: result.headers,
      body: result.body,
    };
  }

  return {
    kind: "success",
    body: buildClaudeNonStreamMessageResponse({
      id: input.createMessageId(),
      model: input.resolvedModelId,
      content: result.processed.content,
      stopReason: result.processed.stopReason,
      usage: result.processed.usage,
    }),
  };
}
