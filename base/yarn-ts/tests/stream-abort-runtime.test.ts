import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamAbortRuntime } from "../src/streaming/stream-abort-runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createStreamAbortRuntime", () => {
  it("creates a hard-timeout abort runtime with protocol-specific event text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const recordSessionEvent = vi.fn();

    const runtime = createStreamAbortRuntime({
      protocolLabel: "Claude",
      model: "claude-test",
      startedAtMs: 1000,
      longWaitEventMs: 45_000,
      hardTimeoutMs: 30_000,
      recordSessionEvent,
    });

    expect(runtime.hardTimeoutMs).toBe(50_000);
    expect(runtime.abortController.signal.aborted).toBe(false);

    vi.advanceTimersByTime(50_000);

    expect(runtime.abortController.signal.aborted).toBe(true);
    expect(recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "stream_hard_timeout",
      component: "stream-heartbeat",
      detail: "Aborted Claude stream after 50000ms",
      metadataJson: {
        elapsedMs: 50_000,
        model: "claude-test",
      },
    });
    clearTimeout(runtime.hardTimeout);
  });
});
