import { describe, expect, it, vi } from "vitest";
import { runOpenAIStreamAfterEvents } from "../src/streaming/openai-stream-after-events.js";
import { OpenAIStreamState } from "../src/streaming/openai-stream-state.js";
import { createOpenAIStreamToolCallAccumulator } from "../src/streaming/openai-stream-tool-call-handler.js";

function baseInput(overrides: Partial<Parameters<typeof runOpenAIStreamAfterEvents>[0]> = {}) {
  const streamState = new OpenAIStreamState();
  const accumulator = createOpenAIStreamToolCallAccumulator();
  const recordBlockedDiscovery = vi.fn();
  const recordSessionEvent = vi.fn();
  const logger = { warn: vi.fn() };
  const stats = { qwenParserMismatchSuspectCount: 0 };
  return {
    streamState,
    accumulator,
    stats,
    logger,
    recordBlockedDiscovery,
    recordSessionEvent,
    input: {
      adapter: { family: "test" },
      localLikeBaseUrl: false,
      requestId: "req_1",
      resolvedModelId: "model-a",
      baseUrl: "http://localhost:8000",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      streamState,
      accumulator,
      blockedDetails: [],
      stats,
      logger,
      recordBlockedDiscovery,
      getBlockedDiscoveryCount: () => 4,
      recordSessionEvent,
      ...overrides,
    },
  };
}

describe("runOpenAIStreamAfterEvents", () => {
  it("normalizes tool-call finish when no tool calls were emitted", () => {
    const h = baseInput();
    h.streamState.markToolCallFinish();

    runOpenAIStreamAfterEvents(h.input);

    expect(h.streamState.rawFinishReason()).toBe("stop");
  });

  it("records qwen parser mismatch suspicion for local repeated repair failures", () => {
    const h = baseInput({
      adapter: { family: "qwen3-coder" },
      localLikeBaseUrl: true,
    });
    h.accumulator.validationFailures = 1;
    h.accumulator.toolRepairs = 2;

    runOpenAIStreamAfterEvents(h.input);

    expect(h.stats.qwenParserMismatchSuspectCount).toBe(1);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      reqId: "req_1",
      validationFailures: 1,
      repairs: 2,
    }), expect.stringContaining("qwen3_parser_mismatch_suspected"));
  });

  it("records blocked and collapsed discovery summaries", () => {
    const h = baseInput({
      blockedDetails: [{ toolName: "Glob", reason: "empty_glob_pattern_blocked" }],
    });
    h.accumulator.blockedBroadDiscovery = 2;
    h.accumulator.collapsedBroadDiscovery = 1;
    h.accumulator.recoveryMode = "top_level_snapshot";
    h.accumulator.recoveryPreviewEntries = 3;

    runOpenAIStreamAfterEvents(h.input);

    expect(h.recordBlockedDiscovery).toHaveBeenCalledWith("session_1", 2);
    expect(h.recordSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: "tool_call_blocked_broad_discovery",
      detail: "blocked=2;sessionTotal=4",
      metadataJson: expect.objectContaining({
        recoveryMode: "top_level_snapshot",
        topLevelPreview: 3,
      }),
    }));
    expect(h.recordSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: "blocked_broad_discovery_then_recovery",
    }));
    expect(h.recordSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: "duplicate_broad_call_collapsed",
      detail: "collapsed=1",
    }));
  });
});
