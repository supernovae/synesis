import { describe, expect, it, vi } from "vitest";
import { prepareOpenAIStreamMessages } from "../src/streaming/openai-stream-message-preflight.js";

function harness() {
  return {
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
    },
    recordSessionEvent: vi.fn(),
  };
}

describe("prepareOpenAIStreamMessages", () => {
  it("repairs orphaned tool calls and records the same route event", () => {
    const h = harness();
    const messages = [
      { role: "user", content: "run pwd" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", function: { name: "Bash", arguments: "{}" } }],
      },
    ];

    const prepared = prepareOpenAIStreamMessages({
      requestId: "req_1",
      messages,
      adapterFamily: "openai",
      debugProtocol: false,
      logger: h.logger,
      recordSessionEvent: h.recordSessionEvent,
    });

    expect(prepared).toHaveLength(3);
    expect(prepared[2]).toMatchObject({
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "Bash",
      }],
    });
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      reqId: "req_1",
      orphanedToolCallIds: ["call_1"],
      count: 1,
    }), "tool_pair_integrity_repair_applied");
    expect(h.recordSessionEvent).toHaveBeenCalledWith({
      eventKind: "tool_pair_integrity_repaired",
      component: "validation",
      detail: "orphaned=1 ids=call_1",
    });
  });

  it("demotes inline system messages for Minimax and normalizes assistant strings", () => {
    const h = harness();
    const prepared = prepareOpenAIStreamMessages({
      requestId: "req_1",
      messages: [
        { role: "system", content: "first" },
        { role: "user", content: "hello" },
        { role: "system", content: "mid" },
        { role: "assistant", content: "answer" },
      ],
      adapterFamily: "minimax",
      debugProtocol: false,
      logger: h.logger,
      recordSessionEvent: h.recordSessionEvent,
    });

    expect(prepared[2]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "[System note]\nmid" }],
    });
    expect(prepared[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
    });
  });

  it("logs debug protocol diagnostics before final content normalization", () => {
    const h = harness();
    prepareOpenAIStreamMessages({
      requestId: "req_1",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "Bash" }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "call_2", toolName: "Read" }],
        },
      ],
      adapterFamily: "qwen3-coder",
      debugProtocol: true,
      samplingOptions: { temperature: 0 },
      logger: h.logger,
      recordSessionEvent: h.recordSessionEvent,
    });

    expect(h.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      reqId: "req_1",
      messageCount: 3,
      orphanedCalls: [],
      orphanedResults: ["call_2"],
      effectiveSampling: { temperature: 0 },
      adapterFamily: "qwen3-coder",
    }), "pre_stream_message_diagnostic");
  });
});
