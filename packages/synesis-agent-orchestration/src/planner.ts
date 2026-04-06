import { ExecutionPlanSchema } from "./schemas.js";
import type { CynefinDomain, IntakeAction, PlannerModule } from "./types.js";

function classifyDomain(objective: string): CynefinDomain {
  const t = objective.toLowerCase();
  if (/\b(outage|incident|down|sev|critical outage|broken deploy)\b/.test(t)) return "chaotic";
  if (/\b(architecture|trade[- ]?off|fork|ambiguous|unclear|unknown)\b/.test(t)) return "complex";
  if (/\b(migration|refactor|orchestration|multi|cross[- ]?service)\b/.test(t)) return "complicated";
  return "clear";
}

function actionForDomain(domain: CynefinDomain): IntakeAction {
  if (domain === "clear") return "plan_and_execute";
  if (domain === "complicated") return "plan_and_execute";
  if (domain === "complex") return "offer_paths";
  return "ask_for_clarification";
}

export class DeterministicPlannerModule implements PlannerModule {
  async classifyAndPlan(input: {
    objective: string;
    availableFiles: string[];
    contextSummary: string;
  }): Promise<{
    domain: CynefinDomain;
    action: IntakeAction;
    plan?: import("./types.js").ExecutionPlan;
    openQuestions: string[];
  }> {
    const domain = classifyDomain(input.objective);
    const action = actionForDomain(domain);
    const openQuestions: string[] = [];
    if (domain === "complex") {
      openQuestions.push("Multiple safe implementation paths detected. Confirm preferred path.");
    }
    if (domain === "chaotic") {
      openQuestions.push("System appears unstable. Confirm stabilization target before broad code edits.");
    }
    if (action !== "plan_and_execute") {
      return { domain, action, openQuestions };
    }
    const executionSlices = [
      {
        id: "slice-1",
        objective: input.objective,
        allowedFiles: input.availableFiles.slice(0, 30),
        forbiddenFiles: [],
        requiredValidation: ["run_lint", "run_test"],
        requiredEvidence: ["git_diff", "list_changed_files"],
      },
    ];
    const riskLevel = domain === "complicated" ? "medium" : "low";
    const plan = ExecutionPlanSchema.parse({
      objective: input.objective,
      assumptions: input.contextSummary ? [input.contextSummary] : [],
      openQuestions,
      riskLevel,
      domain,
      executionSlices,
      validationPlan: ["run_lint", "run_test"],
      rollbackPlan: ["revert_generated_patch", "restore_branch_state"],
      stopConditions: [
        "overlapping_worker_conflicts",
        "destructive_action_detected",
        "schema_or_migration_detected",
      ],
    });
    return { domain, action, plan, openQuestions };
  }
}
