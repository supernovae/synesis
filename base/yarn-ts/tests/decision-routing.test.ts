import { describe, expect, it, beforeEach } from "vitest";
import {
  PhaseModelOrchestrator,
  DEFAULT_THRESHOLDS,
  type OrchestratorContext,
  type EvidenceSignals,
  type DecisionPath,
} from "../src/orchestration/phase-model-orchestrator.js";

function ctx(overrides: Partial<OrchestratorContext> = {}): OrchestratorContext {
  return {
    /** Neutral id: not mapped by resolveExplicitTierFromRequestedModel (Claude wire ids map to tiers). */
    requestedModel: "gpt-4",
    latestUserText: "fix the type error",
    riskProfile: "standard",
    decisionMatrixEnabled: true,
    ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceSignals> = {}): EvidenceSignals {
  return { ...overrides };
}

describe("PhaseModelOrchestrator — Decision Routing (Phase 8)", () => {
  let orch: PhaseModelOrchestrator;

  beforeEach(() => {
    orch = new PhaseModelOrchestrator();
  });

  // --- Phase Detection ---

  describe("phase detection", () => {
    it("detects explore phase", () => {
      const d = orch.decide(ctx({ latestUserText: "explore the codebase structure" }));
      expect(d.phase).toBe("explore");
    });

    it("detects explore from discover keyword", () => {
      const d = orch.decide(ctx({ latestUserText: "let me discover how auth works" }));
      expect(d.phase).toBe("explore");
    });

    it("detects explore from research keyword", () => {
      const d = orch.decide(ctx({ latestUserText: "research the database layer" }));
      expect(d.phase).toBe("explore");
    });

    it("detects explore from investigate keyword", () => {
      const d = orch.decide(ctx({ latestUserText: "investigate the bug cause" }));
      expect(d.phase).toBe("explore");
    });

    it("detects explore from understand keyword", () => {
      const d = orch.decide(ctx({ latestUserText: "I need to understand the flow" }));
      expect(d.phase).toBe("explore");
    });

    it("explore mode gives broader output budget", () => {
      const d = orch.decide(ctx({ latestUserText: "explore how the system works" }));
      expect(d.phase).toBe("explore");
      // tierOutput(): explore phase → 8192
      expect(d.maxOutputTokens).toBe(8192);
    });

    it("detects planning phase", () => {
      const d = orch.decide(ctx({ latestUserText: "design the architecture" }));
      expect(d.phase).toBe("planning");
    });

    it("detects validation phase", () => {
      const d = orch.decide(ctx({ latestUserText: "run lint and typecheck" }));
      expect(d.phase).toBe("validation");
    });

    it("defaults to implementation", () => {
      const d = orch.decide(ctx({ latestUserText: "add the user model" }));
      expect(d.phase).toBe("implementation");
    });

    it("explore takes priority over planning", () => {
      const d = orch.decide(ctx({ latestUserText: "explore the architecture design" }));
      expect(d.phase).toBe("explore");
    });
  });

  // --- Decision Policy Matrix ---

  describe("deterministic path", () => {
    it("selects deterministic path on high recall bypass confidence", () => {
      const d = orch.decide(ctx({
        evidence: evidence({
          recallRouting: "bypass",
          recallConfidence: 0.9,
        }),
      }));
      expect(d.decisionPath).toBe("deterministic");
      expect(d.tier).toBe("synesis-pulse");
      expect(d.reasons).toContain("deterministic_path");
    });

    it("does not select deterministic path if verification is stalled", () => {
      const d = orch.decide(ctx({
        evidence: evidence({
          recallRouting: "bypass",
          recallConfidence: 0.95,
          verificationStalled: true,
        }),
      }));
      expect(d.decisionPath).not.toBe("deterministic");
    });

    it("does not select deterministic path if confidence below threshold", () => {
      const d = orch.decide(ctx({
        evidence: evidence({
          recallRouting: "bypass",
          recallConfidence: 0.5,
        }),
      }));
      expect(d.decisionPath).not.toBe("deterministic");
    });

    it("does not select deterministic path if routing is enrich", () => {
      const d = orch.decide(ctx({
        evidence: evidence({
          recallRouting: "enrich",
          recallConfidence: 0.95,
        }),
      }));
      expect(d.decisionPath).not.toBe("deterministic");
    });

    it("respects custom deterministic threshold", () => {
      orch.setThresholds({ deterministicPathThreshold: 0.95 });
      const d1 = orch.decide(ctx({
        evidence: evidence({ recallRouting: "bypass", recallConfidence: 0.92 }),
      }));
      expect(d1.decisionPath).not.toBe("deterministic");

      const d2 = orch.decide(ctx({
        evidence: evidence({ recallRouting: "bypass", recallConfidence: 0.96 }),
      }));
      expect(d2.decisionPath).toBe("deterministic");
    });
  });

  describe("constrained path", () => {
    it("selects constrained path on recall enrich routing", () => {
      const d = orch.decide(ctx({
        evidence: evidence({
          recallRouting: "enrich",
          recallConfidence: 0.5,
        }),
      }));
      expect(d.decisionPath).toBe("constrained");
      expect(d.tier).toBe("synesis-core");
      expect(d.reasons).toContain("constrained_path");
    });

    it("selects constrained path on high evidence confidence with authoritative", () => {
      const d = orch.decide(ctx({
        evidence: evidence({
          evidenceConfidence: 0.6,
          evidenceAuthoritative: true,
        }),
      }));
      expect(d.decisionPath).toBe("constrained");
    });

    it("does not select constrained on high evidence without authoritative flag", () => {
      const d = orch.decide(ctx({
        evidence: evidence({
          evidenceConfidence: 0.8,
          evidenceAuthoritative: false,
        }),
      }));
      expect(d.decisionPath).not.toBe("constrained");
    });
  });

  describe("abstain path", () => {
    it("selects abstain on low evidence + high risk", () => {
      const d = orch.decide(ctx({
        riskProfile: "high",
        evidence: evidence({
          evidenceConfidence: 0.1,
        }),
      }));
      expect(d.decisionPath).toBe("abstain");
      expect(d.tier).toBe("synesis-core");
      expect(d.uncertaintyFraming).toBeDefined();
      expect(d.uncertaintyFraming).toContain("synesis_uncertainty_framing");
      expect(d.uncertaintyFraming).toContain("insufficient evidence");
    });

    it("does not abstain on standard risk even with low evidence", () => {
      const d = orch.decide(ctx({
        riskProfile: "standard",
        evidence: evidence({
          evidenceConfidence: 0.1,
        }),
      }));
      expect(d.decisionPath).not.toBe("abstain");
    });

    it("does not abstain when evidence is above floor", () => {
      const d = orch.decide(ctx({
        riskProfile: "high",
        evidence: evidence({
          evidenceConfidence: 0.3,
        }),
      }));
      expect(d.decisionPath).not.toBe("abstain");
    });

    it("uncertainty framing mentions stalled verification", () => {
      const d = orch.decide(ctx({
        riskProfile: "high",
        evidence: evidence({
          evidenceConfidence: 0.05,
          verificationStalled: true,
        }),
      }));
      expect(d.uncertaintyFraming).toContain("stalled");
    });

    it("uncertainty framing suggests concrete actions", () => {
      const d = orch.decide(ctx({
        riskProfile: "high",
        evidence: evidence({
          evidenceConfidence: 0.05,
        }),
      }));
      expect(d.uncertaintyFraming).toContain("clarifying questions");
      expect(d.uncertaintyFraming).toContain("verification tools");
      expect(d.uncertaintyFraming).toContain("knowledge search");
    });
  });

  describe("inference-first path", () => {
    it("defaults to inference-first when no signals present", () => {
      const d = orch.decide(ctx({
        evidence: evidence({}),
      }));
      expect(d.decisionPath).toBe("inference_first");
      expect(d.tier).toBe("synesis-core");
    });

    it("uses pulse for validation phase in inference-first", () => {
      const d = orch.decide(ctx({
        latestUserText: "run lint check",
        evidence: evidence({ recallRouting: "passthrough" }),
      }));
      expect(d.decisionPath).toBe("inference_first");
      expect(d.tier).toBe("synesis-pulse");
    });

    it("uses horizon for complex planning in inference-first", () => {
      const d = orch.decide(ctx({
        latestUserText: "plan the complex migration",
        evidence: evidence({ recallRouting: "passthrough" }),
      }));
      expect(d.decisionPath).toBe("inference_first");
      expect(d.tier).toBe("synesis-horizon");
    });

    it("passthrough routing with low confidence remains inference-first", () => {
      const d = orch.decide(ctx({
        evidence: evidence({
          recallRouting: "passthrough",
          recallConfidence: 0.2,
        }),
      }));
      expect(d.decisionPath).toBe("inference_first");
    });
  });

  // --- Escalation ---

  describe("escalation overrides", () => {
    it("high risk forces minimum core even on deterministic path", () => {
      const d = orch.decide(ctx({
        riskProfile: "high",
        evidence: evidence({
          recallRouting: "bypass",
          recallConfidence: 0.95,
          evidenceConfidence: 0.9,
        }),
      }));
      // High risk + low evidence triggers abstain (checked before deterministic has chance to downgrade)
      // Actually: abstain requires evidenceConfidence < floor (0.2), evidence here is 0.9 so no abstain.
      // Deterministic picks pulse, then escalation override forces at least core for high risk.
      expect(d.decisionPath).toBe("deterministic");
      expect(d.tier).not.toBe("synesis-pulse");
    });

    it("consecutive failed verifications escalate to horizon", () => {
      const d = orch.decide(ctx({
        evidence: evidence({
          consecutiveFailedVerifications: 3,
        }),
      }));
      expect(d.tier).toBe("synesis-horizon");
      expect(d.escalated).toBe(true);
      expect(d.reasons).toContain("escalated_failed_verifications");
    });

    it("stalled verification with round >= 2 escalates to horizon", () => {
      const d = orch.decide(ctx({
        evidence: evidence({
          verificationStalled: true,
          verificationRound: 3,
        }),
      }));
      expect(d.tier).toBe("synesis-horizon");
      expect(d.reasons).toContain("escalated_stalled_verification");
    });

    it("stalled verification with round 1 does not escalate", () => {
      const d = orch.decide(ctx({
        evidence: evidence({
          verificationStalled: true,
          verificationRound: 1,
        }),
      }));
      expect(d.reasons).not.toContain("escalated_stalled_verification");
    });

    it("explicit tier still overrides after escalation (unless pulse+high)", () => {
      const d = orch.decide(ctx({
        requestedModel: "synesis-core",
        evidence: evidence({
          consecutiveFailedVerifications: 5,
        }),
      }));
      expect(d.tier).toBe("synesis-core");
      expect(d.reasons).toContain("explicit_requested_tier");
    });

    it("explicit pulse with high risk still escalates", () => {
      const d = orch.decide(ctx({
        requestedModel: "synesis-pulse",
        riskProfile: "high",
        evidence: evidence({
          evidenceConfidence: 0.5,
        }),
      }));
      expect(d.tier).toBe("synesis-horizon");
      expect(d.reasons).toContain("escalated_over_explicit_pulse_due_to_high_risk");
    });
  });

  // --- Session-Level Escalation Tracking ---

  describe("session escalation tracking", () => {
    it("tracks tier increase across session", () => {
      orch.decide(ctx({ evidence: evidence({}) }), "session-1");
      const stats1 = orch.getStats();
      expect(stats1.escalationCount).toBe(0);

      const d2 = orch.decide(ctx({
        evidence: evidence({ consecutiveFailedVerifications: 5 }),
      }), "session-1");
      expect(d2.escalated).toBe(true);
      expect(orch.getStats().escalationCount).toBe(1);
    });

    it("tracks de-escalation when confidence improves", () => {
      orch.decide(ctx({
        evidence: evidence({ consecutiveFailedVerifications: 5 }),
      }), "session-2");

      orch.decide(ctx({
        requestedModel: "synesis-pulse",
        latestUserText: "run lint check",
        evidence: evidence({}),
      }), "session-2");

      expect(orch.getStats().deescalationCount).toBe(1);
    });

    it("getLastTier returns the last tier for a session", () => {
      orch.decide(ctx({}), "session-3");
      expect(orch.getLastTier("session-3")).toBe("synesis-core");

      orch.decide(ctx({
        evidence: evidence({ consecutiveFailedVerifications: 5 }),
      }), "session-3");
      expect(orch.getLastTier("session-3")).toBe("synesis-horizon");
    });

    it("unknown session returns undefined for lastTier", () => {
      expect(orch.getLastTier("unknown")).toBeUndefined();
    });
  });

  // --- Stats ---

  describe("stats accumulation", () => {
    it("tracks per-path counters", () => {
      orch.decide(ctx({
        evidence: evidence({ recallRouting: "bypass", recallConfidence: 0.9 }),
      }));
      orch.decide(ctx({
        evidence: evidence({ recallRouting: "enrich", recallConfidence: 0.5 }),
      }));
      orch.decide(ctx({
        riskProfile: "high",
        evidence: evidence({ evidenceConfidence: 0.05 }),
      }));
      orch.decide(ctx({
        evidence: evidence({}),
      }));

      const s = orch.getStats();
      expect(s.deterministicCount).toBe(1);
      expect(s.constrainedCount).toBe(1);
      expect(s.abstainCount).toBe(1);
      expect(s.inferenceFirstCount).toBe(1);
      expect(s.decisions).toBe(4);
    });

    it("tracks per-phase counters", () => {
      orch.decide(ctx({ latestUserText: "explore this", evidence: evidence({}) }));
      orch.decide(ctx({ latestUserText: "plan the design", evidence: evidence({}) }));
      orch.decide(ctx({ latestUserText: "build it", evidence: evidence({}) }));
      orch.decide(ctx({ latestUserText: "validate tests", evidence: evidence({}) }));

      const s = orch.getStats();
      expect(s.byPhase.explore).toBe(1);
      expect(s.byPhase.planning).toBe(1);
      expect(s.byPhase.implementation).toBe(1);
      expect(s.byPhase.validation).toBe(1);
    });

    it("tracks tier counters", () => {
      orch.decide(ctx({
        evidence: evidence({ recallRouting: "bypass", recallConfidence: 0.95 }),
      }));
      orch.decide(ctx({ evidence: evidence({}) }));
      orch.decide(ctx({
        evidence: evidence({ consecutiveFailedVerifications: 5 }),
      }));

      const s = orch.getStats();
      expect(s.pulseCount).toBe(1);
      expect(s.coreCount).toBe(1);
      expect(s.horizonCount).toBe(1);
    });

    it("getStats returns a copy", () => {
      orch.decide(ctx({ evidence: evidence({}) }));
      const s1 = orch.getStats();
      const s2 = orch.getStats();
      expect(s1).toEqual(s2);
      expect(s1).not.toBe(s2);
      expect(s1.byPhase).not.toBe(s2.byPhase);
    });
  });

  // --- Feature Flag Gating ---

  describe("feature flag gating", () => {
    it("falls back to legacy when decisionMatrixEnabled is false", () => {
      const d = orch.decide(ctx({
        decisionMatrixEnabled: false,
        riskProfile: "high",
        evidence: evidence({
          recallRouting: "bypass",
          recallConfidence: 0.95,
        }),
      }));
      expect(d.decisionPath).toBe("inference_first");
      expect(d.tier).toBe("synesis-horizon");
      expect(d.reasons).toContain("risk_profile_high");
    });

    it("falls back to legacy when no evidence signals provided", () => {
      const d = orch.decide(ctx({
        decisionMatrixEnabled: true,
        riskProfile: "low",
        latestUserText: "run validate checks",
      }));
      expect(d.decisionPath).toBe("inference_first");
      expect(d.tier).toBe("synesis-pulse");
    });

    it("legacy path preserves existing behavior for standard risk", () => {
      const d = orch.decide(ctx({
        decisionMatrixEnabled: false,
        riskProfile: "standard",
        latestUserText: "implement the feature",
      }));
      expect(d.tier).toBe("synesis-core");
      expect(d.reasons).toContain("default_balanced");
    });

    it("legacy path preserves complex planning escalation", () => {
      const d = orch.decide(ctx({
        decisionMatrixEnabled: false,
        riskProfile: "standard",
        latestUserText: "plan the complex multi-service migration",
      }));
      expect(d.tier).toBe("synesis-horizon");
      expect(d.reasons.some((r) => r === "planning_horizon" || r === "complex_planning")).toBe(true);
    });
  });

  // --- Edge Cases ---

  describe("edge cases", () => {
    it("handles undefined evidence gracefully", () => {
      const d = orch.decide({
        requestedModel: "synesis-core",
        latestUserText: "do something",
        decisionMatrixEnabled: true,
      });
      expect(d.decisionPath).toBe("inference_first");
    });

    it("handles empty evidence object", () => {
      const d = orch.decide(ctx({
        evidence: {},
      }));
      expect(d.decisionPath).toBe("inference_first");
    });

    it("deterministic path does not produce uncertainty framing", () => {
      const d = orch.decide(ctx({
        evidence: evidence({ recallRouting: "bypass", recallConfidence: 0.95 }),
      }));
      expect(d.uncertaintyFraming).toBeUndefined();
    });

    it("constrained path does not produce uncertainty framing", () => {
      const d = orch.decide(ctx({
        evidence: evidence({ recallRouting: "enrich", recallConfidence: 0.6 }),
      }));
      expect(d.uncertaintyFraming).toBeUndefined();
    });

    it("inference-first path does not produce uncertainty framing", () => {
      const d = orch.decide(ctx({
        evidence: evidence({}),
      }));
      expect(d.uncertaintyFraming).toBeUndefined();
    });

    it("only abstain produces uncertainty framing", () => {
      const d = orch.decide(ctx({
        riskProfile: "high",
        evidence: evidence({ evidenceConfidence: 0.05 }),
      }));
      expect(d.decisionPath).toBe("abstain");
      expect(d.uncertaintyFraming).toBeDefined();
    });

    it("escalation reason is set on failed verifications", () => {
      const d = orch.decide(ctx({
        evidence: evidence({ consecutiveFailedVerifications: 3 }),
      }));
      expect(d.escalationReason).toContain("failed_verifications");
    });

    it("escalation reason is set on stalled verification", () => {
      const d = orch.decide(ctx({
        evidence: evidence({ verificationStalled: true, verificationRound: 2 }),
      }));
      expect(d.escalationReason).toContain("stalled_verification");
    });
  });

  // --- Threshold Configuration ---

  describe("threshold configuration", () => {
    it("setThresholds updates thresholds", () => {
      orch.setThresholds({ deterministicPathThreshold: 0.99 });
      expect(orch.getThresholds().deterministicPathThreshold).toBe(0.99);
      expect(orch.getThresholds().constrainedPathThreshold).toBe(DEFAULT_THRESHOLDS.constrainedPathThreshold);
    });

    it("custom abstain floor changes abstain trigger", () => {
      orch.setThresholds({ abstainEvidenceFloor: 0.5 });

      const d = orch.decide(ctx({
        riskProfile: "high",
        evidence: evidence({ evidenceConfidence: 0.3 }),
      }));
      expect(d.decisionPath).toBe("abstain");
    });

    it("custom escalation limit changes trigger", () => {
      orch.setThresholds({ escalationFailedVerifLimit: 5 });

      const d1 = orch.decide(ctx({
        evidence: evidence({ consecutiveFailedVerifications: 3 }),
      }));
      expect(d1.reasons).not.toContain("escalated_failed_verifications");

      const d2 = orch.decide(ctx({
        evidence: evidence({ consecutiveFailedVerifications: 6 }),
      }));
      expect(d2.reasons).toContain("escalated_failed_verifications");
    });
  });

  // --- Backward Compatibility ---

  describe("backward compatibility with old tests", () => {
    it("chooses pulse for validation-oriented low-risk tasks", () => {
      const d = orch.decide({
        requestedModel: "gpt-4",
        latestUserText: "run tests and validate lint output",
        riskProfile: "low",
      });
      expect(d.tier).toBe("synesis-pulse");
      expect(d.phase).toBe("validation");
      expect(d.maxOutputTokens).toBeLessThanOrEqual(4096);
    });

    it("chooses horizon for high risk tasks", () => {
      const d = orch.decide({
        requestedModel: "synesis-pulse",
        latestUserText: "critical security migration plan",
        riskProfile: "high",
      });
      expect(d.tier).toBe("synesis-horizon");
    });

    it("respects explicit tier unless escalated from pulse on high risk", () => {
      const d1 = orch.decide({
        requestedModel: "synesis-horizon",
        latestUserText: "small bug",
        riskProfile: "low",
      });
      expect(d1.selectedModel).toBe("synesis-horizon");
      const d2 = orch.decide({
        requestedModel: "synesis-pulse",
        latestUserText: "critical production security issue",
        riskProfile: "high",
      });
      expect(d2.selectedModel).toBe("synesis-horizon");
    });

    it("tracks decision stats", () => {
      orch.decide({ requestedModel: "synesis-core", latestUserText: "validate tests", riskProfile: "low" });
      orch.decide({ requestedModel: "synesis-core", latestUserText: "do implementation", riskProfile: "standard" });
      const s = orch.getStats();
      expect(s.decisions).toBe(2);
      expect(s.pulseCount + s.coreCount + s.horizonCount).toBe(2);
    });
  });
});
