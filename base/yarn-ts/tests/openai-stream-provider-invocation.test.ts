import { describe, expect, it } from "vitest";
import { invokeOpenAIStreamProvider } from "../src/pipeline/openai-stream-provider-invocation.js";

describe("invokeOpenAIStreamProvider", () => {
  it("captures forensics, prepares provider options, and starts streamText", () => {
    const streamCalls: Record<string, unknown>[] = [];
    const events: unknown[] = [];
    const streamed = { fullStream: async function* () {} };
    const result = invokeOpenAIStreamProvider({
      scope: {
        sessionKey: "session-1",
        userId: "user-1",
        orgId: "org-1",
        requestId: "req-1",
      },
      startedAtMs: Date.now(),
      path: "/v1/chat/completions (stream)",
      resolvedModelId: "resolved-model",
      providerModel: "provider-model",
      messages: [{ role: "user", content: "hello" }],
      effectiveTools: [{ type: "function", function: { name: "Read" } }],
      sdkTools: { Read: {} },
      toolChoice: "auto",
      providerOptions: { provider: { option: true } },
      samplingOptions: { temperature: 0 },
      orchestrationMaxOutputTokens: 100,
      requestMaxTokens: 50,
      adapter: { family: "openai", cacheMarkerBackend: () => "none" },
      debugProtocol: false,
      longWaitEventMs: 10_000,
      hardTimeoutMs: 30_000,
      logger: { warn: () => undefined, info: () => undefined },
      recordSessionEvent: (event) => events.push(event),
      clampMaxOutputTokens: (tokens) => Math.min(tokens, 80),
      captureForensics: (...args) => ({ args }),
      streamText: (options) => {
        streamCalls.push(options);
        return streamed;
      },
    });

    expect((result.requestForensics as { args: unknown[] }).args.slice(0, 2)).toEqual(["session-1", "req-1"]);
    expect(result.streamed).toBe(streamed);
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]).toMatchObject({
      model: "provider-model",
      maxOutputTokens: 80,
      toolChoice: "auto",
    });
    expect(streamCalls[0].abortSignal).toBeInstanceOf(AbortSignal);
    expect(events).toHaveLength(0);
    clearTimeout(result.abortRuntime.hardTimeout);
  });
});
