import type { ModelAdapter } from "../providers/model-adapter.js";
import type { PlanContentShadow } from "../planning/plan-content-shadow.js";
import type { PathSandboxPolicy } from "../path-governance/path-sandbox.js";
import type { GovernToolCallOptions, GovernedToolCall, PlanWriteAuditRecord } from "../path-governance/tool-call-governance.js";
import type { YarnUpperHarnessContext } from "../upper-harness/bridge.js";
import {
  prepareGovernedToolCall,
  type AdapterToolHardeningResult,
} from "../governance/tool-call-governor-service.js";
import {
  isGitInspectionChurnBlock,
  recordAdapterToolRepairObservations,
  recordGovernedToolHardeningStats,
  type ToolArgHardeningStats,
} from "../governance/tool-call-observability.js";
import {
  buildOfferedToolNameSet,
  findOfferedToolNameByCanonical,
  listOfferedToolNames,
  type GuardrailToolCall,
} from "../tools/tool-call-availability.js";
import { mergePathContextWithSessionMetadata } from "../session/session-path-context.js";

export interface OpenAINonStreamToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface OpenAINonStreamToolCallSession {
  blockBroadVerificationUntilEdit: boolean;
  blockFailingVerificationUntilEdit: boolean;
  gitInspectionBlockCount: number;
  artifactEditTurns: Map<string, number>;
  record: {
    metadata: {
      plan_content_shadow?: unknown;
    } & Record<string, unknown>;
  };
}

export interface OpenAINonStreamToolCallPathContext {
  projectRoot?: string | null;
  shellCwd?: string | null;
}

export interface OpenAINonStreamToolCallLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
}

export interface OpenAINonStreamToolCallInput<TSession extends OpenAINonStreamToolCallSession> {
  toolCalls: OpenAINonStreamToolCall[];
  artifactToolName: string;
  adapter: ModelAdapter;
  effectiveTools: unknown[];
  upperHarness?: YarnUpperHarnessContext;
  clientKind: string;
  recentToolNames: string[];
  pathContext: OpenAINonStreamToolCallPathContext;
  enforcePathRoot: boolean;
  blockBashPathDrift: boolean;
  strictGovernance: boolean;
  planModeRequested: boolean;
  session: TSession;
  sensemakingRestrictDiscovery?: boolean;
  shouldRestrictDiscoveryForPlanWork(taskCue: unknown): boolean;
  taskCue: unknown;
  artifactShadows: GovernToolCallOptions["artifactShadows"];
  normalizedMessageCount: number;
  pathSandboxEnabled: boolean;
  deserializePlanShadow(data: unknown): PlanContentShadow | null;
  buildPathSandboxPolicy(root: string): PathSandboxPolicy;
  isWriteCapableToolName(name: string): boolean;
  stats: ToolArgHardeningStats;
  strictGovernanceStats: { strictGovernanceRewrites: number };
  logger: OpenAINonStreamToolCallLogger;
  requestId: string;
  sessionKey: string;
  userId: string;
  orgId: string;
  recordUpperHarnessDecision(
    sessionKey: string,
    userId: string,
    orgId: string,
    requestId: string,
    component: string,
    decision: AdapterToolHardeningResult["upperHarnessDecision"],
  ): void;
  updateDiffAccumulator(session: TSession, governed: GovernedToolCall): void;
  maybeUpdateTaskLedgerFromToolCall(
    session: TSession,
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
    logger: OpenAINonStreamToolCallLogger,
    requestId: string,
    toolName: string,
    clientKind: string,
    governed: GovernedToolCall,
    toolCallId?: string,
  ): void;
}

