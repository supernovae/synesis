import { describe, expect, it } from "vitest";
import { RequestResponseRuntime } from "../../../packages/synesis-agent-orchestration/src/runtime.js";
import { BoundedWorkerModule } from "../../../packages/synesis-agent-orchestration/src/worker.js";
import { normalizeProjectInstructions } from "../../../packages/synesis-agent-orchestration/src/compaction.js";
import type { PlannerModule, ReviewerModule, WorkerModule } from "../../../packages/synesis-agent-orchestration/src/types.js";

function makeTwoSlicePlanner(overrides?: { lowBudget?: boolean }): PlannerModule {
  return {
    async classifyAndPlan(input) {
      return {
        domain: "complicated",
        action: "plan_and_execute",
        openQuestions: [],
        plan: {
          objective: input.objective,
          assumptions: [],
          openQuestions: [],
          riskLevel: "medium",
          domain: "complicated",
          executionSlices: [
            {
              id: "frontend",
              objective: "frontend changes",
              allowedFiles: ["base/admin/frontend/src/App.tsx"],
              forbiddenFiles: [],
              requiredValidation: [],
              requiredEvidence: [],
              ...(overrides?.lowBudget ? { tokenBudget: 10, stepBudget: 1, locBudget: 5 } : {}),
            },
            {
              id: "backend",
              objective: "backend changes",
              allowedFiles: ["base/admin/app/routers/yarn.py"],
              forbiddenFiles: [],
              requiredValidation: [],
              requiredEvidence: [],
              ...(overrides?.lowBudget ? { tokenBudget: 10, stepBudget: 1, locBudget: 5 } : {}),
            },
          ],
          validationPlan: [],
          rollbackPlan: [],
          stopConditions: [],
        },
      };
    },
  };
}

