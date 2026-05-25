import { describe, expect, it, vi } from "vitest";

import {
  createClaudeNonStreamPipelineInput,
  createClaudeNonStreamRoutePipelineInput,
  runClaudeNonStreamPipeline,
} from "../src/streaming/claude-nonstream-pipeline.js";

function usage() {
  return { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
}

function baseInput(overrides: Partial<Parameters<typeof runClaudeNonStreamPipeline>[0]> = {}) {
  const span = {
    setStatus: vi.fn(),
    end: vi.fn(),
  };
  return {
    requestId: "req_1",
    sessionKey: "session_1",
    userId: "user_1",
    orgId: "org_1",
    resolvedModelId: "claude-test",
    circuitBreakers: {
      allowRequest: vi.fn(() => true),
      recordFailure: vi.fn(),
      recordSuccess: vi.fn(),
    },
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    startSpan: vi.fn(() => span),
    extractUpstreamErrorDiagnostics: vi.fn(() => ({
      userMessage: "upstream failed",
      errorName: "ProviderError",
      errorCode: "E_PROVIDER",
      httpStatus: 500,
      isVercelAiSdkError: true,
      isMissingToolResults: false,
      rawMessage: "raw upstream failed",
    })),
    providerInput: {
      initialMessages: [{ role: "user", content: "hello" }],
      model: "model",
      resolvedModelId: "claude-test",
      orchestrationMaxOutputTokens: 128,
      phasePolicy: { active: false },
      governorPhase: "edit",
      nativeWebSearchRequested: false,
      clampMaxOutputTokens: (tokens: number) => tokens,
      generateText: vi.fn(async () => ({ text: "done", usage: {}, toolCalls: [] })),
      readUsage: usage,
      captureForensics: () => null,
      finalizeForensics: () => undefined,
      recordSessionEvent: vi.fn(),
      isServerWebSearchTool: () => false,
      resolveServerWebSearch: vi.fn(),
      toServerWebSearchEvent: vi.fn(),
    },
    postprocessInput: {} as never,
    ...overrides,
  };
}

describe("runClaudeNonStreamPipeline", () => {
  it("builds route input from scope identity", () => {
    const recordEvent = vi.fn();
    const persistDecisionTelemetry = vi.fn();
    const input = createClaudeNonStreamPipelineInput({
      ...baseInput(),
      requestId: "ignored",
      sessionKey: "ignored",
      userId: "ignored",
      orgId: "ignored",
      scope: {
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        requestId: "req_1",
        recordEvent,
        persistDecisionTelemetry,
      },
    });

    expect(input).toMatchObject({
      requestId: "req_1",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
    });
  });

  it("assembles provider and postprocess route inputs", () => {
    const recordEvent = vi.fn();
    const persistDecisionTelemetry = vi.fn();
    const capture = vi.fn((context) => ({ context }));
    const finalize = vi.fn(() => undefined);
    const input = createClaudeNonStreamRoutePipelineInput({
      ...baseInput(),
      scope: {
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        requestId: "req_1",
        recordEvent,
        persistDecisionTelemetry,
      },
      providerRouteInput: {
        initialMessages: [{ role: "user", content: "hello" }],
        model: "model",
        resolvedModelId: "claude-test",
        orchestrationMaxOutputTokens: 128,
        phasePolicy: { active: false },
        governorPhase: "edit",
        nativeWebSearchRequested: false,
        clampMaxOutputTokens: (tokens: number) => tokens,
        generateText: vi.fn(async () => ({ text: "done", usage: {}, toolCalls: [] })),
        readUsage: usage,
        scope: {
          sessionKey: "session_1",
          requestId: "req_1",
          recordEvent,
        },
        forensics: {
          path: "/v1/messages",
          stream: false,
          capture,
          finalize,
        },
        isServerWebSearchTool: () => false,
        serverWebSearch: {
          sourceSurface: "yarn_chat",
          toolName: "web_search",
          resolve: vi.fn(),
        },
        toServerWebSearchEvent: vi.fn(),
      },
      postprocessRouteInput: {
        readUsage: usage,
        scope: {
          sessionKey: "session_1",
          userId: "user_1",
          orgId: "org_1",
          requestId: "req_1",
          recordEvent,
          persistDecisionTelemetry,
        },
        resolvedModelId: "claude-test",
        clientRequestedModel: "claude-test",
        toolCallInput: {} as never,
        discoveryInput: {} as never,
        finalizerInput: {} as never,
        telemetryInput: {} as never,
      },
    });

    input.providerInput.recordSessionEvent({
      eventKind: "provider_event",
      component: "provider",
      detail: "detail",
    });
    input.providerInput.captureForensics([{ role: "user", content: "hello" }], undefined);
    input.postprocessInput.telemetryInput.persistDecisionTelemetry({
      usage: usage(),
      latencyMs: 1,
      finishReason: "end_turn",
      tokensSavedByReduction: 0,
      escalated: false,
      snapshot: {} as never,
      trajectory: { toolSequence: [] },
    });

    expect(input).toMatchObject({
      requestId: "req_1",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
    });
    expect(recordEvent).toHaveBeenCalledWith({
      eventKind: "provider_event",
      component: "provider",
      detail: "detail",
    });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "session_1",
      requestId: "req_1",
      resolvedModelId: "claude-test",
    }));
    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      finishReason: "end_turn",
      escalated: false,
    }));
  });

  it("returns a retryable Claude error when the circuit breaker is open", async () => {
    const input = baseInput({
      circuitBreakers: {
        allowRequest: vi.fn(() => false),
        recordFailure: vi.fn(),
        recordSuccess: vi.fn(),
      },
    });

    const result = await runClaudeNonStreamPipeline(input);

    expect(result).toEqual({
      kind: "error",
      statusCode: 503,
      headers: { "Retry-After": "30" },
      body: {
        type: "error",
        error: {
          type: "overloaded_error",
          message: "Model provider temporarily unavailable. Try again shortly.",
        },
      },
    });
    expect(input.providerInput.recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "breaker_open_reject",
      component: "circuit-breaker",
      detail: "Circuit breaker open for claude-test (claude)",
      metadataJson: { model: "claude-test" },
    });
  });

  it("maps upstream provider failures to Claude-compatible errors", async () => {
    const input = baseInput({
      providerInput: {
        ...baseInput().providerInput,
        generateText: vi.fn(async () => {
          throw new Error("boom");
        }),
      } as never,
    });

    const result = await runClaudeNonStreamPipeline(input);

    expect(result).toEqual({
      kind: "error",
      statusCode: 502,
      body: { type: "error", error: { type: "upstream_error", message: "upstream failed" } },
    });
    expect(input.circuitBreakers.recordFailure).toHaveBeenCalledWith("claude-test", "org_1");
    expect(input.providerInput.recordSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: "upstream_error",
      component: "generateText",
      detail: "upstream failed",
    }));
  });
});
