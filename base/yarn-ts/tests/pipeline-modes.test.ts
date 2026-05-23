import { describe, expect, it } from "vitest";
import {
  resolvePipelineMode,
  shouldRunGovernorForMode,
  shouldRunHeavyEnrichmentForMode,
} from "../src/pipeline/modes.js";

describe("pipeline mode resolver", () => {
  it("defaults to governed mode to preserve current behavior", () => {
    expect(resolvePipelineMode().mode).toBe("governed");
  });

  it("allows explicit opt-down through x-synesis-mode", () => {
    const raw = resolvePipelineMode({ headers: { "x-synesis-mode": "raw" } });
    expect(raw).toMatchObject({ mode: "raw", source: "header", explicit: true, valid: true });

    const compat = resolvePipelineMode({ headers: { "X-Synesis-Mode": "compat" } });
    expect(compat).toMatchObject({ mode: "compat", source: "header", explicit: true, valid: true });
  });

  it("allows body metadata mode when no header is present", () => {
    const resolved = resolvePipelineMode({
      body: { metadata: { synesis_mode: "optimized" } },
    });
    expect(resolved).toMatchObject({ mode: "optimized", source: "body", explicit: true, valid: true });
  });

  it("falls back safely for unknown modes", () => {
    const resolved = resolvePipelineMode({ headers: { "x-synesis-mode": "turbo" } });
    expect(resolved).toMatchObject({
      mode: "governed",
      source: "header",
      explicit: true,
      requested: "turbo",
      valid: false,
    });
  });

  it("uses raw/compat as non-governed lightweight modes", () => {
    expect(shouldRunGovernorForMode("raw")).toBe(false);
    expect(shouldRunGovernorForMode("compat")).toBe(false);
    expect(shouldRunGovernorForMode("governed")).toBe(true);
    expect(shouldRunHeavyEnrichmentForMode("raw")).toBe(false);
    expect(shouldRunHeavyEnrichmentForMode("compat")).toBe(true);
  });
});
