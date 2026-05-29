import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { detectClientToolCapabilities } from "../src/adapters/client-tool-capabilities.js";
import { createPlanningStateHelpers } from "../src/planning/planning-state-helpers.js";
import type { SessionState } from "../src/state/session-state.js";
import type { YarnPromptIntakeResult } from "../src/upper-harness/bridge.js";

function makeSession(): SessionState {
  return {
    history: [],
    toolCallsSinceCheckpoint: 0,
    consecutiveToolCalls: 0,
    stagnantToolCycles: 0,
    lastToolSignalHash: "",
    awaitingToolLoopUserAck: false,
    toolLoopAckAnchorUserHash: "",
    toolLoopNoUserAckCount: 0,
    blockBroadVerificationUntilEdit: false,
    blockFailingVerificationUntilEdit: false,
    record: {
      sessionKey: "synesis:test:opencode:_",
      userId: "test",
      orgId: "org",
      conversationId: "",
      clientKind: "opencode",
      createdAt: 1,
      lastActiveAt: 1,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalTokensCached: 0,
      totalTokensSaved: 0,
      requestCount: 1,
      escalationCount: 0,
      consecutiveFailedVerifications: 0,
      metadata: {},
      version: 1,
    },
    pruningWatermark: 0,
    consecutiveRecoveryFires: 0,
    consecutiveEditContextMisses: 0,
    editReplayHardStopGraceUsed: false,
    editMissForceReadPending: false,
    artifactEditTurns: new Map(),
    seenFailureSignatures: new Set(),
    previousFailureSignature: null,
    lastEvidenceDelta: null,
    lastIncomingMessageCount: 0,
    governorPrePauseAttemptsByRule: new Map(),
    implementationSoftStallNudgeStrikes: 0,
    regroundCooldownRemaining: 0,
    lastGovernorNoPauseAt: 0,
    lastGovernorCachedResult: null,
    skipToolIdStabilization: false,
    gitInspectionBlockCount: 0,
    scopeEnvelope: {
      scope: "single_turn",
      confidence: 1,
      reasons: [],
    },
    diffStats: {
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      updatedAt: 0,
    },
    taskLedger: null,
    taskCapabilities: null,
  };
}

function makePromptIntake(sourceHash: string): YarnPromptIntakeResult {
  return {
    shouldAppend: true,
    decision: {
      scope: "macro",
      action: "append",
      reason: "macro task",
      source_hash: sourceHash,
      override: false,
    },
    metadataSnapshot: {
      plan_mode_requested: false,
    },
  } as unknown as YarnPromptIntakeResult;
}

describe("planning state helpers", () => {
  it("falls back to a deterministic planner packet when horizon upreach times out", async () => {
    const events: Array<{ eventKind: string; metadata?: Record<string, unknown> }> = [];
    const generateText = vi.fn().mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const helpers = createPlanningStateHelpers({
      config: {
        SYNESIS_YARN_PLANNER_TODO_PACKET_ENABLED: true,
        SYNESIS_YARN_GOVERNANCE_DISABLED: false,
        SYNESIS_YARN_PLANNER_TODO_REQUIRE_NATIVE_TOOL: false,
        SYNESIS_YARN_PLANNER_TODO_MODEL: "coder-horizon",
        SYNESIS_YARN_PLANNER_TODO_TIMEOUT_MS: 12000,
        SYNESIS_YARN_PLANNER_TODO_FALLBACK_ENABLED: true,
        SYNESIS_YARN_PLANNER_TODO_MAX_OUTPUT_TOKENS: 1400,
        SYNESIS_YARN_PLANNER_TODO_MAX_PROMPT_CHARS: 6000,
        SYNESIS_YARN_TASK_INTAKE_ENABLED: false,
        SYNESIS_YARN_PLAN_GRAPH_ENABLED: false,
      } as AppConfig,
      tierRegistry: {
        setCurrentRequestContext: vi.fn(),
        resolve: vi.fn().mockReturnValue({ model: "horizon-model", resolvedModelId: "coder-horizon" }),
      },
      generateText,
      clampMaxOutputTokensForSafety: (n) => n,
      hashTextSignal: () => "402a5f69",
      getMetadataString: (meta, key) => typeof meta[key] === "string" ? meta[key] : "",
      recordSessionEvent: (_sessionKey, _userId, _orgId, eventKind, _component, _detail, _requestId, metadata) => {
        events.push({ eventKind, metadata });
      },
      logger: { warn: vi.fn() },
    });
    const session = makeSession();
    const caps = detectClientToolCapabilities(
      [{ name: "todowrite" }, { name: "question" }, { name: "write" }],
      "opencode",
      "Build a FastAPI app with SQLite and tests",
    );

    const block = await helpers.maybeBuildPlannerTodoPacketBlock({
      session,
      sessionKey: session.record.sessionKey,
      identity: {
        userId: "test",
        orgId: "org",
        conversationId: "",
        clientKind: "opencode",
      },
      requestId: "req-1",
      surface: "openai",
      latestUserPrompt: "Build a FastAPI app with SQLite storage, web UI, scheduler, tests, and README.",
      promptIntake: makePromptIntake("402a5f69"),
      clientToolCapabilities: caps,
    });

    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
      maxOutputTokens: 1400,
    }));
    expect(block).toContain('model="coder-horizon:fallback"');
    expect(block).toContain("todo_tool=todowrite");
    expect(session.record.metadata.planner_todo_packet_origin).toBe("deterministic_fallback");
    expect(session.record.metadata.planner_todo_packet_failure_kind).toBe("timeout");
    expect(session.record.metadata.planner_todo_packet_timeout_ms).toBe(12000);
    expect(session.taskLedger?.tasks.length).toBeGreaterThan(0);
    expect(events.map((event) => event.eventKind)).toEqual([
      "planner_todo_packet_failed",
      "planner_todo_packet_fallback_generated",
    ]);
    expect(events[0]!.metadata).toMatchObject({
      model_id: "coder-horizon",
      failure_kind: "timeout",
      timeout_ms: 12000,
      source_hash: "402a5f69",
    });
  });
});
