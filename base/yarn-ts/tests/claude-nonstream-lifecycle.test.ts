import { describe, expect, it, vi } from "vitest";
import {
  finalizeClaudeNonStreamProviderSuccess,
  handleClaudeNonStreamProviderError,
} from "../src/streaming/claude-nonstream-lifecycle.js";

describe("claude non-stream lifecycle", () => {
  it("records provider failures and returns the documented upstream error envelope", () => {
    const span = { setStatus: vi.fn(), end: vi.fn() };
    const circuitBreakers = { recordFailure: vi.fn(), recordSuccess: vi.fn() };
    const logger = { error: vi.fn() };
    const recordSessionEvent = vi.fn();

    const response = handleClaudeNonStreamProviderError({
      requestId: "req_1",
      model: "claude-test",
      orgId: "org_1",
      span,
      circuitBreakers,
      logger,
      extractUpstreamErrorDiagnostics: () => ({
        userMessage: "Model request failed",
        rawMessage: "provider stack detail that should be trimmed for logs",
        errorName: "AI_APICallError",
        errorCode: "rate_limit",
        httpStatus: 429,
        isVercelAiSdkError: true,
        isMissingToolResults: false,
      }),
      recordSessionEvent,
    }, new Error("boom"));

    expect(circuitBreakers.recordFailure).toHaveBeenCalledWith("claude-test", "org_1");
    expect(span.setStatus).toHaveBeenCalledWith("error", "Model request failed");
    expect(span.end).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      reqId: "req_1",
      model: "claude-test",
      upstream_error_name: "AI_APICallError",
      upstream_error_code: "rate_limit",
      upstream_http_status: 429,
    }), "Claude non-stream generateText failed");
    expect(recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "upstream_error",
      component: "generateText",
      detail: "Model request failed",
      metadataJson: {
        model: "claude-test",
        error_name: "AI_APICallError",
        error_code: "rate_limit",
        error_status: 429,
        vercel_ai_sdk_error: true,
        missing_tool_results: false,
      },
    });
    expect(response).toEqual({
      statusCode: 502,
      payload: {
        type: "error",
        error: { type: "upstream_error", message: "Model request failed" },
      },
    });
  });

  it("records provider success and closes the span", () => {
    const span = { setStatus: vi.fn(), end: vi.fn() };
    const circuitBreakers = { recordFailure: vi.fn(), recordSuccess: vi.fn() };

    finalizeClaudeNonStreamProviderSuccess({
      model: "claude-test",
      orgId: "org_1",
      span,
      circuitBreakers,
    });

    expect(circuitBreakers.recordSuccess).toHaveBeenCalledWith("claude-test", "org_1");
    expect(span.setStatus).toHaveBeenCalledWith("ok");
    expect(span.end).toHaveBeenCalledOnce();
    expect(circuitBreakers.recordFailure).not.toHaveBeenCalled();
  });
});
