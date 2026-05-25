import { describe, expect, it } from "vitest";
import { startStreamRoute } from "../src/streaming/stream-route-start.js";

const scope = {
  sessionKey: "session-1",
  userId: "user-1",
  orgId: "org-1",
  requestId: "req-1",
};

describe("startStreamRoute", () => {
  it("returns the caller payload when admission rejects", async () => {
    const events: unknown[] = [];
    const result = await startStreamRoute({
      scope,
      resolvedModelId: "model-1",
      spanName: "test.stream",
      logger: { warn: () => undefined },
      streamAdmission: {
        acquire: async () => ({ admitted: false, reason: "queue_full", retryAfterSeconds: 9 }),
        getStats: () => ({ queued: 3 }),
      },
      circuitBreakers: { allowRequest: () => true },
      recordSessionEvent: (...event) => events.push(event),
      startSpan: () => ({ setStatus: () => undefined, end: () => undefined }),
      admissionRejection: {
        logMessage: "stream_admission_rejected_test",
        payload: { error: { type: "overloaded_error" } },
      },
      circuitBreakerRejection: {
        detail: "breaker open",
        logMessage: "circuit_breaker_open_test",
        payload: { error: { type: "provider_unavailable" } },
      },
    });

    expect(result).toEqual({
      ok: false,
      statusCode: 503,
      retryAfter: "9",
      payload: { error: { type: "overloaded_error" } },
    });
    expect(events).toHaveLength(1);
  });

  it("releases admission and returns the caller payload when the breaker rejects", async () => {
    let released = false;
    const result = await startStreamRoute({
      scope,
      resolvedModelId: "model-1",
      spanName: "test.stream",
      logger: { warn: () => undefined },
      streamAdmission: {
        acquire: async () => ({ admitted: true, release: () => { released = true; } }),
        getStats: () => ({}),
      },
      circuitBreakers: { allowRequest: () => false },
      recordSessionEvent: () => undefined,
      startSpan: () => ({ setStatus: () => undefined, end: () => undefined }),
      admissionRejection: {
        logMessage: "stream_admission_rejected_test",
        payload: { error: { type: "overloaded_error" } },
      },
      circuitBreakerRejection: {
        detail: "breaker open",
        logMessage: "circuit_breaker_open_test",
        payload: { error: { type: "provider_unavailable" } },
      },
    });

    expect(released).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      statusCode: 503,
      retryAfter: "30",
      payload: { error: { type: "provider_unavailable" } },
    });
  });

  it("returns route runtime fields when admitted", async () => {
    const result = await startStreamRoute({
      scope,
      resolvedModelId: "model-1",
      spanName: "test.stream",
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
      admissionRejection: {
        logMessage: "stream_admission_rejected_test",
        payload: { error: { type: "overloaded_error" } },
      },
      circuitBreakerRejection: {
        detail: "breaker open",
        logMessage: "circuit_breaker_open_test",
        payload: { error: { type: "provider_unavailable" } },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scope).toEqual(scope);
    expect(result.span).toMatchObject({
      name: "test.stream",
      attributes: { model: "model-1", sessionKey: "session-1" },
    });
  });
});
