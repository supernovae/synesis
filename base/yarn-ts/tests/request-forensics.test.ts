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
      phasePolicy: {
        enabled: true,
        source: "phase_policy",
        phase: "verify",
        effectiveToolChoice: "required",
        filteredToolCount: 2,
      },
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
    expect(second.record.payloadPreview).not.toContain("build project");
    expect(second.record.payloadPreview).not.toContain("parallel_tool_calls");
    expect(first.record.phasePolicy?.effectiveToolChoice).toBe("required");
  });

  it("redacts full-mode payload previews to structural hashes and counts", () => {
    const built = buildRequestForensics({
      providerModel: "synesis-core",
      path: "/v1/chat/completions",
      requestId: "r-redacted",
      stream: false,
      messages: [
        { role: "system", content: "secret system prompt" },
        { role: "user", content: "customer password is hunter2" },
      ],
      tools: [{ type: "function", function: { name: "ReadSecretFile", parameters: { privatePath: "/etc/shadow" } } }],
      toolChoice: { type: "function", function: { name: "ReadSecretFile" } },
      providerOptions: { openai: { apiKey: "sk-secret", metadata: { prompt: "do not store me" } } },
      previous: undefined,
      capturePayload: true,
      maxPreviewChars: 2000,
    });

    expect(built.record.payloadPreview).toContain("content_hash");
    expect(built.record.payloadPreview).toContain("provider_options");
    expect(built.record.payloadPreview).not.toContain("secret system prompt");
    expect(built.record.payloadPreview).not.toContain("hunter2");
    expect(built.record.payloadPreview).not.toContain("sk-secret");
    expect(built.record.payloadPreview).not.toContain("do not store me");
    expect(built.record.payloadPreview).not.toContain("/etc/shadow");
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
