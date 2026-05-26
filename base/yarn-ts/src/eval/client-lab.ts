import type { EvalClientProfile, EvalRunnerConfig, EvalScenario, ScenarioResult } from "./types.js";
import { runScenarios } from "./scenario-runner.js";

export interface EvalClientLabRun {
  profile: EvalClientProfile;
  round: number;
  results: ScenarioResult[];
  summary: EvalClientLabSummary;
}

export interface EvalClientLabResult {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  profiles: EvalClientLabRun[];
  summary: EvalClientLabSummary;
}

export interface EvalClientLabSummary {
  total: number;
  passed: number;
  failed: number;
  avgScore: number;
  governorInterventions: number;
  recoveryLoopScenarios: number;
  hardStopScenarios: number;
}

export const BUILTIN_EVAL_CLIENT_PROFILES: EvalClientProfile[] = [
  {
    id: "raw-openai",
    displayName: "Raw OpenAI-compatible client",
    description: "Minimal client shape with no developer-harness semantics.",
    adminSessionClientId: "eval-raw-openai",
    userAgent: "synesis-eval/raw-openai",
    extraHeaders: {
      "x-synesis-mode": "compat",
    },
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    description: "OpenCode-like OpenAI-compatible developer harness profile.",
    adminSessionClientId: "opencode",
    userAgent: "opencode/synesis-eval",
    extraHeaders: {
      "x-synesis-client-kind": "developer_harness",
      "x-synesis-harness": "opencode",
    },
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    description: "Claude Code-like developer harness profile routed through OpenAI-compatible evals.",
    adminSessionClientId: "claude-code",
    userAgent: "claude-code/synesis-eval",
    extraHeaders: {
      "x-synesis-client-kind": "developer_harness",
      "x-synesis-harness": "claude-code",
    },
  },
  {
    id: "codex-cli",
    displayName: "Codex CLI",
    description: "Codex-like terminal coding harness profile.",
    adminSessionClientId: "codex-cli",
    userAgent: "codex-cli/synesis-eval",
    extraHeaders: {
      "x-synesis-client-kind": "developer_harness",
      "x-synesis-harness": "codex-cli",
    },
  },
  {
    id: "cursor",
    displayName: "Cursor",
    description: "Cursor-like IDE harness profile.",
    adminSessionClientId: "cursor",
    userAgent: "cursor/synesis-eval",
    extraHeaders: {
      "x-synesis-client-kind": "ide_harness",
      "x-synesis-harness": "cursor",
    },
  },
];

export function resolveEvalClientProfiles(profileIds: string[] | undefined): EvalClientProfile[] {
  if (!profileIds || profileIds.length === 0) return BUILTIN_EVAL_CLIENT_PROFILES;
  const byId = new Map(BUILTIN_EVAL_CLIENT_PROFILES.map((profile) => [profile.id, profile]));
  return profileIds.map((id) => {
    const profile = byId.get(id);
    if (!profile) {
      throw new Error(`Unknown eval client profile '${id}'. Known profiles: ${[...byId.keys()].join(", ")}`);
    }
    return profile;
  });
}

export async function runEvalClientLab(input: {
  config: EvalRunnerConfig;
  scenarios: EvalScenario[];
  profiles: EvalClientProfile[];
  rounds?: number;
}): Promise<EvalClientLabResult> {
  const startedAtDate = new Date();
  const runs: EvalClientLabRun[] = [];
  const rounds = Math.max(1, input.rounds ?? 1);

  for (const profile of input.profiles) {
    for (let round = 1; round <= rounds; round++) {
      const results = await runScenarios(
        {
          ...input.config,
          model: profile.model ?? input.config.model,
          clientProfile: profile,
          conversationIdPrefix: `${input.config.conversationIdPrefix ?? "eval-lab"}-${profile.id}-r${round}`,
        },
        input.scenarios,
      );
      runs.push({
        profile,
        round,
        results,
        summary: summarizeScenarioResults(results),
      });
    }
  }

  const completedAtDate = new Date();
  return {
    startedAt: startedAtDate.toISOString(),
    completedAt: completedAtDate.toISOString(),
    durationMs: completedAtDate.getTime() - startedAtDate.getTime(),
    profiles: runs,
    summary: summarizeScenarioResults(runs.flatMap((run) => run.results)),
  };
}

export function summarizeScenarioResults(results: ScenarioResult[]): EvalClientLabSummary {
  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const scoreSum = results.reduce((sum, result) => sum + result.score, 0);
  return {
    total,
    passed,
    failed: total - passed,
    avgScore: total === 0 ? 0 : Number((scoreSum / total).toFixed(3)),
    governorInterventions: results.reduce((sum, result) => sum + result.governorInterventions, 0),
    recoveryLoopScenarios: results.filter((result) =>
      result.allGovernorRules.some((rule) => rule === "governor:recovery_rewrite" || rule.includes("loop")),
    ).length,
    hardStopScenarios: results.filter((result) => result.allGovernorRules.includes("governor:hard_stop")).length,
  };
}

export function renderEvalClientLabMarkdown(result: EvalClientLabResult): string {
  const lines = [
    "# Eval Client Lab",
    "",
    `Profiles: ${result.profiles.length}`,
    `Scenarios: ${result.summary.total}`,
    `Passed: ${result.summary.passed}`,
    `Failed: ${result.summary.failed}`,
    `Average score: ${result.summary.avgScore.toFixed(3)}`,
    `Governor interventions: ${result.summary.governorInterventions}`,
    "",
    "## Profiles",
    "",
  ];
  for (const run of result.profiles) {
    lines.push(`### ${run.profile.id} round ${run.round}`);
    lines.push("");
    lines.push(`Passed: ${run.summary.passed}/${run.summary.total}`);
    lines.push(`Average score: ${run.summary.avgScore.toFixed(3)}`);
    lines.push(`Governor interventions: ${run.summary.governorInterventions}`);
    const failures = run.results.filter((scenario) => !scenario.passed);
    if (failures.length > 0) {
      lines.push("", "Failures:");
      for (const failure of failures) {
        lines.push(`- ${failure.scenarioId}: ${failure.failureReasons.join("; ") || "failed"}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
