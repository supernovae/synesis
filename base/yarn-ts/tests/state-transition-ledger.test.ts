import { describe, expect, it } from "vitest";

import {
  assessStateTransitionQuality,
  buildStateTransitionCalibrationSample,
  buildStateTransitionRecord,
  buildStateTransitionSnapshotFromMetadata,
  calibrateStateTransitionQualityThresholds,
  decodeStateTransitionCalibrationSamples,
  decodeStateTransitionQualityThresholds,
  encodeStateTransitionCalibrationSamples,
  encodeStateTransitionQualityThresholds,
  decodeStateTransitionSnapshot,
  DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS,
  encodeStateTransitionSnapshot,
  materializeStateTransitionTrainingRow,
  summarizeStateTransition,
  type StateTransitionSnapshot,
} from "../src/governance/state-transition-ledger.js";

function makeSnapshot(overrides: Partial<StateTransitionSnapshot>): StateTransitionSnapshot {
  return {
    objectiveEpochId: 1,
    objectiveHash: "hash-1",
    chatPhase: "edit",
    completionStatus: "in_progress",
    verificationOutcome: "unknown",
    unresolvedCorrectionCount: 1,
    resolvedCorrectionCount: 0,
    fileStatusCounts: {
      available: 2,
      partial: 1,
      unchanged: 0,
      stale: 2,
      evicted: 0,
      missing: 0,
    },
    confidenceOverall: 0.45,
    confidenceNeedsReground: true,
    confidenceReasons: ["stale_file_snapshot_present"],
    scopeBoundaryIndex: 10,
    scopeRetainedEvidence: 2,
    scopeDroppedPreBoundary: 8,
    ...overrides,
  };
}

