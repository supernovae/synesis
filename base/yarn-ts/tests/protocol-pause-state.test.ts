import { describe, expect, it } from "vitest";
import { prepareProtocolPauseState } from "../src/session/protocol-pause-state.js";
import type { ChatState } from "../src/governance/chat-state.js";
import type { FileState } from "../src/governance/file-state.js";
import type { TaskLedger } from "../src/task-ledger/types.js";

function chatState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    activeObjective: "Build TaskPulse with tests",
    phase: "edit",
    unresolvedCorrections: [],
    resolvedCorrections: [],
    lastAttemptSummary: null,
    lastVerificationOutcome: "unknown",
    blockers: [],
    currentFocusPaths: [],
    transcriptSummary: "User requested a complete app.",
    narrationResidueSummary: null,
    pendingUserDirective: "Build TaskPulse with tests",
    completionStatus: "in_progress",
    ...overrides,
  };
}

function fileState(): FileState {
  return {
    filesByPath: {},
    fileCount: 0,
  };
}

function taskLedger(): TaskLedger {
  return {
    sessionId: "session-1",
    hasExplicitClientTodoTool: true,
    hasExplicitPlanMode: true,
    reconciliationAttempts: 0,
    tasks: [
      {
        id: "task-1",
        title: "Write test for API",
        status: "in_progress",
        source: "opencode_todowrite",
        evidence: [],
        lastUpdatedTurn: 1,
        createdTurn: 1,
        confidence: 1,
      },
    ],
  };
}

describe("protocol pause state preparation", () => {
  it("persists chat/file snapshots and returns governor pause summaries", () => {
    const metadata: Record<string, unknown> = {};

    const result = prepareProtocolPauseState({
      metadata,
      chatState: chatState({ narrationResidueSummary: "Repeated narration" }),
      fileState: fileState(),
      taskLedger: taskLedger(),
    });

    expect(metadata.chat_state_snapshot).toMatchObject({
      activeObjective: "Build TaskPulse with tests",
      phase: "edit",
      completionStatus: "in_progress",
      lastVerificationOutcome: "unknown",
    });
    expect(metadata.file_state_snapshot).toMatchObject({
      fileCount: 0,
      staleFiles: [],
      partialFiles: [],
      evictedFiles: [],
    });
    expect(result.pauseChatSummary).toMatchObject({
      active_objective: "Build TaskPulse with tests",
      pending_user_directive: "Build TaskPulse with tests",
      completion_status: "in_progress",
      narration_residue_present: true,
    });
    expect(result.pauseFileSummary).toMatchObject({
      files_total: 0,
      stale_files: [],
      partial_files: [],
      evicted_files: [],
    });
    expect(result.pauseTaskContext).toMatchObject({
      current_task: "Write test for API",
      current_task_status: "in_progress",
      open_task_count: 1,
      recommended_next_step: expect.stringContaining("targeted test command"),
    });
    expect(result.chatStateBlock).toContain("<SYNESIS_CHAT_STATE");
    expect(result.fileStateBlock).toBeNull();
  });

  it("uses the most recently updated in-progress task for pause context", () => {
    const metadata: Record<string, unknown> = {};
    const ledger = taskLedger();
    ledger.tasks.push({
      id: "task-2",
      title: "Create services/scheduler.py for background health score updates",
      status: "in_progress",
      source: "opencode_todowrite",
      evidence: [],
      lastUpdatedTurn: 7,
      createdTurn: 2,
      confidence: 1,
    });

    const result = prepareProtocolPauseState({
      metadata,
      chatState: chatState(),
      fileState: fileState(),
      taskLedger: ledger,
    });

    expect(result.pauseTaskContext).toMatchObject({
      current_task: "Create services/scheduler.py for background health score updates",
      current_task_status: "in_progress",
      open_task_count: 2,
    });
  });
});
