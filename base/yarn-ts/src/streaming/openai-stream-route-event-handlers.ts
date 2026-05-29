import type { PathSandboxPolicy } from "../path-governance/path-sandbox.js";
import type { GovernToolCallOptions, GovernedToolCall, PlanWriteAuditRecord } from "../path-governance/tool-call-governance.js";
import type { ModelAdapter } from "../providers/model-adapter.js";
import type { PlanContentShadow } from "../planning/plan-content-shadow.js";
import type { YarnUpperHarnessContext } from "../upper-harness/bridge.js";
import type { AdapterToolHardeningResult } from "../governance/tool-call-governor-service.js";
import type { ToolArgHardeningStats } from "../governance/tool-call-observability.js";
import { mergePathContextWithSessionMetadata } from "../session/session-path-context.js";
import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import {
  buildOfferedToolNameSet,
  findOfferedToolNameByCanonical,
  listOfferedToolNames,
  type GuardrailToolCall,
} from "../tools/tool-call-availability.js";
import { createOpenAIStreamEventHandlers } from "./openai-stream-event-handlers.js";
import type { OpenAIStreamEventHandlers } from "./openai-stream-event-runner.js";
import type { OpenAIStreamResponseWriter } from "./openai-stream-response-writer.js";
import type { OpenAIStreamState } from "./openai-stream-state.js";
import type {
  OpenAIStreamDiscoveryGuardrailResult,
  OpenAIStreamToolCallAccumulator,
  OpenAIStreamToolCallRecovery,
} from "./openai-stream-tool-call-handler.js";

export interface OpenAIStreamRouteEventSession {
  gitInspectionBlockCount: number;
  blockBroadVerificationUntilEdit: boolean;
  blockFailingVerificationUntilEdit: boolean;
  artifactEditTurns: Map<string, number>;
  record: {
    requestCount: number;
    metadata: {
      plan_content_shadow?: unknown;
    } & Record<string, unknown>;
  };
}

export interface OpenAIStreamRouteEventPathContext {
  projectRoot?: string | null;
  shellCwd?: string | null;
}

export interface OpenAIStreamRouteEventHandlerInput {
  streamState: OpenAIStreamState;
  writer: OpenAIStreamResponseWriter;
  adapter: ModelAdapter;
  requestId: string;
  resolvedModelId: string;
  clientKind: string;
  effectiveTools: unknown[];
  debugProtocol: boolean;
  strictGovernance: boolean;
  upperHarness?: YarnUpperHarnessContext;
  recentToolNames: string[];
  taskCue: unknown;
  clientPlanModeRequested: boolean;
  sensemakingRestrictDiscovery?: boolean;
  pathContext: OpenAIStreamRouteEventPathContext;
  enforcePathRoot: boolean;
  blockBashPathDrift: boolean;
  pathSandboxEnabled: boolean;
  artifactShadows: GovernToolCallOptions["artifactShadows"];
  normalizedMessageCount: number;
  session: OpenAIStreamRouteEventSession;
  acceptedGuardrailCalls: GuardrailToolCall[];
  blockedDiscoveryDetails: BlockedDiscoveryDetail[];
  stats: ToolArgHardeningStats;
  logger: Parameters<typeof createOpenAIStreamEventHandlers>[0]["logger"];
  accumulator: OpenAIStreamToolCallAccumulator;
  scrubAndFlushText(text: string): void;
  isWriteCapableToolName(name: string): boolean;
  shouldRestrictDiscoveryForPlanWork(taskCue: unknown): boolean;
  deserializePlanShadow(data: unknown): PlanContentShadow | null;
  buildPathSandboxPolicy(root: string): PathSandboxPolicy;
  updateDiffAccumulator(governed: GovernedToolCall): void;
  maybeUpdateTaskLedgerFromToolCall(toolName: string, input: Record<string, unknown>, requestCount: number): void;
  emitPlanWriteAuditEvent(audit: PlanWriteAuditRecord): void;
  maybeLogEnvelopeUnwrapSample(toolName: string, governed: GovernedToolCall, toolCallId: string): void;
  recordUpperHarnessDecision(decision: AdapterToolHardeningResult["upperHarnessDecision"]): void;
  incrementStrictGovernanceRewrites(count: number): void;
  recordRedirectedDiscovery(count: number): void;
  getTopLevelDirs(root?: string | null): Promise<string[]>;
  applyDiscoveryGuardrail(calls: GuardrailToolCall[], topLevelDirs: string[]): OpenAIStreamDiscoveryGuardrailResult;
  buildBlockedDiscoveryRecovery(blockedDetails: BlockedDiscoveryDetail[]): Promise<OpenAIStreamToolCallRecovery>;
}

