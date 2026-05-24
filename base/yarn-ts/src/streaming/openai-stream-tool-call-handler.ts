import type { ModelAdapter } from "../providers/model-adapter.js";
import type { GovernToolCallOptions, GovernedToolCall, PlanWriteAuditRecord } from "../path-governance/tool-call-governance.js";
import type { BlockedDiscoveryDetail } from "../tool-collapse/blocked-discovery-recovery.js";
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
  restoreGuardrailCallForClient,
  type GuardrailToolCall,
} from "../tools/tool-call-availability.js";
import { parseToolInput, serializeToolInput } from "./ai-sdk-stream-events.js";
import type { OpenAIStreamToolCallEvent } from "./openai-stream-event-runner.js";
import type { OpenAIStreamResponseWriter } from "./openai-stream-response-writer.js";
import type { OpenAIStreamState } from "./openai-stream-state.js";

export interface OpenAIStreamDiscoveryGuardrailResult {
  calls: GuardrailToolCall[];
  blockedCount: number;
  redirectedCount: number;
  collapsedCount: number;
  blockedDetails: BlockedDiscoveryDetail[];
}

export interface OpenAIStreamToolCallRecovery {
  text: string;
  entryCount: number;
  recoveryMode: "top_level_snapshot" | "no_project_root" | "root_empty" | "snapshot_io_error";
}

export interface OpenAIStreamToolCallHandlerResult {
  emittedToolCalls: number;
  toolRepairs: number;
  validationFailures: number;
  strictGovernanceRewrites: number;
  blockedBroadDiscovery: number;
  collapsedBroadDiscovery: number;
  recoveryPreviewEntries: number;
  recoveryMode: OpenAIStreamToolCallRecovery["recoveryMode"] | null;
}

