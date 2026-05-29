import { describe, expect, it } from "vitest";
import {
  applyArchitectureMediationMode,
  buildArchitecturePolicySystemHint,
  buildContextMediationArtifacts,
  deriveModelExecutionPolicy,
  resolveArchitectureMediationMode,
  resolveModelArchitectureProfile,
} from "../src/index.js";

describe("architecture mediation", () => {
  it("keeps unknown models conservative but mediated", () => {
    const profile = resolveModelArchitectureProfile({ modelId: "unknown-model" });
    const policy = deriveModelExecutionPolicy(profile);

    expect(profile.attention).toBe("unknown");
    expect(policy.contextBudget.interpretation).toBe("unknown");
    expect(policy.stateReinforcement.activeStateHeader).toBe(true);
  });

  it("treats hybrid compressed attention as storage with a working set", () => {
    const profile = resolveModelArchitectureProfile({
      modelId: "kimi-k2.6",
      declaredContextTokens: 256_000,
    });
    const policy = applyArchitectureMediationMode(deriveModelExecutionPolicy(profile), "adaptive");
    const artifacts = buildContextMediationArtifacts({
      policy,
      messages: [
        { role: "user", content: "Always keep the ship name Aurora in canon." },
        { role: "assistant", content: "Understood." },
      ],
      objective: "Continue the scene.",
    });

    expect(profile.attention).toBe("hybrid_compressed_attention");
    expect(policy.contextBudget.interpretation).toBe("storage_with_working_set");
    expect(policy.canonicalization.dedupe).toBe(true);
    expect(policy.retrieval.evidenceManifest).toBe(true);
    expect(artifacts.criticalFactPins.length).toBeGreaterThan(0);
    expect(artifacts.activeStateHeader).toContain("SYNESIS_ACTIVE_STATE");
  });

  it("does not add heavy active-state hints for full-attention models by default", () => {
    const profile = resolveModelArchitectureProfile({ modelId: "gpt-4.1", provider: "openai" });
    const policy = applyArchitectureMediationMode(deriveModelExecutionPolicy(profile), "adaptive");

    expect(profile.attention).toBe("full_attention");
    expect(policy.stateReinforcement.activeStateHeader).toBe(false);
    expect(buildArchitecturePolicySystemHint(policy)).toBeNull();
  });

  it("accepts legacy aliases but resolves to canonical modes", () => {
    expect(resolveArchitectureMediationMode({ configMode: "adapt" })).toBe("adaptive");
    expect(resolveArchitectureMediationMode({ configMode: "strict" })).toBe("aggressive");
    expect(resolveArchitectureMediationMode({
      metadata: { synesis: { contextMediation: "observe" } },
    })).toBe("observe");
  });
});
