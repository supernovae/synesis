import type { SessionRecord } from "./session-store.js";
import type { SessionEventInsert, UsageEvent } from "./usage-writer.js";
import type { LlmUsage, PricingRates, TraceRecord } from "@synesis/telemetry";

export interface SessionUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface SessionUsageWithCost extends SessionUsageSummary {
  cacheCreationTokens: number;
  costUsd: number;
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

export interface UsageCostBreakdown {
  tokens_uncached_input?: number;
  tokens_cache_read?: number;
  tokens_cache_write?: number;
  input_cost_usd?: number;
  cache_read_cost_usd?: number;
  cache_write_cost_usd?: number;
  output_cost_usd?: number;
  estimated_no_cache_cost_usd?: number;
  cache_savings_usd?: number;
}

export interface BuildUsageEventInput {
  record: SessionRecord;
  requestId: string;
  resolvedModelId: string;
  traceModel: string;
  usage: SessionUsageSummary;
  costBreakdown: UsageCostBreakdown;
  tokensSavedByReduction: number;
  latencyMs: number;
  normalizedEstimatedCostUsd: number;
  normalizedActualCostUsd: number;
  pricingSource: string;
  escalated: boolean;
  toolCallsCount: number;
  finishReason: string;
}

export interface BuildTelemetryUsageInput {
  usage: SessionUsageWithCost;
  normalizedEstimatedCostUsd: number;
}

export interface BuildTokenEconomicsWarningEventInput {
  record: SessionRecord;
  requestId: string;
  recommendation: string;
  warnings: string[];
  metadataJson: Record<string, unknown>;
  usage: Pick<SessionUsageSummary, "inputTokens" | "outputTokens">;
}

export interface BuildYarnTraceRecordInput {
  requestId: string;
  record: SessionRecord;
  parentTraceId?: string;
  rootTraceId: string;
  traceModel: string;
  resolvedModelId: string;
  backendModel?: string;
  clientRequestedModel?: string;
  telemetryUsage: LlmUsage;
  normalizedEstimatedCostUsd: number;
  latencyMs: number;
  tierRates: PricingRates;
  rootPromptSnippet: string;
  latestPromptSnippet: string;
  snapshotTraceFields?: Partial<TraceRecord> & { trace_context?: Record<string, unknown> };
  chatStateSummary?: unknown;
  fileStateSummary?: unknown;
  objectiveScopeSummary?: unknown;
  stateConfidenceSummary?: unknown;
  stateTransitionSummary?: unknown;
  tokenEconomics?: unknown;
  optimizationLedger?: unknown;
  finishReason: string;
}

export type YarnTraceRecord = TraceRecord & {
  optimization_ledger?: unknown;
};

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

export function buildUsageEvent(input: BuildUsageEventInput): UsageEvent {
  return {
    sessionKey: input.record.sessionKey,
    requestId: input.requestId,
    userId: input.record.userId,
    orgId: input.record.orgId,
    provider: input.resolvedModelId,
    model: input.traceModel,
    tokensIn: input.usage.inputTokens,
    tokensOut: input.usage.outputTokens,
    tokensCached: input.usage.cachedTokens,
    tokensUncachedInput: input.costBreakdown.tokens_uncached_input,
    tokensCacheRead: input.costBreakdown.tokens_cache_read,
    tokensCacheWrite: input.costBreakdown.tokens_cache_write,
    inputCostUsd: input.costBreakdown.input_cost_usd,
    cacheReadCostUsd: input.costBreakdown.cache_read_cost_usd,
    cacheWriteCostUsd: input.costBreakdown.cache_write_cost_usd,
    outputCostUsd: input.costBreakdown.output_cost_usd,
    estimatedNoCacheCostUsd: input.costBreakdown.estimated_no_cache_cost_usd,
    cacheSavingsUsd: input.costBreakdown.cache_savings_usd,
    tokensSavedByReduction: input.tokensSavedByReduction,
    latencyMs: input.latencyMs,
    estimatedCostUsd: input.normalizedEstimatedCostUsd,
    actualCostUsd: input.normalizedActualCostUsd,
    pricingSource: input.pricingSource,
    authMethod: String(input.record.metadata.auth_method ?? ""),
    authKeyId: String(input.record.metadata.auth_key_id ?? ""),
    authKeyName: String(input.record.metadata.auth_key_name ?? ""),
    authKeyPrefix: String(input.record.metadata.auth_key_prefix ?? ""),
    escalated: input.escalated,
    toolCallsCount: input.toolCallsCount,
    finishReason: input.finishReason,
  };
}

export function buildTelemetryUsage(input: BuildTelemetryUsageInput): LlmUsage {
  return {
    prompt_tokens: input.usage.inputTokens,
    completion_tokens: input.usage.outputTokens,
    total_tokens: input.usage.inputTokens + input.usage.outputTokens,
    cached_prompt_tokens: input.usage.cachedTokens,
    cache_creation_tokens: input.usage.cacheCreationTokens,
    estimated_cost_usd: input.normalizedEstimatedCostUsd,
    actual_cost_usd: input.usage.costUsd > 0 ? input.usage.costUsd : 0,
  };
}

export function buildTokenEconomicsWarningEvent(
  input: BuildTokenEconomicsWarningEventInput,
): SessionEventInsert | null {
  if (input.warnings.length === 0 || input.usage.inputTokens + input.usage.outputTokens <= 0) {
    return null;
  }
  return {
    sessionKey: input.record.sessionKey,
    requestId: input.requestId,
    userId: input.record.userId,
    orgId: input.record.orgId,
    eventKind: "token_economics_warning_v1",
    component: "token-economics",
    detail: `${input.recommendation}: ${input.warnings.join(",")}`,
    metadataJson: input.metadataJson,
  };
}

export function buildYarnTraceRecord(input: BuildYarnTraceRecordInput): YarnTraceRecord {
  const orig = (input.clientRequestedModel ?? "").trim();
  const hasOriginalModel = orig && orig.toLowerCase() !== "auto";
  const traceContext = input.snapshotTraceFields?.trace_context ?? {};
  return {
    service: "yarn",
    trace_id: input.requestId,
    request_id: input.requestId,
    conversation_id: input.record.sessionKey,
    parent_trace_id: input.parentTraceId,
    root_trace_id: input.rootTraceId,
    timestamp: Date.now() / 1000,
    user_id: input.record.userId,
    org_id: input.record.orgId,
    tenant_id: "",
    model: input.traceModel,
    query_snippet: (input.rootPromptSnippet || input.latestPromptSnippet).slice(0, 2000),
    tokens: input.telemetryUsage,
    cost: {
      estimated_usd: input.normalizedEstimatedCostUsd,
      actual_usd: input.telemetryUsage.actual_cost_usd,
      rates_snapshot: input.tierRates,
    },
    latency_ms: input.latencyMs,
    ...input.snapshotTraceFields,
    trace_context: {
      ...traceContext,
      turn_index: input.record.requestCount,
      root_user_prompt: input.rootPromptSnippet || undefined,
      latest_user_prompt: input.latestPromptSnippet || undefined,
      parent_trace_id: input.parentTraceId,
      root_trace_id: input.rootTraceId,
      ...(hasOriginalModel
        ? {
            client_requested_model: orig,
            resolved_backend_model: input.backendModel,
            registry_tier_id: input.resolvedModelId,
          }
        : {
            resolved_backend_model: input.backendModel,
            registry_tier_id: input.resolvedModelId,
          }),
      chat_state: input.chatStateSummary,
      file_state: input.fileStateSummary,
      objective_scope: input.objectiveScopeSummary,
      state_confidence: input.stateConfidenceSummary,
      state_transition: input.stateTransitionSummary,
      token_economics: input.tokenEconomics,
    },
    ...(input.optimizationLedger ? { optimization_ledger: input.optimizationLedger } : {}),
    has_error: input.finishReason === "error" || undefined,
  };
}
