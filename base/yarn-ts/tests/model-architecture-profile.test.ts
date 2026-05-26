import { describe, expect, it } from "vitest";
import {
  applyArchitectureMediationMode,
  deriveModelExecutionPolicy,
  resolveArchitectureMediationMode,
  resolveModelArchitectureProfile,
  buildArchitecturePolicySystemHint,
} from "../src/providers/model-architecture-profile.js";

describe("model architecture profile", () => {
  it("uses conservative defaults for unknown models", () => {
    const profile = resolveModelArchitectureProfile({ modelId: "unknown-model" });
    const policy = deriveModelExecutionPolicy(profile);

    expect(profile.attention).toBe("unknown");
    expect(profile.recommendations.preferExplicitStateHeaders).toBe(true);
    expect(policy.preferMemoryStitching).toBe(true);
    expect(policy.preferDeterministicValidation).toBe(true);
  });

  it("lets operator overrides win over inferred defaults", () => {
    const profile = resolveModelArchitectureProfile({
      modelId: "deepseek/deepseek-r1",
      provider: "openrouter",
      declaredContextTokens: 128_000,
      override: {
        attention: "full_attention",
        effectiveWorkingContextTokens: 120_000,
        recommendations: { preferShorterTurns: false },
      },
    });

    expect(profile.attention).toBe("full_attention");
    expect(profile.effectiveWorkingContextTokens).toBe(120_000);
    expect(profile.recommendations.preferShorterTurns).toBe(false);
  });

  it("maps DeepSeek-like models to MLA mediation", () => {
    const profile = resolveModelArchitectureProfile({
      modelId: "deepseek/deepseek-v3.2",
      declaredContextTokens: 128_000,
      family: "deepseek",
    });
    const policy = deriveModelExecutionPolicy(profile);

    expect(profile.attention).toBe("mla");
    expect(policy.preferMemoryStitching).toBe(true);
    expect(policy.preferExplicitStateHeaders).toBe(true);
    expect(policy.reasons).toContain("attention_compression");
  });

  it("reduces effective working context for sliding-window profiles", () => {
    const profile = resolveModelArchitectureProfile({
      modelId: "mistral-swa-coder",
      declaredContextTokens: 100_000,
    });
    const policy = deriveModelExecutionPolicy(profile);

    expect(profile.attention).toBe("sliding_window");
    expect(policy.effectiveContextCeilingTokens).toBeLessThan(100_000);
    expect(policy.compactionMode).toBe("aggressive");
  });

  it("raises deterministic validation preference for MoE profiles", () => {
    const profile = resolveModelArchitectureProfile({ modelId: "kimi-k2.6", family: "kimi" });
    const policy = deriveModelExecutionPolicy(profile);

    expect(profile.activation).toBe("moe");
    expect(policy.preferDeterministicValidation).toBe(true);
    expect(policy.reasons).toContain("moe_activation");
  });

  it("enables stream/tool boundary validation for speculative-friendly profiles", () => {
    const profile = resolveModelArchitectureProfile({ modelId: "minimax-m2.1", family: "minimax" });
    const policy = deriveModelExecutionPolicy(profile);

    expect(profile.decoding).toBe("speculative_friendly");
    expect(policy.strictStreamToolBoundaryValidation).toBe(true);
    expect(policy.reasons).toContain("stream_boundary_sensitive_decoding");
  });

  it("resolves architecture mediation mode from request metadata before config", () => {
    expect(resolveArchitectureMediationMode({
      metadata: { synesis_architecture_mediation: "observe" },
      configMode: "strict",
    })).toBe("observe");
    expect(resolveArchitectureMediationMode({
      extraBody: { architecture_mediation: "hands-off" },
    })).toBe("off");
    expect(resolveArchitectureMediationMode({ configMode: "assertive" })).toBe("strict");
    expect(resolveArchitectureMediationMode({ configMode: "unexpected" })).toBe("adapt");
  });

  it("observe mode traces policy without applying budget or prompt mediation", () => {
    const profile = resolveModelArchitectureProfile({
      modelId: "deepseek/deepseek-v3.2",
      declaredContextTokens: 128_000,
      family: "deepseek",
    });
    const policy = applyArchitectureMediationMode(deriveModelExecutionPolicy(profile), "observe");

    expect(policy.mediationMode).toBe("observe");
    expect(policy.applyContextBudgetPolicy).toBe(false);
    expect(policy.applySystemHint).toBe(false);
    expect(policy.effectiveContextCeilingTokens).toBeUndefined();
    expect(policy.compactionMode).toBeUndefined();
    expect(policy.reasons).toContain("architecture_mediation_observe");
    expect(buildArchitecturePolicySystemHint(policy)).toBeNull();
  });

  it("strict mode opts into stronger boundary validation", () => {
    const profile = resolveModelArchitectureProfile({ modelId: "gpt-4.1", provider: "openai" });
    const policy = applyArchitectureMediationMode(deriveModelExecutionPolicy(profile), "strict");

    expect(policy.mediationMode).toBe("strict");
    expect(policy.applyContextBudgetPolicy).toBe(true);
    expect(policy.applySystemHint).toBe(true);
    expect(policy.applyGovernorBias).toBe(true);
    expect(policy.strictStreamToolBoundaryValidation).toBe(true);
    expect(buildArchitecturePolicySystemHint(policy)).toContain("mode=strict");
  });
});
