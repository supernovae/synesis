import { describe, expect, it, vi } from "vitest";

import { startClaudeStreamRoute } from "../src/streaming/claude-stream-route-start.js";

describe("startClaudeStreamRoute", () => {
  it("prepares the provider request, starts SSE runtime, and returns stream components", () => {
    const writeHead = vi.fn();
    const stop = vi.fn();
    const recordSessionEvent = vi.fn();
    const sendSse = vi.fn(() => true);
    const streamText = vi.fn(() => ({
      fullStream: (async function* stream() {})(),
      totalUsage: Promise.resolve({}),
      text: Promise.resolve("done"),
    }));
    const startHeartbeat = vi.fn((input: { onLongWait?: (elapsedMs: number) => void }) => {
      input.onLongWait?.(1_000);
      return { stop };
    });
    const raw = {
      destroyed: false,
      write: vi.fn(),
      writeHead,
    } as unknown as Parameters<typeof startClaudeStreamRoute>[0]["raw"];

    const result = startClaudeStreamRoute({
      scope: {
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        requestId: "req_1",
      },
      recordSessionEvent,
      raw,
      headers: { "content-type": "text/event-stream" },
      heartbeatIntervalMs: 15_000,
      longWaitEventMs: 45_000,
      startHeartbeat,
      createMessageId: () => "msg_1",
      sendSse,
      streamText,
      request: {
        requestId: "req_1",
        model: "model",
        messages: [{ role: "user", content: "hi" }],
        adapter: { family: "openai", supportsThinking: true },
        abortSignal: new AbortController().signal,
        orchestrationMaxOutputTokens: 100,
        requestMaxTokens: 25,
        tools: [{ name: "Edit" }],
        toolChoice: "auto",
        providerOptions: { anthropic: { cache_control: "ephemeral" } },
        clampMaxOutputTokens: (tokens) => tokens,
        logger: { warn: vi.fn() },
      },
      components: {
        tierConfig: { baseUrl: "https://api.anthropic.com", backendModel: "claude-test" },
        resolvedModelId: "claude-test",
        tools: [{ name: "Edit" }],
        computePrefixFingerprint: vi.fn(() => "prefix_1"),
      },
    });

    expect(writeHead).toHaveBeenCalledWith(200, { "content-type": "text/event-stream" });
    expect(sendSse).toHaveBeenCalledWith("message_start", expect.objectContaining({
      message: expect.objectContaining({ id: "msg_1", model: "claude-test" }),
    }));
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "stream_long_wait",
      "stream-heartbeat",
      "Claude stream exceeded 45000ms without finishing",
      "req_1",
      { elapsedMs: 1_000, model: "claude-test" },
    );
    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({
      model: "model",
      maxOutputTokens: 100,
      toolChoice: "auto",
    }));
    expect(result.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(result.cacheShapeDiagnostics).toMatchObject({
      messageCount: 1,
      toolCount: 1,
    });
    expect(result.runtime.messageId).toBe("msg_1");
    expect(result.components.prefixFingerprint).toBe("prefix_1");
    result.runtime.heartbeat.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});
