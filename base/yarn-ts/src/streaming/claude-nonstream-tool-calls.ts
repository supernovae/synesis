import {
  recordAdapterToolRepairObservations,
  recordGovernedToolHardeningStats,
  isGitInspectionChurnBlock,
  type ToolArgHardeningStats,
} from "../governance/tool-call-observability.js";
import {
  applyAdapterToolHardening,
  type AdapterToolHardeningResult,
} from "../governance/tool-call-governor-service.js";
import {
  governToolCall,
  type GovernToolCallOptions,
  type GovernedToolCall,
  type PlanWriteAuditRecord,
} from "../path-governance/tool-call-governance.js";
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

function toToolInputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}
