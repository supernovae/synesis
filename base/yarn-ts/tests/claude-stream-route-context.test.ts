import { describe, expect, it } from "vitest";
import { createClaudeStreamRouteContext } from "../src/streaming/claude-stream-route-context.js";

describe("createClaudeStreamRouteContext", () => {
  it("derives stream, event, and completion scopes from route identity", () => {
    const context = createClaudeStreamRouteContext({
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      traceRequestId: "trace-1",
      responseRequestId: "req-1",
      resolvedModelId: "claude-test",
      projectRoot: "/repo",
    });

    expect(context.resolvedModelId).toBe("claude-test");
    expect(context.streamScope).toEqual({
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      requestId: "trace-1",
    });
    expect(context.requestIds).toEqual({
      traceRequestId: "trace-1",
      responseRequestId: "req-1",
    });
    expect(context.eventRoute).toEqual({
      sessionKey: "session-1",
      resolvedModelId: "claude-test",
      projectRoot: "/repo",
    });
    expect(context.completionScope).toEqual({
      pendingRequestId: "trace-1",
      historyRequestId: "req-1",
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
    });
  });
});
