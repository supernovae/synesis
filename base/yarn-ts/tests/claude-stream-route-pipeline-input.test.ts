import { describe, expect, it, vi } from "vitest";
import { buildClaudeStreamRoutePipelineSupportInput } from "../src/streaming/claude-stream-route-pipeline-input.js";

describe("buildClaudeStreamRoutePipelineSupportInput", () => {
  it("keeps lifecycle and after-events route sections grouped", () => {
    const lifecycle = {
      session: {},
      circuitBreakers: { recordFailure: vi.fn(), recordSuccess: vi.fn() },
      logger: { error: vi.fn() },
      extractUpstreamErrorDiagnostics: vi.fn(),
      recordSessionEvent: vi.fn(),
    } as never;
    const afterEvents = {
      adapter: { family: "anthropic" },
      stats: { qwenParserMismatchSuspectCount: 0 },
      logger: { warn: vi.fn() },
      recordBlockedDiscovery: vi.fn(),
      getBlockedDiscoveryCount: vi.fn(() => 0),
      recordSessionEvent: vi.fn(),
    } as never;

    const input = buildClaudeStreamRoutePipelineSupportInput({
      lifecycle,
      afterEvents,
    });

    expect(input.lifecycle).toBe(lifecycle);
    expect(input.afterEvents).toBe(afterEvents);
  });
});
