import { describe, expect, it, vi } from "vitest";
import {
  applySessionUsagePersistenceMutation,
  buildRequestTrajectoryEvent,
  buildStateTransitionEvents,
  buildStateTransitionSummary,
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
