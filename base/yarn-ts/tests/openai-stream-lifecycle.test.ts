import { describe, expect, it, vi } from "vitest";
import { createOpenAIStreamLifecycleHandlers } from "../src/streaming/openai-stream-lifecycle.js";
import { OpenAIStreamResponseWriter } from "../src/streaming/openai-stream-response-writer.js";
import { OpenAIStreamState } from "../src/streaming/openai-stream-state.js";

function harness(overrides: Partial<Parameters<typeof createOpenAIStreamLifecycleHandlers>[0]> = {}) {
  const writes: string[] = [];
  const raw = {
    destroyed: false,
    write: (data: string) => {
      writes.push(data);
    },
  } as NodeJS.WritableStream & { destroyed?: boolean };
  const streamState = new OpenAIStreamState();
  const writer = new OpenAIStreamResponseWriter({
    raw,
    requestId: "chatcmpl_test",
    model: "model-a",
  });
  const session = { skipToolIdStabilization: false };
  const abortController = new AbortController();
  const hardTimeout = setTimeout(() => undefined, 10_000);
  const input = {
    requestId: "req_1",
    model: "model-a",
    orgId: "org_1",
    sessionKey: "session_1",
    userId: "user_1",
    session,
    abortSignal: abortController.signal,
    hardTimeout,
    admissionRelease: vi.fn(),
    streamState,
    writer,
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
    recordSessionEvent: vi.fn(),
    ...overrides,
  };
  return {
    writes,
    streamState,
    session,
    abortController,
    hardTimeout,
    input,
    handlers: createOpenAIStreamLifecycleHandlers(input),
  };
}

describe("createOpenAIStreamLifecycleHandlers", () => {
  it("records stream errors, marks stream state, and emits retry hint", () => {
    const { handlers, input, streamState, writes } = harness();

    handlers.onEventError(new Error("boom"));

    expect(input.circuitBreakers.recordFailure).toHaveBeenCalledWith("model-a", "org_1");
    expect(input.span.setStatus).toHaveBeenCalledWith("error", "Upstream failed");
    expect(input.recordSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: "stream_error",
      component: "streamText",
      detail: "Upstream failed",
    }));
    expect(streamState.rawFinishReason()).toBe("error");
    expect(writes[0]).toContain("Upstream provider error");
    clearTimeout(input.hardTimeout);
  });

  it("sets skipToolIdStabilization and writes missing-tool-results hint", () => {
    const { handlers, input, session, writes } = harness({
      extractUpstreamErrorDiagnostics: vi.fn(() => ({
        userMessage: "Internal message integrity error (missing tool results)",
        rawMessage: "MissingToolResultsError",
        isVercelAiSdkError: true,
        isMissingToolResults: true,
      })),
    });

    handlers.onEventError(new Error("MissingToolResultsError"));

    expect(session.skipToolIdStabilization).toBe(true);
    expect(writes[0]).toContain("Internal message integrity error");
    clearTimeout(input.hardTimeout);
  });

  it("writes timeout hint when abort reason is stream hard timeout", () => {
    const abortController = new AbortController();
    abortController.abort("stream_hard_timeout: 1000ms");
    const { handlers, input, writes } = harness({
      abortSignal: abortController.signal,
    });

    handlers.onEventError(new Error("timeout"));

    expect(input.span.setStatus).toHaveBeenCalledWith("error", "Upstream model request timed out");
    expect(writes[0]).toContain("Stream timed out before completion");
    clearTimeout(input.hardTimeout);
  });

  it("releases admission, records success, and ends span before successful finalize", () => {
    const { handlers, input } = harness();

    handlers.beforeFinalize("stop");

    expect(input.admissionRelease).toHaveBeenCalledOnce();
    expect(input.circuitBreakers.recordSuccess).toHaveBeenCalledWith("model-a", "org_1");
    expect(input.span.setStatus).toHaveBeenCalledWith("ok");
    expect(input.span.end).toHaveBeenCalledOnce();
  });

  it("does not record circuit breaker success for error finalization", () => {
    const { handlers, input } = harness();

    handlers.beforeFinalize("error");

    expect(input.admissionRelease).toHaveBeenCalledOnce();
    expect(input.circuitBreakers.recordSuccess).not.toHaveBeenCalled();
    expect(input.span.end).toHaveBeenCalledOnce();
  });
});
