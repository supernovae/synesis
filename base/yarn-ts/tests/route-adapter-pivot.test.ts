import { describe, expect, it, vi } from "vitest";

import {
  applyRouteAdapterPivot,
  classifyQwenPivotEvent,
  extractRecentAssistantText,
  extractRecentToolResultText,
  resetQwenInterventionOnUserTurn,
} from "../src/pipeline/route-adapter-pivot.js";
import type { ModelAdapter, RecentToolCall } from "../src/providers/model-adapter.js";

function makeAdapter(overrides: Partial<ModelAdapter> = {}): ModelAdapter {
  return {
    family: "qwen3-coder",
    supportsThinking: false,
    ...overrides,
  };
}

function baseInput(sessionKey: string, overrides: Partial<Parameters<typeof applyRouteAdapterPivot>[0]> = {}) {
  const appendSystemMessageAndNormalize = vi.fn((messages, content) => [
    ...messages,
    { role: "system", content },
  ]);
  return {
    surface: "openai" as const,
    adapter: makeAdapter(),
    sessionKey,
    requestId: "req_1",
    modelMessages: [{ role: "user", content: "fix it" }],
    normalizedMessages: [{ role: "user", content: "fix it" }],
    recentCalls: [] as RecentToolCall[],
    recentUserPrompt: "fix it",
    governanceDisabled: false,
    toolLoopSteeringEnabled: true,
    governanceRecoveryActive: false,
    harnessTelemetryEnabled: false,
    skipTelemetry: {},
    cooldownTurns: 1,
    stagnationWindow: 4,
    stagnationThreshold: 3,
    planNoActionLimit: 2,
    editRetryLimit: 2,
    dampeningLogEvent: "adapter_dampening_oai",
    logger: { info: vi.fn(), warn: vi.fn() },
    appendSystemMessageAndNormalize,
    recordSessionEvent: vi.fn(),
    ...overrides,
  };
}

describe("route adapter pivot", () => {
  it("extracts recent assistant and tool-result text", () => {
    expect(extractRecentAssistantText([
      { role: "assistant", content: [{ type: "text", text: "older" }] },
      { role: "user", content: "next" },
      { role: "assistant", content: "newer" },
    ])).toBe("newer");

    expect(extractRecentToolResultText([
      { role: "tool", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "tool_result", content: [{ type: "text", text: "second" }] },
    ])).toBe("second\nfirst");
  });

  it("classifies repeated read loops and dampening pivots", () => {
    const calls = [
      { toolName: "Read" },
      { toolName: "Read" },
      { toolName: "Read" },
      { toolName: "Read" },
    ];

    expect(classifyQwenPivotEvent("please act", calls)).toBe("adapter_qwen_read_loop");
    expect(classifyQwenPivotEvent("please act", calls, "dampening")).toBe("adapter_qwen_dampening");
  });

  it("applies early pivot prompts and records intervention state", () => {
    const input = baseInput("pivot-session-1", {
      adapter: makeAdapter({
        getEarlyPivotPrompt: () => "Take one concrete action.",
      }),
      normalizedMessages: [{ role: "assistant", content: "I will inspect" }],
    });

    const result = applyRouteAdapterPivot(input);

    expect(result.applied).toBe(true);
    expect(result.modelMessages.at(-1)).toEqual({ role: "system", content: "Take one concrete action." });
    expect(input.appendSystemMessageAndNormalize).toHaveBeenCalledWith(
      [{ role: "user", content: "fix it" }],
      "Take one concrete action.",
    );
    expect(input.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "pivot-session-1", pivotLen: 25 }),
      "adapter_qwen_early_pivot",
    );
  });

  it("logs skipped pivots when generic governance already recovered", () => {
    const input = baseInput("pivot-session-2", {
      governanceRecoveryActive: true,
      harnessTelemetryEnabled: true,
      skipTelemetry: { policy_pivot: true },
    });

    const result = applyRouteAdapterPivot(input);

    expect(result.applied).toBe(false);
    expect(input.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reqId: "req_1", policy_pivot: true }),
      "yarn_harness_adapter_pivot_skipped",
    );
  });

  it("suppresses repeated pivots inside cooldown until reset", () => {
    const sessionKey = "pivot-session-3";
    const input = baseInput(sessionKey, {
      adapter: makeAdapter({
        getEarlyPivotPrompt: () => "You have read too much.",
      }),
      cooldownTurns: 10,
    });

    const first = applyRouteAdapterPivot(input);
    const secondInput = baseInput(sessionKey, {
      adapter: input.adapter,
      cooldownTurns: 10,
    });
    const second = applyRouteAdapterPivot(secondInput);

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(secondInput.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey }),
      "adapter_qwen_cooldown_suppressed",
    );

    resetQwenInterventionOnUserTurn(sessionKey);
    const afterReset = applyRouteAdapterPivot(baseInput(sessionKey, {
      adapter: input.adapter,
      cooldownTurns: 10,
    }));
    expect(afterReset.applied).toBe(true);
  });

  it("uses forced recovery after ignored pivots exceed the hard-stop threshold", () => {
    const sessionKey = "pivot-session-4";
    const adapter = makeAdapter({
      getEarlyPivotPrompt: () => "You have read too much.",
    });

    for (let i = 0; i < 7; i += 1) {
      applyRouteAdapterPivot(baseInput(sessionKey, { adapter, cooldownTurns: 0 }));
    }
    const input = baseInput(sessionKey, { adapter, cooldownTurns: 0 });
    const result = applyRouteAdapterPivot(input);

    expect(result.applied).toBe(true);
    expect(String(result.modelMessages.at(-1)?.content)).toContain("CRITICAL: Do not ask the user");
    expect(input.recordSessionEvent).toHaveBeenCalledWith(
      "adapter_pivot_auto_recover",
      "adapter",
      expect.stringContaining("forced continue after ignored pivots"),
    );
  });
});
