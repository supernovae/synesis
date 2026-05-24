import { describe, expect, it, vi } from "vitest";
import { captureStreamRequestForensics } from "../src/streaming/stream-request-forensics.js";

describe("captureStreamRequestForensics", () => {
  it("binds stream scope and marks the request as streaming", () => {
    const capture = vi.fn(() => ({ record: { requestId: "req_1" }, serialized: "{}" }));

    const result = captureStreamRequestForensics({
      scope: {
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        requestId: "req_1",
      },
      path: "/v1/chat/completions (stream)",
      resolvedModelId: "model-a",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "Read" }],
      toolChoice: "auto",
      providerOptions: { provider: "option" },
      phasePolicy: { enabled: true, source: "phase_policy" },
      capabilityMatrix: {
        mode: "enforced",
        globalOptimizationsEnabled: true,
        modelId: "model-a",
        matchedOverrideIds: [],
        capabilityHash: "hash",
      },
      capture,
    });

    expect(result).toEqual({ record: { requestId: "req_1" }, serialized: "{}" });
    expect(capture).toHaveBeenCalledWith(
      "session_1",
      "req_1",
      "/v1/chat/completions (stream)",
      "model-a",
      true,
      [{ role: "user", content: "hello" }],
      [{ name: "Read" }],
      "auto",
      { provider: "option" },
      { enabled: true, source: "phase_policy" },
      {
        mode: "enforced",
        globalOptimizationsEnabled: true,
        modelId: "model-a",
        matchedOverrideIds: [],
        capabilityHash: "hash",
      },
    );
  });
});
