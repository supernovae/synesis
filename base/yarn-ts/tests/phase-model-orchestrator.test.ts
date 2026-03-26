import { describe, expect, it } from "vitest";
import { PhaseModelOrchestrator } from "../src/orchestration/phase-model-orchestrator.js";

describe("PhaseModelOrchestrator", () => {
  it("chooses pulse for validation-oriented low-risk tasks", () => {
    const o = new PhaseModelOrchestrator();
    const d = o.decide({
      requestedModel: "claude-sonnet-4-5",
      latestUserText: "run tests and validate lint output",
      riskProfile: "low"
    });
    expect(d.tier).toBe("synesis-pulse");
    expect(d.phase).toBe("validation");
    expect(d.maxOutputTokens).toBeLessThanOrEqual(1800);
  });

  it("chooses horizon for high risk tasks", () => {
    const o = new PhaseModelOrchestrator();
    const d = o.decide({
      requestedModel: "synesis-pulse",
      latestUserText: "critical security migration plan",
      riskProfile: "high"
    });
    expect(d.tier).toBe("synesis-horizon");
    expect(d.reasons).toContain("risk_profile_high");
  });

  it("respects explicit tier unless escalated from pulse on high risk", () => {
    const o = new PhaseModelOrchestrator();
    const d1 = o.decide({
      requestedModel: "synesis-horizon",
      latestUserText: "small bug",
      riskProfile: "low"
    });
    expect(d1.selectedModel).toBe("synesis-horizon");
    const d2 = o.decide({
      requestedModel: "synesis-pulse",
      latestUserText: "critical production security issue",
      riskProfile: "high"
    });
    expect(d2.selectedModel).toBe("synesis-horizon");
  });

  it("tracks decision stats", () => {
    const o = new PhaseModelOrchestrator();
    o.decide({ requestedModel: "synesis-core", latestUserText: "validate tests", riskProfile: "low" });
    o.decide({ requestedModel: "synesis-core", latestUserText: "do implementation", riskProfile: "standard" });
    const s = o.getStats();
    expect(s.decisions).toBe(2);
    expect(s.pulseCount + s.coreCount + s.horizonCount).toBe(2);
  });
});
