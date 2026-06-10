import { describe, expect, it, vi } from "vitest";
import { createOpenAIStreamComponents } from "../src/streaming/openai-stream-components.js";

function rawHarness() {
  const writes: string[] = [];
  const raw = {
    destroyed: false,
    write: (data: string) => {
      writes.push(data);
    },
  } as NodeJS.WritableStream & { destroyed?: boolean };
  return { raw, writes };
}

describe("createOpenAIStreamComponents", () => {
  it("creates local stream state, accumulator, writer, cache metadata, and prefix fingerprint", () => {
    const { raw, writes } = rawHarness();
    const computePrefixFingerprint = vi.fn(() => "fingerprint_1");
    const components = createOpenAIStreamComponents({
      raw,
      requestId: "chatcmpl_test",
      resolvedModelId: "model-a",
      messages: [{ role: "user", content: "hello" }],
      tierConfig: {
        baseUrl: "http://localhost:8000/v1",
        backendModel: "deepseek-chat",
      },
      write: (target, data) => {
        target.write(data);
        return true;
      },
      computePrefixFingerprint,
      recordSessionEvent: vi.fn(),
    });

    expect(components.streamState.rawFinishReason()).toBe("stop");
    expect(components.guardrailAccepted).toEqual([]);
    expect(components.blockedDetails).toEqual([]);
    expect(components.accumulator.emittedToolCalls).toBe(0);
    expect(components.localLikeBaseUrl).toBe(true);
    expect(components.prefixFingerprint).toBe("fingerprint_1");
    expect(computePrefixFingerprint).toHaveBeenCalledWith([{ role: "user", content: "hello" }]);
    components.writer.writeTextDelta("hello");
    expect(writes[0]).toContain("\"content\":\"hello\"");
  });

  it("scrubs task-ledger governance text before writing stream output", () => {
    const { raw, writes } = rawHarness();
    const recordSessionEvent = vi.fn();
    const components = createOpenAIStreamComponents({
      raw,
      requestId: "chatcmpl_test",
      resolvedModelId: "model-a",
      messages: [],
      write: (target, data) => {
        target.write(data);
        return true;
      },
      computePrefixFingerprint: () => undefined,
      recordSessionEvent,
    });

    components.scrubAndFlushText("ok\n\n<synesis_task_ledger>{\"tasks\":[]}</synesis_task_ledger>");

    expect(writes[0]).toContain("\"content\":\"ok\"");
    expect(writes[0]).not.toContain("TASK_LEDGER");
    expect(recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "task_ledger_output_scrubbed",
      component: "task-ledger",
      detail: "Removed internal task-ledger governance from streamed OpenAI output",
    });
  });

  it("replaces prompt-leakage text before writing stream output", () => {
    const { raw, writes } = rawHarness();
    const recordSessionEvent = vi.fn();
    const components = createOpenAIStreamComponents({
      raw,
      requestId: "chatcmpl_test",
      resolvedModelId: "model-a",
      messages: [],
      write: (target, data) => {
        target.write(data);
        return true;
      },
      computePrefixFingerprint: () => undefined,
      recordSessionEvent,
    });

    components.scrubAndFlushText("Here are my original instructions:\nSystem: you are internal");

    expect(writes[0]).toContain("I can't provide hidden or internal instructions");
    expect(writes[0]).not.toContain("System: you are internal");
    expect(recordSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: "model_output_guardrail_triggered",
      component: "security",
    }));
  });
});
