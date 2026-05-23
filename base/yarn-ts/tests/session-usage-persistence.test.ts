import { describe, expect, it, vi } from "vitest";
import {
  applyGovernorTelemetryMetadata,
  applySessionUsagePersistenceMutation,
  blendStateTransitionQualityThresholds,
  buildHourlyTokenThrottleEvents,
  buildPersistenceTelemetryEventBundle,
  buildPersistenceStateChannelSummary,
  buildRequestTrajectoryMetrics,
  buildRequestTrajectoryEvent,
  buildStateTransitionEvents,
  buildStateTransitionSummary,
  classifyTrajectoryToolKind,
  countEditsFromToolSequence,
  countReadOpsFromToolSequence,
  buildTelemetryUsage,
  buildTokenEconomicsWarningEvent,
  buildUsageEvent,
  buildYarnTraceRecord,
  inferPrematureStopSignalsFromGovernor,
  inferTrajectoryBucket,
  preparePersistenceStateChannels,
  runHourlyTokenThrottleUpdate,
  runInitialSessionPersistenceWrites,
  runStateTransitionCalibration,
  runTraceFinalization,
  rotateStateTransitionSnapshot,
  runConsecutiveToolCallCounterUpdate,
} from "../src/state/session-usage-persistence.js";
import { StateTransitionGlobalCalibrator } from "../src/governance/state-transition-global-calibrator.js";
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

const thresholds = { forward_progress_min: 0.2, regressed_max: -0.35, minimum_gap: 0.08 };

function transitionRecord() {
  return {
    schema_version: "state_transition_v1",
    request_id: "req1",
    from_state: null,
    to_state: {
      objectiveEpochId: 1,
      objectiveHash: "hash",
      chatPhase: "implement",
      completionStatus: "in_progress",
      verificationOutcome: "unknown",
      unresolvedCorrectionCount: 0,
      resolvedCorrectionCount: 0,
      fileStatusCounts: { available: 1, partial: 0, unchanged: 0, stale: 0, evicted: 0, missing: 0 },
      confidenceOverall: 0.8,
      confidenceNeedsReground: false,
      confidenceReasons: [],
      scopeBoundaryIndex: 2,
      scopeRetainedEvidence: 3,
      scopeDroppedPreBoundary: 0,
    },
    event: {
      tool_sequence: ["Read", "apply_patch", "run_test"],
      governor_rules: [],
      governor_pause: false,
      evidence_delta: { changed: true },
      outcome_state: "verified",
    },
    delta: {
      changed_fields: ["chatPhase"],
      objective_epoch_advanced: true,
      objective_changed: false,
      completion_status_changed: true,
      verification_outcome_changed: false,
      unresolved_corrections_delta: 0,
      resolved_corrections_delta: 0,
      stale_files_delta: -1,
      partial_files_delta: 0,
      evicted_files_delta: 0,
      confidence_delta: 0.2,
      confidence_improved: true,
    },
    quality: {
      label: "forward_progress",
      score: 0.8,
      reasons: ["confidence improved"],
      recommended_action: "continue",
    },
  } as const;
}

function calibration(applied: boolean) {
  return {
    schema_version: "state_transition_quality_calibration_v1",
    sample_count: 13,
    positive_count: 10,
    negative_count: 2,
    neutral_count: 1,
    applied,
    previous_thresholds: thresholds,
    calibrated_thresholds: thresholds,
    summary: applied ? "calibrated" : "unchanged",
  } as const;
}

