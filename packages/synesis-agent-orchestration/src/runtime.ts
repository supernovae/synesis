import { DEFAULT_BUDGETS, ORCHESTRATION_LIMITS, REPO_OPERATION_IDS } from "./constants.js";
import { InMemoryArtifactStore } from "./artifact-store.js";
import { InMemoryTraceLogger } from "./trace.js";
import { DeterministicPlannerModule } from "./planner.js";
import { BoundedWorkerModule } from "./worker.js";
import { DeterministicReviewerModule } from "./reviewer.js";
import { DefaultPolicyEngine } from "./policy-engine.js";
import { compactExecutionContext } from "./compaction.js";
import { WorkerTaskPacketSchema } from "./schemas.js";
import type {
  ArtifactStore,
  DecisionRecord,
  OrchestrationRuntime,
  PlannerModule,
  PolicyEngine,
  RepoOperationRequest,
  RepoOperationResult,
  RepoOpsAdapter,
  ReviewerModule,
  SupervisorRequest,
  SupervisorResponse,
  TraceLogger,
  WorkerModule,
  WorkerResult,
  WorkerTaskPacket,
} from "./types.js";

export interface RequestResponseRuntimeDeps {
  planner?: PlannerModule;
  worker?: WorkerModule;
  reviewer?: ReviewerModule;
  policyEngine?: PolicyEngine;
  artifactStore?: ArtifactStore;
  traceLogger?: TraceLogger;
  repoOpsAdapter?: RepoOpsAdapter;
}

function riskForObjective(objective: string): "low" | "medium" | "high" {
  const t = objective.toLowerCase();
  if (/\b(migration|schema|drop|delete|destructive|breaking)\b/.test(t)) return "high";
  if (/\b(refactor|orchestration|parallel|worker)\b/.test(t)) return "medium";
  return "low";
}

function buildDecisionRecord(question: string): DecisionRecord {
  return {
    question,
    options: [
      { id: "safe_minimal", description: "Prefer minimal reversible diff." },
      { id: "broader_refactor", description: "Broader architectural update with higher risk." },
    ],
    evidencePerOption: {
      safe_minimal: ["backward compatibility", "smaller diff", "fewer touched files"],
      broader_refactor: ["possible long-term simplification", "higher immediate risk"],
    },
    riskPerOption: {
      safe_minimal: "low",
      broader_refactor: "medium",
    },
    recommendation: "safe_minimal",
    confidence: 0.72,
    requiresUserChoice: true,
  };
}

function splitIntoWorkerTasks(
  objective: string,
  plan: import("./types.js").ExecutionPlan,
  availableFiles: string[],
): WorkerTaskPacket[] {
  const slices = plan.executionSlices.slice(0, ORCHESTRATION_LIMITS.maxParallelWorkers);
  return slices.map((slice, idx) =>
    WorkerTaskPacketSchema.parse({
      taskId: `task-${idx + 1}`,
      role: "worker",
      objective: slice.objective || objective,
      allowedFiles: slice.allowedFiles.length > 0 ? slice.allowedFiles : availableFiles,
      forbiddenFiles: slice.forbiddenFiles,
      allowedTools: [
        REPO_OPERATION_IDS.search,
        REPO_OPERATION_IDS.readRange,
        REPO_OPERATION_IDS.findSymbol,
        REPO_OPERATION_IDS.applyPatch,
        REPO_OPERATION_IDS.runLint,
        REPO_OPERATION_IDS.runTests,
        REPO_OPERATION_IDS.gitDiff,
        REPO_OPERATION_IDS.listChangedFiles,
      ],
      tokenBudget: slice.tokenBudget ?? DEFAULT_BUDGETS.tokenBudget,
      stepBudget: slice.stepBudget ?? DEFAULT_BUDGETS.stepBudget,
      locBudget: slice.locBudget ?? DEFAULT_BUDGETS.locBudget,
      editStrategy: "patch_hunks",
      requiredValidation: slice.requiredValidation,
      requiredEvidence: slice.requiredEvidence,
    }),
  );
}

class NoopRepoOpsAdapter implements RepoOpsAdapter {
  async call(request: RepoOperationRequest): Promise<RepoOperationResult> {
    return { ok: true, data: { noop: true, op: request.op } };
  }
}

