import { describe, expect, it } from "vitest";
import {
  applyArchitectureMediationMode,
  buildArchitecturePolicySystemHint,
  buildContextMediationArtifacts,
  deriveModelExecutionPolicy,
  normalizeModelCapabilityPreset,
  parseArchitectureMediationModeContract,
  parseArchitectureProfileSourceContract,
  parseModelArchitectureDiagnosticsV1,
  parseModelCapabilityPresetContract,
  parseSynesisMetadataContract,
  resolveArchitectureMediationMode,
  resolveModelArchitectureProfile,
  telemetryProviderForModelCapabilityPreset,
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

  it("uses controlled model capability presets independent of endpoint/model string", () => {
    const profile = resolveModelArchitectureProfile({
      modelId: "provider-opaque-v4-pro",
      provider: "generic",
      modelCapabilityPreset: "deepseek_v4",
      declaredContextTokens: 128_000,
    });
    const policy = deriveModelExecutionPolicy(profile);

    expect(profile.attention).toBe("mla");
    expect(policy.contextBudget.interpretation).toBe("storage_with_working_set");
    expect(policy.reasons).toContain("attention_compression");
    expect(telemetryProviderForModelCapabilityPreset("deepseek-v4")).toBe("deepseek");
    expect(normalizeModelCapabilityPreset("mimo-v2.5")).toBe("xiaomi_mimo_2_5");
  });

  it("lets explicit generic preset suppress model-name inference", () => {
    const profile = resolveModelArchitectureProfile({
      modelId: "deepseek-compatible-finetune",
      modelCapabilityPreset: "generic_openai_compatible",
    });

    expect(profile.attention).toBe("unknown");
  });

  it("does not promote path-miss tool noise into critical fact pins", () => {
    const profile = resolveModelArchitectureProfile({
      modelId: "deepseek-v4-pro",
      modelCapabilityPreset: "deepseek_v4",
    });
    const policy = applyArchitectureMediationMode(deriveModelExecutionPolicy(profile), "adaptive");
    const artifacts = buildContextMediationArtifacts({
      policy,
      messages: [
        { role: "user", content: "Build the TaskPulse project. All endpoints must validate Pydantic models." },
        { role: "tool", content: "File not found: /home/byron/src/test/src/test/taskpulse/app/main.py" },
        { role: "tool", content: "AssertionError: Status code 204 must not have a response body" },
      ],
    });

    const pinText = artifacts.criticalFactPins.map((pin) => pin.text).join("\n");
    expect(pinText).toContain("All endpoints must validate Pydantic models.");
    expect(pinText).toContain("Status code 204 must not have a response body");
    expect(pinText).not.toContain("File not found");
  });

  it("accepts legacy aliases but resolves to canonical modes", () => {
    expect(resolveArchitectureMediationMode({ configMode: "adapt" })).toBe("adaptive");
    expect(resolveArchitectureMediationMode({ configMode: "strict" })).toBe("aggressive");
    expect(resolveArchitectureMediationMode({
      metadata: { synesis: { contextMediation: "observe" } },
    })).toBe("observe");
  });

  it("validates architecture contracts while preserving legacy input tolerance", () => {
    expect(parseArchitectureMediationModeContract({ configMode: "strict" })).toBe("aggressive");
    expect(parseArchitectureProfileSourceContract({ configSource: "raw" })).toBe("raw");
    expect(parseArchitectureMediationModeContract({
      headers: {
        authorization: "Bearer ignored",
        "content-type": "application/json",
        "x-synesis-context-mediation": "safe",
      },
      extraBody: {
        top_k: 20,
        min_p: 0.1,
        synesis_context_mediation: "observe",
      },
    })).toBe("safe");
    expect(parseModelCapabilityPresetContract("deepseek-v4-pro")).toBe("deepseek_v4");
    expect(parseSynesisMetadataContract({
      synesis: {
        contextMediation: "adaptive",
        architectureProfile: "model-registry",
      },
      request_id: "req-1",
    })).toEqual({
      synesis: {
        contextMediation: "adaptive",
        architectureProfile: "model-registry",
      },
      request_id: "req-1",
    });
  });

  it("rejects invented architecture metadata fields at contract boundaries", () => {
    expect(() => parseArchitectureMediationModeContract({
      metadata: {
        synesis_context_mediation: "adaptive",
        role_override: "platform_admin",
      },
    })).toThrow(/role_override/);

    expect(() => parseArchitectureProfileSourceContract({
      metadata: {
        synesis_architecture_profile: "auto",
        workspace_owner_id: "attacker",
      },
    })).toThrow(/workspace_owner_id/);

    expect(() => parseSynesisMetadataContract({
      synesis: { contextMediation: "safe" },
      role_override: "platform_admin",
    })).toThrow(/role_override/);
  });

  it("validates model architecture diagnostics envelopes", () => {
    const envelope = parseModelArchitectureDiagnosticsV1({
      schema_version: "model_architecture_diagnostics_v1",
      count: 1,
      models: [{
        model_id: "coder-deepseek",
        resolved: true,
        backend_model: "deepseek-v4-pro",
        adapter_family: "deepseek",
        model_capability_preset: "deepseek_v4",
        override_applied: false,
        architecture: { attention: "mla" },
      }],
    });

    expect(envelope.models[0]?.model_id).toBe("coder-deepseek");
    expect(() => parseModelArchitectureDiagnosticsV1({
      schema_version: "model_architecture_diagnostics_v1",
      count: 2,
      models: [],
    })).toThrow(/count must match/);
  });
});
