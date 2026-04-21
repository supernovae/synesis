import { describe, expect, it } from "vitest";
import {
  compactionSystemPromptFor,
  effectiveMaxRawChars,
  effectiveReducerProfile,
  effectiveSawtoothCheckpointToolCalls,
  effectiveSawtoothHistoryLengthThreshold,
  inferCompactionSensitivity,
  looksLikeVerificationFailureOutput,
} from "../src/context/compaction-sensitivity.js";

describe("compaction-sensitivity", () => {
  it("classifies coder-next as strict_literals", () => {
    expect(inferCompactionSensitivity("Qwen/Qwen3-Coder-Next-30B-A3B-Instruct")).toBe("strict_literals");
    expect(inferCompactionSensitivity("org/Qwen3.6-Coder-Next")).toBe("strict_literals");
  });

  it("classifies other Qwen3 coders as qwen_coder", () => {
    expect(inferCompactionSensitivity("Qwen/Qwen3-Coder-30B-A3B")).toBe("qwen_coder");
    expect(inferCompactionSensitivity("qwen3-coder-480b")).toBe("qwen_coder");
  });

  it("demotes aggressive reducer profile for qwen_coder", () => {
    expect(effectiveReducerProfile("aggressive", "qwen_coder")).toBe("balanced");
    expect(effectiveReducerProfile("balanced", "qwen_coder")).toBe("balanced");
  });

  it("raises max raw chars for strict_literals", () => {
    expect(effectiveMaxRawChars(48_000, "strict_literals")).toBeGreaterThan(48_000);
    expect(effectiveMaxRawChars(48_000, "default")).toBe(48_000);
  });

  it("raises sawtooth thresholds for strict_literals", () => {
    expect(effectiveSawtoothCheckpointToolCalls(12, "strict_literals")).toBe(18);
    expect(effectiveSawtoothHistoryLengthThreshold(60, "strict_literals")).toBe(80);
  });

  it("strict compaction prompt demands verbatim failure output", () => {
    const p = compactionSystemPromptFor("strict_literals");
    expect(p).toContain("VERBATIM");
    expect(p).toContain("FAIL");
  });

  it("detects common verification failure patterns", () => {
    expect(looksLikeVerificationFailureOutput("--- FAIL: TestFoo (0.00s)")).toBe(true);
    expect(looksLikeVerificationFailureOutput("error TS2322: Type 'string' is not assignable")).toBe(true);
    expect(looksLikeVerificationFailureOutput("all tests passed")).toBe(false);
    expect(looksLikeVerificationFailureOutput("./ask.go:306:18: undefined: extractPathField")).toBe(true);
  });
});
