import { describe, expect, it } from "vitest";
import { SynesisProviderRegistry } from "../src/providers/synesis-provider.js";

describe("SynesisProviderRegistry", () => {
  it("exposes auto in model list", () => {
    const reg = new SynesisProviderRegistry();
    reg.updateTiers([
      {
        id: "synesis-core",
        backendModel: "x",
        baseUrl: "https://example.com/v1",
        apiKey: "k",
        inputPerM: 0.1,
        outputPerM: 0.2,
        cachedPerM: 0.01,
        cacheWritePerM: null,
        pricingSource: "manual",
      },
    ]);
    const models = reg.getAvailableModels().map((m) => m.id);
    expect(models[0]).toBe("auto");
    expect(models).toContain("synesis-core");
  });
});