describe("state transition ledger", () => {
  it("builds snapshot from metadata payloads", () => {
    const snapshot = buildStateTransitionSnapshotFromMetadata({
      objective_epoch_id: 3,
      objective_epoch_objective_hash: "abc123",
      objective_scope_boundary_index: 42,
      objective_scope_retained_evidence: 3,
      objective_scope_dropped_pre_boundary: 12,
      state_confidence_overall: 0.71,
      state_confidence_needs_reground: false,
      state_confidence_reasons: ["ok"],
      chat_state_snapshot: {
        phase: "verify",
        completionStatus: "ready_to_finalize",
        lastVerificationOutcome: "pass",
        unresolvedCorrectionCount: 0,
        resolvedCorrectionCount: 2,
      },
      file_state_snapshot: {
        statusCounts: {
          available: 4,
          partial: 1,
          unchanged: 2,
          stale: 0,
          evicted: 0,
          missing: 0,
        },
      },
    });

    expect(snapshot.objectiveEpochId).toBe(3);
    expect(snapshot.chatPhase).toBe("verify");
    expect(snapshot.completionStatus).toBe("ready_to_finalize");
    expect(snapshot.fileStatusCounts.available).toBe(4);
    expect(snapshot.confidenceOverall).toBe(0.71);
    expect(snapshot.scopeBoundaryIndex).toBe(42);
  });

  it("round-trips encoded snapshots", () => {
    const snapshot = makeSnapshot({
      objectiveEpochId: 5,
      confidenceOverall: 0.62,
      confidenceNeedsReground: false,
    });
    const encoded = encodeStateTransitionSnapshot(snapshot);
    const decoded = decodeStateTransitionSnapshot(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded?.objectiveEpochId).toBe(5);
    expect(decoded?.confidenceOverall).toBe(0.62);
    expect(decoded?.fileStatusCounts.stale).toBe(2);
  });

  it("computes transition deltas for training-grade signals", () => {
    const previous = makeSnapshot({
      objectiveEpochId: 2,
      objectiveHash: "hash-old",
      completionStatus: "in_progress",
      verificationOutcome: "fail",
      unresolvedCorrectionCount: 2,
      resolvedCorrectionCount: 0,
      fileStatusCounts: {
        available: 1,
        partial: 2,
        unchanged: 0,
        stale: 3,
        evicted: 1,
        missing: 0,
      },
      confidenceOverall: 0.41,
    });
    const current = makeSnapshot({
      objectiveEpochId: 3,
      objectiveHash: "hash-new",
      completionStatus: "ready_to_finalize",
      verificationOutcome: "pass",
      unresolvedCorrectionCount: 0,
      resolvedCorrectionCount: 2,
      fileStatusCounts: {
        available: 3,
        partial: 0,
        unchanged: 1,
        stale: 1,
        evicted: 0,
        missing: 0,
      },
      confidenceOverall: 0.77,
      confidenceNeedsReground: false,
    });

    const record = buildStateTransitionRecord({
      requestId: "req-123",
      previousSnapshot: previous,
      currentSnapshot: current,
      toolSequence: ["Read", "Edit", "Bash"],
      governorRules: ["allow"],
      governorPause: false,
      evidenceDelta: "improved",
      outcomeState: "verified",
    });

    expect(record.delta.objective_epoch_advanced).toBe(true);
    expect(record.delta.objective_changed).toBe(true);
    expect(record.delta.completion_status_changed).toBe(true);
    expect(record.delta.verification_outcome_changed).toBe(true);
    expect(record.delta.unresolved_corrections_delta).toBe(-2);
    expect(record.delta.stale_files_delta).toBe(-2);
    expect(record.delta.confidence_improved).toBe(true);
    expect(record.delta.changed_fields).toContain("file_status_counts");
    expect(summarizeStateTransition(record)).toContain("epoch=2->3");
    expect(record.quality.label).toBe("forward_progress");
    expect(record.quality.score).toBeGreaterThan(0);
  });

  it("labels reground-required transitions deterministically", () => {
    const quality = assessStateTransitionQuality({
      delta: {
        changed_fields: ["reground_gate"],
        objective_epoch_advanced: false,
        objective_changed: false,
        completion_status_changed: false,
        verification_outcome_changed: false,
        unresolved_corrections_delta: 0,
        resolved_corrections_delta: 0,
        stale_files_delta: 0,
        partial_files_delta: 0,
        evicted_files_delta: 0,
        confidence_delta: -0.12,
        confidence_improved: false,
      },
      toState: makeSnapshot({
        confidenceNeedsReground: true,
        confidenceOverall: 0.28,
      }),
      event: {
        tool_sequence: ["Read"],
        governor_rules: [],
        governor_pause: false,
        evidence_delta: "stalled",
        outcome_state: "partial",
      },
    });

    expect(quality.label).toBe("reground_required");
    expect(quality.recommended_action).toBe("reground");
    expect(quality.reasons).toContain("reground_required");
  });

  it("materializes compact training rows with quality labels", () => {
    const record = buildStateTransitionRecord({
      requestId: "req-training-row",
      previousSnapshot: makeSnapshot({
        confidenceOverall: 0.44,
        confidenceNeedsReground: true,
        fileStatusCounts: {
          available: 1,
          partial: 1,
          unchanged: 0,
          stale: 2,
          evicted: 1,
          missing: 0,
        },
      }),
      currentSnapshot: makeSnapshot({
        confidenceOverall: 0.72,
        confidenceNeedsReground: false,
        unresolvedCorrectionCount: 0,
        resolvedCorrectionCount: 2,
        fileStatusCounts: {
          available: 3,
          partial: 0,
          unchanged: 0,
          stale: 0,
          evicted: 0,
          missing: 0,
        },
      }),
      toolSequence: ["Read", "Edit", "Bash"],
      governorRules: [],
      governorPause: false,
      evidenceDelta: "improved",
      outcomeState: "verified",
    });

    const row = materializeStateTransitionTrainingRow(record);
    expect(row.schema_version).toBe("state_transition_training_v1");
    expect(row.quality_label).toBe("forward_progress");
    expect(row.quality_score).toBeGreaterThan(0);
    expect(row.stale_files_delta).toBeLessThan(0);
  });

  it("supports calibrated threshold overrides when scoring labels", () => {
    const quality = assessStateTransitionQuality({
      delta: {
        changed_fields: ["confidence"],
        objective_epoch_advanced: false,
        objective_changed: false,
        completion_status_changed: false,
        verification_outcome_changed: false,
        unresolved_corrections_delta: 0,
        resolved_corrections_delta: 0,
        stale_files_delta: 0,
        partial_files_delta: 0,
        evicted_files_delta: 0,
        confidence_delta: 0.02,
        confidence_improved: false,
      },
      toState: makeSnapshot({
        confidenceNeedsReground: false,
      }),
      event: {
        tool_sequence: ["Read"],
        governor_rules: [],
        governor_pause: false,
        evidence_delta: "changed",
        outcome_state: "partial",
      },
      thresholds: {
        forward_progress_min: 0.01,
        regressed_max: -0.25,
        minimum_gap: 0.08,
      },
    });

    expect(quality.label).toBe("forward_progress");
  });

  it("calibrates thresholds from observed positive/negative samples", () => {
    const report = calibrateStateTransitionQualityThresholds({
      baseThresholds: DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS,
      minSamples: 8,
      minPositive: 3,
      minNegative: 3,
      smoothing: 0.6,
      samples: [
        { quality_score: 0.72, outcome_state: "verified", evidence_delta: "improved", governor_pause: false, needs_reground: false },
        { quality_score: 0.61, outcome_state: "verified", evidence_delta: "improved", governor_pause: false, needs_reground: false },
        { quality_score: 0.55, outcome_state: "completed", evidence_delta: "changed", governor_pause: false, needs_reground: false },
        { quality_score: -0.62, outcome_state: "stalled", evidence_delta: "regressed", governor_pause: true, needs_reground: false },
        { quality_score: -0.51, outcome_state: "stalled", evidence_delta: "stalled", governor_pause: true, needs_reground: false },
        { quality_score: -0.42, outcome_state: "partial", evidence_delta: "regressed", governor_pause: false, needs_reground: false },
        { quality_score: 0.12, outcome_state: "partial", evidence_delta: "changed", governor_pause: false, needs_reground: false },
        { quality_score: -0.05, outcome_state: "partial", evidence_delta: "unknown", governor_pause: false, needs_reground: false },
      ],
    });

    expect(report.applied).toBe(true);
    expect(report.sample_count).toBe(8);
    expect(report.calibrated_thresholds.forward_progress_min).toBeGreaterThan(
      DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS.forward_progress_min,
    );
    expect(report.calibrated_thresholds.regressed_max).toBeLessThan(
      DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS.regressed_max,
    );
  });

  it("round-trips encoded threshold and sample metadata", () => {
    const thresholds = decodeStateTransitionQualityThresholds(encodeStateTransitionQualityThresholds({
      forward_progress_min: 0.24,
      regressed_max: -0.4,
      minimum_gap: 0.09,
    }));
    expect(thresholds?.forward_progress_min).toBe(0.24);
    expect(thresholds?.regressed_max).toBe(-0.4);

    const row = buildStateTransitionRecord({
      requestId: "req-sample-roundtrip",
      previousSnapshot: makeSnapshot({ confidenceNeedsReground: false, confidenceOverall: 0.5 }),
      currentSnapshot: makeSnapshot({ confidenceNeedsReground: false, confidenceOverall: 0.6 }),
      toolSequence: ["Read"],
      governorRules: [],
      governorPause: false,
      evidenceDelta: "changed",
      outcomeState: "partial",
    });
    const sample = buildStateTransitionCalibrationSample(row);
    const encoded = encodeStateTransitionCalibrationSamples([sample], 8);
    const decoded = decodeStateTransitionCalibrationSamples(encoded, 8);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].quality_score).toBe(sample.quality_score);
    expect(decoded[0].outcome_state).toBe(sample.outcome_state);
  });
});
