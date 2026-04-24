import type { ClientTaskCapabilities, HarnessTask, TaskLedger } from "./types.js";

function statusTag(status: string): string {
  return `[${status}]`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

function evidenceSummary(task: HarnessTask): string {
  if (task.evidence.length === 0) return "no evidence yet";
  return task.evidence.slice(0, 2).join("; ");
}

/**
 * Build a compact task ledger summary for context injection.
 * Designed to stay under ~300 tokens.
 */
export function buildTaskLedgerSummary(ledger: TaskLedger): string {
  if (ledger.tasks.length === 0) return "";

  const lines = ledger.tasks.map(
    (t) => `- ${statusTag(t.status)} ${truncate(t.title, 80)} \u2014 ${evidenceSummary(t)}`,
  );

  return [
    "<synesis_task_ledger>",
    "Current task ledger:",
    ...lines,
    "</synesis_task_ledger>",
  ].join("\n");
}

/**
 * Build a reconciliation nudge for injection before final response.
 * Adapts the nudge based on whether the client has an explicit todo tool.
 */
export function buildTaskLedgerNudge(
  ledger: TaskLedger,
  capabilities: ClientTaskCapabilities,
): string {
  const openTasks = ledger.tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress" || t.status === "unknown",
  );
  if (openTasks.length === 0) return "";

  const summary = buildTaskLedgerSummary(ledger);

  const todoToolInstruction = capabilities.hasExplicitTodoTool && capabilities.todoToolName
    ? `Call ${capabilities.todoToolName} to mark each task as completed, obsolete, or blocked before your final response.`
    : capabilities.hasExplicitPlanMode
      ? "Update the plan to reflect the current state of each task before your final response."
      : "Include a reconciled task summary in your response showing the status of each task.";

  const reconciliationInstruction = [
    "Before final response, reconcile the task ledger.",
    `${openTasks.length} task(s) remain open.`,
    "For each open task: mark it completed with evidence, mark it obsolete/not applicable with a reason, mark it blocked, or explicitly state it remains unfinished.",
    "Do not claim all work is complete while open tasks remain.",
    todoToolInstruction,
  ].join(" ");

  return [summary, "", reconciliationInstruction].join("\n");
}

/**
 * Build a governance block for PromptFrame injection.
 * Only emits content when there are tasks worth tracking.
 */
export function buildTaskLedgerGovernanceBlock(
  ledger: TaskLedger | null,
  capabilities: ClientTaskCapabilities | null,
): string {
  if (!ledger || ledger.tasks.length === 0) return "";

  const openTasks = ledger.tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress" || t.status === "unknown",
  );

  if (openTasks.length === 0) {
    return buildTaskLedgerSummary(ledger);
  }

  return buildTaskLedgerNudge(ledger, capabilities ?? {
    hasExplicitTodoTool: false,
    hasExplicitPlanMode: false,
    todoToolName: null,
    detectedSource: "unknown",
  });
}
