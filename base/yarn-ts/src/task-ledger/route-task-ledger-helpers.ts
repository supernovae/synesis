import type { SessionState } from "../state/session-state.js";
import { isTaskToolCall, normalizeTaskToolCall } from "./normalizeTaskToolCall.js";
import {
  createEmptyLedger,
  reconcileFromEvidence,
  reconcileFromToolCall,
} from "./reconcileTaskLedger.js";
import type { EvidenceSignal, HarnessTask, TaskLedger, TaskSource, TaskStatus } from "./types.js";

type TaskLedgerCountView = {
  tasks: Array<{
    status: TaskStatus | string;
    source?: TaskSource | string;
  }>;
};

function isOpenTask(task: Pick<HarnessTask, "status"> | { status: string }): boolean {
  return task.status === "pending" || task.status === "in_progress" || task.status === "unknown";
}

function isExplicitClientTask(task: Pick<HarnessTask, "source"> | { source?: string }): boolean {
  return task.source === "claude_todowrite"
    || task.source === "opencode_todowrite"
    || task.source === "cline_plan"
    || task.source === "cursor_plan";
}

export function countOpenTasks(ledger: TaskLedgerCountView | null | undefined): number | undefined {
  if (!ledger) return undefined;
  return ledger.tasks.filter(isOpenTask).length;
}

export function countExplicitOpenTasks(ledger: TaskLedgerCountView | null | undefined): number | undefined {
  if (!ledger) return undefined;
  return ledger.tasks.filter((task) => isOpenTask(task) && isExplicitClientTask(task)).length;
}

/**
 * Update the task ledger when a tool call is detected as a todo/task tool.
 * Call after governToolCall for every tool call in the pipeline.
 */
export function maybeUpdateTaskLedgerFromToolCall(
  session: SessionState,
  toolName: string,
  args: Record<string, unknown>,
  turn: number,
): void {
  if (!isTaskToolCall(toolName)) return;
  if (!session.taskCapabilities) return;

  const normalized = normalizeTaskToolCall(
    { toolName, args, turn },
    session.taskCapabilities,
  );
  if (normalized.length === 0) return;

  if (!session.taskLedger) {
    session.taskLedger = createEmptyLedger(
      session.record.sessionKey,
      session.taskCapabilities.hasExplicitTodoTool,
      session.taskCapabilities.hasExplicitPlanMode,
    );
  }
  session.taskLedger = reconcileFromToolCall(session.taskLedger, normalized, turn);
}

/**
 * Update the task ledger with evidence signals from tool results.
 */
export function maybeUpdateTaskLedgerFromEvidence(
  session: SessionState,
  signals: EvidenceSignal[],
): void {
  if (!session.taskLedger || session.taskLedger.tasks.length === 0) return;
  if (signals.length === 0) return;
  session.taskLedger = reconcileFromEvidence(session.taskLedger, signals);
}

/**
 * Classify a tool result into evidence signals for the task ledger.
 */
export function classifyToolResultAsEvidence(
  toolName: string,
  resultText: string,
  turn: number,
): EvidenceSignal[] {
  const signals: EvidenceSignal[] = [];
  const lower = toolName.toLowerCase().replace(/-/g, "_");
  const resultLower = resultText.toLowerCase();

  if (lower.includes("write") || lower.includes("edit") || lower.includes("patch") || lower.includes("replace") || lower.includes("str_replace")) {
    if (!resultLower.includes("error") && !resultLower.includes("failed")) {
      signals.push({ kind: "file_edit", detail: resultText.slice(0, 200), turn });
    }
  }

  if (lower.includes("test") || lower.includes("bash") || lower.includes("shell") || lower.includes("terminal") || lower.includes("command")) {
    if (/\b(pass|ok|passed|success)\b/i.test(resultText) && !/\b(fail|error|FAIL)\b/.test(resultText)) {
      signals.push({ kind: "test_pass", detail: resultText.slice(0, 200), turn });
    } else if (/\b(fail|FAIL|error|Error)\b/.test(resultText)) {
      signals.push({ kind: "test_fail", detail: resultText.slice(0, 200), turn });
    } else if (!resultLower.includes("error") && !resultLower.includes("failed") && resultText.length > 5) {
      signals.push({ kind: "command_success", detail: resultText.slice(0, 200), turn });
    }
  }

  return signals;
}
