import { describe, expect, it } from "vitest";
import {
  computeEvidenceDelta,
  summarizeEvidenceDelta,
  evidenceDeltaStreakAdjustment,
  type TurnEvidenceDelta,
} from "../src/governance/evidence-delta.js";
import type { CommandEvent } from "../src/governance/execution-governor.js";

function bashEvent(command: string, resultSignature: string): CommandEvent {
  return { command, toolName: "bash", resultSignature, argsObject: null };
}

describe("computeEvidenceDelta", () => {
  it("detects stalled when same failure signature repeats", () => {
    const sig = "error: imported and not used 'fmt' in file.go";
    const events: CommandEvent[] = [
      bashEvent("go test ./...", sig),
    ];
    const seen = new Set<string>();
    const delta = computeEvidenceDelta(events, ["file.go"], seen, sig);
    expect(delta.signatureChanged).toBe(false);
    expect(delta.currentFailureSignature).toBe(sig);
    expect(delta.previousFailureSignature).toBe(sig);
    expect(delta.regressionDetected).toBe(false);
  });

  it("detects improvement when error count decreases", () => {
    const prev = "error: x\nerror: y\nerror: z";
    const curr = "error: x";
    const events: CommandEvent[] = [
      bashEvent("go test ./...", curr),
    ];
    const seen = new Set<string>();
    const delta = computeEvidenceDelta(events, [], seen, prev);
    expect(delta.signatureChanged).toBe(true);
    expect(delta.failureCountDelta).toBeLessThan(0);
  });

  it("detects regression when a previously-seen signature returns", () => {
    const sigA = "error: undefined foo in bar.go";
    const sigB = "error: type mismatch in baz.go";
    const seen = new Set([sigA]);
    const events: CommandEvent[] = [
      bashEvent("go test ./...", sigA),
    ];
    const delta = computeEvidenceDelta(events, [], seen, sigB);
    expect(delta.regressionDetected).toBe(true);
    expect(delta.signatureChanged).toBe(true);
  });

  it("detects new artifact creation for test files", () => {
    const events: CommandEvent[] = [
      { command: "tool:write", toolName: "write", resultSignature: "ok", argsObject: { path: "pkg/handler_test.go" } },
      bashEvent("go test ./pkg/handler/...", "PASS"),
    ];
    const delta = computeEvidenceDelta(events, ["pkg/handler.go"], new Set(), null);
    expect(delta.newArtifactCreated).toBe(true);
  });

  it("reports no failure when verification passes", () => {
    const events: CommandEvent[] = [
      bashEvent("go test ./...", "ok  pkg/handler 0.3s"),
    ];
    const delta = computeEvidenceDelta(events, [], new Set(), "error: old failure");
    expect(delta.currentFailureSignature).toBeNull();
    expect(delta.signatureChanged).toBe(true);
  });

  it("accumulates signatures in seenSignatures set", () => {
    const seen = new Set<string>();
    const sig1 = "error: cannot find symbol Foo";
    const sig2 = "error: type mismatch at Bar";
    computeEvidenceDelta([bashEvent("go test ./...", sig1)], [], seen, null);
    expect(seen.has(sig1)).toBe(true);
    computeEvidenceDelta([bashEvent("go test ./...", sig2)], [], seen, sig1);
    expect(seen.has(sig2)).toBe(true);
    expect(seen.size).toBe(2);
  });

  it("handles empty events gracefully", () => {
    const delta = computeEvidenceDelta([], [], new Set(), null);
    expect(delta.currentFailureSignature).toBeNull();
    expect(delta.signatureChanged).toBe(false);
    expect(delta.failureCountDelta).toBe(0);
  });
});

