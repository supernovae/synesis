import { describe, expect, it, vi } from "vitest";
import { buildClaudeStreamRouteStartInput } from "../src/streaming/claude-stream-route-start-input.js";

describe("buildClaudeStreamRouteStartInput", () => {
  it("builds the Claude stream start section from transport/provider/components groups", () => {
    const raw = { destroyed: false, write: vi.fn(), writeHead: vi.fn() } as never;
    const startHeartbeat = vi.fn();
    const sendSse = vi.fn();
    const streamText = vi.fn();
    const recordSessionEvent = vi.fn();
    const computePrefixFingerprint = vi.fn(() => "prefix-1");
    const clampMaxOutputTokens = vi.fn((tokens: number) => tokens);
    const logger = { warn: vi.fn() };

    const input = buildClaudeStreamRouteStartInput({
      recordSessionEvent,
      transport: {
        raw,
        headers: { "content-type": "text/event-stream" },
        heartbeatIntervalMs: 15_000,
        longWaitEventMs: 45_000,
        startHeartbeat,
        createMessageId: () => "msg-1",
        sendSse,
        streamText,
      },
      provider: {
        requestId: "trace-1",
        model: "model",
        messages: [{ role: "user", content: "hi" }],
        adapter: { family: "anthropic", supportsThinking: true },
        orchestrationMaxOutputTokens: 512,
        requestMaxTokens: 128,
        samplingOptions: { temperature: 0.2 },
        stopSequences: ["stop"],
        tools: [{ name: "Read" }],
        toolChoice: "auto",
        providerOptions: { anthropic: { cache_control: "ephemeral" } },
        clampMaxOutputTokens,
        logger,
      },
      components: {
        tierConfig: { baseUrl: "https://api.anthropic.com", backendModel: "claude-test" },
        resolvedModelId: "claude-test",
        tools: [{ name: "Read" }],
        computePrefixFingerprint,
      },
    });

    expect(input.raw).toBe(raw);
    expect(input.recordSessionEvent).toBe(recordSessionEvent);
    expect(input.headers).toEqual({ "content-type": "text/event-stream" });
    expect(input.startHeartbeat).toBe(startHeartbeat);
    expect(input.createMessageId()).toBe("msg-1");
    expect(input.sendSse).toBe(sendSse);
    expect(input.streamText).toBe(streamText);
    expect(input.request).toMatchObject({
      requestId: "trace-1",
      model: "model",
      messages: [{ role: "user", content: "hi" }],
      adapter: { family: "anthropic", supportsThinking: true },
      orchestrationMaxOutputTokens: 512,
      requestMaxTokens: 128,
      samplingOptions: { temperature: 0.2 },
      stopSequences: ["stop"],
      tools: [{ name: "Read" }],
      toolChoice: "auto",
      providerOptions: { anthropic: { cache_control: "ephemeral" } },
    });
    expect(input.request.clampMaxOutputTokens).toBe(clampMaxOutputTokens);
    expect(input.request.logger).toBe(logger);
    expect(input.components.computePrefixFingerprint).toBe(computePrefixFingerprint);
  });
});
