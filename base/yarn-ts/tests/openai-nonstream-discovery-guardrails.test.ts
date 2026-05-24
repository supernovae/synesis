import { describe, expect, it, vi } from "vitest";
import { applyOpenAINonStreamDiscoveryGuardrailPass } from "../src/pipeline/openai-nonstream-discovery-guardrails.js";
import type { GuardrailToolCall } from "../src/tools/tool-call-availability.js";

function baseInput(overrides: Partial<Parameters<typeof applyOpenAINonStreamDiscoveryGuardrailPass<GuardrailToolCall>>[0]> = {}) {
  const calls: GuardrailToolCall[] = [
    { toolCallId: "call-1", toolName: "Glob", input: { pattern: "src/*" } },
  ];
  return {
    calls,
    finalText: "done",
    guardrail: {
      calls,
      blockedCount: 0,
      redirectedCount: 0,
      collapsedCount: 0,
      blockedDetails: [],
      redirectedDetails: [],
    },
    sessionKey: "session-1",
    userId: "user-1",
    orgId: "org-1",
    requestId: "req-1",
    resolvedModelId: "openai-test",
    projectRoot: "/repo",
    recordRecoveryEvent: true,
    buildBlockedDiscoveryRecovery: vi.fn(async () => ({
      text: "Read README.md first.",
      entryCount: 2,
      recoveryMode: "top_level_snapshot",
    })),
    recordBlockedDiscovery: vi.fn(() => 1),
    getBlockedDiscoveryCount: vi.fn(() => 1),
    recordSessionEvent: vi.fn(),
    ...overrides,
  };
}

describe("applyOpenAINonStreamDiscoveryGuardrailPass", () => {
  it("records redirected discovery and returns guarded calls", async () => {
    const guardedCalls = [
      { toolCallId: "call-1", toolName: "Glob", input: { pattern: "src/*" } },
    ];
    const input = baseInput({
      guardrail: {
        calls: guardedCalls,
        blockedCount: 0,
        redirectedCount: 1,
        collapsedCount: 0,
        blockedDetails: [],
        redirectedDetails: [{
          toolCallId: "call-1",
          toolName: "Glob",
          reason: "root_wildcard_glob_redirected",
          originalPattern: "*",
          redirectedPattern: "src/*",
        }],
      },
    });

    const result = await applyOpenAINonStreamDiscoveryGuardrailPass(input);

    expect(result.calls).toBe(guardedCalls);
    expect(input.recordBlockedDiscovery).toHaveBeenCalledWith("session-1", 1);
    expect(input.recordSessionEvent).toHaveBeenCalledWith(
      "session-1",
      "user-1",
      "org-1",
      "broad_discovery_redirected",
      "tool-guardrails",
      "redirected=1;sessionTotal=1",
      "req-1",
      expect.objectContaining({ sessionBlockedTotal: 1 }),
    );
  });

  it("appends recovery guidance and records first-pass recovery telemetry", async () => {
    const input = baseInput({
      guardrail: {
        calls: [],
        blockedCount: 1,
        redirectedCount: 0,
        collapsedCount: 0,
        blockedDetails: [{ toolName: "Glob", reason: "blocked", argsPreview: "{\"pattern\":\"**/*\"}" }],
        redirectedDetails: [],
      },
      recordBlockedDiscovery: vi.fn(() => 2),
    });

    const result = await applyOpenAINonStreamDiscoveryGuardrailPass(input);

    expect(result.finalText).toContain("done\n\nRead README.md first.");
    expect(result.finalText).toContain("CRITICAL: Glob has been blocked multiple times");
    expect(input.recordSessionEvent).toHaveBeenCalledWith(
      "session-1",
      "user-1",
      "org-1",
      "tool_call_blocked_broad_discovery",
      "tool-guardrails",
      "blocked=1;sessionTotal=2",
      "req-1",
      expect.objectContaining({ recoveryMode: "top_level_snapshot", sessionBlockedTotal: 2 }),
    );
    expect(input.recordSessionEvent).toHaveBeenCalledWith(
      "session-1",
      "user-1",
      "org-1",
      "blocked_broad_discovery_then_recovery",
      "tool-guardrails",
      "mode=top_level_snapshot;top_level_preview=2",
      "req-1",
      { recoveryMode: "top_level_snapshot", topLevelPreview: 2 },
    );
  });

  it("preserves legacy pass telemetry shape when recovery event is disabled", async () => {
    const input = baseInput({
      recordRecoveryEvent: false,
      guardrail: {
        calls: [],
        blockedCount: 1,
        redirectedCount: 0,
        collapsedCount: 1,
        blockedDetails: [{ toolName: "Glob", reason: "blocked" }],
        redirectedDetails: [],
      },
    });

    await applyOpenAINonStreamDiscoveryGuardrailPass(input);

    const blockedEvent = vi.mocked(input.recordSessionEvent).mock.calls.find((call) =>
      call[3] === "tool_call_blocked_broad_discovery"
    );
    expect(blockedEvent?.[7]).toEqual({
      blockedDetails: [{ toolName: "Glob", reason: "blocked" }],
      sessionBlockedTotal: 1,
    });
    expect(input.recordSessionEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "blocked_broad_discovery_then_recovery",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(input.recordSessionEvent).toHaveBeenCalledWith(
      "session-1",
      "user-1",
      "org-1",
      "duplicate_broad_call_collapsed",
      "tool-guardrails",
      "collapsed=1",
      "req-1",
    );
  });
});
