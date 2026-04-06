import { ORCHESTRATION_LIMITS } from "./constants.js";
import type { PolicyEngine, WorkerResult, WorkerTaskPacket } from "./types.js";

function overlaps(aStart?: number, aEnd?: number, bStart?: number, bEnd?: number): boolean {
  if (!aStart || !aEnd || !bStart || !bEnd) return true;
  return aStart <= bEnd && bStart <= aEnd;
}

export class DefaultPolicyEngine implements PolicyEngine {
  validateWorkerTask(task: WorkerTaskPacket): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (task.role !== "worker") reasons.push("worker_task_role_must_be_worker");
    if (task.stepBudget <= 0) reasons.push("step_budget_must_be_positive");
    if (task.tokenBudget <= 0) reasons.push("token_budget_must_be_positive");
    if (task.locBudget <= 0) reasons.push("loc_budget_must_be_positive");
    if (task.editStrategy === "full_file") reasons.push("full_file_strategy_forbidden_default");
    if (task.allowedTools.length === 0) reasons.push("allowed_tools_required");
    return { ok: reasons.length === 0, reasons };
  }

  validateWorkerResult(result: WorkerResult, allowFullFileOverride: boolean): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (result.confidence < 0 || result.confidence > 1) reasons.push("invalid_confidence_range");
    for (const change of result.proposedChanges) {
      if (change.kind === "full_file" && !allowFullFileOverride) {
        reasons.push(`forbidden_full_file_change:${change.filePath}`);
      }
      if (change.startLine && change.endLine && change.endLine < change.startLine) {
        reasons.push(`invalid_line_range:${change.filePath}`);
      }
    }
    return { ok: reasons.length === 0, reasons };
  }

  detectOverlappingChanges(results: WorkerResult[]): { hasOverlap: boolean; conflicts: string[] } {
    const conflicts: string[] = [];
    for (let i = 0; i < results.length; i += 1) {
      const a = results[i];
      for (let j = i + 1; j < results.length; j += 1) {
        const b = results[j];
        for (const aChange of a.proposedChanges) {
          for (const bChange of b.proposedChanges) {
            if (aChange.filePath !== bChange.filePath) continue;
            if (overlaps(aChange.startLine, aChange.endLine, bChange.startLine, bChange.endLine)) {
              conflicts.push(`overlap:${aChange.filePath}`);
            }
          }
        }
      }
    }
    return { hasOverlap: conflicts.length > 0, conflicts: [...new Set(conflicts)].slice(0, ORCHESTRATION_LIMITS.maxParallelWorkers * 4) };
  }
}
