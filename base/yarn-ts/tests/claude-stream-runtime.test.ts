import { describe, expect, it, vi } from "vitest";
import {
  startClaudeStreamRouteRuntime,
  startClaudeStreamSseRuntime,
} from "../src/streaming/claude-stream-runtime.js";

describe("startClaudeStreamSseRuntime", () => {
  it("writes SSE headers and starts heartbeat with Claude long-wait event recording", () => {
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
    } as unknown as Parameters<typeof startClaudeStreamSseRuntime>[0]["raw"];

    const heartbeat = startClaudeStreamSseRuntime({
      raw,
      headers: { "content-type": "text/event-stream" },
      model: "claude-model",
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
        model: "claude-model",
      },
    });
    heartbeat.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("starts route runtime and emits Claude message_start with session-scoped heartbeat events", () => {
    const writeHead = vi.fn();
    const stop = vi.fn();
    const recordSessionEvent = vi.fn();
    const sendSse = vi.fn(() => true);
    const startHeartbeat = vi.fn((input: {
      onLongWait?: (elapsedMs: number) => void;
    }) => {
      input.onLongWait?.(2_500);
      return { stop };
    });
    const raw = {
      destroyed: false,
      write: vi.fn(),
      writeHead,
    } as unknown as Parameters<typeof startClaudeStreamRouteRuntime>[0]["raw"];

    const runtime = startClaudeStreamRouteRuntime({
      raw,
      headers: { "content-type": "text/event-stream" },
      model: "claude-model",
      heartbeatIntervalMs: 15_000,
      longWaitEventMs: 45_000,
      startHeartbeat,
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      requestId: "req_1",
      createMessageId: () => "msg_1",
      sendSse,
      recordSessionEvent,
    });

    expect(runtime.messageId).toBe("msg_1");
    expect(runtime.heartbeat.stop).toBe(stop);
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "stream_long_wait",
      "stream-heartbeat",
      "Claude stream exceeded 45000ms without finishing",
      "req_1",
      { elapsedMs: 2_500, model: "claude-model" },
    );
    expect(sendSse).toHaveBeenCalledWith("message_start", {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-model",
        content: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  });
});
