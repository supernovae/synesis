import { describe, expect, it, vi } from "vitest";
import {
  createOpenAIChatNonStreamPipelineInput,
  createOpenAIChatNonStreamRoutePipelineInput,
  runOpenAIChatNonStreamPipeline,
} from "../src/pipeline/openai-chat-nonstream-pipeline.js";

function baseInput(overrides: Partial<Parameters<typeof runOpenAIChatNonStreamPipeline>[0]> = {}) {
  return {
    requestId: "req_1",
    sessionKey: "session_1",
    userId: "user_1",
    orgId: "org_1",
    resolvedModelId: "openai-test",
    circuitBreakers: {
      allowRequest: vi.fn(() => true),
      recordFailure: vi.fn(),
      recordSuccess: vi.fn(),
    },
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    startSpan: vi.fn(() => ({
      setStatus: vi.fn(),
      end: vi.fn(),
    })),
    extractUpstreamErrorDiagnostics: vi.fn(() => ({
      userMessage: "upstream failed",
      errorName: "ProviderError",
      errorCode: "E_PROVIDER",
      httpStatus: 500,
      isVercelAiSdkError: true,
      isMissingToolResults: true,
      rawMessage: "raw upstream failed",
    })),
    onMissingToolResults: vi.fn(),
    recordSessionEvent: vi.fn(),
    providerInput: {
      initialMessages: [{ role: "user", content: "hello" }],
      model: "model",
      orchestrationMaxOutputTokens: 128,
      phasePolicy: { active: false },
      governorPhase: "edit",
      clampMaxOutputTokens: (tokens: number) => tokens,
      generateText: vi.fn(async () => ({ text: "done", usage: {} })),
      readUsage: () => ({ inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 }),
      captureForensics: () => null,
      finalizeForensics: () => undefined,
      recordSessionEvent: vi.fn(),
      serverSideToolResolvers: {
        artifactToolName: "artifact",
        knowledgeToolName: "knowledge",
        devDocsToolName: "dev_docs",
        webSearchToolName: "web_search",
        webSearchToolAlias: "web",
        retrieveArtifact: vi.fn(),
        resolveKnowledge: vi.fn(),
        resolveDevDocs: vi.fn(),
        resolveWebSearch: vi.fn(),
      },
    },
    getTopLevelDirs: vi.fn(async () => []),
    postprocessInput: {} as never,
    ...overrides,
  };
}

