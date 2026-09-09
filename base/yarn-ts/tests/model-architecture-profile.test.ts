import { describe, expect, it } from "vitest";
import {
  applyArchitectureMediationMode,
  deriveModelExecutionPolicy,
  resolveArchitectureMediationMode,
  resolveArchitectureProfileSource,
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

  it.each([
    ["deepseek-v4-pro", "hybrid_compressed_attention"],
    ["deepseek-v3.2", "compressed_sparse_attention"],
    ["deepseek-r1", "mla"],
    ["DeepSeek-R1-Distill-Qwen-32B", "unknown"],
    ["Qwen3-Coder-480B-A35B-Instruct", "full_attention"],
    ["Qwen3-Coder-Next", "unknown"],
    ["Qwen3.6-35B-A3B", "unknown"],
    ["GLM-5", "compressed_sparse_attention"],
    ["kimi-k2.5", "mla"],
    ["mistral-swa-coder", "unknown"],
    ["minimax-m2.5", "unknown"],
    ["mimo-v2.5-pro", "unknown"],
    ["gpt-4.1", "unknown"],
  ])("keeps capacity and quality separate from verified architecture: %s", (modelId, attention) => {
    const profile = resolveModelArchitectureProfile({ modelId, declaredContextTokens: 128_000 });
    const policy = applyArchitectureMediationMode(deriveModelExecutionPolicy(profile), "adaptive");
    expect(profile.attention).toBe(attention);
    expect(profile.effectiveWorkingContextTokens).toBe(128_000);
    expect(profile.traits.exactNeedleRecallReliability).toBe("unknown");
    expect(profile.decoding).toBe("unknown");
    expect(policy.compactionMode).not.toBe("aggressive");
    expect(policy.applyGovernorBias).toBe(false);
    expect(policy.multipass.enabled).toBe(false);
    expect(policy.strictStreamToolBoundaryValidation).toBe(true);
  });

  it("uses measured sensitivity to preserve context instead of compacting harder", () => {
    const profile = resolveModelArchitectureProfile({ modelId: "measured", override: {
      traits: { compactionSensitivity: "high" }, effectiveWorkingContextTokens: 32_000,
    } });
    const policy = deriveModelExecutionPolicy(profile);
    expect(policy.compactionMode).toBe("minimal");
    expect(policy.effectiveContextCeilingTokens).toBe(32_000);
  });

  it("resolves architecture mediation mode from request metadata before config", () => {
    expect(resolveArchitectureMediationMode({
      metadata: { synesis_architecture_mediation: "observe" },
      configMode: "strict",
    })).toBe("observe");
    expect(resolveArchitectureMediationMode({
      extraBody: { architecture_mediation: "hands-off" },
    })).toBe("off");
    expect(resolveArchitectureMediationMode({ configMode: "assertive" })).toBe("aggressive");
    expect(resolveArchitectureMediationMode({ configMode: "unexpected" })).toBe("adaptive");
    expect(resolveArchitectureMediationMode({
      headers: { "x-synesis-context-mediation": "safe" },
      metadata: { synesis: { contextMediation: "adaptive" } },
    })).toBe("safe");
  });

  it("resolves architecture profile source from header or nested metadata", () => {
    expect(resolveArchitectureProfileSource({
      headers: { "x-synesis-architecture-profile": "raw" },
      metadata: { synesis: { architectureProfile: "model-registry" } },
    })).toBe("raw");
    expect(resolveArchitectureProfileSource({
      metadata: { synesis: { architectureProfile: "auto" } },
    })).toBe("auto");
    expect(resolveArchitectureProfileSource({})).toBe("model-registry");
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
    expect(policy.reasons).toContain("context_mediation_observe");
    expect(buildArchitecturePolicySystemHint(policy)).toBeNull();
  });

  it("aggressive mode opts into stronger boundary validation", () => {
    const profile = resolveModelArchitectureProfile({ modelId: "gpt-4.1", provider: "openai" });
    const policy = applyArchitectureMediationMode(deriveModelExecutionPolicy(profile), "aggressive");

    expect(policy.mediationMode).toBe("aggressive");
    expect(policy.applyContextBudgetPolicy).toBe(true);
    expect(policy.applySystemHint).toBe(true);
    expect(policy.applyGovernorBias).toBe(false);
    expect(policy.strictStreamToolBoundaryValidation).toBe(true);
    expect(policy.multipass.retrieveAnswerVerifyRepair).toBe(true);
    expect(buildArchitecturePolicySystemHint(policy)).toContain("mode=aggressive");
  });
});
