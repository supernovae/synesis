import { buildTaskLedgerNudge } from "./buildTaskLedgerNudge.js";
import type { ClientTaskCapabilities, TaskCompletionGateResult, TaskLedger } from "./types.js";

/**
 * Maximum reconciliation attempts before the gate stops blocking.
 * After this many nudge cycles, the model is allowed to finalize
 * even with open tasks — prevents infinite loops.
 */
const MAX_RECONCILIATION_ATTEMPTS = 2;

/**
 * Evaluate whether the session is ready to finalize based on task ledger state.
 *
 * Returns `allow: true` when:
 * - No ledger exists (simple one-shot query)
 * - Ledger has no tasks
 * - All tasks are in terminal state (completed/obsolete/blocked)
 * - Reconciliation attempts exceeded the cap (escape hatch)
 *
 * Returns `allow: false` with a nudge when open tasks remain
 * and the model hasn't exhausted its reconciliation budget.
 */
export function evaluateTaskCompletionGate(
  ledger: TaskLedger | null,
  capabilities: ClientTaskCapabilities | null,
): TaskCompletionGateResult {
  if (!ledger || ledger.tasks.length === 0) {
    return { allow: true, severity: "none" };
  }

  const openTasks = ledger.tasks.filter(
    (t) => t.status === "pending" || t.status === "in_progress" || t.status === "unknown",
  );

  if (openTasks.length === 0) {
    return { allow: true, severity: "none" };
  }

  if (ledger.reconciliationAttempts >= MAX_RECONCILIATION_ATTEMPTS) {
    return { allow: true, severity: "none" };
  }

  const nudge = buildTaskLedgerNudge(
    ledger,
    capabilities ?? {
      hasExplicitTodoTool: false,
      hasExplicitPlanMode: false,
      todoToolName: null,
      detectedSource: "unknown",
    },
  );

  return {
    allow: false,
    severity: "soft",
    reason: `${openTasks.length} task(s) remain open in the task ledger.`,
    nudge,
  };
}

/**
 * Increment the reconciliation attempt counter on the ledger.
 * Call this after injecting a task-ledger nudge so the gate
 * knows how many passes have occurred.
 */
export function incrementReconciliationAttempts(ledger: TaskLedger): TaskLedger {
  return { ...ledger, reconciliationAttempts: ledger.reconciliationAttempts + 1 };
}
