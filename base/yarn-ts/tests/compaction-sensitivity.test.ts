import { describe, expect, it } from "vitest";
import { COMPACTION_SYSTEM_PROMPT, looksLikeVerificationFailureOutput } from "../src/context/compaction-sensitivity.js";

describe("shared compaction evidence policy", () => {
  it("preserves concrete error evidence without model-specific instructions", () => {
    expect(COMPACTION_SYSTEM_PROMPT).toContain("failure excerpt literal");
    expect(COMPACTION_SYSTEM_PROMPT).not.toMatch(/Qwen|MiniMax|fragile/i);
  });
  it("detects common verification failure patterns", () => {
    expect(looksLikeVerificationFailureOutput("--- FAIL: TestFoo (0.00s)")).toBe(true);
    expect(looksLikeVerificationFailureOutput("error TS2322: Type 'string' is not assignable")).toBe(true);
    expect(looksLikeVerificationFailureOutput("all tests passed")).toBe(false);
    expect(looksLikeVerificationFailureOutput("./ask.go:306:18: undefined: extractPathField")).toBe(true);
  });
});
