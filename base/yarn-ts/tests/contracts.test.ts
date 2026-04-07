import { describe, expect, it } from "vitest";
import { buildOpenAIPath, classifyOpenAIErrorStatus } from "../src/contracts/openai-contract.js";
import { extractAnthropicTextChunk, normalizeAnthropicStopReason } from "../src/contracts/anthropic-contract.js";
import { acpShouldRetry, validateAcpEnvelope } from "../src/contracts/acp-contract.js";

describe("contract helpers", () => {
  it("normalizes openai base path without duplicate /v1", () => {
    expect(buildOpenAIPath("https://api.openai.com/v1", "/chat/completions"))
      .toBe("https://api.openai.com/v1/chat/completions");
  });

  it("classifies retryable statuses", () => {
    expect(classifyOpenAIErrorStatus(429)).toBe("retryable");
    expect(classifyOpenAIErrorStatus(400)).toBe("fatal");
  });

  it("extracts anthropic stream text and stop reasons", () => {
    expect(extractAnthropicTextChunk({ delta: { text: "hi" } })).toBe("hi");
    expect(normalizeAnthropicStopReason("end_turn")).toBe("stop");
  });

  it("validates acp envelope and retry behavior", () => {
    expect(validateAcpEnvelope({ id: "1", type: "event" }).ok).toBe(true);
    expect(validateAcpEnvelope({ type: "event" }).ok).toBe(false);
    expect(acpShouldRetry(503)).toBe(true);
  });
});