export function createOpenAIStreamRouteEventHandlers(
  input: OpenAIStreamRouteEventHandlerInput,
): OpenAIStreamEventHandlers {
  const pathContext = mergePathContextWithSessionMetadata(input.pathContext, input.session);
  const effectiveRoot = pathContext.projectRoot ?? pathContext.shellCwd;
  return createOpenAIStreamEventHandlers({
    streamState: input.streamState,
    writer: input.writer,
    adapter: input.adapter,
    requestId: input.requestId,
    clientKind: input.clientKind,
    effectiveTools: input.effectiveTools,
    debugProtocol: input.debugProtocol,
    strictGovernance: input.strictGovernance,
    upperHarness: input.upperHarness,
    recentToolNames: input.recentToolNames,
    governanceOptions: () => buildOpenAIStreamRouteGovernanceOptions({ ...input, pathContext }),
    availability: {
      offeredToolSet: buildOfferedToolNameSet(input.effectiveTools),
      offeredToolNames: listOfferedToolNames(input.effectiveTools),
      fallbackBashToolName: findOfferedToolNameByCanonical(input.effectiveTools, "Bash"),
    },
    acceptedGuardrailCalls: input.acceptedGuardrailCalls,
    blockedDiscoveryDetails: input.blockedDiscoveryDetails,
    stats: input.stats,
    logger: input.logger,
    accumulator: input.accumulator,
    scrubAndFlushText: input.scrubAndFlushText,
    isWriteCapableToolName: input.isWriteCapableToolName,
    onWriteCapableTool: () => {
      input.session.blockBroadVerificationUntilEdit = false;
      input.session.blockFailingVerificationUntilEdit = false;
    },
    onGitInspectionChurnBlock: () => {
      input.session.gitInspectionBlockCount += 1;
    },
    onGovernedToolCall: (governed) => {
      input.updateDiffAccumulator(governed);
      input.maybeUpdateTaskLedgerFromToolCall(
        governed.toolName,
        governed.input,
        input.session.record.requestCount,
      );
    },
    onPlanWriteAudit: input.emitPlanWriteAuditEvent,
    onEnvelopeUnwrapSample: input.maybeLogEnvelopeUnwrapSample,
    onUpperHarnessDecision: input.recordUpperHarnessDecision,
    onStrictGovernanceRewrites: input.incrementStrictGovernanceRewrites,
    onRedirectedDiscovery: input.recordRedirectedDiscovery,
    getTopLevelDirs: () => input.getTopLevelDirs(effectiveRoot),
    applyDiscoveryGuardrail: input.applyDiscoveryGuardrail,
    buildBlockedDiscoveryRecovery: input.buildBlockedDiscoveryRecovery,
  });
}

export function buildOpenAIStreamRouteGovernanceOptions(
  input: OpenAIStreamRouteEventHandlerInput,
): Omit<GovernToolCallOptions, "toolName" | "input"> {
  const pathContext = mergePathContextWithSessionMetadata(input.pathContext, input.session);
  const effectiveRoot = pathContext.projectRoot ?? pathContext.shellCwd;
  return {
    projectRoot: pathContext.projectRoot,
    shellCwd: pathContext.shellCwd,
    enforcePathRoot: input.enforcePathRoot,
    blockBashPathDrift: input.blockBashPathDrift,
    strictBashBlock: input.strictGovernance,
    blockWriteCapableTools: input.strictGovernance || input.clientPlanModeRequested,
    clientKind: input.clientKind,
    sessionGitInspectionBlockCount: input.session.gitInspectionBlockCount,
    restrictDiscoveryForPlanWork: input.sensemakingRestrictDiscovery
      ?? input.shouldRestrictDiscoveryForPlanWork(input.taskCue),
    blockBroadVerificationForGreen: input.session.blockBroadVerificationUntilEdit,
    blockVerificationForFailure: input.session.blockFailingVerificationUntilEdit,
    planContentShadow: input.deserializePlanShadow(input.session.record.metadata.plan_content_shadow),
    artifactShadows: input.artifactShadows,
    currentTurnIndex: input.normalizedMessageCount + input.streamState.nextToolCallIndex() + 1,
    onEditTurn: (canonicalPath, turnIndex) => {
      input.session.artifactEditTurns.set(canonicalPath, turnIndex);
    },
    pathSandboxPolicy: input.pathSandboxEnabled && effectiveRoot
      ? input.buildPathSandboxPolicy(effectiveRoot)
      : null,
  };
}
