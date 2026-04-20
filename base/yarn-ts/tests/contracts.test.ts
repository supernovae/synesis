import { describe, expect, it } from "vitest";
import { buildOpenAIPath, classifyOpenAIErrorStatus } from "../src/contracts/openai-contract.js";
import { extractAnthropicTextChunk, normalizeAnthropicStopReason } from "../src/contracts/anthropic-contract.js";
import { acpShouldRetry, validateAcpEnvelope } from "../src/contracts/acp-contract.js";

describe("contract helpers", () => {
  it("normalizes openai base path without duplicate /v1", () => {
    expect(buildOpenAIPath("https://api.openai.com/v1", "/chat/completions"))
      .toBe("https://api.openai.com/v1/chat/completions");
  });

  it("classifies retryable statuses across 429/5xx timeout envelopes", () => {
    expect(classifyOpenAIErrorStatus(408)).toBe("retryable");
    expect(classifyOpenAIErrorStatus(429)).toBe("retryable");
    expect(classifyOpenAIErrorStatus(500)).toBe("retryable");
    expect(classifyOpenAIErrorStatus(503)).toBe("retryable");
    expect(classifyOpenAIErrorStatus(599)).toBe("retryable");
    expect(classifyOpenAIErrorStatus(400)).toBe("fatal");
    expect(classifyOpenAIErrorStatus(401)).toBe("fatal");
  });

  it("extracts anthropic stream text and stop reasons", () => {
    expect(extractAnthropicTextChunk({ delta: { text: "hi" } })).toBe("hi");
    expect(extractAnthropicTextChunk({ content_block: { text: "hello" } })).toBe("hello");
    expect(extractAnthropicTextChunk({ type: "ping" })).toBe("");
    expect(normalizeAnthropicStopReason("end_turn")).toBe("stop");
    expect(normalizeAnthropicStopReason("tool_use")).toBe("tool_call");
    expect(normalizeAnthropicStopReason("max_tokens")).toBe("length");
    expect(normalizeAnthropicStopReason(undefined)).toBe("unknown");
  });

  it("validates acp envelope and retry behavior", () => {
    expect(validateAcpEnvelope({ id: "1", type: "event" }).ok).toBe(true);
    expect(validateAcpEnvelope({ type: "event" }).ok).toBe(false);
    expect(acpShouldRetry(503)).toBe(true);
  });
});
