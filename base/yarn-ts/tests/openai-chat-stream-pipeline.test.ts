import { describe, expect, it } from "vitest";
import { runOpenAIChatStreamPipeline } from "../src/pipeline/openai-chat-stream-pipeline.js";

describe("runOpenAIChatStreamPipeline", () => {
  it("returns the OpenAI pipeline error result when stream start rejects", async () => {
    const result = await runOpenAIChatStreamPipeline({
      scope: {
        sessionKey: "session-1",
        userId: "user-1",
        orgId: "org-1",
        requestId: "req-1",
      },
      resolvedModelId: "model-1",
      recordSessionEvent: () => undefined,
      start: {
        logger: { warn: () => undefined },
        streamAdmission: {
          acquire: async () => ({ admitted: false, reason: "full", retryAfterSeconds: 9 }),
          getStats: () => ({}),
        },
        circuitBreakers: { allowRequest: () => true },
        startSpan: () => ({ setStatus: () => undefined, end: () => undefined }),
      },
      provider: {} as never,
      runtime: {} as never,
      eventHandlers: {} as never,
      finalizer: {} as never,
      telemetry: {} as never,
    });

    expect(result).toEqual({
      kind: "error",
      statusCode: 503,
      headers: { "Retry-After": "9" },
      body: { error: { type: "service_unavailable", message: "Server at capacity. Try again shortly." } },
    });
  });
});
