import {
  formatChatStateBlock,
  toChatStateSnapshot,
  type ChatState,
  type ChatStateSnapshot,
} from "../governance/chat-state.js";
import {
  formatFileStateBlock,
  toFileStateSnapshot,
  type FileState,
  type FileStateSnapshot,
} from "../governance/file-state.js";
import type {
  GovernorPauseChatStateSummary,
  GovernorPauseFileStateSummary,
  GovernorPauseTaskContext,
} from "../governance/execution-governor.js";
import type { TaskLedger } from "../task-ledger/types.js";
import { summarizeFileStateForGovernor } from "../state/persistence-state-channels.js";

export type ProtocolPauseChatStateSummary = GovernorPauseChatStateSummary & Record<string, unknown>;
export type ProtocolPauseFileStateSummary = GovernorPauseFileStateSummary & Record<string, unknown>;

export interface ProtocolPauseStatePreparation {
  chatStateSnapshot: ChatStateSnapshot;
  fileStateSnapshot: FileStateSnapshot;
  pauseChatSummary: ProtocolPauseChatStateSummary;
  pauseFileSummary: ProtocolPauseFileStateSummary;
  pauseTaskContext: GovernorPauseTaskContext | undefined;
  chatStateBlock: string | null;
  fileStateBlock: string | null;
}

export interface PrepareProtocolPauseStateInput {
  metadata: Record<string, unknown>;
  chatState: ChatState;
  fileState: FileState;
  taskLedger: TaskLedger | null;
  maxSnapshotPaths?: number;
}

function trimSnippet(text: string, max = 2000): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function summarizeChatStateForGovernor(chatState: ChatState): ProtocolPauseChatStateSummary {
  return {
    active_objective: chatState.activeObjective ? trimSnippet(chatState.activeObjective, 220) : null,
    pending_user_directive: chatState.pendingUserDirective ? trimSnippet(chatState.pendingUserDirective, 220) : null,
    completion_status: chatState.completionStatus,
    last_verification_outcome: chatState.lastVerificationOutcome,
    narration_residue_present: Boolean(chatState.narrationResidueSummary),
  } as ProtocolPauseChatStateSummary;
}

export function buildGovernorPauseTaskContext(ledger: TaskLedger | null): GovernorPauseTaskContext | undefined {
  if (!ledger || ledger.tasks.length === 0) return undefined;
  const openTasks = ledger.tasks.filter((task) =>
    task.status === "pending" || task.status === "in_progress" || task.status === "unknown"
  );
  const currentTask = [...openTasks]
    .sort((a, b) => {
      if (a.status === "in_progress" && b.status !== "in_progress") return -1;
      if (b.status === "in_progress" && a.status !== "in_progress") return 1;
      return b.lastUpdatedTurn - a.lastUpdatedTurn;
    })[0];
  if (!currentTask) return undefined;
  const title = currentTask.title.trim();
  const titleLower = title.toLowerCase();
  let recommended = `Continue the current task: ${title}. Make exactly one concrete edit or task update before any repeated narration.`;
  if (/\b(test|pytest|spec)\b/.test(titleLower)) {
    recommended = `Continue the current test task: ${title}. Create or edit the relevant test file, then run one targeted test command.`;
  } else if (/\b(readme|doc|documentation)\b/.test(titleLower)) {
    recommended = `Continue the current documentation task: ${title}. Edit the documentation file directly, then verify the file exists.`;
  }
  return {
    current_task: title,
    current_task_status: currentTask.status,
    open_task_count: openTasks.length,
    recommended_next_step: recommended,
  };
}

export function prepareProtocolPauseState(
  input: PrepareProtocolPauseStateInput,
): ProtocolPauseStatePreparation {
  const fileStateSnapshot = toFileStateSnapshot(input.fileState, {
    maxPaths: input.maxSnapshotPaths ?? 8,
  });
  const chatStateSnapshot = toChatStateSnapshot(input.chatState);
  input.metadata.chat_state_snapshot = chatStateSnapshot as unknown as Record<string, unknown>;
  input.metadata.file_state_snapshot = fileStateSnapshot as unknown as Record<string, unknown>;

  return {
    chatStateSnapshot,
    fileStateSnapshot,
    pauseChatSummary: summarizeChatStateForGovernor(input.chatState),
    pauseFileSummary: summarizeFileStateForGovernor(fileStateSnapshot) as ProtocolPauseFileStateSummary,
    pauseTaskContext: buildGovernorPauseTaskContext(input.taskLedger),
    chatStateBlock: formatChatStateBlock(input.chatState),
    fileStateBlock: formatFileStateBlock(input.fileState),
  };
}
