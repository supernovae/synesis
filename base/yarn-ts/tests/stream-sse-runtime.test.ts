import { describe, expect, it, vi } from "vitest";
import { startStreamSseRuntime } from "../src/streaming/stream-sse-runtime.js";

describe("startStreamSseRuntime", () => {
  it("writes SSE headers and records protocol-specific long-wait events", () => {
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
      write: vi.fn(),
      writeHead,
    } as unknown as Parameters<typeof startStreamSseRuntime>[0]["raw"];

    const heartbeat = startStreamSseRuntime({
      raw,
      headers: { "content-type": "text/event-stream" },
      protocolLabel: "Claude",
      model: "claude-test",
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
      detail: "Claude stream exceeded 45000ms without finishing",
      metadataJson: {
        elapsedMs: 12_345,
        model: "claude-test",
      },
    });
    heartbeat.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});
