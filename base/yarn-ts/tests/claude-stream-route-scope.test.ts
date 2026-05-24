import { describe, expect, it, vi } from "vitest";
import { createClaudeStreamEventRecorder } from "../src/streaming/claude-stream-route-scope.js";

describe("createClaudeStreamEventRecorder", () => {
  it("binds Claude stream session identity and request id to event recording", () => {
    const recordSessionEvent = vi.fn();
    const recordEvent = createClaudeStreamEventRecorder({
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      requestId: "req_1",
    }, recordSessionEvent);

    recordEvent({
      eventKind: "stream_long_wait",
      component: "stream-heartbeat",
      detail: "waited",
      metadataJson: { elapsedMs: 1000 },
    });

    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "stream_long_wait",
      "stream-heartbeat",
      "waited",
      "req_1",
      { elapsedMs: 1000 },
    );
  });
});
