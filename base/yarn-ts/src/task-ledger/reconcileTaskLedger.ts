import type { EvidenceSignal, HarnessTask, TaskLedger, TaskStatus } from "./types.js";

/**
 * Terminal statuses that cannot be overwritten by lower-confidence sources.
 */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "obsolete"]);

/**
 * Confidence threshold above which a task with sufficient evidence
 * is auto-promoted to "completed". This closes the feedback loop when
 * the model does the work but forgets to call the todo tool.
 */
const AUTO_PROMOTE_CONFIDENCE = 0.85;
const AUTO_PROMOTE_MIN_EVIDENCE = 2;

/**
 * Match tasks by id, then by normalized title prefix (first 40 chars, lowered).
 */
function findExistingTask(tasks: HarnessTask[], candidate: HarnessTask): HarnessTask | undefined {
  const byId = tasks.find((t) => t.id === candidate.id);
  if (byId) return byId;

  if (candidate.clientTaskId) {
    const byClientId = tasks.find((t) => t.clientTaskId === candidate.clientTaskId);
    if (byClientId) return byClientId;
  }

  const normTitle = candidate.title.toLowerCase().slice(0, 40);
  if (normTitle.length >= 10) {
    return tasks.find((t) => t.title.toLowerCase().slice(0, 40) === normTitle);
  }
  return undefined;
}

/**
 * Merge explicit tool-call task updates into the ledger.
 * Tool-sourced tasks have high confidence and overwrite text-derived state.
 */
export function reconcileFromToolCall(
  ledger: TaskLedger,
  normalizedTasks: HarnessTask[],
  turn: number,
): TaskLedger {
  if (normalizedTasks.length === 0) return ledger;

  const tasks = [...ledger.tasks];

  for (const incoming of normalizedTasks) {
    const existing = findExistingTask(tasks, incoming);
    if (existing) {
      const idx = tasks.indexOf(existing);
      tasks[idx] = {
        ...existing,
        status: incoming.status,
        evidence: [...new Set([...existing.evidence, ...incoming.evidence])],
        lastUpdatedTurn: turn,
        confidence: Math.max(existing.confidence, incoming.confidence),
        source: incoming.source !== "unknown" ? incoming.source : existing.source,
      };
    } else {
      tasks.push({ ...incoming, createdTurn: turn, lastUpdatedTurn: turn });
    }
  }

  return { ...ledger, tasks, lastReconciledTurn: turn };
}

/**
 * Merge text-extracted tasks into the ledger.
 * Lower confidence: does not overwrite explicit tool state or terminal statuses.
 */
export function reconcileFromText(
  ledger: TaskLedger,
  extractedTasks: HarnessTask[],
  turn: number,
): TaskLedger {
  if (extractedTasks.length === 0) return ledger;

  const tasks = [...ledger.tasks];

  for (const incoming of extractedTasks) {
    const existing = findExistingTask(tasks, incoming);
    if (existing) {
      if (TERMINAL_STATUSES.has(existing.status)) continue;
      if (existing.confidence >= incoming.confidence) continue;

      const idx = tasks.indexOf(existing);
      tasks[idx] = {
        ...existing,
        status: incoming.status,
        lastUpdatedTurn: turn,
        confidence: incoming.confidence,
      };
    } else {
      tasks.push({ ...incoming, createdTurn: turn, lastUpdatedTurn: turn });
    }
  }

  return { ...ledger, tasks, lastReconciledTurn: turn };
}

/**
 * Update task confidence based on edit/test/build evidence signals.
 */
export function reconcileFromEvidence(
  ledger: TaskLedger,
  signals: EvidenceSignal[],
): TaskLedger {
  if (signals.length === 0 || ledger.tasks.length === 0) return ledger;

  const tasks = ledger.tasks.map((task) => {
    const titleLower = task.title.toLowerCase();
    let updatedTask = task;

    for (const signal of signals) {
      const detailLower = signal.detail.toLowerCase();

      const hasKeywordOverlap = titleLower.split(/\s+/).some(
        (word) => word.length >= 4 && detailLower.includes(word),
      );
      if (!hasKeywordOverlap) continue;

      const newEvidence = [...new Set([...updatedTask.evidence, `${signal.kind}: ${signal.detail}`])];

      if (signal.kind === "test_pass" || signal.kind === "build_pass" || signal.kind === "lint_pass") {
        updatedTask = {
          ...updatedTask,
          evidence: newEvidence,
          confidence: Math.min(1.0, updatedTask.confidence + 0.15),
          lastUpdatedTurn: signal.turn,
        };
      } else if (signal.kind === "file_edit" || signal.kind === "command_success") {
        updatedTask = {
          ...updatedTask,
          evidence: newEvidence,
          confidence: Math.min(1.0, updatedTask.confidence + 0.1),
          lastUpdatedTurn: signal.turn,
        };
      } else if (signal.kind === "test_fail" || signal.kind === "build_fail") {
        updatedTask = {
          ...updatedTask,
          evidence: newEvidence,
          lastUpdatedTurn: signal.turn,
        };
      }
    }

    if (
      !TERMINAL_STATUSES.has(updatedTask.status) &&
      updatedTask.confidence >= AUTO_PROMOTE_CONFIDENCE &&
      updatedTask.evidence.length >= AUTO_PROMOTE_MIN_EVIDENCE
    ) {
      updatedTask = { ...updatedTask, status: "completed" };
    }

    return updatedTask;
  });

  return { ...ledger, tasks };
}

