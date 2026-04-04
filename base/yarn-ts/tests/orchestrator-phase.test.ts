import { describe, expect, it } from "vitest";
import { parseOrchestratorPhaseHeader } from "../src/validation/orchestrator-phase.js";

describe("parseOrchestratorPhaseHeader", () => {
  it("returns undefined for auto and empty", () => {
    expect(parseOrchestratorPhaseHeader(undefined)).toBeUndefined();
    expect(parseOrchestratorPhaseHeader("")).toBeUndefined();
    expect(parseOrchestratorPhaseHeader("auto")).toBeUndefined();
    expect(parseOrchestratorPhaseHeader("AUTO")).toBeUndefined();
  });

  it("parses known phases case-insensitively", () => {
    expect(parseOrchestratorPhaseHeader("planning")).toBe("planning");
    expect(parseOrchestratorPhaseHeader("Implementation")).toBe("implementation");
  });

  it("returns undefined for unknown values", () => {
    expect(parseOrchestratorPhaseHeader("nope")).toBeUndefined();
  });
});
