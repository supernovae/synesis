import { describe, expect, it } from "vitest";
import { normalizeValidationOutput } from "../src/validation/normalizer.js";

describe("normalizeValidationOutput", () => {
  it("normalizes TypeScript compiler output into findings", () => {
    const raw = "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    const out = normalizeValidationOutput({
      toolName: "tsc",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 200
    });
    expect(out.family).toBe("typescript");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].file).toBe("src/foo.ts");
    expect(out.findings[0].line).toBe(12);
    expect(out.summary).toContain("<VALIDATION_SUMMARY");
  });

  it("normalizes ruff output and captures code", () => {
    const raw = "app/main.py:8:1: F401 `os` imported but unused";
    const out = normalizeValidationOutput({
      toolName: "ruff",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 200
    });
    expect(out.family).toBe("ruff");
    expect(out.findings[0].message).toContain("F401");
  });

  it("normalizes pytest assertion lines", () => {
    const raw = [
      "________________________ test_add ________________________",
      "E       assert 2 == 3"
    ].join("\n");
    const out = normalizeValidationOutput({
      toolName: "pytest",
      rawOutput: raw,
      maxFindings: 10,
      maxExcerptChars: 200
    });
    expect(out.family).toBe("pytest");
    expect(out.findings[0].message).toContain("test_add");
  });
});
