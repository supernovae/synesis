import { describe, expect, it, vi } from "vitest";
import {
  applySessionUsagePersistenceMutation,
  buildTelemetryUsage,
  buildTokenEconomicsWarningEvent,
  buildUsageEvent,
  buildYarnTraceRecord,
} from "../src/state/session-usage-persistence.js";
import type { SessionRecord } from "../src/state/session-store.js";

function record(metadata: Record<string, unknown> = {}): SessionRecord {
  return {
    sessionKey: "s1",
    userId: "u1",
    orgId: "o1",
    conversationId: "c1",
    clientKind: "opencode",
    createdAt: 1,
    lastActiveAt: 1,
    totalTokensIn: 10,
    totalTokensOut: 2,
    totalTokensCached: 3,
    totalTokensSaved: 4,
    requestCount: 5,
    escalationCount: 0,
    consecutiveFailedVerifications: 0,
    metadata,
    version: 0,
  };
}

describe("session usage persistence mutation", () => {
  it("updates usage counters, cost totals, and trace links", () => {
    vi.useFakeTimers();
    vi.setSystemTime(123_456);
    const state = {
      record: record({ last_trace_id: "prev", total_estimated_cost_usd: 0.1, total_actual_cost_usd: 0.05 }),
      consecutiveToolCalls: 0,
      stagnantToolCycles: 2,
      lastToolSignalHash: "hash",
      awaitingToolLoopUserAck: false,
      toolLoopAckAnchorUserHash: "",
      toolLoopNoUserAckCount: 0,
      blockBroadVerificationUntilEdit: true,
      blockFailingVerificationUntilEdit: false,
    };

    const links = applySessionUsagePersistenceMutation(state, {
      requestId: "req2",
      resolvedModelId: "pulse",
      traceModel: "gpt-test",
      usage: { inputTokens: 40, outputTokens: 8, cachedTokens: 20 },
      tokensSavedByReduction: 6,
      normalizedEstimatedCostUsd: 0.25,
      normalizedActualCostUsd: 0.2,
      finishReason: "stop",
      tokenEconomicsWarnings: ["low_cache"],
    });

    expect(links).toEqual({ previousTraceId: "prev", parentTraceId: "prev", rootTraceId: "prev" });
    expect(state.record).toMatchObject({
      lastProvider: "pulse",
      lastModel: "gpt-test",
      totalTokensIn: 50,
      totalTokensOut: 10,
      totalTokensCached: 23,
      totalTokensSaved: 10,
      requestCount: 6,
      lastActiveAt: 123_456,
    });
    expect(state.record.metadata).toMatchObject({
      total_estimated_cost_usd: 0.35,
      total_actual_cost_usd: 0.25,
      root_trace_id: "prev",
      last_trace_id: "req2",
      last_cache_hit_ratio: 0.5,
      last_token_economics_warnings: ["low_cache"],
      consecutive_tool_calls: 0,
      stagnant_tool_cycles: 0,
      last_tool_signal_hash: "",
      block_broad_verification_until_edit: true,
      block_failing_verification_until_edit: false,
    });
    vi.useRealTimers();
  });

  it("increments tool-call loop counters for tool stop reasons", () => {
    const state = {
      record: record(),
      consecutiveToolCalls: 2,
      stagnantToolCycles: 1,
      lastToolSignalHash: "same",
      awaitingToolLoopUserAck: true,
      toolLoopAckAnchorUserHash: "anchor",
      toolLoopNoUserAckCount: 3,
      blockBroadVerificationUntilEdit: false,
      blockFailingVerificationUntilEdit: true,
    };

    const links = applySessionUsagePersistenceMutation(state, {
      requestId: "req1",
      resolvedModelId: "pulse",
      traceModel: "pulse",
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      tokensSavedByReduction: 0,
      normalizedEstimatedCostUsd: 0,
      normalizedActualCostUsd: 0,
      finishReason: "tool_calls",
      tokenEconomicsWarnings: [],
    });

    expect(links.rootTraceId).toBe("req1");
    expect(state.consecutiveToolCalls).toBe(3);
    expect(state.record.metadata).toMatchObject({
      consecutive_tool_calls: 3,
      stagnant_tool_cycles: 1,
      last_tool_signal_hash: "same",
      awaiting_tool_loop_user_ack: true,
      tool_loop_ack_anchor_user_hash: "anchor",
      tool_loop_no_user_ack_count: 3,
      last_cache_hit_ratio: 0,
    });
  });

  it("builds usage writer payloads from session record metadata", () => {
    const payload = buildUsageEvent({
      record: record({
        auth_method: "bearer",
        auth_key_id: "key1",
        auth_key_name: "dev",
        auth_key_prefix: "sk-",
      }),
      requestId: "req1",
      resolvedModelId: "pulse",
      traceModel: "gpt-test",
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 75 },
      costBreakdown: {
        tokens_uncached_input: 25,
        tokens_cache_read: 75,
        tokens_cache_write: 10,
        input_cost_usd: 0.01,
        cache_read_cost_usd: 0.001,
        cache_write_cost_usd: 0.002,
        output_cost_usd: 0.03,
        estimated_no_cache_cost_usd: 0.06,
        cache_savings_usd: 0.017,
      },
      tokensSavedByReduction: 300,
      latencyMs: 1234,
      normalizedEstimatedCostUsd: 0.043,
      normalizedActualCostUsd: 0.04,
      pricingSource: "provider",
      escalated: true,
      toolCallsCount: 4,
      finishReason: "stop",
    });

    expect(payload).toMatchObject({
      sessionKey: "s1",
      requestId: "req1",
      userId: "u1",
      orgId: "o1",
      provider: "pulse",
      model: "gpt-test",
      tokensIn: 100,
      tokensOut: 20,
      tokensCached: 75,
      tokensUncachedInput: 25,
      tokensCacheRead: 75,
      tokensCacheWrite: 10,
      estimatedCostUsd: 0.043,
      actualCostUsd: 0.04,
      pricingSource: "provider",
      authMethod: "bearer",
      authKeyId: "key1",
      authKeyName: "dev",
      authKeyPrefix: "sk-",
      escalated: true,
      toolCallsCount: 4,
      finishReason: "stop",
    });
  });

  it("builds telemetry usage for metrics and traces", () => {
    expect(buildTelemetryUsage({
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cachedTokens: 75,
        cacheCreationTokens: 10,
        costUsd: 0.42,
      },
      normalizedEstimatedCostUsd: 0.5,
    })).toEqual({
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      cached_prompt_tokens: 75,
      cache_creation_tokens: 10,
      estimated_cost_usd: 0.5,
      actual_cost_usd: 0.42,
    });
  });

  it("builds token economics warning events only when useful", () => {
    const built = buildTokenEconomicsWarningEvent({
      record: record(),
      requestId: "req1",
      recommendation: "preserve_prefix",
      warnings: ["cache_miss"],
      metadataJson: { cache_policy_state: { misses: 1 } },
      usage: { inputTokens: 10, outputTokens: 1 },
    });

    expect(built).toMatchObject({
      sessionKey: "s1",
      requestId: "req1",
      userId: "u1",
      orgId: "o1",
      eventKind: "token_economics_warning_v1",
      component: "token-economics",
      detail: "preserve_prefix: cache_miss",
      metadataJson: { cache_policy_state: { misses: 1 } },
    });
    expect(buildTokenEconomicsWarningEvent({
      record: record(),
      requestId: "req1",
      recommendation: "ok",
      warnings: [],
      metadataJson: {},
      usage: { inputTokens: 10, outputTokens: 1 },
    })).toBeNull();
    expect(buildTokenEconomicsWarningEvent({
      record: record(),
      requestId: "req1",
      recommendation: "ok",
      warnings: ["missing"],
      metadataJson: {},
      usage: { inputTokens: 0, outputTokens: 0 },
    })).toBeNull();
  });

  it("builds yarn trace records with snapshot and optimization context", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const telemetryUsage = buildTelemetryUsage({
      usage: { inputTokens: 5, outputTokens: 7, cachedTokens: 3, cacheCreationTokens: 1, costUsd: 0.02 },
      normalizedEstimatedCostUsd: 0.03,
    });

    const trace = buildYarnTraceRecord({
      requestId: "req1",
      record: record(),
      parentTraceId: "parent",
      rootTraceId: "root",
      traceModel: "gpt-test",
      resolvedModelId: "pulse",
      backendModel: "backend-test",
      clientRequestedModel: "auto",
      telemetryUsage,
      normalizedEstimatedCostUsd: 0.03,
      latencyMs: 42,
      tierRates: {
        input_per_million: 1,
        output_per_million: 2,
        cached_input_per_million: 0.1,
        cache_write_input_per_million: 0.5,
      },
      rootPromptSnippet: "root prompt",
      latestPromptSnippet: "latest prompt",
      snapshotTraceFields: { trace_context: { decision_path: "direct" }, has_error: false },
      chatStateSummary: { phase: "implement" },
      fileStateSummary: { stale: 0 },
      objectiveScopeSummary: { epoch_id: 1 },
      stateConfidenceSummary: { overall: 0.9 },
      stateTransitionSummary: { quality_label: "forward" },
      tokenEconomics: { cache: "hit" },
      optimizationLedger: { prefix_hash: "abc" },
      finishReason: "stop",
    });

    expect(trace).toMatchObject({
      service: "yarn",
      trace_id: "req1",
      request_id: "req1",
      conversation_id: "s1",
      parent_trace_id: "parent",
      root_trace_id: "root",
      timestamp: 2,
      model: "gpt-test",
      query_snippet: "root prompt",
      tokens: telemetryUsage,
      cost: {
        estimated_usd: 0.03,
        actual_usd: 0.02,
      },
      latency_ms: 42,
      trace_context: {
        decision_path: "direct",
        turn_index: 5,
        root_user_prompt: "root prompt",
        latest_user_prompt: "latest prompt",
        parent_trace_id: "parent",
        root_trace_id: "root",
        resolved_backend_model: "backend-test",
        registry_tier_id: "pulse",
        chat_state: { phase: "implement" },
        file_state: { stale: 0 },
        objective_scope: { epoch_id: 1 },
        state_confidence: { overall: 0.9 },
        state_transition: { quality_label: "forward" },
        token_economics: { cache: "hit" },
      },
      optimization_ledger: { prefix_hash: "abc" },
    });
    expect(trace.has_error).toBeUndefined();
    vi.useRealTimers();
  });
});
