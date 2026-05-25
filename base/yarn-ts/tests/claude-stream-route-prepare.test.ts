import { describe, expect, it, vi } from "vitest";
import { prepareClaudeStreamRoute } from "../src/streaming/claude-stream-route-prepare.js";

const scope = {
  sessionKey: "session-1",
  userId: "user-1",
  orgId: "org-1",
  requestId: "trace-1",
};

function runtimeInput() {
  return {
    requestIds: {
      traceRequestId: "trace-1",
      responseRequestId: "req-1",
    },
    resolvedModelId: "claude-test",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    toolChoice: "auto",
    providerOptions: {},
    captureRequestForensics: vi.fn(() => ({ summary: "captured" })),
    sideEffects: {
      session: { record: { requestCount: 1 } },
      clientKind: "claude-code",
      logger: { info: vi.fn() },
      strictGovernanceStats: { strictGovernanceRewrites: 0 },
      updateDiffAccumulator: vi.fn(),
      maybeUpdateTaskLedgerFromToolCall: vi.fn(),
      emitPlanWriteAuditEvent: vi.fn(),
      maybeLogEnvelopeUnwrapSample: vi.fn(),
      recordUpperHarnessDecision: vi.fn(),
    },
    abort: {
      longWaitEventMs: 10_000,
      hardTimeoutMs: 60_000,
    },
  };
}

describe("prepareClaudeStreamRoute", () => {
  it("returns the gate rejection without creating runtime", async () => {
    const result = await prepareClaudeStreamRoute({
      gates: {
        scope,
        resolvedModelId: "claude-test",
        logger: { warn: vi.fn() },
        streamAdmission: {
          acquire: async () => ({ admitted: false, retryAfterSeconds: 8, reason: "queue_full" }),
          getStats: () => ({}),
        },
        circuitBreakers: { allowRequest: () => true },
        recordSessionEvent: vi.fn(),
        startSpan: vi.fn(),
      },
      runtime: runtimeInput(),
    });

    expect(result).toEqual({
      ok: false,
      rejection: {
        ok: false,
        statusCode: 503,
        retryAfter: "8",
        payload: {
          type: "error",
          error: { type: "overloaded_error", message: "Server at capacity. Try again shortly." },
        },
      },
    });
  });

  it("creates runtime when gates pass", async () => {
    const result = await prepareClaudeStreamRoute({
      gates: {
        scope,
        resolvedModelId: "claude-test",
        logger: { warn: vi.fn() },
        streamAdmission: {
          acquire: async () => ({ admitted: true, release: vi.fn() }),
          getStats: () => ({}),
        },
        circuitBreakers: { allowRequest: () => true },
        recordSessionEvent: vi.fn(),
        startSpan: vi.fn(() => ({ setStatus: vi.fn(), end: vi.fn() })),
      },
      runtime: runtimeInput(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runtime.streamScope).toEqual(scope);
    expect(result.runtime.responseScope.requestId).toBe("req-1");
    expect(result.runtime.streamForensics).toEqual({ summary: "captured" });
    clearTimeout(result.runtime.streamAbortRuntime.hardTimeout);
  });
});
