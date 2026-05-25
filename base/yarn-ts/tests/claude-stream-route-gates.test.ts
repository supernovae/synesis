import { describe, expect, it } from "vitest";
import { startClaudeStreamRouteGates } from "../src/streaming/claude-stream-route-gates.js";

const scope = {
  sessionKey: "session-1",
  userId: "user-1",
  orgId: "org-1",
  requestId: "req-1",
};

describe("startClaudeStreamRouteGates", () => {
  it("returns the Claude overloaded envelope when admission rejects", async () => {
    const result = await startClaudeStreamRouteGates({
      scope,
      resolvedModelId: "model-1",
      logger: { warn: () => undefined },
      streamAdmission: {
        acquire: async () => ({ admitted: false, reason: "queue_full", retryAfterSeconds: 11 }),
        getStats: () => ({ queued: 4 }),
      },
      circuitBreakers: { allowRequest: () => true },
      recordSessionEvent: () => undefined,
      startSpan: () => ({ setStatus: () => undefined, end: () => undefined }),
    });

    expect(result).toEqual({
      ok: false,
      statusCode: 503,
      retryAfter: "11",
      payload: {
        type: "error",
        error: { type: "overloaded_error", message: "Server at capacity. Try again shortly." },
      },
    });
  });

  it("returns the Claude provider unavailable envelope when breaker rejects", async () => {
    let released = false;
    const result = await startClaudeStreamRouteGates({
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
      statusCode: 503,
      retryAfter: "30",
      payload: {
        type: "error",
        error: {
          type: "overloaded_error",
          message: "Model provider temporarily unavailable. Try again shortly.",
        },
      },
    });
  });

  it("starts the Claude stream span when gates pass", async () => {
    const result = await startClaudeStreamRouteGates({
      scope,
      resolvedModelId: "model-1",
      logger: { warn: () => undefined },
      streamAdmission: {
        acquire: async () => ({ admitted: true, release: () => undefined }),
        getStats: () => ({}),
      },
      circuitBreakers: { allowRequest: () => true },
      recordSessionEvent: () => undefined,
      startSpan: (name, attributes) => ({
        setStatus: () => undefined,
        end: () => undefined,
        name,
        attributes,
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.span).toMatchObject({
      name: "yarn.claude.stream",
      attributes: { model: "model-1", sessionKey: "session-1" },
    });
  });
});