describe("phase3 agent orchestration runtime", () => {
  it("routes ambiguity to clarification", async () => {
    const runtime = new RequestResponseRuntime();
    const out = await runtime.run({
      traceId: "t-clarify",
      objective: "architecture fork is ambiguous and unclear",
      projectRoot: "/tmp/repo",
    });
    expect(out.accepted).toBe(false);
    expect(out.action).toBe("offer_paths");
    expect(out.decisionRecord).toBeTruthy();
  });

  it("supports safe parallel frontend/backend split", async () => {
    const worker: WorkerModule = {
      async execute(task) {
        return {
          summary: `done ${task.taskId}`,
          proposedChanges: [{
            kind: "patch_hunk",
            filePath: task.allowedFiles[0]!,
            startLine: 10,
            endLine: 12,
            summary: "small patch",
          }],
          touchedFiles: [task.allowedFiles[0]!],
          evidence: [],
          unresolvedIssues: [],
          confidence: 0.9,
          needsHumanInput: false,
          tokensUsed: 5,
          stepsUsed: 1,
        };
      },
    };
    const runtime = new RequestResponseRuntime({
      planner: makeTwoSlicePlanner(),
      worker,
    });
    const out = await runtime.run({
      traceId: "t-split",
      objective: "split frontend and backend changes",
      projectRoot: "/tmp/repo",
    });
    expect(out.accepted).toBe(true);
    expect(out.finalReview?.accepted).toBe(true);
  });

  it("escalates overlapping worker conflicts", async () => {
    const worker: WorkerModule = {
      async execute() {
        return {
          summary: "overlap",
          proposedChanges: [{
            kind: "patch_hunk",
            filePath: "base/admin/app/routers/yarn.py",
            startLine: 100,
            endLine: 120,
            summary: "edit",
          }],
          touchedFiles: ["base/admin/app/routers/yarn.py"],
          evidence: [],
          unresolvedIssues: [],
          confidence: 0.8,
          needsHumanInput: false,
        };
      },
    };
    const runtime = new RequestResponseRuntime({
      planner: makeTwoSlicePlanner(),
      worker,
    });
    const out = await runtime.run({
      traceId: "t-overlap",
      objective: "parallel changes that collide",
      projectRoot: "/tmp/repo",
    });
    expect(out.accepted).toBe(false);
    expect(out.responseSummary).toContain("overlapping edit regions");
  });

  it("emits decision record for architectural fork", async () => {
    const runtime = new RequestResponseRuntime();
    const out = await runtime.run({
      traceId: "t-fork",
      objective: "architecture trade-off with ambiguous options",
      projectRoot: "/tmp/repo",
    });
    expect(out.action).toBe("offer_paths");
    expect(out.decisionRecord?.options.length).toBeGreaterThanOrEqual(2);
  });

  it("allows exactly one reviewer remand", async () => {
    let reviews = 0;
    const reviewer: ReviewerModule = {
      async review(input) {
        reviews += 1;
        if (input.repairRound === 0) {
          return {
            accepted: false,
            reviewSummary: "needs one repair",
            mergedPatchPlan: [],
            conflicts: [{ type: "validation", message: "needs fix", files: [] }],
            followUps: ["single_repair_round_allowed"],
            userQuestions: [],
            prSummaryDraft: "",
          };
        }
        return {
          accepted: true,
          reviewSummary: "accepted after remand",
          mergedPatchPlan: [],
          conflicts: [],
          followUps: [],
          userQuestions: [],
          prSummaryDraft: "ok",
        };
      },
    };
    const worker: WorkerModule = {
      async execute() {
        return {
          summary: "change",
          proposedChanges: [],
          touchedFiles: [],
          evidence: [],
          unresolvedIssues: [],
          confidence: 0.9,
          needsHumanInput: false,
        };
      },
    };
    const runtime = new RequestResponseRuntime({
      planner: makeTwoSlicePlanner(),
      worker,
      reviewer,
    });
    const out = await runtime.run({
      traceId: "t-remand",
      objective: "bounded remand test",
      projectRoot: "/tmp/repo",
    });
    expect(out.accepted).toBe(true);
    expect(reviews).toBe(2);
  });

  it("rejects full-file rewrite by policy", async () => {
    const worker: WorkerModule = {
      async execute(task) {
        return {
          summary: "full file",
          proposedChanges: [{
            kind: "full_file",
            filePath: task.allowedFiles[0] ?? "base/yarn-ts/src/index.ts",
            summary: "rewrite whole file",
          }],
          touchedFiles: [task.allowedFiles[0] ?? "base/yarn-ts/src/index.ts"],
          evidence: [],
          unresolvedIssues: [],
          confidence: 0.7,
          needsHumanInput: false,
        };
      },
    };
    const runtime = new RequestResponseRuntime({
      planner: makeTwoSlicePlanner(),
      worker,
    });
    const out = await runtime.run({
      traceId: "t-full-file",
      objective: "attempt whole file rewrite",
      projectRoot: "/tmp/repo",
    });
    expect(out.accepted).toBe(false);
    expect(out.responseSummary).toContain("policy violation");
  });

  it("enforces token and step budgets", async () => {
    const worker = new BoundedWorkerModule(
      { call: async () => ({ ok: true, data: {} }) },
      async () => ({
        summary: "over budget",
        proposedChanges: [],
        touchedFiles: [],
        evidence: [],
        unresolvedIssues: [],
        confidence: 0.9,
        needsHumanInput: false,
        tokensUsed: 999,
        stepsUsed: 999,
      }),
    );
    const runtime = new RequestResponseRuntime({
      planner: makeTwoSlicePlanner({ lowBudget: true }),
      worker,
    });
    const out = await runtime.run({
      traceId: "t-budget",
      objective: "budget constraint test",
      projectRoot: "/tmp/repo",
    });
    expect(out.accepted).toBe(false);
    expect(out.responseSummary.toLowerCase()).toContain("rejected");
  });

  it("normalizes project instructions from AGENTS.md and CLAUDE.md", () => {
    const set = normalizeProjectInstructions({
      agentsMd: "  rule 1 \n\n rule 2 ",
      claudeMd: "  claude rule ",
      internalInstructions: [" internal  "],
    });
    expect(set.sections.length).toBe(3);
    expect(set.normalized).toContain("AGENTS.md");
    expect(set.normalized).toContain("CLAUDE.md");
  });

  it("produces end-to-end trace artifacts for frontend+backend request", async () => {
    const worker: WorkerModule = {
      async execute(task) {
        return {
          summary: "done",
          proposedChanges: [{
            kind: "patch_hunk",
            filePath: task.allowedFiles[0] ?? "unknown.ts",
            startLine: 1,
            endLine: 2,
            summary: "tiny change",
          }],
          touchedFiles: [task.allowedFiles[0] ?? "unknown.ts"],
          evidence: ["git_diff"],
          unresolvedIssues: [],
          confidence: 0.95,
          needsHumanInput: false,
        };
      },
    };
    const runtime = new RequestResponseRuntime({
      planner: makeTwoSlicePlanner(),
      worker,
    });
    const out = await runtime.run({
      traceId: "t-e2e",
      objective: "update frontend and backend safely",
      projectRoot: "/tmp/repo",
    });
    expect(out.accepted).toBe(true);
    expect(out.artifactIds.length).toBeGreaterThanOrEqual(5);
    expect(out.traceId).toBe("t-e2e");
  });
});
