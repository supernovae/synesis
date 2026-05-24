import { describe, expect, it, vi } from "vitest";
import {
  createStreamRouteEventRecorder,
  createStreamRouteScopeBundle,
} from "../src/streaming/stream-route-scope.js";

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

describe("createStreamRouteScopeBundle", () => {
  it("returns the stream scope and its bound event recorder", () => {
    const recordSessionEvent = vi.fn();
    const bundle = createStreamRouteScopeBundle({
      sessionKey: "session_2",
      userId: "user_2",
      orgId: "org_2",
      requestId: "req_2",
    }, recordSessionEvent);

    expect(bundle.scope).toEqual({
      sessionKey: "session_2",
      userId: "user_2",
      orgId: "org_2",
      requestId: "req_2",
    });

    bundle.recordEvent({
      eventKind: "stream_hard_timeout",
      component: "stream-heartbeat",
      detail: "timeout",
    });

    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_2",
      "user_2",
      "org_2",
      "stream_hard_timeout",
      "stream-heartbeat",
      "timeout",
      "req_2",
      undefined,
    );
  });
});
