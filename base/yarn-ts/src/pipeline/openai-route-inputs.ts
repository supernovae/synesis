import { resolveWorkspaceRootForCollapse } from "../adapters/session-execution-context.js";
import type { DedupeLayer } from "../dedupe/DedupeLayer.js";
import type { PathSandboxPolicy } from "../path-governance/path-sandbox.js";
import type { GovernToolCallOptions } from "../path-governance/tool-call-governance.js";
import type { PlanContentShadow } from "../planning/plan-content-shadow.js";
import type { ModelAdapter } from "../providers/model-adapter.js";
import type { OpenAIStreamFinalizerTextResult } from "../streaming/openai-stream-finalizer.js";
import type { StreamTelemetryRouteBaseInput } from "../streaming/stream-telemetry-route-base.js";
import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import type { ToolPrefixCache } from "../tool-prefix-cache/ToolPrefixCache.js";
import type { GuardrailToolCall } from "../tools/tool-call-availability.js";
import type { ToolArgHardeningStats } from "../governance/tool-call-observability.js";
import type { YarnUpperHarnessContext } from "../upper-harness/bridge.js";
import type {
  OpenAINonStreamDiscoveryGuardrailPassInput,
  OpenAINonStreamDiscoveryRecovery,
} from "./openai-nonstream-discovery-guardrails.js";
import type { OpenAINonStreamToolCallLogger, OpenAINonStreamToolCallPathContext } from "./openai-nonstream-tool-calls.js";
import type {
  OpenAINonStreamToolCollapseInput,
  OpenAINonStreamToolCollapseLogger,
} from "./openai-nonstream-tool-collapse.js";

type RuntimeTelemetryFields = "scope" | "startedAtMs" | "resolvedModelId";

export type OpenAIChatRouteTelemetryBase = Omit<StreamTelemetryRouteBaseInput, RuntimeTelemetryFields>;

export function createOpenAIChatRouteTelemetryBase(
  input: OpenAIChatRouteTelemetryBase,
): OpenAIChatRouteTelemetryBase {
  return {
    clientRequestedModel: input.clientRequestedModel,
    reductions: input.reductions,
    reducedToolResults: input.reducedToolResults,
    orchestration: input.orchestration,
    policyMatchedRules: input.policyMatchedRules,
    evidencePrefetched: input.evidencePrefetched,
    evidenceConfidence: input.evidenceConfidence,
    evidenceAuthoritative: input.evidenceAuthoritative,
    evidencePrefetchLatencyMs: input.evidencePrefetchLatencyMs,
    evidenceQuality: input.evidenceQuality,
    sensemakingTriggered: input.sensemakingTriggered,
    sensemakingReason: input.sensemakingReason,
    governorDecision: input.governorDecision,
    governorChatStateSummary: input.governorChatStateSummary,
    governorFileStateSummary: input.governorFileStateSummary,
    normalizedMessages: input.normalizedMessages,
    inferVerificationSteps: input.inferVerificationSteps,
    trajectoryDiagnostics: input.trajectoryDiagnostics,
    toolDefinitionCount: input.toolDefinitionCount,
    artifactToolInjected: input.artifactToolInjected,
    knowledgeToolInjected: input.knowledgeToolInjected,
    promptProfileIds: input.promptProfileIds,
    promptProfileHashes: input.promptProfileHashes,
    prefixHash: input.prefixHash,
    prefixChangeReasons: input.prefixChangeReasons,
    requirementChecklistMust: input.requirementChecklistMust,
    requirementChecklistShould: input.requirementChecklistShould,
    contextAdmission: input.contextAdmission,
    cacheShapeDiagnostics: input.cacheShapeDiagnostics,
    countMessageRoles: input.countMessageRoles,
    pushDiagnostic: input.pushDiagnostic,
  };
}

export interface OpenAIChatRouteFinalizerBaseInput<TSession, TChecklist, TVerification, TPlanGraph> {
  session: TSession;
  checklist: TChecklist | null;
  traceRootPrompt: string;
  latestUserPrompt: string;
  verification: TVerification;
  recentToolNames: string[];
  planGraph?: TPlanGraph | null;
  responseStyleMode: string;
  applyMarkdownGuardrail(text: string, mode: string): string;
  finalizeCompletionText(input: {
    requestId: string;
    sessionKey: string;
    userId: string;
    orgId: string;
    assistantText: string;
    checklist: TChecklist | null;
    traceRootPrompt: string;
    latestUserPrompt: string;
    verification: TVerification;
    recentToolNames: string[];
    nonActionableEventDetail: string;
    planGraph?: TPlanGraph | null;
    session?: TSession | null;
  }): Promise<OpenAIStreamFinalizerTextResult>;
}

export type OpenAIChatRouteFinalizerBase<TSession, TChecklist, TVerification, TPlanGraph> =
  OpenAIChatRouteFinalizerBaseInput<TSession, TChecklist, TVerification, TPlanGraph>;

export function createOpenAIChatRouteFinalizerBase<TSession, TChecklist, TVerification, TPlanGraph>(
  input: OpenAIChatRouteFinalizerBaseInput<TSession, TChecklist, TVerification, TPlanGraph>,
): OpenAIChatRouteFinalizerBase<TSession, TChecklist, TVerification, TPlanGraph> {
  return {
    session: input.session,
    checklist: input.checklist,
    traceRootPrompt: input.traceRootPrompt,
    latestUserPrompt: input.latestUserPrompt,
    verification: input.verification,
    recentToolNames: input.recentToolNames,
    planGraph: input.planGraph,
    responseStyleMode: input.responseStyleMode,
    applyMarkdownGuardrail: input.applyMarkdownGuardrail,
    finalizeCompletionText: input.finalizeCompletionText,
  };
}

