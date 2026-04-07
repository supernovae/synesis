import { describe, expect, it } from "vitest";
import { PhaseModelOrchestrator } from "../src/orchestration/phase-model-orchestrator.js";

describe("PhaseModelOrchestrator", () => {
  it("chooses pulse for validation-oriented low-risk tasks", () => {
    const o = new PhaseModelOrchestrator();
    const d = o.decide({
      requestedModel: "gpt-4",
      latestUserText: "run tests and validate lint output",
      riskProfile: "low"
    });
    expect(d.tier).toBe("synesis-pulse");
    expect(d.phase).toBe("validation");
    // tierOutput(): pulse → 4096 (validation phase does not further cap).
    expect(d.maxOutputTokens).toBeLessThanOrEqual(4096);
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

  it("treats auto as router-managed default", () => {
    const o = new PhaseModelOrchestrator();
    const d = o.decide({
      requestedModel: "auto",
      latestUserText: "implement feature and run tests",
      riskProfile: "standard",
    });
    expect(d.reasons).toContain("model_auto_default");
    expect(["synesis-pulse", "synesis-core", "synesis-horizon"]).toContain(d.tier);
  });

  it("honors explicit model lock mode", () => {
    const o = new PhaseModelOrchestrator();
    const d = o.decide({
      requestedModel: "synesis-pulse",
      modelSelectionMode: "lock",
      latestUserText: "critical security migration",
      riskProfile: "high",
    });
    expect(d.tier).toBe("synesis-pulse");
    expect(d.reasons).toContain("explicit_model_lock");
  });

  it("routes planning phase to horizon on legacy path when planningUseHorizon is default", () => {
    const o = new PhaseModelOrchestrator();
    const d = o.decide({
      requestedModel: "gpt-4",
      latestUserText: "outline next steps only",
      workingPhase: "planning",
      riskProfile: "standard",
    });
    expect(d.tier).toBe("synesis-horizon");
    expect(d.reasons).toContain("planning_horizon");
  });

  it("keeps planning on core when planningUseHorizon is false and no complex keywords", () => {
    const o = new PhaseModelOrchestrator();
    const d = o.decide({
      requestedModel: "gpt-4",
      latestUserText: "outline next steps only",
      workingPhase: "planning",
      riskProfile: "standard",
      planningUseHorizon: false,
    });
    expect(d.tier).toBe("synesis-core");
  });
});
