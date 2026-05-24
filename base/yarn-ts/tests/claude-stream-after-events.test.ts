import { describe, expect, it, vi } from "vitest";
import {
  createClaudeStreamAfterEventsHandler,
  runClaudeStreamAfterEvents,
} from "../src/streaming/claude-stream-after-events.js";
import { ClaudeStreamState } from "../src/streaming/claude-stream-state.js";

function baseInput(overrides: Partial<Parameters<typeof runClaudeStreamAfterEvents>[0]> = {}) {
  const streamState = new ClaudeStreamState();
  const discovery = {
    recoveryPreviewEntries: 0,
    recoveryMode: null,
    blockedBroadDiscovery: 0,
    collapsedBroadDiscovery: 0,
  };
  const recordBlockedDiscovery = vi.fn();
  const recordSessionEvent = vi.fn();
  const logger = { warn: vi.fn() };
  const stats = { qwenParserMismatchSuspectCount: 0 };
  return {
    streamState,
    discovery,
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
      streamState,
      discovery,
      blockedDetails: [],
      toolRepairs: 0,
      validationFailures: 0,
      stats,
      logger,
      recordBlockedDiscovery,
      getBlockedDiscoveryCount: () => 4,
      recordSessionEvent,
      ...overrides,
    },
  };
}

describe("runClaudeStreamAfterEvents", () => {
  it("normalizes tool-use stop reason when no tool calls were emitted", () => {
    const h = baseInput();
    h.streamState.markToolUse();

    runClaudeStreamAfterEvents(h.input);

    expect(h.streamState.rawStopReason()).toBe("end_turn");
  });

  it("records qwen parser mismatch suspicion for local repeated repair failures", () => {
    const h = baseInput({
      adapter: { family: "qwen3-coder" },
      localLikeBaseUrl: true,
      validationFailures: 1,
      toolRepairs: 2,
    });

    runClaudeStreamAfterEvents(h.input);

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
    h.discovery.blockedBroadDiscovery = 2;
    h.discovery.collapsedBroadDiscovery = 1;
    h.discovery.recoveryMode = "top_level_snapshot";
    h.discovery.recoveryPreviewEntries = 3;

    runClaudeStreamAfterEvents(h.input);

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

  it("creates route after-event handler with session-scoped event recording", () => {
    const h = baseInput();
    h.discovery.blockedBroadDiscovery = 1;
    h.discovery.recoveryMode = "top_level_snapshot";
    h.discovery.recoveryPreviewEntries = 2;
    const recordSessionEvent = vi.fn();
    const afterEvents = createClaudeStreamAfterEventsHandler({
      adapter: { family: "test" },
      localLikeBaseUrl: false,
      requestId: "req_1",
      resolvedModelId: "model-a",
      baseUrl: "http://localhost:8000",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      streamState: h.streamState,
      discovery: h.discovery,
      blockedDetails: [],
      stats: h.stats,
      logger: h.logger,
      recordBlockedDiscovery: h.recordBlockedDiscovery,
      getBlockedDiscoveryCount: () => 5,
      recordSessionEvent,
    });

    afterEvents({ toolRepairs: 0, validationFailures: 0 });

    expect(h.recordBlockedDiscovery).toHaveBeenCalledWith("session_1", 1);
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "tool_call_blocked_broad_discovery",
      "tool-guardrails",
      "blocked=1;sessionTotal=5",
      "req_1",
      expect.objectContaining({
        recoveryMode: "top_level_snapshot",
        topLevelPreview: 2,
      }),
    );
  });
});
