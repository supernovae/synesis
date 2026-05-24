import { describe, expect, it } from "vitest";

import {
  admissionErrorMessage,
  countMessageRoles,
  estimateToolSchemaChars,
  evaluateContextAdmission,
} from "../src/pipeline/context-admission.js";

describe("countMessageRoles", () => {
  it("counts protocol roles and estimated input chars", () => {
    expect(countMessageRoles([
      { role: "system", content: "abc" },
      { role: "user", content: { x: 1 } },
      { role: "tool", content: "tool-output" },
      { role: "assistant", content: null },
    ])).toEqual({
      systemMessageCount: 1,
      userMessageCount: 1,
      toolMessageCount: 1,
      totalInputChars: 3 + "{\"x\":1}".length + "tool-output".length + "\"\"".length,
    });
  });
});

describe("estimateToolSchemaChars", () => {
  it("returns zero for empty or unserializable tool arrays", () => {
    expect(estimateToolSchemaChars([])).toBe(0);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(estimateToolSchemaChars([circular])).toBe(0);
  });
});

describe("evaluateContextAdmission", () => {
  it("allows contexts below configured limits", () => {
    expect(evaluateContextAdmission([{ role: "user", content: "short" }], [], "hybrid", 100, 200)).toEqual({
      decision: "allow",
      estimatedTokens: 2,
      estimatedChars: 5,
    });
  });

  it("warns above warn limit unless mode is enforced", () => {
    expect(evaluateContextAdmission([{ role: "user", content: "x".repeat(40) }], [], "hybrid", 5, 20)).toEqual({
      decision: "warn",
      reason: "estimated_input_tokens_above_warn_limit (10 > 5)",
      estimatedTokens: 10,
      estimatedChars: 40,
    });
    expect(evaluateContextAdmission([{ role: "user", content: "x".repeat(40) }], [], "enforced", 5, 20)).toEqual({
      decision: "reject",
      reason: "estimated_input_tokens_exceeded_warn_limit_enforced (10 > 5)",
      estimatedTokens: 10,
      estimatedChars: 40,
    });
  });

  it("rejects above hard limit and formats the public error message", () => {
    const result = evaluateContextAdmission([{ role: "user", content: "x".repeat(84) }], [], "advisory", 0, 20);

    expect(result).toEqual({
      decision: "reject",
      reason: "estimated_input_tokens_exceeded_hard_limit (21 > 20)",
      estimatedTokens: 21,
      estimatedChars: 84,
    });
    expect(admissionErrorMessage(result)).toBe(
      "Request context is too large for safe model admission. Estimated input tokens: 21. Reduce history length, narrow tool output, or split the task into smaller turns.",
    );
  });
});
