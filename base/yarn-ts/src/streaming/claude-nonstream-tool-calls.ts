import {
  recordAdapterToolRepairObservations,
  recordGovernedToolHardeningStats,
  isGitInspectionChurnBlock,
  type ToolArgHardeningStats,
} from "../governance/tool-call-observability.js";
import {
  applyAdapterToolHardening,
  type AdapterToolHardeningResult,
  type AdapterToolHardeningOptions,
} from "../governance/tool-call-governor-service.js";
import {
  governToolCall,
  type GovernToolCallOptions,
  type GovernedToolCall,
  type PlanWriteAuditRecord,
} from "../path-governance/tool-call-governance.js";
import type { PathSandboxPolicy } from "../path-governance/path-sandbox.js";
import type { PlanContentShadow } from "../planning/plan-content-shadow.js";
import type { ModelAdapter } from "../providers/model-adapter.js";

export interface ClaudeNonStreamToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ClaudeNonStreamExternalToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ClaudeNonStreamToolCallInput {
  toolCalls: ClaudeNonStreamToolCall[];
  adapter: ModelAdapter;
  requestId: string;
  clientKind: string;
  strictGovernance: boolean;
  hardeningOptions?: Parameters<typeof applyAdapterToolHardening>[4];
  governanceOptions(index: number): Omit<GovernToolCallOptions, "toolName" | "input">;
  stats: ToolArgHardeningStats;
  logger: {
    warn(obj: Record<string, unknown>, msg?: string): void;
  };
  isWriteCapableToolName(name: string): boolean;
  onWriteCapableTool(): void;
  onGitInspectionChurnBlock(): void;
  onGovernedToolCall(governed: GovernedToolCall): void;
  onPlanWriteAudit(audit: PlanWriteAuditRecord): void;
  onEnvelopeUnwrapSample(toolName: string, governed: GovernedToolCall, toolCallId: string): void;
  onUpperHarnessDecision(decision: AdapterToolHardeningResult["upperHarnessDecision"]): void;
  onStrictGovernanceRewrites(count: number): void;
}

export interface ClaudeNonStreamRouteToolCallSession {
  blockBroadVerificationUntilEdit: boolean;
  blockFailingVerificationUntilEdit: boolean;
  gitInspectionBlockCount: number;
  artifactEditTurns: Map<string, number>;
  record: {
    requestCount: number;
    metadata: Record<string, unknown>;
  };
}

export interface ClaudeNonStreamPathContext {
  projectRoot?: string | null;
  shellCwd?: string | null;
}

export interface ClaudeNonStreamRouteToolCallInput {
  toolCalls: ClaudeNonStreamToolCall[];
  adapter: ModelAdapter;
  requestId: string;
  clientKind: string;
  strictGovernance: boolean;
  upperHarness?: AdapterToolHardeningOptions["upperHarness"];
  recentToolNames: string[];
  pathContext: ClaudeNonStreamPathContext;
  enforcePathRoot: boolean;
  blockBashPathDrift: boolean;
  pathSandboxEnabled: boolean;
  planModeRequested: boolean;
  session: ClaudeNonStreamRouteToolCallSession;
  restrictDiscoveryForPlanWork?: boolean;
  taskCue: unknown;
  normalizedMessageCount: number;
  artifactShadows?: GovernToolCallOptions["artifactShadows"];
  stats: ToolArgHardeningStats;
  logger: ClaudeNonStreamToolCallInput["logger"];
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
}

export function prepareClaudeNonStreamToolCalls(
  input: ClaudeNonStreamToolCallInput,
): ClaudeNonStreamExternalToolCall[] {
  return input.toolCalls.map((toolCall, toolCallIndex) => {
    const rawInput = toToolInputRecord(toolCall.input);
    const hard = applyAdapterToolHardening(
      input.adapter,
      toolCall.toolName,
      rawInput,
      undefined,
      input.hardeningOptions,
    );
    input.onUpperHarnessDecision(hard.upperHarnessDecision);
    recordAdapterToolRepairObservations({
      stats: input.stats,
      hardening: hard,
      logger: input.logger,
      requestId: input.requestId,
      originalToolName: toolCall.toolName,
      originalInput: rawInput,
    });

    if (input.isWriteCapableToolName(hard.toolName)) {
      input.onWriteCapableTool();
    }

    const governed = governToolCall({
      ...input.governanceOptions(toolCallIndex),
      toolName: hard.toolName,
      input: hard.input,
    });
    if (isGitInspectionChurnBlock(governed)) {
      input.onGitInspectionChurnBlock();
    }
    recordGovernedToolHardeningStats(input.stats, governed);
    input.onGovernedToolCall(governed);
    if (governed.planWriteAudit) {
      input.onPlanWriteAudit(governed.planWriteAudit);
    }
    input.onEnvelopeUnwrapSample(governed.toolName, governed, toolCall.toolCallId);

    if (governed.validationMissing.length > 0) {
      input.logger.warn(
        { reqId: input.requestId, toolName: governed.toolName, missing: governed.validationMissing },
        "tool_args_validation_failed",
      );
    }
    if (
      input.strictGovernance
      && input.isWriteCapableToolName(toolCall.toolName)
      && governed.toolName === "Bash"
    ) {
      input.onStrictGovernanceRewrites(1);
    }

    return {
      toolCallId: toolCall.toolCallId,
      toolName: governed.toolName,
      input: governed.input,
    };
  });
}

export function prepareClaudeNonStreamRouteToolCalls(
  input: ClaudeNonStreamRouteToolCallInput,
): ClaudeNonStreamExternalToolCall[] {
  const sandboxRoot = input.pathContext.projectRoot ?? input.pathContext.shellCwd;
  return prepareClaudeNonStreamToolCalls({
    toolCalls: input.toolCalls,
    adapter: input.adapter,
    requestId: input.requestId,
    clientKind: input.clientKind,
    strictGovernance: input.strictGovernance,
    hardeningOptions: {
      upperHarness: input.upperHarness,
      clientKind: input.clientKind,
      recentToolNames: input.recentToolNames,
    },
    governanceOptions: (toolCallIndex) => ({
      projectRoot: input.pathContext.projectRoot,
      shellCwd: input.pathContext.shellCwd,
      enforcePathRoot: input.enforcePathRoot,
      blockBashPathDrift: input.blockBashPathDrift,
      strictBashBlock: input.strictGovernance,
      blockWriteCapableTools: input.strictGovernance || input.planModeRequested,
      clientKind: input.clientKind,
      sessionGitInspectionBlockCount: input.session.gitInspectionBlockCount,
      restrictDiscoveryForPlanWork: input.restrictDiscoveryForPlanWork
        ?? input.shouldRestrictDiscoveryForPlanWork(input.taskCue),
      blockBroadVerificationForGreen: input.session.blockBroadVerificationUntilEdit,
      blockVerificationForFailure: input.session.blockFailingVerificationUntilEdit,
      planContentShadow: input.deserializePlanShadow(input.session.record.metadata.plan_content_shadow),
      artifactShadows: input.artifactShadows,
      currentTurnIndex: input.normalizedMessageCount + toolCallIndex + 1,
      onEditTurn: (canonicalPath, turnIndex) => {
        input.session.artifactEditTurns.set(canonicalPath, turnIndex);
      },
      pathSandboxPolicy: input.pathSandboxEnabled && sandboxRoot
        ? input.buildPathSandboxPolicy(sandboxRoot)
        : null,
    }),
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
  });
}

function toToolInputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}