describe("runOpenAIChatNonStreamPipeline", () => {
  it("builds route input from scope identity and event recorder", () => {
    const recordEvent = vi.fn();
    const input = createOpenAIChatNonStreamPipelineInput({
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
        persistDecisionTelemetry: vi.fn(),
      },
    });

    input.recordSessionEvent("event", "component", "detail", { ok: true });

    expect(input).toMatchObject({
      requestId: "req_1",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
    });
    expect(recordEvent).toHaveBeenCalledWith({
      eventKind: "event",
      component: "component",
      detail: "detail",
      metadataJson: { ok: true },
    });
  });

  it("assembles provider and postprocess route inputs from one route input", () => {
    const recordEvent = vi.fn();
    const persistDecisionTelemetry = vi.fn();
    const capture = vi.fn((context) => ({ context }));
    const finalize = vi.fn(() => undefined);
    const input = createOpenAIChatNonStreamRoutePipelineInput({
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
        orchestrationMaxOutputTokens: 128,
        requestMaxTokens: 128,
        phasePolicy: { active: false },
        governorPhase: "edit",
        clampMaxOutputTokens: (tokens: number) => tokens,
        generateText: vi.fn(async () => ({ text: "done", usage: {} })),
        readUsage: () => ({ inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 }),
        scope: {
          sessionKey: "session_1",
          requestId: "req_1",
          recordEvent,
        },
        resolvedModelId: "openai-test",
        forensics: {
          path: "/v1/chat/completions",
          stream: false,
          capture,
          finalize,
        },
        serverSideToolResolvers: {
          artifactToolName: "artifact",
          knowledgeToolName: "knowledge",
          devDocsToolName: "dev_docs",
          webSearchToolName: "web_search",
          webSearchToolAlias: "web",
          retrieveArtifact: vi.fn(),
          resolveKnowledge: vi.fn(),
          resolveDevDocs: vi.fn(),
          resolveWebSearch: vi.fn(),
        },
      },
      postprocessRouteInput: {
        scope: {
          sessionKey: "session_1",
          userId: "user_1",
          orgId: "org_1",
          requestId: "req_1",
          recordEvent,
          persistDecisionTelemetry,
        },
        responseModel: "openai-test",
        readUsage: (usage) => usage as never,
        toolCallInput: {} as never,
        applyDiscoveryGuardrail: (calls) => ({
          calls,
          blockedCount: 0,
          redirectedCount: 0,
          collapsedCount: 0,
          blockedDetails: [],
          redirectedDetails: [],
        }),
        discoveryInput: {} as never,
        collapseInput: {
          enabled: false,
          rewriteNonStream: false,
          collapseHeader: undefined,
          workspaceRoot: null,
          shellAllowlistEnv: "",
          logger: { info: vi.fn() },
          requestId: "req_1",
        },
        finalizerInput: {} as never,
        telemetryInput: {
          clientRequestedModel: "openai-test",
          escalated: true,
        } as never,
        responseInput: {
          effectiveTools: [],
          clientKind: "opencode",
        },
      },
    });

    input.recordSessionEvent("event", "component", "detail", { ok: true });
    input.providerInput.recordSessionEvent({
      eventKind: "provider_event",
      component: "provider",
      detail: "detail",
    });
    input.providerInput.captureForensics([{ role: "user", content: "hello" }], undefined);
    input.postprocessInput.telemetryInput.persistDecisionTelemetry({
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
      latencyMs: 1,
      finishReason: "stop",
      tokensSavedByReduction: 0,
      snapshot: {} as never,
      trajectory: { toolSequence: [] },
      optimizationLedger: { prefix_hash: "abc" },
    });

    expect(input).toMatchObject({
      requestId: "req_1",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
    });
    expect(input.postprocessInput.responseId).toBe("req_1");
    expect(recordEvent).toHaveBeenCalledWith({
      eventKind: "event",
      component: "component",
      detail: "detail",
      metadataJson: { ok: true },
    });
    expect(recordEvent).toHaveBeenCalledWith({
      eventKind: "provider_event",
      component: "provider",
      detail: "detail",
    });
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "session_1",
      requestId: "req_1",
      resolvedModelId: "openai-test",
    }));
    expect(persistDecisionTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      finishReason: "stop",
      escalated: true,
      optimizationLedger: { prefix_hash: "abc" },
    }));
  });

  it("returns a retryable error when the circuit breaker is open", async () => {
    const input = baseInput({
      circuitBreakers: {
        allowRequest: vi.fn(() => false),
        recordFailure: vi.fn(),
        recordSuccess: vi.fn(),
      },
    });

    const result = await runOpenAIChatNonStreamPipeline(input);

    expect(result).toEqual({
      kind: "error",
      statusCode: 503,
      headers: { "Retry-After": "30" },
      body: {
        error: {
          type: "service_unavailable",
          message: "Model provider temporarily unavailable. Try again shortly.",
        },
      },
    });
    expect(input.recordSessionEvent).toHaveBeenCalledWith(
      "breaker_open_reject",
      "circuit-breaker",
      "Circuit breaker open for openai-test",
      { model: "openai-test" },
    );
  });

  it("maps upstream provider failures to OpenAI-compatible errors", async () => {
    const input = baseInput({
      providerInput: {
        ...baseInput().providerInput,
        generateText: vi.fn(async () => {
          throw new Error("boom");
        }),
      } as never,
    });

    const result = await runOpenAIChatNonStreamPipeline(input);

    expect(result).toEqual({
      kind: "error",
      statusCode: 502,
      body: { error: { type: "upstream_error", message: "upstream failed" } },
    });
    expect(input.onMissingToolResults).toHaveBeenCalled();
    expect(input.circuitBreakers.recordFailure).toHaveBeenCalledWith("openai-test", "org_1");
    expect(input.recordSessionEvent).toHaveBeenCalledWith(
      "upstream_error",
      "generateText",
      "upstream failed",
      expect.objectContaining({
        model: "openai-test",
        missing_tool_results: true,
      }),
    );
  });
});
