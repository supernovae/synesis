import { describe, expect, it } from "vitest";
import { mergeYarnPublicOfferingsIntoTiers, type TierConfig } from "../src/providers/admin-tier-registry.js";

describe("mergeYarnPublicOfferingsIntoTiers", () => {
  const base: TierConfig[] = [
    {
      id: "synesis-core",
      backendModel: "m-core",
      baseUrl: "http://x",
      apiKey: "k",
      inputPerM: 1,
      outputPerM: 2,
      cachedPerM: null,
      cacheWritePerM: null,
      pricingSource: "manual",
    },
  ];

  it("clones coder-core tier under client id with backend override", () => {
    const merged = mergeYarnPublicOfferingsIntoTiers(base, [
      { client_model_id: "exp-test", effort_tier: "core", backend_model_override: "override-model" },
    ]);
    const custom = merged.find((t) => t.id === "exp-test");
    expect(custom?.backendModel).toBe("override-model");
    expect(custom?.baseUrl).toBe("http://x");
    expect(merged.find((t) => t.id === "synesis-core")).toBeDefined();
  });

  it("inherits backend model when override empty", () => {
    const merged = mergeYarnPublicOfferingsIntoTiers(base, [
      { client_model_id: "exp-2", effort_tier: "core", backend_model_override: null },
    ]);
    expect(merged.find((t) => t.id === "exp-2")?.backendModel).toBe("m-core");
  });
});
