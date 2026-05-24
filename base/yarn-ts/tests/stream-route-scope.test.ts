import { describe, expect, it, vi } from "vitest";
import { createStreamRouteEventRecorder } from "../src/streaming/stream-route-scope.js";

describe("createStreamRouteEventRecorder", () => {
  it("binds stream session identity and request id to event recording", () => {
    const recordSessionEvent = vi.fn();
    const recordEvent = createStreamRouteEventRecorder({
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
