import { describe, expect, it, vi } from "vitest";

import { createSessionEventRecorder } from "../src/state/session-event-recorder.js";
import type { SessionEventInsert } from "../src/state/usage-writer.js";

describe("createSessionEventRecorder", () => {
  it("logs a compact event and enqueues the full session event payload", () => {
    const enqueueSessionEvent = vi.fn<(event: SessionEventInsert) => void>();
    const warn = vi.fn<(obj: Record<string, unknown>, message: string) => void>();
    const record = createSessionEventRecorder({
      writer: { enqueueSessionEvent },
      logger: { warn },
    });

    record(
      "session-1",
      "user-1",
      "org-1",
      "tool_retry",
      "governor",
      "x".repeat(250),
      "req-1",
      { retry: true },
    );

    expect(warn).toHaveBeenCalledWith(
      {
        sessionKey: "session-1",
        requestId: "req-1",
        component: "governor",
        eventKind: "tool_retry",
        detail: "x".repeat(200),
      },
      "session_event: tool_retry",
    );
    expect(enqueueSessionEvent).toHaveBeenCalledWith({
      sessionKey: "session-1",
      requestId: "req-1",
      userId: "user-1",
      orgId: "org-1",
      eventKind: "tool_retry",
      component: "governor",
      detail: "x".repeat(250),
      metadataJson: { retry: true },
    });
  });
});
