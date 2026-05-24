import type { ModelAdapter } from "../providers/model-adapter.js";
import {
  governToolCall,
  type GovernToolCallOptions,
  type GovernedToolCall,
  type PlanWriteAuditRecord,
} from "../path-governance/tool-call-governance.js";
import {
  applyAdapterToolHardening,
  type AdapterToolHardeningResult,
} from "../governance/tool-call-governor-service.js";
import {
  isGitInspectionChurnBlock,
  recordAdapterToolRepairObservations,
  recordGovernedToolHardeningStats,
  type ToolArgHardeningStats,
} from "../governance/tool-call-observability.js";
import type { GuardrailToolCall } from "../tools/tool-call-availability.js";
import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
import { parseToolInput, serializeToolInput, type AiSdkStreamEvent } from "./ai-sdk-stream-events.js";
import type { ClaudeStreamDiscoveryState } from "./claude-stream-components.js";
import type { ClaudeStreamState } from "./claude-stream-state.js";
import type {
  OpenAIStreamDiscoveryGuardrailResult,
  OpenAIStreamToolCallRecovery,
} from "./openai-stream-tool-call-handler.js";

export type ClaudeStreamToolCallEvent = Extract<AiSdkStreamEvent, { type: "tool_call" }>;

export interface ClaudeStreamToolCallHandlerResult {
  toolRepairs: number;
  validationFailures: number;
  strictGovernanceRewrites: number;
  emittedToolCalls: number;
}

export interface ClaudeStreamToolCallHandlerInput {
  event: ClaudeStreamToolCallEvent;
  streamState: ClaudeStreamState;
  adapter: ModelAdapter;
  requestId: string;
  clientKind: string;
  debugProtocol: boolean;
  strictGovernance: boolean;
  hardeningOptions?: Parameters<typeof applyAdapterToolHardening>[4];
  governanceOptions: Omit<GovernToolCallOptions, "toolName" | "input">;
  acceptedGuardrailCalls: GuardrailToolCall[];
  blockedDiscoveryDetails: BlockedDiscoveryDetail[];
  discovery: ClaudeStreamDiscoveryState;
  toolSequence: string[];
  stats: ToolArgHardeningStats;
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    debug?(obj: Record<string, unknown>, msg?: string): void;
  };
  isWriteCapableToolName(name: string): boolean;
  onWriteCapableTool(): void;
  onGitInspectionChurnBlock(): void;
  onGovernedToolCall(governed: GovernedToolCall): void;
  onPlanWriteAudit(audit: PlanWriteAuditRecord): void;
  onEnvelopeUnwrapSample(toolName: string, governed: GovernedToolCall, toolCallId: string): void;
  onUpperHarnessDecision(decision: AdapterToolHardeningResult["upperHarnessDecision"]): void;
  onStrictGovernanceRewrites(count: number): void;
  onRedirectedDiscovery(count: number): void;
  getTopLevelDirs(): Promise<string[]>;
  applyDiscoveryGuardrail(
    calls: GuardrailToolCall[],
    topLevelDirs: string[],
  ): OpenAIStreamDiscoveryGuardrailResult;
  buildBlockedDiscoveryRecovery(blockedDetails: BlockedDiscoveryDetail[]): Promise<OpenAIStreamToolCallRecovery>;
  sendSse(event: string, data: unknown): boolean;
}