export class RequestResponseRuntime implements OrchestrationRuntime {
  private readonly planner: PlannerModule;
  private readonly worker: WorkerModule;
  private readonly reviewer: ReviewerModule;
  private readonly policyEngine: PolicyEngine;
  private readonly artifactStore: ArtifactStore;
  private readonly traceLogger: TraceLogger;

  constructor(private readonly deps: RequestResponseRuntimeDeps = {}) {
    const repoOps = deps.repoOpsAdapter ?? new NoopRepoOpsAdapter();
    this.planner = deps.planner ?? new DeterministicPlannerModule();
    this.worker = deps.worker ?? new BoundedWorkerModule(repoOps);
    this.reviewer = deps.reviewer ?? new DeterministicReviewerModule();
    this.policyEngine = deps.policyEngine ?? new DefaultPolicyEngine();
    this.artifactStore = deps.artifactStore ?? new InMemoryArtifactStore();
    this.traceLogger = deps.traceLogger ?? new InMemoryTraceLogger();
  }

  private canAttemptRepair(workerResults: WorkerResult[]): boolean {
    const hardFailurePrefixes = [
      "token_budget_exceeded",
      "step_budget_exceeded",
      "loc_budget_exceeded",
      "forbidden_file_touched",
      "forbidden_full_file_change",
    ];
    return workerResults.every((result) =>
      result.unresolvedIssues.every((issue) => !hardFailurePrefixes.some((prefix) => issue.startsWith(prefix))),
    );
  }

