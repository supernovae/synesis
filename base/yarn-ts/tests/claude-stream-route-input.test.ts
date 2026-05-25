import { describe, expect, it, vi } from "vitest";
import { buildClaudeStreamRouteRunInput } from "../src/streaming/claude-stream-route-input.js";

describe("buildClaudeStreamRouteRunInput", () => {
  it("derives runtime-linked fields for the Claude stream route", () => {
    const abortController = new AbortController();
    const hardTimeout = setTimeout(() => undefined, 60_000);
    const admissionRelease = vi.fn();
    const streamScope = {
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      requestId: "trace-1",
    };
    const responseScope = {
      ...streamScope,
      requestId: "response-1",
    };
    const span = { setStatus: vi.fn(), end: vi.fn() };

    const input = buildClaudeStreamRouteRunInput({
      runtime: {
        streamSpan: span,
        startedAtMs: 123,
        streamScope,
        responseScope,
        recordStreamEvent: vi.fn(),
        admissionRelease,
        streamForensics: { summary: "forensics" },
        streamToolSideEffects: {} as never,
        streamAbortRuntime: {
          abortController,
          hardTimeout,
          hardTimeoutMs: 60_000,
        },
      },
      start: {
        recordSessionEvent: vi.fn(),
        raw: { destroyed: false, write: vi.fn(), writeHead: vi.fn() } as never,
        headers: { "content-type": "text/event-stream" },
        heartbeatIntervalMs: 15_000,
        longWaitEventMs: 45_000,
        startHeartbeat: vi.fn(),
        createMessageId: () => "msg-1",
        sendSse: vi.fn(),
        streamText: vi.fn(),
        request: {
          requestId: "trace-1",
          model: "model",
          messages: [{ role: "user", content: "hi" }],
          adapter: { family: "anthropic", supportsThinking: true },
          orchestrationMaxOutputTokens: 256,
          clampMaxOutputTokens: (tokens) => tokens,
          logger: { warn: vi.fn() },
        },
        components: {
          resolvedModelId: "claude-test",
          tools: [],
          computePrefixFingerprint: () => "prefix-1",
        },
      },
      pipeline: {
        eventHandlers: {} as never,
        lifecycle: {
          session: {},
          circuitBreakers: {},
          logger: {},
          extractUpstreamErrorDiagnostics: vi.fn(),
          recordSessionEvent: vi.fn(),
        } as never,
        afterEvents: {} as never,
      },
      completion: {
        finalizer: {
          session: {},
          readUsage: vi.fn(),
          finalizeRequestForensics: vi.fn(),
          handlerInput: {},
          endStream: vi.fn(),
          recordSessionEvent: vi.fn(),
        } as never,
        telemetry: {
          clientRequestedModel: "claude-test",
          reductions: {},
          reducedToolResults: 0,
          orchestration: {},
          policyMatchedRules: [],
          normalizedMessages: [],
          inferVerificationSteps: vi.fn(),
          toolDefinitionCount: 0,
          artifactToolInjected: false,
          knowledgeToolInjected: false,
          countMessageRoles: vi.fn(),
          pushDiagnostic: vi.fn(),
          recordSessionEvent: vi.fn(),
          persistDecisionTelemetry: vi.fn(),
        } as never,
      },
    });

    expect(input.start.scope).toBe(streamScope);
    expect(input.start.request.abortSignal).toBe(abortController.signal);
    expect(input.pipeline.lifecycle.abortSignal).toBe(abortController.signal);
    expect(input.pipeline.lifecycle.hardTimeout).toBe(hardTimeout);
    expect(input.pipeline.lifecycle.admissionRelease).toBe(admissionRelease);
    expect(input.pipeline.lifecycle.span).toBe(span);
    expect(input.completion.finalizer).toMatchObject(responseScope);
    expect(input.completion.telemetry.scope).toBe(responseScope);
    expect(input.completion.telemetry.startedAtMs).toBe(123);
    expect(input.completion.telemetry.resolvedModelId).toBe("claude-test");

    clearTimeout(hardTimeout);
  });
});