export function prepareOpenAINonStreamExternalToolCalls<TSession extends OpenAINonStreamToolCallSession>(
  input: OpenAINonStreamToolCallInput<TSession>,
): GuardrailToolCall[] {
  const offeredToolSet = buildOfferedToolNameSet(input.effectiveTools);
  const offeredToolNames = listOfferedToolNames(input.effectiveTools);
  const fallbackBashToolName = findOfferedToolNameByCanonical(input.effectiveTools, "Bash");
  const pathContext = mergePathContextWithSessionMetadata(input.pathContext, input.session);
  const effectiveRoot = pathContext.projectRoot ?? pathContext.shellCwd;

  return input.toolCalls
    .filter((tc) => tc.toolName !== input.artifactToolName)
    .map((tc, toolCallIndex) => {
      const rawInput = recordInput(tc.input);
      const prepared = prepareGovernedToolCall({
        adapter: input.adapter,
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: rawInput,
        hardeningOptions: {
          upperHarness: input.upperHarness,
          clientKind: input.clientKind,
          recentToolNames: input.recentToolNames,
        },
        governanceOptions: {
          projectRoot: pathContext.projectRoot,
          shellCwd: pathContext.shellCwd,
          enforcePathRoot: input.enforcePathRoot,
          blockBashPathDrift: input.blockBashPathDrift,
          strictBashBlock: input.strictGovernance,
          blockWriteCapableTools: input.strictGovernance || input.planModeRequested,
          clientKind: input.clientKind,
          sessionGitInspectionBlockCount: input.session.gitInspectionBlockCount,
          restrictDiscoveryForPlanWork: input.sensemakingRestrictDiscovery ?? input.shouldRestrictDiscoveryForPlanWork(input.taskCue),
          blockBroadVerificationForGreen: input.session.blockBroadVerificationUntilEdit,
          blockVerificationForFailure: input.session.blockFailingVerificationUntilEdit,
          planContentShadow: input.deserializePlanShadow(input.session.record.metadata.plan_content_shadow),
          artifactShadows: input.artifactShadows,
          currentTurnIndex: input.normalizedMessageCount + toolCallIndex + 1,
          onEditTurn: (canonicalPath, turnIndex) => {
            input.session.artifactEditTurns.set(canonicalPath, turnIndex);
          },
          pathSandboxPolicy: input.pathSandboxEnabled && effectiveRoot
            ? input.buildPathSandboxPolicy(effectiveRoot)
            : null,
        },
        availability: {
          offeredToolSet,
          offeredToolNames,
          fallbackBashToolName,
        },
      });
      const { hardening: hard, governed } = prepared;
      input.recordUpperHarnessDecision(
        input.sessionKey,
        input.userId,
        input.orgId,
        input.requestId,
        "upper-harness:openai",
        hard.upperHarnessDecision,
      );
      recordAdapterToolRepairObservations({
        stats: input.stats,
        hardening: hard,
        logger: input.logger,
        requestId: input.requestId,
        originalToolName: tc.toolName,
        originalInput: rawInput,
      });
      if (input.isWriteCapableToolName(hard.toolName)) {
        input.session.blockBroadVerificationUntilEdit = false;
        input.session.blockFailingVerificationUntilEdit = false;
      }
      if (isGitInspectionChurnBlock(governed)) {
        input.session.gitInspectionBlockCount += 1;
      }
      recordGovernedToolHardeningStats(input.stats, governed);
      input.updateDiffAccumulator(input.session, governed);
      input.maybeUpdateTaskLedgerFromToolCall(
        input.session,
        governed.toolName,
        governed.input,
        input.normalizedMessageCount + toolCallIndex,
      );
      if (governed.planWriteAudit) {
        input.emitPlanWriteAuditEvent(
          input.sessionKey,
          input.userId,
          input.orgId,
          input.requestId,
          governed.planWriteAudit,
        );
      }
      input.maybeLogEnvelopeUnwrapSample(
        input.logger,
        input.requestId,
        governed.toolName,
        input.clientKind,
        governed,
        tc.toolCallId,
      );
      if (governed.validationMissing.length > 0) {
        input.logger.warn(
          { reqId: input.requestId, toolName: governed.toolName, missing: governed.validationMissing },
          "tool_args_validation_failed",
        );
      }
      if (input.strictGovernance && input.isWriteCapableToolName(tc.toolName) && governed.toolName === "Bash") {
        input.strictGovernanceStats.strictGovernanceRewrites += 1;
      }
      if (prepared.unavailableRewrite.rewritten) {
        input.logger.warn(
          {
            reqId: input.requestId,
            requested_tool: prepared.unavailableRewrite.requestedTool,
            fallback_tool: prepared.call.toolName,
          },
          "tool_call_unavailable_rewritten",
        );
      }
      return prepared.call;
    });
}

function recordInput(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}