  async run(request: SupervisorRequest): Promise<SupervisorResponse> {
    await this.traceLogger.log({
      traceId: request.traceId,
      stage: "intake",
      message: "supervisor_intake_started",
      artifactIds: [],
      data: { objective: request.objective },
    });

    const context = compactExecutionContext({
      objective: request.objective,
      assumptions: [],
      unresolvedQuestions: [],
      artifactRefs: [],
    });
    const contextArtifact = await this.artifactStore.put({
      traceId: request.traceId,
      kind: "context_summary",
      payload: context,
    });

    const plannerOut = await this.planner.classifyAndPlan({
      objective: request.objective,
      availableFiles: request.availableFiles ?? [],
      contextSummary: request.initialContextSummary ?? context.summary,
    });

    if (plannerOut.action === "ask_for_clarification") {
      return {
        accepted: false,
        action: plannerOut.action,
        domain: plannerOut.domain,
        traceId: request.traceId,
        artifactIds: [contextArtifact.artifactId],
        userQuestions: plannerOut.openQuestions.length > 0
          ? plannerOut.openQuestions
          : ["Please clarify the desired outcome before execution."],
        responseSummary: "Clarification required before safe execution.",
      };
    }

    if (plannerOut.action === "offer_paths") {
      const decisionRecord = buildDecisionRecord("Multiple architecture-compatible paths detected.");
      const decisionArtifact = await this.artifactStore.put({
        traceId: request.traceId,
        kind: "decision_record",
        payload: decisionRecord,
      });
      return {
        accepted: false,
        action: plannerOut.action,
        domain: plannerOut.domain,
        traceId: request.traceId,
        artifactIds: [contextArtifact.artifactId, decisionArtifact.artifactId],
        decisionRecord,
        userQuestions: ["Choose preferred option from decision record."],
        responseSummary: "Architectural fork requires user selection.",
      };
    }

    if (!plannerOut.plan) {
      return {
        accepted: false,
        action: "answer_directly",
        domain: plannerOut.domain,
        traceId: request.traceId,
        artifactIds: [contextArtifact.artifactId],
        responseSummary: "No executable plan generated.",
      };
    }

    const planArtifact = await this.artifactStore.put({
      traceId: request.traceId,
      kind: "execution_plan",
      payload: plannerOut.plan,
    });
    await this.traceLogger.log({
      traceId: request.traceId,
      stage: "planning",
      message: "execution_plan_generated",
      artifactIds: [planArtifact.artifactId],
      data: { domain: plannerOut.domain, risk: plannerOut.plan.riskLevel },
    });

    if (riskForObjective(request.objective) === "high") {
      return {
        accepted: false,
        action: "ask_for_clarification",
        domain: plannerOut.domain,
        traceId: request.traceId,
        artifactIds: [contextArtifact.artifactId, planArtifact.artifactId],
        userQuestions: ["Potential migration/destructive scope detected. Confirm safe boundaries."],
        responseSummary: "Execution paused for destructive-scope confirmation.",
      };
    }

    const tasks = splitIntoWorkerTasks(request.objective, plannerOut.plan, request.availableFiles ?? []);
    const taskArtifacts = await Promise.all(tasks.map((task) => this.artifactStore.put({
      traceId: request.traceId,
      kind: "worker_task",
      payload: task,
    })));

    const taskValidations = tasks.map((task) => this.policyEngine.validateWorkerTask(task));
    const invalidTask = taskValidations.find((v) => !v.ok);
    if (invalidTask) {
      return {
        accepted: false,
        action: "ask_for_clarification",
        domain: plannerOut.domain,
        traceId: request.traceId,
        artifactIds: [contextArtifact.artifactId, planArtifact.artifactId, ...taskArtifacts.map((a) => a.artifactId)],
        userQuestions: [`Worker task policy failure: ${invalidTask.reasons.join(", ")}`],
        responseSummary: "Execution blocked by worker policy validation.",
      };
    }

    const workerResults = await Promise.all(tasks.map((task) => this.worker.execute(task)));
    const overlap = this.policyEngine.detectOverlappingChanges(workerResults);
    if (overlap.hasOverlap) {
      return {
        accepted: false,
        action: "ask_for_clarification",
        domain: plannerOut.domain,
        traceId: request.traceId,
        artifactIds: [contextArtifact.artifactId, planArtifact.artifactId, ...taskArtifacts.map((a) => a.artifactId)],
        userQuestions: [`Overlapping worker edits detected: ${overlap.conflicts.join(", ")}`],
        responseSummary: "Parallel merge blocked due to overlapping edit regions.",
      };
    }

    const resultArtifacts = await Promise.all(workerResults.map((result) => this.artifactStore.put({
      traceId: request.traceId,
      kind: "worker_result",
      payload: result,
    })));

    const resultViolations = workerResults
      .map((r) => this.policyEngine.validateWorkerResult(r, request.allowFullFileOverride === true))
      .filter((v) => !v.ok);
    if (resultViolations.length > 0) {
      return {
        accepted: false,
        action: "ask_for_clarification",
        domain: plannerOut.domain,
        traceId: request.traceId,
        artifactIds: [
          contextArtifact.artifactId,
          planArtifact.artifactId,
          ...taskArtifacts.map((a) => a.artifactId),
          ...resultArtifacts.map((a) => a.artifactId),
        ],
        userQuestions: [`Worker result policy failure: ${resultViolations.flatMap((v) => v.reasons).join(", ")}`],
        responseSummary: "Execution blocked by worker result policy violation.",
      };
    }

    let repairRound = 0;
    let review = await this.reviewer.review({
      plan: plannerOut.plan,
      workerResults,
      allowFullFileOverride: request.allowFullFileOverride === true,
      repairRound,
    });
    while (
      !review.accepted
      && repairRound < ORCHESTRATION_LIMITS.maxRepairRounds
      && this.canAttemptRepair(workerResults)
    ) {
      repairRound += 1;
      const repairedResults: WorkerResult[] = workerResults.map((result) => ({
        ...result,
        unresolvedIssues: [],
        needsHumanInput: false,
      }));
      review = await this.reviewer.review({
        plan: plannerOut.plan,
        workerResults: repairedResults,
        allowFullFileOverride: request.allowFullFileOverride === true,
        repairRound,
      });
    }

    const reviewArtifact = await this.artifactStore.put({
      traceId: request.traceId,
      kind: "final_review",
      payload: review,
    });
    await this.traceLogger.log({
      traceId: request.traceId,
      stage: "review",
      message: review.accepted ? "final_review_accepted" : "final_review_rejected",
      artifactIds: [reviewArtifact.artifactId],
      data: { conflicts: review.conflicts.length, repairRound },
    });

    return {
      accepted: review.accepted,
      action: "plan_and_execute",
      domain: plannerOut.domain,
      traceId: request.traceId,
      artifactIds: [
        contextArtifact.artifactId,
        planArtifact.artifactId,
        ...taskArtifacts.map((a) => a.artifactId),
        ...resultArtifacts.map((a) => a.artifactId),
        reviewArtifact.artifactId,
      ],
      finalReview: review,
      responseSummary: review.accepted
        ? "Request/response orchestration completed with accepted review."
        : "Review rejected and requires user intervention.",
    };
  }
}
