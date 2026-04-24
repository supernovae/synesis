import { describe, expect, it } from "vitest";
import { SynesisProviderRegistry } from "../src/providers/synesis-provider.js";

describe("SynesisProviderRegistry", () => {
  const sampleCoreTier = {
    id: "synesis-core" as const,
    backendModel: "x",
    baseUrl: "https://example.com/v1",
    apiKey: "k",
    inputPerM: 0.1,
    outputPerM: 0.2,
    cachedPerM: 0.01,
    cacheWritePerM: null,
    pricingSource: "manual" as const,
  };

  it("exposes auto in model list", () => {
    const reg = new SynesisProviderRegistry();
    reg.updateTiers([sampleCoreTier]);
    const models = reg.getAvailableModels().map((m) => m.id);
    expect(models[0]).toBe("auto");
    expect(models).toContain("synesis-core");
    expect(models).toContain("core");
  });

  it("resolves short tier model ids to registry tiers", () => {
    const reg = new SynesisProviderRegistry();
    reg.updateTiers([sampleCoreTier]);
    const { resolvedModelId } = reg.resolve("core", "synesis-core");
    expect(resolvedModelId).toBe("synesis-core");
  });

  it("resolves path-suffixed tier ids", () => {
    const reg = new SynesisProviderRegistry();
    reg.updateTiers([sampleCoreTier]);
    const { resolvedModelId } = reg.resolve("openai/core", "synesis-core");
    expect(resolvedModelId).toBe("synesis-core");
  });
});
