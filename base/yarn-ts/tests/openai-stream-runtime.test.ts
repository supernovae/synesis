import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAIStreamAbortRuntime,
  startOpenAIStreamSseRuntime,
} from "../src/streaming/openai-stream-runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenAI stream runtime", () => {
  it("creates a hard-timeout abort runtime and records timeout events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const recordSessionEvent = vi.fn();

    const runtime = createOpenAIStreamAbortRuntime({
      requestId: "req_1",
      model: "model-a",
      startedAtMs: 10_000,
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
      detail: "Aborted OpenAI stream after 50000ms",
      metadataJson: {
        elapsedMs: 50_000,
        model: "model-a",
      },
    });
    clearTimeout(runtime.hardTimeout);
  });

  it("writes SSE headers and starts heartbeat with long-wait event recording", () => {
    const writes: string[] = [];
    const writeHead = vi.fn();
    const stop = vi.fn();
    const recordSessionEvent = vi.fn();
    const startHeartbeat = vi.fn((input: {
      onLongWait?: (elapsedMs: number) => void;
    }) => {
      input.onLongWait?.(12_345);
      return { stop };
    });
    const raw = {
      destroyed: false,
      write: (data: string) => {
        writes.push(data);
      },
      writeHead,
    } as unknown as Parameters<typeof startOpenAIStreamSseRuntime>[0]["raw"];

    const heartbeat = startOpenAIStreamSseRuntime({
      raw,
      headers: { "content-type": "text/event-stream" },
      model: "model-a",
      heartbeatIntervalMs: 15_000,
      longWaitEventMs: 45_000,
      startHeartbeat,
      recordSessionEvent,
    });

    expect(writeHead).toHaveBeenCalledWith(200, { "content-type": "text/event-stream" });
    expect(startHeartbeat).toHaveBeenCalledWith(expect.objectContaining({
      raw,
      intervalMs: 15_000,
      longWaitEventMs: 45_000,
    }));
    expect(recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "stream_long_wait",
      component: "stream-heartbeat",
      detail: "OpenAI stream exceeded 45000ms without finishing",
      metadataJson: {
        elapsedMs: 12_345,
        model: "model-a",
      },
    });
    heartbeat.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});
