import { describe, expect, it } from "vitest";
import {
  buildGovernorPauseContextSnapshot,
  buildGovernorPauseResumeBlock,
  GOVERNOR_PAUSE_CONTEXT_SCHEMA_VERSION,
  isGovernorPauseSummaryRequest,
  parseGovernorPauseContextSnapshot,
} from "../src/governance/governor-pause-context.js";
import { buildExecutionGovernorPauseEnvelope } from "../src/governance/execution-governor.js";

describe("governor pause context", () => {
  it("detects explicit summarize/status recovery requests", () => {
    expect(isGovernorPauseSummaryRequest("stop and summarize current status so I know what we're trying to fix")).toBe(true);
    expect(isGovernorPauseSummaryRequest("3")).toBe(true);
    expect(isGovernorPauseSummaryRequest("option 3 please")).toBe(true);
    expect(isGovernorPauseSummaryRequest("continue with one focused fix")).toBe(false);
  });

  it("round-trips pause context and builds a no-tool summary recovery block", () => {
    const envelope = buildExecutionGovernorPauseEnvelope({
      matchedRules: ["identical_tool_repeat"],
      consecutiveRecoveryFires: 2,
      hardStopThreshold: 4,
      questionToolName: "question",
      chatStateSummary: {
        active_objective: "Build TaskPulse",
        pending_user_directive: "Stop and summarize",
        completion_status: "in_progress",
        last_verification_outcome: "unknown",
        narration_residue_present: false,
      },
      fileStateSummary: {
        files_total: 3,
        status_counts: { partial: 1 },
        stale_files: [],
        partial_files: ["taskpulse/app/main.py"],
        evicted_files: [],
      },
    });

    const snapshot = buildGovernorPauseContextSnapshot({
      surface: "openai",
      requestId: "req_123",
      envelope,
      pauseMessage: "GOVERNOR PAUSE: Agent progress is blocked by repeated loops.",
      questionToolName: "question",
      now: 123,
    });
    const parsed = parseGovernorPauseContextSnapshot(snapshot);
    expect(parsed?.schema_version).toBe(GOVERNOR_PAUSE_CONTEXT_SCHEMA_VERSION);
    expect(parsed?.pause_reason).toBe("identical_tool_repeat");
    expect(parsed?.question_tool_name).toBe("question");
    expect(parsed?.next_actions.map((action) => action.id)).toContain("summarize_and_stop");

    const block = buildGovernorPauseResumeBlock(parsed!, "stop and summarize current status");
    expect(block).toContain("mode=\"summarize_and_stop\"");
    expect(block).toContain("Do not call tools");
    expect(block).toContain("identical_tool_repeat");
    expect(block).toContain("TaskPulse");
  });
});
