import { buildChecklistFromPrompt, type RequirementChecklist } from "../validation/requirement-coverage.js";

export type PlanStage = "discover" | "implement" | "verify" | "finalize";

export interface RequirementRubricScore {
  requirementCoverage: number;
  testingCoverage: number;
  unixBehaviorCoverage: number;
  endpointCompatibilityCoverage: number;
  overall: number;
}

export interface TaskIntake {
  sourceHash: string;
  sourcePreview: string;
  checklist: RequirementChecklist;
  acceptanceCriteria: string[];
  stages: PlanStage[];
  rubric: RequirementRubricScore;
  createdAt: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function scorePromptDimension(prompt: string, patterns: RegExp[]): number {
  const text = prompt.toLowerCase();
  if (!text.trim()) return 0;
  let hits = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) hits += 1;
  }
  return clamp01(hits / patterns.length);
}

function buildAcceptanceCriteria(prompt: string, checklist: RequirementChecklist): string[] {
  const fromChecklist = [
    ...checklist.must.map((r) => `must:${r.title}`),
    ...checklist.should.map((r) => `should:${r.title}`),
  ];
  if (fromChecklist.length > 0) return fromChecklist.slice(0, 40);

  const trimmed = prompt.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];
  return trimmed
    .split(/[.;\n]+/)
    .map((v) => v.trim())
    .filter((v) => v.length >= 16)
    .slice(0, 20);
}

export function buildTaskIntake(prompt: string, sourceHash: string): TaskIntake {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  const checklist = buildChecklistFromPrompt(normalized, sourceHash);
  const acceptanceCriteria = buildAcceptanceCriteria(normalized, checklist);

  const requirementCoverage = clamp01((checklist.must.length * 1.5 + checklist.should.length) / 20);
  const testingCoverage = scorePromptDimension(normalized, [
    /\btest\b/,
    /\bintegration\b/,
    /\bfuzz\b/,
    /\bgolden\b/,
  ]);
  const unixBehaviorCoverage = scorePromptDimension(normalized, [
    /\btty\b/,
    /\bstdin\b/,
    /\bstdout\b/,
    /\bstderr\b/,
    /\bpipe\b/,
    /\bexit code\b/,
  ]);
  const endpointCompatibilityCoverage = scorePromptDimension(normalized, [
    /\/v1\/chat\/completions/,
    /\/v1\/responses/,
    /\bopenai-compatible\b/,
    /\banthropic\b|\bacp\b/,
  ]);
  const overall = clamp01(
    requirementCoverage * 0.45
      + testingCoverage * 0.2
      + unixBehaviorCoverage * 0.2
      + endpointCompatibilityCoverage * 0.15,
  );

  return {
    sourceHash,
    sourcePreview: normalized.slice(0, 800),
    checklist,
    acceptanceCriteria,
    stages: ["discover", "implement", "verify", "finalize"],
    rubric: {
      requirementCoverage,
      testingCoverage,
      unixBehaviorCoverage,
      endpointCompatibilityCoverage,
      overall,
    },
    createdAt: Date.now(),
  };
}

export function formatTaskIntakeBlock(intake: TaskIntake): string {
  const lines: string[] = [
    `<synesis_task_intake overall="${intake.rubric.overall.toFixed(2)}">`,
    `stages=${intake.stages.join(" -> ")}`,
    `rubric=requirements:${intake.rubric.requirementCoverage.toFixed(2)},tests:${intake.rubric.testingCoverage.toFixed(2)},unix:${intake.rubric.unixBehaviorCoverage.toFixed(2)},endpoints:${intake.rubric.endpointCompatibilityCoverage.toFixed(2)}`,
  ];
  if (intake.acceptanceCriteria.length > 0) {
    lines.push("acceptance_criteria:");
    for (const criteria of intake.acceptanceCriteria.slice(0, 10)) {
      lines.push(`- ${criteria}`);
    }
  }
  lines.push("</synesis_task_intake>");
  return lines.join("\n");
}
