import { describe, expect, it, vi } from "vitest";

import { createRequestForensicsRecorder } from "../src/telemetry/request-forensics-recorder.js";
import type { SessionEventInsert } from "../src/state/usage-writer.js";

function sessionState() {
  return {
    record: {
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
    },
  } as never;
}

describe("createRequestForensicsRecorder", () => {
  it("skips capture and persistence when disabled", () => {
    const enqueueSessionEvent = vi.fn<(event: SessionEventInsert) => void>();
    const recorder = createRequestForensicsRecorder({
      mode: "off",
      maxPreviewChars: 128,
      usageWriter: { enqueueSessionEvent } as never,
    });

    const captured = recorder.captureRequestForensics(
      "session-1",
      "req-1",
      "/v1/chat/completions",
      "model-a",
      false,
      [{ role: "user", content: "hello" }],
      undefined,
      undefined,
      {},
    );

    expect(captured).toBeNull();
    expect(recorder.finalizeRequestForensics(sessionState(), "req-1", captured)).toBeUndefined();
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
  });

  it("persists compact forensic events with usage and previous-request context", () => {
    const enqueueSessionEvent = vi.fn<(event: SessionEventInsert) => void>();
    const recorder = createRequestForensicsRecorder({
      mode: "full",
      maxPreviewChars: 32,
      usageWriter: { enqueueSessionEvent } as never,
    });

    const first = recorder.captureRequestForensics(
      "session-1",
      "req-1",
      "/v1/chat/completions",
      "model-a",
      false,
      [{ role: "user", content: "hello" }],
      [],
      undefined,
      {},
    );
    const firstRecord = recorder.finalizeRequestForensics(sessionState(), "req-1", first, {
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 80,
      cacheCreationTokens: 0,
      costUsd: 0.001,
    });

    const second = recorder.captureRequestForensics(
      "session-1",
      "req-2",
      "/v1/chat/completions",
      "model-a",
      false,
      [{ role: "user", content: "hello again" }],
      [],
      undefined,
      {},
    );

    expect(firstRecord?.usage?.cacheHitRatio).toBe(0.8);
    expect(second?.record.previousRequestId).toBe("req-1");
    expect(second?.record.payloadPreview?.length).toBeLessThanOrEqual(32);
    expect(enqueueSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "session-1",
        requestId: "req-1",
        userId: "user-1",
        orgId: "org-1",
        eventKind: "request_forensics_v1",
        component: "yarn",
      }),
    );
  });
});