export async function handleClaudeStreamToolCall(
  input: ClaudeStreamToolCallHandlerInput,
): Promise<ClaudeStreamToolCallHandlerResult> {
  const {
    event,
    streamState,
    adapter,
    requestId,
    debugProtocol,
    strictGovernance,
    hardeningOptions,
    governanceOptions,
    acceptedGuardrailCalls,
    blockedDiscoveryDetails,
    discovery,
    toolSequence,
    stats,
    logger,
  } = input;
  const result: ClaudeStreamToolCallHandlerResult = {
    toolRepairs: 0,
    validationFailures: 0,
    strictGovernanceRewrites: 0,
    emittedToolCalls: 0,
  };

  const pending = streamState.getToolInput(event.toolCallId);
  const rawToolInput = parseToolInput(event.input, serializeToolInput(event.input));
  const hard = applyAdapterToolHardening(
    adapter,
    event.toolName,
    rawToolInput,
    pending?.toolName,
    hardeningOptions,
  );
  input.onUpperHarnessDecision(hard.upperHarnessDecision);
  result.toolRepairs += recordAdapterToolRepairObservations({
    stats,
    hardening: hard,
    logger,
    requestId,
    originalToolName: event.toolName,
    originalInput: rawToolInput,
  }).repairCountDelta;

  let emitToolName = hard.toolName;
  let finalInput = hard.input;
  if (input.isWriteCapableToolName(emitToolName)) {
    input.onWriteCapableTool();
  }

  const governed = governToolCall({
    ...governanceOptions,
    toolName: emitToolName,
    input: finalInput,
  });
  if (isGitInspectionChurnBlock(governed)) {
    input.onGitInspectionChurnBlock();
  }
  emitToolName = governed.toolName;
  finalInput = governed.input;
  recordGovernedToolHardeningStats(stats, governed);
  input.onGovernedToolCall(governed);
  if (governed.planWriteAudit) {
    input.onPlanWriteAudit(governed.planWriteAudit);
  }
  input.onEnvelopeUnwrapSample(emitToolName, governed, event.toolCallId);
  logGovernedToolCall(input, governed, emitToolName);

  if (governed.validationMissing.length > 0) {
    result.validationFailures += 1;
    logger.warn(
      {
        reqId: requestId,
        toolName: emitToolName,
        missing: governed.validationMissing,
        argsPreview: JSON.stringify(finalInput).slice(0, 220),
      },
      "tool_args_validation_failed",
    );
  }
  if (strictGovernance && input.isWriteCapableToolName(event.toolName) && governed.toolName === "Bash") {
    result.strictGovernanceRewrites += 1;
    input.onStrictGovernanceRewrites(1);
  }

  if (debugProtocol) {
    logger.debug?.({
      reqId: requestId,
      toolName: emitToolName,
      toolCallId: event.toolCallId,
      argsLen: JSON.stringify(finalInput).length,
      argsPreview: JSON.stringify(finalInput).slice(0, 300),
      remapped: hard.remapped,
      repairedWriteContent: hard.repairedWriteContent,
      repairedWrite: hard.repairedWrite,
      repairedBash: hard.repairedBash,
      adapterFamily: adapter.family,
    }, "claude_tool_call_streamed");
  }

  let candidateCall: GuardrailToolCall = {
    toolCallId: event.toolCallId,
    toolName: emitToolName,
    input: finalInput,
  };
  const topLevelDirs = await input.getTopLevelDirs();
  const streamGuarded = input.applyDiscoveryGuardrail([...acceptedGuardrailCalls, candidateCall], topLevelDirs);
  if (streamGuarded.redirectedCount > 0) {
    discovery.blockedBroadDiscovery += streamGuarded.redirectedCount;
    input.onRedirectedDiscovery(streamGuarded.redirectedCount);
    const redirectedCall = streamGuarded.calls[streamGuarded.calls.length - 1];
    if (redirectedCall) {
      candidateCall = redirectedCall as GuardrailToolCall;
      finalInput = redirectedCall.input;
    }
  }
  if (streamGuarded.calls.length === acceptedGuardrailCalls.length) {
    discovery.blockedBroadDiscovery += streamGuarded.blockedCount;
    discovery.collapsedBroadDiscovery += streamGuarded.collapsedCount;
    const blockedToolCallId = event.toolCallId;
    if (blockedToolCallId) {
      streamState.removeToolInput(blockedToolCallId);
    }
    if (streamGuarded.blockedCount > 0) {
      const recovery = await input.buildBlockedDiscoveryRecovery(streamGuarded.blockedDetails);
      blockedDiscoveryDetails.push(...streamGuarded.blockedDetails);
      discovery.recoveryPreviewEntries += recovery.entryCount;
      discovery.recoveryMode = recovery.recoveryMode;
      writeClaudeTextBlock(input, `\n${recovery.text}\n`);
    }
    return result;
  }

  acceptedGuardrailCalls.push(candidateCall);
  toolSequence.push(emitToolName);
  emitClaudeToolUseBlock(input, event.toolCallId, emitToolName, finalInput);
  streamState.removeToolInput(event.toolCallId);
  streamState.recordEmittedToolCall();
  streamState.markToolUse();
  result.emittedToolCalls += 1;
  return result;
}

function logGovernedToolCall(
  input: ClaudeStreamToolCallHandlerInput,
  governed: GovernedToolCall,
  toolName: string,
): void {
  const { event, requestId, logger } = input;
  if (governed.constrainedToRoot) {
    logger.info(
      { reqId: requestId, toolName, toolCallId: event.toolCallId },
      "file_tool_path_constrained_to_project_root",
    );
  }
  if (governed.blockedBashDrift) {
    logger.warn(
      { reqId: requestId, toolName, toolCallId: event.toolCallId },
      "bash_path_drift_blocked",
    );
  }
  if (governed.blockedUnsafeShell) {
    logger.warn(
      { reqId: requestId, toolName, toolCallId: event.toolCallId },
      "unsafe_shell_command_blocked",
    );
  }
  if (governed.blockedWriteCapable) {
    logger.warn(
      { reqId: requestId, toolName, toolCallId: event.toolCallId },
      "write_capable_tool_blocked",
    );
  }
}

function emitClaudeToolUseBlock(
  input: ClaudeStreamToolCallHandlerInput,
  toolCallId: string,
  toolName: string,
  finalInput: Record<string, unknown>,
): void {
  const blockIndex = input.streamState.currentBlockIndex();
  input.sendSse("content_block_start", {
    type: "content_block_start",
    index: blockIndex,
    content_block: { type: "tool_use", id: toolCallId, name: toolName },
  });
  input.sendSse("content_block_delta", {
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(finalInput) },
  });
  input.sendSse("content_block_stop", { type: "content_block_stop", index: blockIndex });
  input.streamState.advanceBlock();
}

function writeClaudeTextBlock(
  input: ClaudeStreamToolCallHandlerInput,
  text: string,
): void {
  const blockIndex = input.streamState.currentBlockIndex();
  input.sendSse("content_block_start", {
    type: "content_block_start",
    index: blockIndex,
    content_block: { type: "text", text: "" },
  });
  input.sendSse("content_block_delta", {
    type: "content_block_delta",
    index: blockIndex,
    delta: { type: "text_delta", text },
  });
  input.sendSse("content_block_stop", { type: "content_block_stop", index: blockIndex });
  input.streamState.advanceBlock();
}