export interface OpenAIStreamToolCallHandlerInput {
  event: OpenAIStreamToolCallEvent;
  streamState: OpenAIStreamState;
  writer: OpenAIStreamResponseWriter;
  adapter: ModelAdapter;
  requestId: string;
  clientKind: string;
  effectiveTools: unknown[];
  debugProtocol: boolean;
  strictGovernance: boolean;
  hardeningOptions: Parameters<typeof prepareGovernedToolCall>[0]["hardeningOptions"];
  governanceOptions: Omit<GovernToolCallOptions, "toolName" | "input">;
  availability: NonNullable<Parameters<typeof prepareGovernedToolCall>[0]["availability"]>;
  acceptedGuardrailCalls: GuardrailToolCall[];
  blockedDiscoveryDetails: BlockedDiscoveryDetail[];
  stats: ToolArgHardeningStats;
  logger: {
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
  onRedirectedDiscovery(count: number): void;
  getTopLevelDirs(): Promise<string[]>;
  applyDiscoveryGuardrail(
    calls: GuardrailToolCall[],
    topLevelDirs: string[],
  ): OpenAIStreamDiscoveryGuardrailResult;
  buildBlockedDiscoveryRecovery(blockedDetails: BlockedDiscoveryDetail[]): Promise<OpenAIStreamToolCallRecovery>;
}

export async function handleOpenAIStreamToolCall(
  input: OpenAIStreamToolCallHandlerInput,
): Promise<OpenAIStreamToolCallHandlerResult> {
  const {
    event,
    streamState,
    writer,
    adapter,
    requestId,
    clientKind,
    effectiveTools,
    debugProtocol,
    strictGovernance,
    hardeningOptions,
    governanceOptions,
    availability,
    acceptedGuardrailCalls,
    blockedDiscoveryDetails,
    stats,
    logger,
  } = input;
  const result: OpenAIStreamToolCallHandlerResult = {
    emittedToolCalls: 0,
    toolRepairs: 0,
    validationFailures: 0,
    strictGovernanceRewrites: 0,
    blockedBroadDiscovery: 0,
    collapsedBroadDiscovery: 0,
    recoveryPreviewEntries: 0,
    recoveryMode: null,
  };

  streamState.markToolCallFinish();
  let argsStr = serializeToolInput(event.input);
  const rawArgsLen = argsStr.length;
  if (adapter.normalizeToolCallArgs) argsStr = adapter.normalizeToolCallArgs(argsStr);
  const parsedInput = parseToolInput(event.input, argsStr);
  const prepared = prepareGovernedToolCall({
    adapter,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: parsedInput,
    hardeningOptions,
    governanceOptions,
    availability,
  });
  const hard = prepared.hardening;
  const governed = prepared.governed;
  input.onUpperHarnessDecision(hard.upperHarnessDecision);
  result.toolRepairs += recordAdapterToolRepairObservations({
    stats,
    hardening: hard,
    logger,
    requestId,
    originalToolName: event.toolName,
    originalInput: parsedInput,
  }).repairCountDelta;
  if (input.isWriteCapableToolName(hard.toolName)) {
    input.onWriteCapableTool();
  }
  if (isGitInspectionChurnBlock(governed)) {
    input.onGitInspectionChurnBlock();
  }
  recordGovernedToolHardeningStats(stats, governed);
  input.onGovernedToolCall(governed);
  if (governed.planWriteAudit) {
    input.onPlanWriteAudit(governed.planWriteAudit);
  }
  input.onEnvelopeUnwrapSample(governed.toolName, governed, event.toolCallId);
  if (governed.validationMissing.length > 0) {
    result.validationFailures += 1;
    logger.warn(
      { reqId: requestId, toolName: governed.toolName, missing: governed.validationMissing },
      "tool_args_validation_failed",
    );
  }
  if (strictGovernance && input.isWriteCapableToolName(event.toolName) && governed.toolName === "Bash") {
    result.strictGovernanceRewrites += 1;
  }
  argsStr = JSON.stringify(governed.input);
  if (debugProtocol) {
    logger.debug?.({
      reqId: requestId,
      toolName: governed.toolName,
      toolCallId: event.toolCallId,
      argsLen: rawArgsLen,
      normalized: argsStr.length !== rawArgsLen,
      repairedWriteContent: hard.repairedWriteContent,
      adapterFamily: adapter.family,
    }, "tool_call_streamed");
  }
  let candidateCall = prepared.call;
  if (prepared.unavailableRewrite.rewritten) {
    logger.warn(
      {
        reqId: requestId,
        requested_tool: prepared.unavailableRewrite.requestedTool,
        fallback_tool: prepared.call.toolName,
      },
      "tool_call_unavailable_rewritten",
    );
  }
  const topLevelDirs = await input.getTopLevelDirs();
  const streamGuarded = input.applyDiscoveryGuardrail([...acceptedGuardrailCalls, candidateCall], topLevelDirs);
  if (streamGuarded.redirectedCount > 0) {
    result.blockedBroadDiscovery += streamGuarded.redirectedCount;
    input.onRedirectedDiscovery(streamGuarded.redirectedCount);
    const redirectedCall = streamGuarded.calls[streamGuarded.calls.length - 1];
    if (redirectedCall) {
      candidateCall = redirectedCall as GuardrailToolCall;
    }
  }
  if (streamGuarded.calls.length === acceptedGuardrailCalls.length) {
    result.blockedBroadDiscovery += streamGuarded.blockedCount;
    result.collapsedBroadDiscovery += streamGuarded.collapsedCount;
    const blockedId = event.toolCallId;
    if (blockedId) {
      streamState.removeToolCall(blockedId);
    }
    if (streamGuarded.blockedCount > 0) {
      const recovery = await input.buildBlockedDiscoveryRecovery(streamGuarded.blockedDetails);
      blockedDiscoveryDetails.push(...streamGuarded.blockedDetails);
      result.recoveryPreviewEntries += recovery.entryCount;
      result.recoveryMode = recovery.recoveryMode;
      writer.writeTextDelta(`\n${recovery.text}\n`);
    }
    return result;
  }
  acceptedGuardrailCalls.push(candidateCall);
  const clientCandidateCall = restoreGuardrailCallForClient(
    candidateCall,
    effectiveTools,
    clientKind,
  );
  argsStr = JSON.stringify(clientCandidateCall.input);
  const existing = streamState.findToolCall(event.toolCallId);
  if (existing) {
    existing.name = clientCandidateCall.toolName;
    writer.writeToolCallDelta({
      index: existing.index,
      function: { arguments: argsStr },
    }, event.created);
    result.emittedToolCalls += 1;
  } else {
    writer.writeToolCallDelta({
      index: streamState.nextToolCallIndex(),
      id: event.toolCallId,
      type: "function",
      function: { name: clientCandidateCall.toolName, arguments: argsStr },
    }, event.created);
    result.emittedToolCalls += 1;
  }
  return result;
}
