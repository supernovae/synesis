import { FinalReviewSchema } from "./schemas.js";
import type { FinalReview, ReviewerModule, WorkerResult } from "./types.js";

function toPatchPlan(results: WorkerResult[]): string[] {
  const out: string[] = [];
  for (const result of results) {
    for (const change of result.proposedChanges) {
      out.push(`${change.kind}:${change.filePath}`);
    }
  }
  return out;
}

export class DeterministicReviewerModule implements ReviewerModule {
  async review(input: {
    plan: import("./types.js").ExecutionPlan;
    workerResults: WorkerResult[];
    allowFullFileOverride: boolean;
    repairRound: number;
  }): Promise<FinalReview> {
    const conflicts: Array<{ type: "overlap" | "policy" | "validation"; message: string; files: string[] }> = [];
    for (const result of input.workerResults) {
      if (result.unresolvedIssues.length > 0) {
        conflicts.push({
          type: "validation",
          message: `worker_unresolved:${result.unresolvedIssues.join(",")}`,
          files: result.touchedFiles,
        });
      }
      for (const change of result.proposedChanges) {
        if (change.kind === "full_file" && !input.allowFullFileOverride) {
          conflicts.push({
            type: "policy",
            message: `full_file_rewrite_rejected:${change.filePath}`,
            files: [change.filePath],
          });
        }
      }
    }
    const accepted = conflicts.length === 0;
    const review = FinalReviewSchema.parse({
      accepted,
      reviewSummary: accepted
        ? "Review accepted. Patch plan is safe and policy-compliant."
        : "Review blocked due to policy/validation conflicts.",
      mergedPatchPlan: toPatchPlan(input.workerResults),
      conflicts,
      followUps: accepted
        ? []
        : input.repairRound < 1
          ? ["single_repair_round_allowed"]
          : ["repair_limit_reached_escalate_to_user"],
      userQuestions: [],
      prSummaryDraft: accepted
        ? `Implements ${input.plan.executionSlices.length} execution slice(s) with bounded worker orchestration.`
        : "",
    });
    return review;
  }
}