export interface OpenAIChatRouteToolHandlingBaseInput<TSession> {
  adapter: ModelAdapter;
  clientKind: string;
  effectiveTools: unknown[];
  strictGovernance: boolean;
  upperHarness?: YarnUpperHarnessContext;
  recentToolNames: string[];
  taskCue: unknown;
  planModeRequested: boolean;
  sensemakingRestrictDiscovery?: boolean;
  pathContext: OpenAINonStreamToolCallPathContext;
  enforcePathRoot: boolean;
  blockBashPathDrift: boolean;
  pathSandboxEnabled: boolean;
  artifactShadows: GovernToolCallOptions["artifactShadows"];
  normalizedMessageCount: number;
  session: TSession;
  stats: ToolArgHardeningStats;
  logger: OpenAINonStreamToolCallLogger;
  isWriteCapableToolName(name: string): boolean;
  shouldRestrictDiscoveryForPlanWork(taskCue: unknown): boolean;
  deserializePlanShadow(data: unknown): PlanContentShadow | null;
  buildPathSandboxPolicy(root: string): PathSandboxPolicy;
}

export type OpenAIChatRouteToolHandlingBase<TSession> = OpenAIChatRouteToolHandlingBaseInput<TSession>;

export function createOpenAIChatRouteToolHandlingBase<TSession>(
  input: OpenAIChatRouteToolHandlingBaseInput<TSession>,
): OpenAIChatRouteToolHandlingBase<TSession> {
  return {
    adapter: input.adapter,
    clientKind: input.clientKind,
    effectiveTools: input.effectiveTools,
    strictGovernance: input.strictGovernance,
    upperHarness: input.upperHarness,
    recentToolNames: input.recentToolNames,
    taskCue: input.taskCue,
    planModeRequested: input.planModeRequested,
    sensemakingRestrictDiscovery: input.sensemakingRestrictDiscovery,
    pathContext: input.pathContext,
    enforcePathRoot: input.enforcePathRoot,
    blockBashPathDrift: input.blockBashPathDrift,
    pathSandboxEnabled: input.pathSandboxEnabled,
    artifactShadows: input.artifactShadows,
    normalizedMessageCount: input.normalizedMessageCount,
    session: input.session,
    stats: input.stats,
    logger: input.logger,
    isWriteCapableToolName: input.isWriteCapableToolName,
    shouldRestrictDiscoveryForPlanWork: input.shouldRestrictDiscoveryForPlanWork,
    deserializePlanShadow: input.deserializePlanShadow,
    buildPathSandboxPolicy: input.buildPathSandboxPolicy,
  };
}

export interface OpenAINonStreamDiscoveryRouteInput {
  projectRoot?: string | null;
  buildBlockedDiscoveryRecovery(
    resolvedModelId: string,
    blockedDetails: BlockedDiscoveryDetail[],
    projectRoot: string | null | undefined,
  ): Promise<OpenAINonStreamDiscoveryRecovery>;
  recordBlockedDiscovery(sessionKey: string, count: number): number;
  getBlockedDiscoveryCount(sessionKey: string): number;
}

export function createOpenAINonStreamDiscoveryRouteInput(
  input: OpenAINonStreamDiscoveryRouteInput,
): Omit<
  OpenAINonStreamDiscoveryGuardrailPassInput<GuardrailToolCall>,
  "calls" | "finalText" | "guardrail" | "recordRecoveryEvent" | "sessionKey" | "userId" | "orgId" | "requestId" | "resolvedModelId" | "recordSessionEvent"
> {
  return {
    projectRoot: input.projectRoot,
    buildBlockedDiscoveryRecovery: input.buildBlockedDiscoveryRecovery,
    recordBlockedDiscovery: input.recordBlockedDiscovery,
    getBlockedDiscoveryCount: input.getBlockedDiscoveryCount,
  };
}

export interface OpenAINonStreamCollapseRouteInput {
  enabled: boolean;
  rewriteNonStream: boolean;
  collapseHeader: unknown;
  headers: Record<string, string | string[] | undefined>;
  bodyMetadata: Record<string, unknown> | null;
  shellAllowlistEnv: string;
  dedupeLayer?: DedupeLayer | null;
  toolPrefixCache?: ToolPrefixCache | null;
  logger: OpenAINonStreamToolCollapseLogger;
  requestId: string;
}

export function createOpenAINonStreamCollapseRouteInput(
  input: OpenAINonStreamCollapseRouteInput,
): Omit<OpenAINonStreamToolCollapseInput, "calls"> {
  return {
    enabled: input.enabled,
    rewriteNonStream: input.rewriteNonStream,
    collapseHeader: input.collapseHeader,
    workspaceRoot: resolveWorkspaceRootForCollapse(input.headers, input.bodyMetadata),
    shellAllowlistEnv: input.shellAllowlistEnv,
    dedupeLayer: input.dedupeLayer,
    toolPrefixCache: input.toolPrefixCache,
    logger: input.logger,
    requestId: input.requestId,
  };
}
