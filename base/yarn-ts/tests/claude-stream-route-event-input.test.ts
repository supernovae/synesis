import { describe, expect, it, vi } from "vitest";
import { buildClaudeStreamRouteEventHandlersInput } from "../src/streaming/claude-stream-route-event-input.js";

describe("buildClaudeStreamRouteEventHandlersInput", () => {
  it("derives route event handler wiring from route state", async () => {
    const recordBlockedDiscovery = vi.fn();
    const buildBlockedDiscoveryRecoverySnapshot = vi.fn(async () => ({
      text: "recovery",
      entryCount: 1,
      recoveryMode: "top_level_snapshot" as const,
    }));
    const toolSideEffects = {
      updateDiffAccumulator: vi.fn(),
      maybeUpdateTaskLedgerFromToolCall: vi.fn(),
      emitPlanWriteAuditEvent: vi.fn(),
      maybeLogEnvelopeUnwrapSample: vi.fn(),
      recordUpperHarnessDecision: vi.fn(),
      incrementStrictGovernanceRewrites: vi.fn(),
    };

    const input = buildClaudeStreamRouteEventHandlersInput({
      base: {
        adapter: { family: "anthropic", supportsThinking: true } as never,
        requestId: "trace-1",
        clientKind: "claude-code",
        debugProtocol: false,
        strictGovernance: true,
        taskCue: "build",
        clientPlanModeRequested: false,
        pathContext: { projectRoot: "/repo", shellCwd: "/repo" },
        enforcePathRoot: true,
        blockBashPathDrift: true,
        pathSandboxEnabled: true,
        artifactShadows: [],
        session: {
          gitInspectionBlockCount: 0,
          blockBroadVerificationUntilEdit: false,
          blockFailingVerificationUntilEdit: false,
          artifactEditTurns: new Map(),
          record: { requestCount: 3, metadata: {} },
        },
        stats: {} as never,
        logger: { warn: vi.fn(), error: vi.fn() } as never,
        isWriteCapableToolName: () => false,
        shouldRestrictDiscoveryForPlanWork: () => false,
        deserializePlanShadow: () => null,
        buildPathSandboxPolicy: vi.fn() as never,
        getTopLevelDirs: vi.fn(async () => []),
        applyDiscoveryGuardrail: vi.fn() as never,
      },
      toolSideEffects,
      recentCalls: [{ toolName: "Read" }, { toolName: "Edit" }],
      normalizedMessages: [{ role: "user" }, { role: "assistant" }],
      route: {
        sessionKey: "session-1",
        resolvedModelId: "claude-test",
        projectRoot: "/repo",
      },
      recordBlockedDiscovery,
      buildBlockedDiscoveryRecoverySnapshot,
    });

    input.recordRedirectedDiscovery(2);
    const recovery = await input.buildBlockedDiscoveryRecovery([{ toolName: "Glob" } as never]);

    expect(input.recentToolNames).toEqual(["Read", "Edit"]);
    expect(input.normalizedMessageCount).toBe(2);
    expect(input.updateDiffAccumulator).toBe(toolSideEffects.updateDiffAccumulator);
    expect(recordBlockedDiscovery).toHaveBeenCalledWith("session-1", 2);
    expect(buildBlockedDiscoveryRecoverySnapshot).toHaveBeenCalledWith(
      "claude-test",
      [{ toolName: "Glob" }],
      "/repo",
    );
    expect(recovery).toEqual({
      text: "recovery",
      entryCount: 1,
      recoveryMode: "top_level_snapshot",
    });
  });
});
