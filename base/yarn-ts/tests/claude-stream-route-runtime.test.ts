import { describe, expect, it, vi } from "vitest";
import { createClaudeStreamRouteRuntime } from "../src/streaming/claude-stream-route-runtime.js";

describe("createClaudeStreamRouteRuntime", () => {
  it("builds stream forensics, side effects, and abort runtime from a started route", () => {
    const captured: unknown[] = [];
    const sideEffectCalls: unknown[] = [];
    const recordedEvents: unknown[] = [];
    const hardTimeouts: Array<ReturnType<typeof setTimeout>> = [];

    const runtime = createClaudeStreamRouteRuntime({
      started: {
        ok: true,
        startedAtMs: Date.now(),
        admission: { admitted: true, release: vi.fn() },
        scope: {
          sessionKey: "session-1",
          userId: "user-1",
          orgId: "org-1",
          requestId: "trace-1",
        },
        recordEvent: (event) => recordedEvents.push(event),
        span: { setStatus: vi.fn(), end: vi.fn() },
      },
      requestIds: {
        traceRequestId: "trace-1",
        responseRequestId: "response-1",
      },
      resolvedModelId: "model-1",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "Read" }],
      toolChoice: "auto",
      providerOptions: { anthropic: { cacheControl: true } },
      phasePolicy: { enabled: true, source: "phase_policy", phase: "build" },
      capabilityMatrix: {
        mode: "enforced",
        globalOptimizationsEnabled: true,
        modelId: "model-1",
        matchedOverrideIds: [],
        capabilityHash: "cap-1",
      },
      captureRequestForensics: (...args) => {
        captured.push(args);
        return { summary: "captured" };
      },
      sideEffects: {
        session: { record: { requestCount: 3 } },
        clientKind: "claude-code",
        logger: { info: vi.fn() },
        strictGovernanceStats: { strictGovernanceRewrites: 0 },
        updateDiffAccumulator: (...args) => sideEffectCalls.push(["diff", ...args]),
        maybeUpdateTaskLedgerFromToolCall: (...args) => sideEffectCalls.push(["task", ...args]),
        emitPlanWriteAuditEvent: (...args) => sideEffectCalls.push(["audit", ...args]),
        maybeLogEnvelopeUnwrapSample: (...args) => sideEffectCalls.push(["unwrap", ...args]),
        recordUpperHarnessDecision: (...args) => sideEffectCalls.push(["upper", ...args]),
      },
      abort: {
        longWaitEventMs: 10_000,
        hardTimeoutMs: 60_000,
      },
    });
    hardTimeouts.push(runtime.streamAbortRuntime.hardTimeout);

    expect(runtime.responseScope).toEqual({
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      requestId: "response-1",
    });
    expect(runtime.streamForensics).toEqual({ summary: "captured" });
    expect(captured[0]).toEqual([
      "session-1",
      "trace-1",
      "/v1/messages (stream)",
      "model-1",
      true,
      [{ role: "user", content: "hello" }],
      [{ name: "Read" }],
      "auto",
      { anthropic: { cacheControl: true } },
      { enabled: true, source: "phase_policy", phase: "build" },
      {
        mode: "enforced",
        globalOptimizationsEnabled: true,
        modelId: "model-1",
        matchedOverrideIds: [],
        capabilityHash: "cap-1",
      },
    ]);

    runtime.streamToolSideEffects.incrementStrictGovernanceRewrites(2);
    runtime.streamToolSideEffects.recordUpperHarnessDecision({
      action: "pass",
      reason: "ok",
      metadata: {},
    });
    runtime.recordStreamEvent({ eventKind: "started", component: "test", detail: "ok" });

    expect(sideEffectCalls).toContainEqual([
      "upper",
      "session-1",
      "user-1",
      "org-1",
      "trace-1",
      "upper-harness:claude-stream",
      { action: "pass", reason: "ok", metadata: {} },
    ]);
    expect(recordedEvents).toEqual([{ eventKind: "started", component: "test", detail: "ok" }]);
    expect(runtime.streamAbortRuntime.hardTimeoutMs).toBe(60_000);

    for (const timeout of hardTimeouts) {
      clearTimeout(timeout);
    }
  });
});
