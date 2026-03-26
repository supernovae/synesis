import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphState } from "../src/state/types.js";

export interface PythonBaselineResult {
  style_passed: boolean;
  decision_passed: boolean;
  citation_passed: boolean;
  style_violations_count: number;
  decision_violations_count: number;
  citation_violations_count: number;
  oscillation_total_score: number;
  oscillation_decision_score: number;
}

export function isPythonBaselineCompareEnabled(): boolean {
  return (process.env.SYNESIS_PLANNER_TS_COMPARE_PY_BASELINE ?? "false").toLowerCase() === "true";
}

export function evaluateWithPythonBaseline(state: GraphState): PythonBaselineResult {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(currentDir, "../../..");
  const scriptPath = path.resolve(repoRoot, "base/planner/tests/tools/ts_migration_baseline.py");

  const proc = spawnSync("uv", ["run", "python", scriptPath], {
    cwd: repoRoot,
    input: JSON.stringify(state),
    encoding: "utf8"
  });

  if (proc.error) {
    throw proc.error;
  }
  if (proc.status !== 0) {
    throw new Error(`python baseline failed: ${proc.stderr || proc.stdout || "unknown error"}`);
  }
  const out = proc.stdout?.trim();
  if (!out) {
    throw new Error("python baseline returned empty output");
  }
  return JSON.parse(out) as PythonBaselineResult;
}
