import type { SessionRecord } from "./session-store.js";

export interface SessionUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface SessionUsagePersistenceState {
  record: SessionRecord;
  consecutiveToolCalls: number;
  stagnantToolCycles: number;
  lastToolSignalHash: string;
  awaitingToolLoopUserAck: boolean;
  toolLoopAckAnchorUserHash: string;
  toolLoopNoUserAckCount: number;
  blockBroadVerificationUntilEdit: boolean;
  blockFailingVerificationUntilEdit: boolean;
}

export interface ApplySessionUsagePersistenceInput {
  requestId: string;
  resolvedModelId: string;
  traceModel: string;
  usage: SessionUsageSummary;
  tokensSavedByReduction: number;
  normalizedEstimatedCostUsd: number;
  normalizedActualCostUsd: number;
  finishReason: string;
  tokenEconomicsWarnings: unknown;
}

export interface SessionTraceLinks {
  previousTraceId: string | undefined;
  parentTraceId: string | undefined;
  rootTraceId: string;
}

function metadataString(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

export function applySessionUsagePersistenceMutation(
  state: SessionUsagePersistenceState,
  input: ApplySessionUsagePersistenceInput,
): SessionTraceLinks {
  const { record } = state;
  record.lastProvider = input.resolvedModelId;
  record.lastModel = input.traceModel;
  record.totalTokensIn += input.usage.inputTokens;
  record.totalTokensOut += input.usage.outputTokens;
  record.totalTokensCached += input.usage.cachedTokens;
  record.totalTokensSaved = (record.totalTokensSaved ?? 0) + input.tokensSavedByReduction;

  const prevEstimatedCost = Number(record.metadata.total_estimated_cost_usd ?? 0);
  const prevActualCost = Number(record.metadata.total_actual_cost_usd ?? 0);
  record.metadata.total_estimated_cost_usd = prevEstimatedCost + input.normalizedEstimatedCostUsd;
  record.metadata.total_actual_cost_usd = prevActualCost + input.normalizedActualCostUsd;
  record.requestCount += 1;
  record.lastActiveAt = Date.now();

  const previousTraceId = metadataString(record.metadata, "last_trace_id") || undefined;
  const rootTraceId = metadataString(record.metadata, "root_trace_id") || previousTraceId || input.requestId;
  record.metadata.root_trace_id = rootTraceId;
  record.metadata.last_trace_id = input.requestId;
  record.metadata.last_cache_hit_ratio = input.usage.inputTokens > 0
    ? Number((input.usage.cachedTokens / input.usage.inputTokens).toFixed(4))
    : 0;
  record.metadata.last_token_economics_warnings = input.tokenEconomicsWarnings;

  if (input.finishReason === "tool_calls" || input.finishReason === "tool_use") {
    state.consecutiveToolCalls += 1;
  } else {
    state.consecutiveToolCalls = 0;
    state.stagnantToolCycles = 0;
    state.lastToolSignalHash = "";
  }

  record.metadata.consecutive_tool_calls = state.consecutiveToolCalls;
  record.metadata.stagnant_tool_cycles = state.stagnantToolCycles;
  record.metadata.last_tool_signal_hash = state.lastToolSignalHash;
  record.metadata.awaiting_tool_loop_user_ack = state.awaitingToolLoopUserAck;
  record.metadata.tool_loop_ack_anchor_user_hash = state.toolLoopAckAnchorUserHash;
  record.metadata.tool_loop_no_user_ack_count = state.toolLoopNoUserAckCount;
  record.metadata.block_broad_verification_until_edit = state.blockBroadVerificationUntilEdit;
  record.metadata.block_failing_verification_until_edit = state.blockFailingVerificationUntilEdit;

  return {
    previousTraceId,
    parentTraceId: previousTraceId,
    rootTraceId,
  };
}
