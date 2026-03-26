import { describe, expect, it } from "vitest";
import { detectOscillation } from "../src/nodes/oscillation-detector.js";

describe("detectOscillation", () => {
  it("returns zero-ish score for calm state", () => {
    const report = detectOscillation({
      generated_code: "# Title\n\nAnswer.",
      draft_fingerprints: ["a", "a"]
    });
    expect(report.total_score).toBeGreaterThanOrEqual(0);
    expect(report.total_score).toBeLessThan(0.2);
  });

  it("increases score for repeated decision overrides", () => {
    const report = detectOscillation({
      override_log: [
        { target_decision_id: "d1", approved: false, override_reason: "" },
        { target_decision_id: "d1", approved: false, override_reason: "" },
        { target_decision_id: "d1", approved: false, override_reason: "" }
      ]
    });
    expect(report.decision_score).toBeGreaterThan(0.5);
    expect(report.unsupported_overrides).toBe(3);
  });

  it("flags duplicate H1 title drift strongly", () => {
    const report = detectOscillation({
      generated_code: "# Title\n\nA\n\n# Title\n\nB",
      draft_fingerprints: ["a", "b", "c"]
    });
    expect(report.content_drift).toBe(1);
    expect(report.total_score).toBeGreaterThan(0.2);
  });
});