describe("session usage persistence mutation", () => {
  it("applies governor telemetry metadata when a governor snapshot exists", () => {
    const session = record({ governor_pause_count: 2 });

    applyGovernorTelemetryMetadata({
      record: session,
      snapshot: {
        decisionPath: "direct",
        phase: "implement",
        tier: "pulse",
        escalated: false,
        policyDecision: "",
        reducedToolResults: 0,
        tokensSavedByReduction: 0,
        isStreaming: false,
        governor: {
          pause: true,
          reason: "needs verification",
          matchedRules: ["verification_after_completion_claim"],
          telemetry: {} as never,
        },
      },
    });

    expect(session.metadata).toMatchObject({
      last_governor_pause: true,
      last_governor_rules: ["verification_after_completion_claim"],
      governor_pause_count: 3,
    });
  });

  it("leaves governor telemetry metadata unchanged without a governor snapshot", () => {
    const session = record({ governor_pause_count: 2 });

    applyGovernorTelemetryMetadata({
      record: session,
      snapshot: {
        decisionPath: "direct",
        phase: "implement",
        tier: "pulse",
        escalated: false,
        policyDecision: "",
        reducedToolResults: 0,
        tokensSavedByReduction: 0,
        isStreaming: false,
      },
    });

    expect(session.metadata).toEqual({ governor_pause_count: 2 });
  });

  it("rotates state transition snapshots through session metadata", () => {
    const metadata: Record<string, unknown> = {
      state_transition_prev_snapshot: transitionRecord().to_state,
      objective_epoch_id: 7,
      objective_epoch_objective_hash: "next-hash",
      chat_state_snapshot: {
        phase: "verify",
        completionStatus: "done",
        lastVerificationOutcome: "passed",
        unresolvedCorrectionCount: 1,
        resolvedCorrectionCount: 2,
      },
      file_state_snapshot: {
        statusCounts: {
          available: 2,
          stale: 1,
          partial: 1,
        },
      },
      state_confidence_overall: 0.9,
      state_confidence_needs_reground: true,
      state_confidence_reasons: ["verified"],
      objective_scope_boundary_index: 4,
      objective_scope_retained_evidence: 5,
      objective_scope_dropped_pre_boundary: 6,
    };

    const rotation = rotateStateTransitionSnapshot({ metadata });

    expect(rotation.previousSnapshot).toMatchObject({
      objectiveEpochId: 1,
      objectiveHash: "hash",
      chatPhase: "implement",
    });
    expect(rotation.currentSnapshot).toMatchObject({
      objectiveEpochId: 7,
      objectiveHash: "next-hash",
      chatPhase: "verify",
      completionStatus: "done",
      verificationOutcome: "passed",
      unresolvedCorrectionCount: 1,
      resolvedCorrectionCount: 2,
      fileStatusCounts: {
        available: 2,
        partial: 1,
        stale: 1,
      },
      confidenceOverall: 0.9,
      confidenceNeedsReground: true,
      confidenceReasons: ["verified"],
      scopeBoundaryIndex: 4,
      scopeRetainedEvidence: 5,
      scopeDroppedPreBoundary: 6,
    });
    expect(metadata.state_transition_prev_snapshot).toMatchObject({
      objectiveEpochId: 7,
      objectiveHash: "next-hash",
      chatPhase: "verify",
    });
  });

  it("runs consecutive tool call counter updates", async () => {
    const counter = {
      setConsecutiveToolCalls: vi.fn().mockResolvedValue(true),
    };

    await runConsecutiveToolCallCounterUpdate({
      record: record(),
      consecutiveToolCalls: 3,
      counter,
    });

    expect(counter.setConsecutiveToolCalls).toHaveBeenCalledWith("s1", 3);
  });

  it("warns when consecutive tool call counter update rejects", async () => {
    const err = new Error("redis down");
    const counter = {
      setConsecutiveToolCalls: vi.fn().mockRejectedValue(err),
    };
    const warn = vi.fn();

    await runConsecutiveToolCallCounterUpdate({
      record: record(),
      consecutiveToolCalls: 3,
      counter,
      warn,
    });

    expect(warn).toHaveBeenCalledWith(err);
  });

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

  it("runs initial session persistence writes in the existing order", () => {
    const calls: string[] = [];
    const session = record({
      auth_method: "bearer",
      auth_key_id: "key1",
    });
    session.continuity = {
      currentTask: "task",
      keyFindings: ["finding"],
      decisions: [],
      recentFiles: [],
      updatedAt: 123,
    };
    const writer = {
      enqueueSessionUpsert: vi.fn(() => calls.push("session")),
      enqueueSessionEvent: vi.fn(() => calls.push("event")),
      enqueueContinuityUpsert: vi.fn(() => calls.push("continuity")),
      enqueueUsageInsert: vi.fn(() => calls.push("usage")),
    };
    const saveSession = vi.fn(() => calls.push("save"));

    runInitialSessionPersistenceWrites({
      record: session,
      requestId: "req1",
      writer,
      saveSession,
      conversationMemoryEnabled: true,
      tokenEconomicsRecommendation: "stable",
      tokenEconomicsWarnings: ["low_cache"],
      tokenEconomicsMetadata: { cache: "low" },
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 50 },
      costBreakdown: { tokens_uncached_input: 50 },
      resolvedModelId: "pulse",
      traceModel: "gpt-test",
      tokensSavedByReduction: 30,
      latencyMs: 123,
      normalizedEstimatedCostUsd: 0.04,
      normalizedActualCostUsd: 0.03,
      pricingSource: "provider",
      escalated: false,
      toolCallsCount: 2,
      finishReason: "stop",
    });

    expect(calls).toEqual(["save", "session", "event", "continuity", "usage"]);
    expect(saveSession).toHaveBeenCalledTimes(1);
    expect(writer.enqueueSessionUpsert).toHaveBeenCalledWith(session);
    expect(writer.enqueueSessionEvent.mock.calls[0][0]).toMatchObject({
      eventKind: "token_economics_warning_v1",
      detail: "stable: low_cache",
      metadataJson: { cache: "low" },
    });
    expect(writer.enqueueContinuityUpsert).toHaveBeenCalledWith(
      "u1",
      "o1",
      "s1",
      session.continuity,
    );
    expect(writer.enqueueUsageInsert.mock.calls[0][0]).toMatchObject({
      sessionKey: "s1",
      requestId: "req1",
      provider: "pulse",
      model: "gpt-test",
      tokensIn: 100,
      tokensCached: 50,
      tokensSavedByReduction: 30,
      estimatedCostUsd: 0.04,
      actualCostUsd: 0.03,
      toolCallsCount: 2,
    });
  });

  it("skips optional initial persistence writes when warning and continuity are absent", () => {
    const writer = {
      enqueueSessionUpsert: vi.fn(),
      enqueueSessionEvent: vi.fn(),
      enqueueContinuityUpsert: vi.fn(),
      enqueueUsageInsert: vi.fn(),
    };

    runInitialSessionPersistenceWrites({
      record: record(),
      requestId: "req1",
      writer,
      saveSession: vi.fn(),
      conversationMemoryEnabled: true,
      tokenEconomicsRecommendation: "stable",
      tokenEconomicsWarnings: [],
      tokenEconomicsMetadata: {},
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      costBreakdown: {},
      resolvedModelId: "pulse",
      traceModel: "gpt-test",
      tokensSavedByReduction: 0,
      latencyMs: 0,
      normalizedEstimatedCostUsd: 0,
      normalizedActualCostUsd: 0,
      pricingSource: "provider",
      escalated: false,
      toolCallsCount: 0,
      finishReason: "stop",
    });

    expect(writer.enqueueSessionUpsert).toHaveBeenCalledTimes(1);
    expect(writer.enqueueUsageInsert).toHaveBeenCalledTimes(1);
    expect(writer.enqueueSessionEvent).not.toHaveBeenCalled();
    expect(writer.enqueueContinuityUpsert).not.toHaveBeenCalled();
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

  it("runs trace finalization with metrics and emit callbacks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const metrics = vi.fn();
    const emit = vi.fn();
    const session = record({
      trace_root_prompt: "root prompt",
      latest_user_prompt: "latest prompt",
    });

    const result = runTraceFinalization({
      requestId: "req1",
      record: session,
      parentTraceId: "parent",
      rootTraceId: "root",
      traceModel: "gpt-test",
      resolvedModelId: "pulse",
      backendModel: "backend-test",
      clientRequestedModel: "auto",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cachedTokens: 75,
        cacheCreationTokens: 10,
        costUsd: 0.42,
      },
      normalizedEstimatedCostUsd: 0.5,
      latencyMs: 250,
      tierRates: { inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 0.2 },
      snapshot: {
        decisionPath: "direct",
        phase: "implement",
        tier: "pulse",
        escalated: false,
        policyDecision: "rule_a",
        reducedToolResults: 1,
        tokensSavedByReduction: 12,
        isStreaming: true,
      },
      chatStateSummary: { phase: "implement" },
      fileStateSummary: { stale: 0 },
      objectiveScopeSummary: { epoch_id: 1 },
      stateConfidenceSummary: { overall: 0.9 },
      stateTransitionSummary: { quality_label: "forward" },
      tokenEconomics: { cache: "hit" },
      optimizationLedger: { prefix_hash: "abc" },
      finishReason: "stop",
      recordUsageMetrics: metrics,
      emitTrace: emit,
    });

    expect(result.telemetryUsage).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 25,
      cached_prompt_tokens: 75,
      estimated_cost_usd: 0.5,
      actual_cost_usd: 0.42,
    });
    expect(metrics).toHaveBeenCalledWith("gpt-test", "pulse", result.telemetryUsage, 0.25);
    expect(emit).toHaveBeenCalledWith(result.trace);
    expect(result.trace).toMatchObject({
      trace_id: "req1",
      query_snippet: "root prompt",
      parent_trace_id: "parent",
      root_trace_id: "root",
      streaming: { mode: "streaming" },
      trace_context: {
        phase: "implement",
        root_user_prompt: "root prompt",
        latest_user_prompt: "latest prompt",
        resolved_backend_model: "backend-test",
        registry_tier_id: "pulse",
        state_transition: { quality_label: "forward" },
      },
      optimization_ledger: { prefix_hash: "abc" },
    });
    vi.useRealTimers();
  });

  it("builds state transition summaries", () => {
    const summary = buildStateTransitionSummary({
      stateTransitionRecord: transitionRecord(),
      activeQualityThresholds: thresholds,
      stateTransitionCalibration: calibration(true),
      globalThresholdResolutionAfter: {
        selected_scope: "model",
        selected_thresholds: thresholds,
        org_model_sample_count: 3,
        model_sample_count: 22,
      },
      globalSampleCountAfter: 22,
      globalWeightAfter: 0.3333,
    });

    expect(summary).toMatchObject({
      changed_fields: ["chatPhase"],
      objective_epoch_advanced: true,
      confidence_improved: true,
      stale_files_delta: -1,
      quality_label: "forward_progress",
      quality_score: 0.8,
      quality_calibration_applied: true,
      quality_calibration_sample_count: 13,
      quality_global_scope: "model",
      quality_global_sample_count: 22,
      quality_global_weight: 0.333,
    });
  });

  it("blends state transition quality thresholds with normalized weight", () => {
    expect(blendStateTransitionQualityThresholds(
      thresholds,
      { forward_progress_min: 0.4, regressed_max: -0.1, minimum_gap: 0.2 },
      0.5,
    )).toEqual({
      forward_progress_min: 0.3,
      regressed_max: -0.225,
      minimum_gap: 0.14,
    });
  });

  it("runs state transition calibration and persists metadata updates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const metadata: Record<string, unknown> = {};
    const globalCalibrator = new StateTransitionGlobalCalibrator({
      activationSampleCount: 1,
      backingStore: null,
    });

    const result = runStateTransitionCalibration({
      metadata,
      requestId: "req1",
      orgId: "o1",
      modelId: "pulse",
      previousSnapshot: null,
      currentSnapshot: transitionRecord().to_state,
      toolSequence: ["Read", "apply_patch", "run_test"],
      governorRules: ["verification_after_completion_claim"],
      governorPause: false,
      evidenceDelta: "changed",
      outcomeState: "verified",
      globalCalibrator,
    });

    expect(metadata.state_transition_quality_samples).toEqual([
      expect.objectContaining({
        outcome_state: "verified",
        evidence_delta: "changed",
        governor_pause: false,
      }),
    ]);
    expect(metadata.state_transition_quality_thresholds).toEqual(expect.objectContaining({
      forward_progress_min: expect.any(Number),
      regressed_max: expect.any(Number),
      minimum_gap: expect.any(Number),
    }));
    expect(metadata.state_transition_quality_global_scope).toBe("org_model");
    expect(metadata.state_transition_quality_global_sample_count).toBe(1);
    expect(result.stateTransitionRecord.request_id).toBe("req1");
    expect(result.stateTransitionTrainingRow.schema_version).toBe("state_transition_training_v1");
    expect(result.globalSampleCountAfter).toBe(1);
    expect(result.globalWeightAfter).toBe(0.25);
    vi.useRealTimers();
  });

  it("builds request trajectory events with training signals", () => {
    const event = buildRequestTrajectoryEvent({
      record: record(),
      requestId: "req1",
      traceModel: "gpt-test",
      snapshot: {
        decisionPath: "direct",
        phase: "implement",
        tier: "pulse",
        escalated: false,
        policyDecision: "rule_a,rule_b",
        reducedToolResults: 0,
        tokensSavedByReduction: 0,
        isStreaming: false,
        governor: {
          pause: true,
          reason: "needs verification",
          matchedRules: ["verification_after_completion_claim"],
          telemetry: {
            noEditEvidence: true,
            trailingVerificationRunLength: 3,
            activeGuards: ["false_green_suspected"],
          } as never,
        },
      },
      escalated: false,
      toolSequence: ["Read", "apply_patch"],
      taskBucket: "micro",
      countsByKind: { discovery: 0, evidence: 1, mutation: 1, verification: 0, other: 0 },
      retryCountTotal: 2,
      blindRetryCount: 1,
      filesReadCount: 1,
      filesWrittenCount: 1,
      patchOpsCount: 1,
      wholeWriteOpsCount: 0,
      patchRatio: 1,
      wholeWriteRatio: 0,
      readEditRatio: 1,
      verificationSteps: ["pytest"],
      firstPassVerifyOk: false,
      structuredErrorsCount: 1,
      diagnosticLinesCount: 2,
      structuredErrorCoverage: 0.5,
      completionGateBlocked: true,
      criticBlocked: false,
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 50, cacheCreationTokens: 5, costUsd: 0 },
      tokensSavedByReduction: 30,
      latencyMs: 123,
      tokenEconomics: { cache_policy_state: { last_recommendation: "stable" } },
      outcomeState: "partial",
      failureStage: "verification",
      chatStateSummary: { completion_status: "partial" },
      fileStateSummary: { status: "ok" },
      objectiveScopeSummary: { epoch_id: 1 },
      stateConfidenceSummary: { overall: 0.8 },
      stateTransitionSummary: {
        changed_fields: ["chatPhase"],
        objective_epoch_advanced: true,
        objective_changed: false,
        confidence_improved: true,
        stale_files_delta: 0,
        partial_files_delta: 0,
        evicted_files_delta: 0,
        quality_label: "forward_progress",
        quality_score: 0.8,
        quality_reasons: [],
        recommended_action: "continue",
        quality_thresholds: thresholds,
        quality_calibration_applied: false,
        quality_calibration_sample_count: 1,
        quality_global_scope: "none",
        quality_global_sample_count: 0,
        quality_global_weight: 0,
      },
      evidenceDelta: { changed: true },
      chatPhase: "implement",
      chatCompletionStatus: "partial",
      fileStatusCounts: { stale: 2, partial: 1, evicted: 0 },
      objectiveEpochId: 1,
      objectiveScopeBoundaryIndex: 2,
      objectiveScopeRetainedEvidence: 3,
      objectiveScopeDroppedPreBoundary: 4,
      stateConfidenceOverall: 0.8,
      stateConfidenceNeedsReground: true,
      stateConfidenceReasons: ["stale"],
      stateTransitionRecord: transitionRecord(),
      activeQualityThresholds: thresholds,
      stateTransitionCalibration: calibration(false),
      globalThresholdResolutionAfter: {
        selected_scope: "none",
        selected_thresholds: thresholds,
        org_model_sample_count: 0,
        model_sample_count: 0,
      },
      globalSampleCountAfter: 0,
      prematureStopSignals: 1,
    });

    expect(event).toMatchObject({
      eventKind: "request_trajectory_v1",
      component: "yarn",
      detail: "trajectory partial bucket=micro tools=2",
    });
    const metadata = event.metadataJson as Record<string, Record<string, unknown>>;
    expect(metadata.workflow).toMatchObject({
      decision_path: "direct",
      phase: "implement",
      policy_rules_matched: ["rule_a", "rule_b"],
    });
    expect(metadata.cost).toMatchObject({
      tokens_in: 100,
      tokens_cached: 50,
      cache_hit_ratio: 0.5,
      tokens_saved_by_reduction: 30,
    });
    expect(metadata.training_signals).toMatchObject({
      governor_intervened: true,
      no_edit_evidence: true,
      trailing_verification_stall: true,
      false_green_detected: true,
      premature_stop_signals: 1,
      file_state_stale_count: 2,
    });
  });

  it("builds persistence telemetry event bundles in enqueue order", () => {
    const stateChannelSummary = buildPersistenceStateChannelSummary({
      objective_epoch_id: 1,
      objective_scope_boundary_index: 2,
      objective_scope_retained_evidence: 3,
      state_confidence_overall: 0.8,
      state_confidence_reasons: ["stable"],
    });
    const trajectoryMetrics = buildRequestTrajectoryMetrics({
      trajectory: {
        toolSequence: ["Read", "apply_patch"],
        retryCountTotal: 4,
        diagnostics: { structuredErrorsCount: 1, diagnosticLinesCount: 2 },
      },
      snapshot: {
        decisionPath: "direct",
        phase: "implement",
        tier: "pulse",
        escalated: false,
        policyDecision: "rule_a",
        reducedToolResults: 0,
        tokensSavedByReduction: 0,
        isStreaming: false,
      },
      finishReason: "stop",
    });
    const bundle = buildPersistenceTelemetryEventBundle({
      record: record(),
      requestId: "req1",
      traceModel: "pulse",
      snapshot: {
        decisionPath: "direct",
        phase: "implement",
        tier: "pulse",
        escalated: false,
        policyDecision: "rule_a",
        reducedToolResults: 0,
        tokensSavedByReduction: 0,
        isStreaming: false,
      },
      escalated: false,
      trajectory: { retryCountTotal: 4 },
      trajectoryMetrics,
      blindRetryCount: 1,
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 50, cacheCreationTokens: 5, costUsd: 0 },
      tokensSavedByReduction: 30,
      latencyMs: 123,
      tokenEconomics: { cache_policy_state: { last_recommendation: "stable" } },
      chatStateSummary: { completion_status: "partial" },
      fileStateSummary: { status: "ok" },
      objectiveScopeSummary: stateChannelSummary.objectiveScopeSummary,
      stateConfidenceSummary: stateChannelSummary.stateConfidenceSummary,
      evidenceDelta: "changed",
      chatPhase: "implement",
      chatCompletionStatus: "partial",
      fileStatusCounts: { stale: 2, partial: 1, evicted: 0 },
      stateChannelSummary,
      stateTransitionCalibrationRun: {
        persistedQualityThresholds: thresholds,
        globalThresholdResolutionBefore: {
          selected_scope: "none",
          selected_thresholds: thresholds,
          org_model_sample_count: 0,
          model_sample_count: 0,
        },
        globalThresholdResolutionAfter: {
          selected_scope: "model",
          selected_thresholds: thresholds,
          org_model_sample_count: 2,
          model_sample_count: 20,
        },
        globalCalibrationObservation: {
          resolution: {
            selected_scope: "model",
            selected_thresholds: thresholds,
            org_model_sample_count: 2,
            model_sample_count: 20,
          },
          org_model_calibration: calibration(false),
          model_calibration: calibration(false),
        },
        globalSampleCountAfter: 20,
        globalWeightAfter: 0.33,
        activeQualityThresholds: thresholds,
        stateTransitionRecord: transitionRecord(),
        stateTransitionTrainingRow: {
          schema_version: "state_transition_training_v1",
          request_id: "req1",
          quality_label: "forward_progress",
          quality_score: 0.8,
          quality_reasons: [],
          recommended_action: "continue",
          outcome_state: "verified",
          evidence_delta: "changed",
          governor_pause: false,
          objective_epoch_advanced: true,
          objective_changed: false,
          confidence_delta: 0.2,
          stale_files_delta: -1,
          partial_files_delta: 0,
          evicted_files_delta: 0,
          unresolved_corrections_delta: 0,
          resolved_corrections_delta: 0,
        },
        stateTransitionCalibration: calibration(false),
        thresholdShift: 0,
        globalThresholdShift: 0,
      },
    });

    expect(bundle.stateTransitionSummary).toMatchObject({
      quality_label: "forward_progress",
      quality_global_scope: "model",
      quality_global_sample_count: 20,
    });
    expect(bundle.sessionEvents.map((event) => event.eventKind)).toEqual([
      "request_trajectory_v1",
      "state_transition_v1",
    ]);
    expect(bundle.sessionEvents[0].metadataJson.tools).toMatchObject({
      retry_count_total: 4,
    });
    expect(bundle.sessionEvents[0].metadataJson.training_signals).toMatchObject({
      evidence_delta: "changed",
      state_transition_quality_label: "forward_progress",
    });
  });

  it("classifies and infers request trajectory metrics", () => {
    expect(classifyTrajectoryToolKind("search_repo")).toBe("discovery");
    expect(classifyTrajectoryToolKind("Read")).toBe("evidence");
    expect(classifyTrajectoryToolKind("apply_patch")).toBe("mutation");
    expect(classifyTrajectoryToolKind("run_test")).toBe("verification");
    expect(classifyTrajectoryToolKind("Question")).toBe("other");
    expect(countEditsFromToolSequence(["Read", "apply_patch", "write", "edit"])).toEqual({
      patchOps: 2,
      wholeWriteOps: 1,
    });
    expect(countReadOpsFromToolSequence(["Read", "read_file", "Bash"])).toBe(2);
    expect(inferTrajectoryBucket(["Read"], 0, 0)).toBe("investigation");
    expect(inferTrajectoryBucket(["Read", "apply_patch"], 1, 0)).toBe("micro");
    expect(inferTrajectoryBucket(Array.from({ length: 12 }, (_, index) => `tool_${index}`), 0, 1)).toBe("feature");
    expect(inferPrematureStopSignalsFromGovernor([
      "verbal_intent_without_action",
      "verbal_intent_without_action",
      "other",
      "completion_claim_requires_task_update",
    ])).toBe(2);
  });

  it("builds request trajectory metrics with explicit overrides and defaults", () => {
    const metrics = buildRequestTrajectoryMetrics({
      trajectory: {
        toolSequence: ["Read", "apply_patch", "run_test"],
        bytesReadTotal: -10,
        diagnostics: { structuredErrorsCount: 2, diagnosticLinesCount: 4 },
        completionGateBlocked: true,
      },
      snapshot: {
        decisionPath: "direct",
        phase: "implement",
        tier: "pulse",
        escalated: false,
        policyDecision: "",
        reducedToolResults: 0,
        tokensSavedByReduction: 0,
        isStreaming: false,
        verificationRound: 2,
        governor: {
          pause: true,
          reason: "stop",
          matchedRules: ["verification_after_completion_claim"],
          telemetry: {} as never,
        },
      },
      finishReason: "stop",
    });

    expect(metrics).toMatchObject({
      toolSequence: ["Read", "apply_patch", "run_test"],
      patchOpsCount: 1,
      wholeWriteOpsCount: 0,
      filesWrittenCount: 1,
      filesReadCount: 1,
      bytesReadTotal: 0,
      readEditRatio: 1,
      patchRatio: 1,
      wholeWriteRatio: 0,
      prematureStopSignals: 1,
      verificationSteps: [],
      countsByKind: { evidence: 1, mutation: 1, verification: 1 },
      taskBucket: "micro",
      firstPassVerifyOk: false,
      structuredErrorCoverage: 0.5,
      completionGateBlocked: true,
      outcomeState: "partial",
      failureStage: "verification",
    });
  });

  it("builds persistence state channel summaries from session metadata", () => {
    const summary = buildPersistenceStateChannelSummary({
      objective_epoch_id: 3,
      objective_scope_boundary_index: 9,
      objective_scope_retained_evidence: 4,
      objective_scope_dropped_pre_boundary: 2,
      state_confidence_chat: "0.75",
      state_confidence_file: 0.5,
      state_confidence_overall: 0.66,
      state_confidence_needs_reground: true,
      state_confidence_recommended_path: "src/index.ts",
      state_confidence_reasons: ["stale-file", 42],
    });

    expect(summary).toMatchObject({
      objectiveEpochId: 3,
      objectiveScopeBoundaryIndex: 9,
      objectiveScopeRetainedEvidence: 4,
      objectiveScopeDroppedPreBoundary: 2,
      objectiveScopeSummary: {
        epoch_id: 3,
        boundary_index: 9,
        retained_evidence: 4,
        dropped_pre_boundary: 2,
      },
      stateConfidenceChat: 0.75,
      stateConfidenceFile: 0.5,
      stateConfidenceOverall: 0.66,
      stateConfidenceNeedsReground: true,
      stateConfidenceRecommendedPath: "src/index.ts",
      stateConfidenceReasons: ["stale-file", "42"],
      stateConfidenceSummary: {
        chat: 0.75,
        file: 0.5,
        overall: 0.66,
        needs_reground: true,
        recommended_path: "src/index.ts",
        reasons: ["stale-file", "42"],
      },
    });
  });

  it("omits objective and confidence summaries when metadata is absent", () => {
    const summary = buildPersistenceStateChannelSummary({});

    expect(summary.objectiveScopeSummary).toBeUndefined();
    expect(summary.stateConfidenceSummary).toBeUndefined();
    expect(summary.objectiveEpochId).toBe(0);
    expect(summary.objectiveScopeBoundaryIndex).toBe(-1);
    expect(summary.stateConfidenceNeedsReground).toBe(false);
    expect(summary.stateConfidenceReasons).toEqual([]);
  });

  it("prepares persistence state channels from persisted metadata", () => {
    const prepared = preparePersistenceStateChannels({
      chat_state_snapshot: {
        activeObjective: "Ship the persistence extraction",
        pendingUserDirective: "keep going",
        phase: "verify",
        completionStatus: "blocked",
        lastVerificationOutcome: "fail",
        unresolvedCorrectionCount: 2,
        resolvedCorrectionCount: 1,
        transcriptSummary: "summary",
        updatedAt: 10,
      },
      file_state_snapshot: {
        fileCount: 3,
        statusCounts: {
          available: 1,
          partial: 1,
          unchanged: 0,
          stale: 1,
          evicted: 0,
          missing: 0,
        },
        staleFiles: ["src/a.ts", "src/b.ts"],
        partialFiles: ["src/c.ts"],
        evictedFiles: [],
        updatedAt: 11,
      },
      objective_epoch_id: 2,
      objective_scope_boundary_index: 4,
      objective_scope_retained_evidence: 5,
      objective_scope_dropped_pre_boundary: 1,
      state_confidence_overall: 0.7,
      state_confidence_needs_reground: true,
      state_confidence_reasons: ["stale"],
    });

    expect(prepared.persistedChatSnapshot).toMatchObject({
      phase: "verify",
      completionStatus: "blocked",
      lastVerificationOutcome: "fail",
      unresolvedCorrectionCount: 2,
      resolvedCorrectionCount: 1,
    });
    expect(prepared.chatStateSummary).toMatchObject({
      active_objective: "Ship the persistence extraction",
      pending_user_directive: "keep going",
      completion_status: "blocked",
      last_verification_outcome: "fail",
      narration_residue_present: false,
    });
    expect(prepared.fileStateSummary).toMatchObject({
      files_total: 3,
      stale_files: ["src/a.ts", "src/b.ts"],
      partial_files: ["src/c.ts"],
    });
    expect(prepared.objectiveScopeSummary).toMatchObject({
      epoch_id: 2,
      boundary_index: 4,
      retained_evidence: 5,
      dropped_pre_boundary: 1,
    });
    expect(prepared.stateConfidenceSummary).toMatchObject({
      overall: 0.7,
      needs_reground: true,
      reasons: ["stale"],
    });
  });

  it("omits invalid persisted chat summaries while retaining file and state summaries", () => {
    const prepared = preparePersistenceStateChannels({
      chat_state_snapshot: {
        phase: "implement",
        completionStatus: "done",
        lastVerificationOutcome: "passed",
      },
      file_state_snapshot: {
        fileCount: "bad",
        statusCounts: { stale: 2 },
        staleFiles: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      },
    });

    expect(prepared.persistedChatSnapshot).toBeNull();
    expect(prepared.chatStateSummary).toBeUndefined();
    expect(prepared.persistedFileSnapshot).toMatchObject({
      fileCount: 0,
      staleFiles: ["a", "b", "c", "d", "e", "f", "g", "h"],
    });
    expect(prepared.fileStateSummary).toMatchObject({
      files_total: 0,
      stale_files: ["a", "b", "c", "d", "e", "f", "g", "h"],
    });
  });

  it("builds hourly token throttle events only on threshold crossings", () => {
    const events = buildHourlyTokenThrottleEvents({
      record: record(),
      requestId: "req1",
      snapshot: {
        sessionTokensInWindow: 1_500,
        userTokensInWindow: 3_000,
      },
      previousSessionWindowTokens: 900,
      previousUserWindowTokens: 2_500,
      windowMs: 3_600_000,
      sessionLimit: 1_000,
      userLimit: 2_000,
    });

    expect(events.map((event) => event.metadataJson?.scope)).toEqual(["session"]);
    expect(events[0]).toMatchObject({
      sessionKey: "s1",
      requestId: "req1",
      eventKind: "hourly_token_throttle_warn",
      component: "token-throttle",
      detail: "Session input tokens in rolling 60m window exceeded 1,000 (used: 1,500)",
      metadataJson: {
        scope: "session",
        mode: "audit",
        window_ms: 3_600_000,
        limit_tokens: 1_000,
        observed_tokens: 1_500,
      },
    });
  });

  it("builds both hourly throttle events when both scopes cross limits", () => {
    const events = buildHourlyTokenThrottleEvents({
      record: record(),
      requestId: "req1",
      snapshot: {
        sessionTokensInWindow: 1_500,
        userTokensInWindow: 3_000,
      },
      previousSessionWindowTokens: 900,
      previousUserWindowTokens: 1_900,
      windowMs: 60_000,
      sessionLimit: 1_000,
      userLimit: 2_000,
    });

    expect(events.map((event) => event.metadataJson?.scope)).toEqual(["session", "user"]);
    expect(events[1].detail).toBe("User input tokens in rolling 1m window exceeded 2,000 (used: 3,000)");
  });

  it("runs hourly token throttle updates and persists new window metadata", async () => {
    const session = record({
      hourly_tokens_session: 900,
      hourly_tokens_user: 1_900,
    });
    const counter = {
      addInputTokensAndReadHourlyWindow: vi.fn().mockResolvedValue({
        sessionTokensInWindow: 1_500,
        userTokensInWindow: 3_000,
      }),
    };
    const recordEvent = vi.fn();
    const saveSession = vi.fn();

    await runHourlyTokenThrottleUpdate({
      enabled: true,
      record: session,
      requestId: "req1",
      inputTokens: 100,
      counter,
      windowMs: 60_000,
      sessionLimit: 1_000,
      userLimit: 2_000,
      recordEvent,
      saveSession,
    });

    expect(counter.addInputTokensAndReadHourlyWindow).toHaveBeenCalledWith("s1", "u1", 100);
    expect(session.metadata.hourly_tokens_session).toBe(1_500);
    expect(session.metadata.hourly_tokens_user).toBe(3_000);
    expect(recordEvent).toHaveBeenCalledTimes(2);
    expect(recordEvent.mock.calls.map(([event]) => event.metadataJson.scope)).toEqual(["session", "user"]);
    expect(saveSession).toHaveBeenCalledTimes(1);
  });

  it("skips hourly token throttle updates when disabled or there are no input tokens", async () => {
    const counter = {
      addInputTokensAndReadHourlyWindow: vi.fn().mockResolvedValue(null),
    };
    const recordEvent = vi.fn();
    const saveSession = vi.fn();

    expect(runHourlyTokenThrottleUpdate({
      enabled: false,
      record: record(),
      requestId: "req1",
      inputTokens: 100,
      counter,
      windowMs: 60_000,
      sessionLimit: 1_000,
      userLimit: 2_000,
      recordEvent,
      saveSession,
    })).toBeNull();
    expect(runHourlyTokenThrottleUpdate({
      enabled: true,
      record: record(),
      requestId: "req1",
      inputTokens: 0,
      counter,
      windowMs: 60_000,
      sessionLimit: 1_000,
      userLimit: 2_000,
      recordEvent,
      saveSession,
    })).toBeNull();

    expect(counter.addInputTokensAndReadHourlyWindow).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(saveSession).not.toHaveBeenCalled();
  });

  it("builds state transition event set with optional calibration events", () => {
    const events = buildStateTransitionEvents({
      record: record(),
      requestId: "req1",
      stateTransitionRecord: transitionRecord(),
      stateTransitionTrainingRow: {
        schema_version: "state_transition_training_v1",
        request_id: "req1",
        quality_label: "forward_progress",
        quality_score: 0.8,
        quality_reasons: [],
        recommended_action: "continue",
        outcome_state: "verified",
        evidence_delta: { changed: true },
        governor_pause: false,
        objective_epoch_advanced: true,
        objective_changed: false,
        confidence_delta: 0.2,
        stale_files_delta: -1,
        partial_files_delta: 0,
        evicted_files_delta: 0,
        unresolved_corrections_delta: 0,
        resolved_corrections_delta: 0,
      } as never,
      activeQualityThresholds: thresholds,
      stateTransitionCalibration: calibration(true),
      globalThresholdResolutionAfter: {
        selected_scope: "model",
        selected_thresholds: thresholds,
        org_model_sample_count: 2,
        model_sample_count: 20,
      },
      globalCalibrationObservation: {
        resolution: {
          selected_scope: "model",
          selected_thresholds: thresholds,
          org_model_sample_count: 2,
          model_sample_count: 20,
        },
        org_model_calibration: calibration(false),
        model_calibration: calibration(true),
      },
      thresholdShift: 0.02,
      globalThresholdShift: 0.03,
      globalSampleCountAfter: 20,
    });

    expect(events.map((event) => event.eventKind)).toEqual([
      "state_transition_v1",
      "state_transition_quality_calibration_v1",
      "state_transition_quality_global_calibration_v1",
    ]);
    expect(events[0].metadataJson).toMatchObject({
      schema_version: "state_transition_v1",
      training_row: { schema_version: "state_transition_training_v1" },
      quality_global_calibration: {
        model: { applied: true },
      },
    });
  });
});
