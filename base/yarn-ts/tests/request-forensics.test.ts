import { describe, expect, it } from "vitest";
import { buildRequestForensics, withUsage } from "../src/telemetry/request-forensics.js";

describe("request forensics", () => {
  it("computes LCP and first-changed section across adjacent requests", () => {
    const first = buildRequestForensics({
      providerModel: "synesis-core",
      path: "/v1/chat/completions",
      requestId: "r1",
      stream: false,
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "build project" },
      ],
      tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object" } } }],
      toolChoice: "auto",
      providerOptions: { openai: { parallel_tool_calls: true } },
      previous: undefined,
      capturePayload: false,
      maxPreviewChars: 200,
    });

    const second = buildRequestForensics({
      providerModel: "synesis-core",
      path: "/v1/chat/completions",
      requestId: "r2",
      stream: false,
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "build project with tests" },
      ],
      tools: [{ type: "function", function: { name: "Bash", parameters: { type: "object" } } }],
      toolChoice: "auto",
      providerOptions: { openai: { parallel_tool_calls: true } },
      previous: { requestId: "r1", serialized: first.serialized },
      capturePayload: true,
      maxPreviewChars: 100,
    });

    expect(second.record.lcpChars).toBeGreaterThan(0);
    expect(second.record.lcpRatio).toBeGreaterThan(0);
    expect(second.record.firstChangedSection).toBe("user");
    expect(second.record.payloadPreview?.length).toBeLessThanOrEqual(100);
  });

  it("attaches usage metrics and updates summary", () => {
    const built = buildRequestForensics({
      providerModel: "synesis-core",
      path: "/v1/messages",
      requestId: "r3",
      stream: true,
      messages: [{ role: "system", content: "x" }],
      tools: [],
      toolChoice: undefined,
      providerOptions: undefined,
      previous: undefined,
      capturePayload: false,
      maxPreviewChars: 0,
    });
    const withMetrics = withUsage(built.record, {
      inputTokens: 1000,
      outputTokens: 120,
      cachedTokens: 400,
      cacheCreationTokens: 0,
      costUsd: 0.03,
    }, {
      tokensSavedByReduction: 120,
    });
    expect(withMetrics.usage?.tokensIn).toBe(1000);
    expect(withMetrics.usage?.effectiveInputTokens).toBe(600);
    expect(withMetrics.usage?.effectiveInputAfterReduction).toBe(480);
    expect(withMetrics.usage?.cacheHitRatio).toBe(0.4);
    expect(withMetrics.summary).toContain("usage=1000/120/400");
    expect(withMetrics.summary).toContain("cache_hit=40%");
    expect(withMetrics.summary).toContain("reduced_tokens=120");
  });
});

