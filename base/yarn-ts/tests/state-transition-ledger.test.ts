import { describe, expect, it } from "vitest";

import {
  buildStateTransitionRecord,
  buildStateTransitionSnapshotFromMetadata,
  decodeStateTransitionSnapshot,
  encodeStateTransitionSnapshot,
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
  });
});
