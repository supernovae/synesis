import { describe, expect, it, vi } from "vitest";
import { applyClaudeNonStreamDiscoveryGuardrails } from "../src/streaming/claude-nonstream-discovery.js";

describe("applyClaudeNonStreamDiscoveryGuardrails", () => {
  it("records redirected, blocked, and collapsed discovery events across both passes", async () => {
    const firstCalls = [{ toolCallId: "call_1", toolName: "Glob", input: { pattern: "**/*" } }];
    const secondCalls = [{ toolCallId: "call_2", toolName: "Read", input: { file_path: "README.md" } }];
    const recordSessionEvent = vi.fn();
    let blockedTotal = 0;

    const result = await applyClaudeNonStreamDiscoveryGuardrails({
      calls: firstCalls,
      finalText: "prefix",
      stopReason: "tool_use",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      requestId: "req_1",
      resolvedModelId: "claude-test",
      projectRoot: "/repo",
      getTopLevelDirs: vi.fn(async () => ["src"]),
      applyDiscoveryGuardrail: vi.fn()
        .mockReturnValueOnce({
          calls: secondCalls,
          blockedCount: 1,
          redirectedCount: 1,
          collapsedCount: 1,
          blockedDetails: [{ toolName: "Glob", reason: "root_wildcard_glob_blocked" }],
          redirectedDetails: [{
            toolCallId: "call_1",
            toolName: "Glob",
            reason: "root_wildcard_glob_redirected",
            originalPattern: "**/*",
            redirectedPattern: "src/*",
          }],
        })
        .mockReturnValueOnce({
          calls: [],
          blockedCount: 1,
          redirectedCount: 0,
          collapsedCount: 0,
          blockedDetails: [{ toolName: "Glob", reason: "empty_glob_pattern_blocked" }],
          redirectedDetails: [],
        }),
      buildBlockedDiscoveryRecovery: vi.fn(async (_model, blockedDetails) => ({
        text: `recovery:${blockedDetails[0]?.reason}`,
        entryCount: 3,
        recoveryMode: "top_level_snapshot",
      })),
      recordBlockedDiscovery: (_sessionKey, count) => {
        blockedTotal += count;
        return blockedTotal;
      },
      getBlockedDiscoveryCount: () => blockedTotal,
      recordSessionEvent,
    });

    expect(result.calls).toEqual([]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.finalText).toContain("prefix");
    expect(result.finalText).toContain("recovery:root_wildcard_glob_blocked");
    expect(result.finalText).toContain("recovery:empty_glob_pattern_blocked");
    expect(result.finalText).toContain("CRITICAL: Glob has been blocked multiple times");
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "broad_discovery_redirected",
      "tool-guardrails",
      "redirected=1;sessionTotal=1",
      "req_1",
      expect.objectContaining({ sessionBlockedTotal: 1 }),
    );
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "duplicate_broad_call_collapsed",
      "tool-guardrails",
      "collapsed=1",
      "req_1",
    );
  });
});