/**
 * Decay confidence for tasks that haven't been updated in a while
 * and have no strong evidence. Does NOT force obsolete — just lowers confidence.
 */
export function decayStaleTaskConfidence(
  ledger: TaskLedger,
  currentTurn: number,
  staleTurnThreshold: number = 10,
): TaskLedger {
  const tasks = ledger.tasks.map((task) => {
    if (TERMINAL_STATUSES.has(task.status)) return task;
    const turnsSinceUpdate = currentTurn - task.lastUpdatedTurn;
    if (turnsSinceUpdate < staleTurnThreshold) return task;
    if (task.evidence.length >= 2) return task;

    const decay = Math.min(0.3, turnsSinceUpdate * 0.02);
    return {
      ...task,
      confidence: Math.max(0.1, task.confidence - decay),
    };
  });

  return { ...ledger, tasks };
}

/**
 * Create a fresh empty ledger for a session.
 */
export function createEmptyLedger(
  sessionId: string,
  hasExplicitClientTodoTool: boolean,
  hasExplicitPlanMode: boolean,
): TaskLedger {
  return {
    sessionId,
    tasks: [],
    hasExplicitClientTodoTool,
    hasExplicitPlanMode,
    reconciliationAttempts: 0,
  };
}

/**
 * Serialization for persistence in SessionContinuity.
 */
export function serializeTaskLedger(ledger: TaskLedger): Record<string, unknown> {
  return {
    sessionId: ledger.sessionId,
    tasks: ledger.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      source: t.source,
      clientTaskId: t.clientTaskId,
      evidence: t.evidence,
      lastUpdatedTurn: t.lastUpdatedTurn,
      createdTurn: t.createdTurn,
      confidence: t.confidence,
    })),
    lastReconciledTurn: ledger.lastReconciledTurn,
    hasExplicitClientTodoTool: ledger.hasExplicitClientTodoTool,
    hasExplicitPlanMode: ledger.hasExplicitPlanMode,
    reconciliationAttempts: ledger.reconciliationAttempts,
  };
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "pending", "in_progress", "completed", "blocked", "obsolete", "unknown",
]);

const VALID_SOURCES: ReadonlySet<string> = new Set([
  "opencode_todowrite", "claude_todowrite", "cline_plan", "cursor_plan",
  "markdown_task_list", "model_plan_text", "harness_inferred", "unknown",
]);

export function deserializeTaskLedger(data: unknown): TaskLedger | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.sessionId !== "string") return null;

  const rawTasks = Array.isArray(d.tasks) ? d.tasks : [];
  const tasks: HarnessTask[] = rawTasks
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    .map((t) => ({
      id: String(t.id ?? ""),
      title: String(t.title ?? ""),
      status: (VALID_STATUSES.has(String(t.status ?? "")) ? String(t.status) : "unknown") as TaskStatus,
      source: (VALID_SOURCES.has(String(t.source ?? "")) ? String(t.source) : "unknown") as HarnessTask["source"],
      clientTaskId: typeof t.clientTaskId === "string" ? t.clientTaskId : undefined,
      evidence: Array.isArray(t.evidence) ? t.evidence.filter((e): e is string => typeof e === "string") : [],
      lastUpdatedTurn: typeof t.lastUpdatedTurn === "number" ? t.lastUpdatedTurn : 0,
      createdTurn: typeof t.createdTurn === "number" ? t.createdTurn : 0,
      confidence: typeof t.confidence === "number" ? t.confidence : 0.5,
    }));

  return {
    sessionId: d.sessionId,
    tasks,
    lastReconciledTurn: typeof d.lastReconciledTurn === "number" ? d.lastReconciledTurn : undefined,
    hasExplicitClientTodoTool: d.hasExplicitClientTodoTool === true,
    hasExplicitPlanMode: d.hasExplicitPlanMode === true,
    reconciliationAttempts: typeof d.reconciliationAttempts === "number" ? d.reconciliationAttempts : 0,
  };
}
