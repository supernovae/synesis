import { describe, expect, it, vi } from "vitest";
import {
  finalizeClaudeStreamLifecycle,
  handleClaudeStreamEventError,
} from "../src/streaming/claude-stream-lifecycle.js";
import { ClaudeStreamState } from "../src/streaming/claude-stream-state.js";

function harness(overrides: Partial<Parameters<typeof handleClaudeStreamEventError>[0]> = {}) {
  const streamState = new ClaudeStreamState();
  const session = { skipToolIdStabilization: false };
  const abortController = new AbortController();
  const hardTimeout = setTimeout(() => undefined, 10_000);
  const sendSse = vi.fn(() => true);
  const input = {
    requestId: "req_1",
    model: "model-a",
    orgId: "org_1",
    session,
    abortSignal: abortController.signal,
    hardTimeout,
    admissionRelease: vi.fn(),
    streamState,
    span: {
      setStatus: vi.fn(),
      end: vi.fn(),
    },
    circuitBreakers: {
      recordFailure: vi.fn(),
      recordSuccess: vi.fn(),
    },
    logger: {
      error: vi.fn(),
    },
    extractUpstreamErrorDiagnostics: vi.fn(() => ({
      userMessage: "Upstream failed",
      rawMessage: "raw upstream failed",
      isVercelAiSdkError: false,
      isMissingToolResults: false,
    })),
    sendSse,
    recordSessionEvent: vi.fn(),
    ...overrides,
  };
  return {
    streamState,
    session,
    abortController,
    hardTimeout,
    sendSse,
    input,
  };
}

describe("Claude stream lifecycle", () => {
  it("records stream errors, opens a text block, and emits retry hint", () => {
    const { input, streamState, sendSse } = harness();

    handleClaudeStreamEventError(input, new Error("boom"));

    expect(input.circuitBreakers.recordFailure).toHaveBeenCalledWith("model-a", "org_1");
    expect(input.span.setStatus).toHaveBeenCalledWith("error", "Upstream failed");
    expect(input.recordSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: "stream_error",
      component: "streamText",
      detail: "Upstream failed",
    }));
    expect(sendSse).toHaveBeenCalledWith("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    expect(sendSse).toHaveBeenCalledWith("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: expect.stringContaining("Upstream provider error") },
    });
    expect(streamState.rawStopReason()).toBe("end_turn");
    clearTimeout(input.hardTimeout);
  });

  it("sets skipToolIdStabilization and writes missing-tool-results hint", () => {
    const { input, session, sendSse } = harness({
      extractUpstreamErrorDiagnostics: vi.fn(() => ({
        userMessage: "Internal message integrity error (missing tool results)",
        rawMessage: "MissingToolResultsError",
        isVercelAiSdkError: true,
        isMissingToolResults: true,
      })),
    });

    handleClaudeStreamEventError(input, new Error("MissingToolResultsError"));

    expect(session.skipToolIdStabilization).toBe(true);
    expect(sendSse).toHaveBeenCalledWith("content_block_delta", expect.objectContaining({
      delta: { type: "text_delta", text: expect.stringContaining("Internal message integrity error") },
    }));
    clearTimeout(input.hardTimeout);
  });

  it("writes timeout hint when abort reason is stream hard timeout", () => {
    const abortController = new AbortController();
    abortController.abort("stream_hard_timeout: 1000ms");
    const { input, sendSse } = harness({
      abortSignal: abortController.signal,
    });

    handleClaudeStreamEventError(input, new Error("timeout"));

    expect(input.span.setStatus).toHaveBeenCalledWith("error", "Upstream model request timed out");
    expect(sendSse).toHaveBeenCalledWith("content_block_delta", expect.objectContaining({
      delta: { type: "text_delta", text: expect.stringContaining("Stream timed out before completion") },
    }));
    clearTimeout(input.hardTimeout);
  });

  it("releases admission, records success, and ends span for successful finalization", () => {
    const { input } = harness();
    input.streamState.markToolUse();

    const stopReason = finalizeClaudeStreamLifecycle(input);

    expect(stopReason).toBe("tool_use");
    expect(input.admissionRelease).toHaveBeenCalledOnce();
    expect(input.circuitBreakers.recordSuccess).toHaveBeenCalledWith("model-a", "org_1");
    expect(input.span.setStatus).toHaveBeenCalledWith("ok");
    expect(input.span.end).toHaveBeenCalledOnce();
  });
});
