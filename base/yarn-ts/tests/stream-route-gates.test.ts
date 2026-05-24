import { describe, expect, it, vi } from "vitest";
import {
  buildStreamAdmissionRejection,
  buildStreamCircuitBreakerRejection,
} from "../src/streaming/stream-route-gates.js";

const scope = {
  sessionKey: "session_1",
  userId: "user_1",
  orgId: "org_1",
  requestId: "req_1",
};

describe("buildStreamAdmissionRejection", () => {
  it("returns null for admitted requests", () => {
    expect(buildStreamAdmissionRejection({
      admission: { admitted: true },
      queueStats: { active: 1 },
      logMessage: "stream_admission_rejected",
      scope,
      logger: { warn: vi.fn() },
      recordSessionEvent: vi.fn(),
      payload: { error: "overloaded" },
    })).toBeNull();
  });

  it("logs, records, and returns retry metadata for rejected requests", () => {
    const logger = { warn: vi.fn() };
    const recordSessionEvent = vi.fn();
    const rejection = buildStreamAdmissionRejection({
      admission: { admitted: false, reason: "queue_full", retryAfterSeconds: 9 },
      queueStats: { queued: 10 },
      logMessage: "stream_admission_rejected",
      scope,
      logger,
      recordSessionEvent,
      payload: { error: "overloaded" },
    });

    expect(rejection).toEqual({
      statusCode: 503,
      retryAfter: "9",
      payload: { error: "overloaded" },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { reason: "queue_full", queueStats: { queued: 10 } },
      "stream_admission_rejected",
    );
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "stream_admission_reject",
      "stream-admission",
      "queue_full",
      "req_1",
    );
  });
});

describe("buildStreamCircuitBreakerRejection", () => {
  it("returns null when the breaker allows the request", () => {
    expect(buildStreamCircuitBreakerRejection({
      allowed: true,
      admission: { release: vi.fn() },
      model: "model-a",
      orgId: "org_1",
      detail: "Circuit breaker open",
      logMessage: "circuit_breaker_open_stream",
      scope,
      logger: { warn: vi.fn() },
      recordSessionEvent: vi.fn(),
      payload: { error: "unavailable" },
    })).toBeNull();
  });

  it("releases admission, logs, records, and returns retry metadata when open", () => {
    const release = vi.fn();
    const logger = { warn: vi.fn() };
    const recordSessionEvent = vi.fn();
    const rejection = buildStreamCircuitBreakerRejection({
      allowed: false,
      admission: { release },
      model: "model-a",
      orgId: "org_1",
      detail: "Circuit breaker open for model-a (stream)",
      logMessage: "circuit_breaker_open_stream",
      scope,
      logger,
      recordSessionEvent,
      payload: { error: "unavailable" },
    });

    expect(rejection).toEqual({
      statusCode: 503,
      retryAfter: "30",
      payload: { error: "unavailable" },
    });
    expect(release).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      { model: "model-a", orgId: "org_1" },
      "circuit_breaker_open_stream",
    );
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "breaker_open_reject",
      "circuit-breaker",
      "Circuit breaker open for model-a (stream)",
      "req_1",
      { model: "model-a" },
    );
  });
});
