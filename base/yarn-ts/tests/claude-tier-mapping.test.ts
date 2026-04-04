import { describe, expect, it } from "vitest";
import {
  PhaseModelOrchestrator,
  resolveExplicitTierFromRequestedModel,
} from "../src/orchestration/phase-model-orchestrator.js";

describe("resolveExplicitTierFromRequestedModel", () => {
  it("returns exact synesis tier ids", () => {
    expect(resolveExplicitTierFromRequestedModel("synesis-horizon")).toEqual({
      tier: "synesis-horizon",
      reason: "synesis_exact",
    });
  });

  it("maps Claude opus wire ids to horizon", () => {
    expect(resolveExplicitTierFromRequestedModel("claude-opus-4-6")).toEqual({
      tier: "synesis-horizon",
      reason: "family_or_alias",
    });
  });

  it("maps haiku and sonnet wire ids", () => {
    expect(resolveExplicitTierFromRequestedModel("claude-3-5-haiku-20241022")?.tier).toBe("synesis-pulse");
    expect(resolveExplicitTierFromRequestedModel("claude-sonnet-4-5")?.tier).toBe("synesis-core");
  });

  it("applies env map needles longest-first before family rules", () => {
    const map = { opus: "synesis-core" as const };
    expect(resolveExplicitTierFromRequestedModel("claude-opus-4-6", map)).toEqual({
      tier: "synesis-core",
      reason: "env_map",
    });
  });

  it("maps word-boundary aliases", () => {
    expect(resolveExplicitTierFromRequestedModel("company-large-model")?.tier).toBe("synesis-horizon");
    expect(resolveExplicitTierFromRequestedModel("use small model")?.tier).toBe("synesis-pulse");
    expect(resolveExplicitTierFromRequestedModel("medium tier")?.tier).toBe("synesis-core");
  });

  it("returns null when no match", () => {
    expect(resolveExplicitTierFromRequestedModel("gpt-4")).toBeNull();
    expect(resolveExplicitTierFromRequestedModel("")).toBeNull();
  });
});

describe("PhaseModelOrchestrator — Claude family explicit tier", () => {
  it("uses horizon when requested model is claude-opus despite default implementation phase", () => {
    const orch = new PhaseModelOrchestrator();
    const d = orch.decide({
      requestedModel: "claude-opus-4-6",
      latestUserText: "add the user model",
      riskProfile: "standard",
      decisionMatrixEnabled: false,
    });
    expect(d.tier).toBe("synesis-horizon");
    expect(d.reasons).toContain("explicit_claude_family_tier");
  });

  it("maps claude-haiku to pulse", () => {
    const orch = new PhaseModelOrchestrator();
    const d = orch.decide({
      requestedModel: "claude-3-5-haiku-20241022",
      latestUserText: "add the user model",
      riskProfile: "standard",
      decisionMatrixEnabled: false,
    });
    expect(d.tier).toBe("synesis-pulse");
    expect(d.reasons).toContain("explicit_claude_family_tier");
  });

  it("respects explicit synesis tier with existing reason token", () => {
    const orch = new PhaseModelOrchestrator();
    const d = orch.decide({
      requestedModel: "synesis-core",
      latestUserText: "add the user model",
      riskProfile: "standard",
      decisionMatrixEnabled: false,
    });
    expect(d.tier).toBe("synesis-core");
    expect(d.reasons).toContain("explicit_requested_tier");
  });

  it("does not apply explicit pulse-class model when risk is high (keeps path tier)", () => {
    const orch = new PhaseModelOrchestrator();
    const d = orch.decide({
      requestedModel: "claude-3-5-haiku-20241022",
      latestUserText: "add the user model",
      riskProfile: "high",
      decisionMatrixEnabled: false,
    });
    expect(d.tier).toBe("synesis-horizon");
    expect(d.reasons).toContain("escalated_over_explicit_pulse_due_to_high_risk");
  });

  it("uses env map tier", () => {
    const orch = new PhaseModelOrchestrator({ "my-beta": "synesis-pulse" });
    const d = orch.decide({
      requestedModel: "org-my-beta-preview",
      latestUserText: "hello",
      riskProfile: "standard",
      decisionMatrixEnabled: false,
    });
    expect(d.tier).toBe("synesis-pulse");
    expect(d.reasons).toContain("explicit_claude_tier_map");
  });
});
