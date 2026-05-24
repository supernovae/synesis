import type { ToolArgHardeningStats } from "../governance/tool-call-observability.js";
import type { AdapterToolHardeningResult } from "../governance/tool-call-governor-service.js";
import type { GovernToolCallOptions, GovernedToolCall, PlanWriteAuditRecord } from "../path-governance/tool-call-governance.js";
import type { PathSandboxPolicy } from "../path-governance/path-sandbox.js";
import type { PlanContentShadow } from "../planning/plan-content-shadow.js";
import type { ModelAdapter } from "../providers/model-adapter.js";
import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import type { GuardrailToolCall } from "../tools/tool-call-availability.js";
import type { YarnUpperHarnessContext } from "../upper-harness/bridge.js";
import type { AiSdkStreamEvent } from "./ai-sdk-stream-events.js";
import type { ClaudeStreamDiscoveryState } from "./claude-stream-components.js";
import { handleClaudeStreamLocalEvent } from "./claude-stream-event-handlers.js";
import type { ClaudeStreamState } from "./claude-stream-state.js";
import {
  handleClaudeStreamToolCall,
  type ClaudeStreamToolCallEvent,
  type ClaudeStreamToolCallHandlerResult,
} from "./claude-stream-tool-call-handler.js";
import type {
  OpenAIStreamDiscoveryGuardrailResult,
  OpenAIStreamToolCallRecovery,
} from "./openai-stream-tool-call-handler.js";

type MaybePromise<T> = T | Promise<T>;

export interface ClaudeStreamRouteEventSession {
  gitInspectionBlockCount: number;
  blockBroadVerificationUntilEdit: boolean;
  blockFailingVerificationUntilEdit: boolean;
  artifactEditTurns: Map<string, number>;
  record: {
    requestCount: number;
    metadata: {
      plan_content_shadow?: unknown;
    };
  };
}

export interface ClaudeStreamRouteEventPathContext {
  projectRoot?: string | null;
  shellCwd?: string | null;
}

export interface ClaudeStreamRouteEventHandlerInput {
  streamState: ClaudeStreamState;
  adapter: ModelAdapter;
  requestId: string;
  clientKind: string;
  debugProtocol: boolean;
  strictGovernance: boolean;
  upperHarness?: YarnUpperHarnessContext;
  recentToolNames: string[];
  taskCue: unknown;
  clientPlanModeRequested: boolean;
  sensemakingRestrictDiscovery?: boolean;
  pathContext: ClaudeStreamRouteEventPathContext;
  enforcePathRoot: boolean;
  blockBashPathDrift: boolean;
  pathSandboxEnabled: boolean;
  artifactShadows: GovernToolCallOptions["artifactShadows"];
  normalizedMessageCount: number;
  session: ClaudeStreamRouteEventSession;
  acceptedGuardrailCalls: GuardrailToolCall[];
  blockedDiscoveryDetails: BlockedDiscoveryDetail[];
  discovery: ClaudeStreamDiscoveryState;
  toolSequence: string[];
  stats: ToolArgHardeningStats;
  logger: Parameters<typeof handleClaudeStreamToolCall>[0]["logger"];
  sendSse(event: string, data: unknown): boolean;
  scrubAndFlushTextBlock(text: string): void;
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

export interface ClaudeStreamRouteEventHandlers {
  handleLocalEvent(event: AiSdkStreamEvent): MaybePromise<boolean>;
  handleToolCall(event: ClaudeStreamToolCallEvent): Promise<ClaudeStreamToolCallHandlerResult>;
}

export function createClaudeStreamRouteEventHandlers(
  input: ClaudeStreamRouteEventHandlerInput,
): ClaudeStreamRouteEventHandlers {
  const effectiveRoot = input.pathContext.projectRoot ?? input.pathContext.shellCwd;
  return {
    handleLocalEvent: (event) => handleClaudeStreamLocalEvent(event, {
      streamState: input.streamState,
      sendSse: input.sendSse,
      scrubAndFlushTextBlock: input.scrubAndFlushTextBlock,
    }),
    handleToolCall: (event) => handleClaudeStreamToolCall({
      event,
      streamState: input.streamState,
      adapter: input.adapter,
      requestId: input.requestId,
      clientKind: input.clientKind,
      debugProtocol: input.debugProtocol,
      strictGovernance: input.strictGovernance,
      hardeningOptions: {
        upperHarness: input.upperHarness,
        clientKind: input.clientKind,
        recentToolNames: input.recentToolNames,
      },
      governanceOptions: buildClaudeStreamRouteGovernanceOptions(input),
      acceptedGuardrailCalls: input.acceptedGuardrailCalls,
      blockedDiscoveryDetails: input.blockedDiscoveryDetails,
      discovery: input.discovery,
      toolSequence: input.toolSequence,
      stats: input.stats,
      logger: input.logger,
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
      sendSse: input.sendSse,
    }),
  };
}

export function buildClaudeStreamRouteGovernanceOptions(
  input: ClaudeStreamRouteEventHandlerInput,
): Omit<GovernToolCallOptions, "toolName" | "input"> {
  const effectiveRoot = input.pathContext.projectRoot ?? input.pathContext.shellCwd;
  return {
    projectRoot: input.pathContext.projectRoot,
    shellCwd: input.pathContext.shellCwd,
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
    currentTurnIndex: input.normalizedMessageCount + input.streamState.pendingToolInputCount() + 1,
    onEditTurn: (canonicalPath, turnIndex) => {
      input.session.artifactEditTurns.set(canonicalPath, turnIndex);
    },
    pathSandboxPolicy: input.pathSandboxEnabled && effectiveRoot
      ? input.buildPathSandboxPolicy(effectiveRoot)
      : null,
  };
}