describe("summarizeEvidenceDelta", () => {
  it("returns 'regressed' when regressionDetected", () => {
    const delta: TurnEvidenceDelta = {
      previousFailureSignature: "a", currentFailureSignature: "b",
      signatureChanged: true, failureCountDelta: 0,
      changedFilesIntersectImplicated: false, verificationCoversChangedFiles: false,
      newArtifactCreated: false, seenSignatures: new Set(), regressionDetected: true,
    };
    expect(summarizeEvidenceDelta(delta)).toBe("regressed");
  });

  it("returns 'stalled' when same signature replays", () => {
    const delta: TurnEvidenceDelta = {
      previousFailureSignature: "a", currentFailureSignature: "a",
      signatureChanged: false, failureCountDelta: 0,
      changedFilesIntersectImplicated: false, verificationCoversChangedFiles: false,
      newArtifactCreated: false, seenSignatures: new Set(), regressionDetected: false,
    };
    expect(summarizeEvidenceDelta(delta)).toBe("stalled");
  });

  it("returns 'improved' when error count decreases", () => {
    const delta: TurnEvidenceDelta = {
      previousFailureSignature: "a", currentFailureSignature: "b",
      signatureChanged: true, failureCountDelta: -2,
      changedFilesIntersectImplicated: false, verificationCoversChangedFiles: false,
      newArtifactCreated: false, seenSignatures: new Set(), regressionDetected: false,
    };
    expect(summarizeEvidenceDelta(delta)).toBe("improved");
  });

  it("returns 'changed' when signature changed but count same", () => {
    const delta: TurnEvidenceDelta = {
      previousFailureSignature: "a", currentFailureSignature: "b",
      signatureChanged: true, failureCountDelta: 0,
      changedFilesIntersectImplicated: false, verificationCoversChangedFiles: false,
      newArtifactCreated: false, seenSignatures: new Set(), regressionDetected: false,
    };
    expect(summarizeEvidenceDelta(delta)).toBe("changed");
  });

  it("returns 'unknown' for null delta", () => {
    expect(summarizeEvidenceDelta(null)).toBe("unknown");
  });
});

describe("evidenceDeltaStreakAdjustment", () => {
  it("returns +2 for regression", () => {
    const delta: TurnEvidenceDelta = {
      previousFailureSignature: "a", currentFailureSignature: "b",
      signatureChanged: true, failureCountDelta: 0,
      changedFilesIntersectImplicated: false, verificationCoversChangedFiles: false,
      newArtifactCreated: false, seenSignatures: new Set(), regressionDetected: true,
    };
    expect(evidenceDeltaStreakAdjustment(delta)).toBe(2);
  });

  it("returns +1 for stalled", () => {
    const delta: TurnEvidenceDelta = {
      previousFailureSignature: "a", currentFailureSignature: "a",
      signatureChanged: false, failureCountDelta: 0,
      changedFilesIntersectImplicated: false, verificationCoversChangedFiles: false,
      newArtifactCreated: false, seenSignatures: new Set(), regressionDetected: false,
    };
    expect(evidenceDeltaStreakAdjustment(delta)).toBe(1);
  });

  it("returns -2 for improvement", () => {
    const delta: TurnEvidenceDelta = {
      previousFailureSignature: "a", currentFailureSignature: "b",
      signatureChanged: true, failureCountDelta: -1,
      changedFilesIntersectImplicated: false, verificationCoversChangedFiles: false,
      newArtifactCreated: false, seenSignatures: new Set(), regressionDetected: false,
    };
    expect(evidenceDeltaStreakAdjustment(delta)).toBe(-2);
  });

  it("returns -1 for new artifact creation", () => {
    const delta: TurnEvidenceDelta = {
      previousFailureSignature: null, currentFailureSignature: null,
      signatureChanged: false, failureCountDelta: 0,
      changedFilesIntersectImplicated: false, verificationCoversChangedFiles: false,
      newArtifactCreated: true, seenSignatures: new Set(), regressionDetected: false,
    };
    expect(evidenceDeltaStreakAdjustment(delta)).toBe(-1);
  });

  it("returns 0 for null delta", () => {
    expect(evidenceDeltaStreakAdjustment(null)).toBe(0);
  });
});
