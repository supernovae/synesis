import { describe, expect, it } from "vitest";
import { startOpenAIStreamRoute } from "../src/pipeline/openai-stream-route-start.js";

const scope = {
  sessionKey: "session-1",
  userId: "user-1",
  orgId: "org-1",
  requestId: "req-1",
};

describe("startOpenAIStreamRoute", () => {
  it("returns a pipeline error result when stream admission rejects", async () => {
    const events: unknown[] = [];
    const result = await startOpenAIStreamRoute({
      scope,
      resolvedModelId: "model-1",
      logger: { warn: () => undefined },
      streamAdmission: {
        acquire: async () => ({ admitted: false, reason: "queue_full", retryAfterSeconds: 7 }),
        getStats: () => ({ queued: 10 }),
      },
      circuitBreakers: { allowRequest: () => true },
      recordSessionEvent: (...event) => events.push(event),
      startSpan: () => ({ setStatus: () => undefined, end: () => undefined }),
    });

    expect(result).toEqual({
      ok: false,
      result: {
        kind: "error",
        statusCode: 503,
        headers: { "Retry-After": "7" },
        body: { error: { type: "service_unavailable", message: "Server at capacity. Try again shortly." } },
      },
    });
    expect(events).toHaveLength(1);
  });

  it("releases admission and returns a pipeline error when the circuit breaker is open", async () => {
    let released = false;
    const result = await startOpenAIStreamRoute({
      scope,
      resolvedModelId: "model-1",
      logger: { warn: () => undefined },
      streamAdmission: {
        acquire: async () => ({ admitted: true, release: () => { released = true; } }),
        getStats: () => ({}),
      },
      circuitBreakers: { allowRequest: () => false },
      recordSessionEvent: () => undefined,
      startSpan: () => ({ setStatus: () => undefined, end: () => undefined }),
    });

    expect(released).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      result: {
        kind: "error",
        statusCode: 503,
        headers: { "Retry-After": "30" },
      },
    });
  });

  it("returns stream route context when admitted and breaker allows", async () => {
    const events: unknown[] = [];
    const result = await startOpenAIStreamRoute({
      scope,
      resolvedModelId: "model-1",
      logger: { warn: () => undefined },
      streamAdmission: {
        acquire: async () => ({ admitted: true, release: () => undefined }),
        getStats: () => ({}),
      },
      circuitBreakers: { allowRequest: () => true },
      recordSessionEvent: (...event) => events.push(event),
      startSpan: (name, attributes) => ({
        setStatus: () => undefined,
        end: () => undefined,
        name,
        attributes,
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope).toEqual(scope);
    expect(result.span).toMatchObject({
      name: "yarn.openai.stream",
      attributes: { model: "model-1", sessionKey: "session-1" },
    });
    result.recordEvent({ eventKind: "started", component: "test", detail: "ok" });
    expect(events).toHaveLength(1);
  });
});
