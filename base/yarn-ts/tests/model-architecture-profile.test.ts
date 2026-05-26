import { describe, expect, it } from "vitest";
import {
  deriveModelExecutionPolicy,
  resolveModelArchitectureProfile,
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
});
