#!/usr/bin/env tsx
/**
 * Build a daily harness scorecard from eval outputs.
 *
 * Inputs:
 * - governor regression eval JSON (`--regression`)
 * - regression budget summary JSON (`--budget`)
 * - optional power-user canary eval JSON (`--canary`)
 *
 * Outputs:
 * - scorecard JSON (`--out-json`)
 * - scorecard markdown (`--out-md`)
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  buildHarnessScorecard,
  renderHarnessScorecardMarkdown,
  type HarnessScorecard,
} from "../src/eval/harness-scorecard.js";
import type { RegressionBudgetEvaluation } from "../src/eval/regression-budget.js";
import type { ScenarioResult } from "../src/eval/types.js";

interface EvalResultsJson {
  results?: ScenarioResult[];
  trajectoryRows?: unknown[];
}

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadEvalResults(path: string): { results: ScenarioResult[]; trajectoryRowCount: number } {
  const parsed = readJsonFile(path) as EvalResultsJson | ScenarioResult[];
  if (Array.isArray(parsed)) {
    return { results: parsed as ScenarioResult[], trajectoryRowCount: 0 };
  }
  if (Array.isArray(parsed.results)) {
    return {
      results: parsed.results,
      trajectoryRowCount: Array.isArray(parsed.trajectoryRows) ? parsed.trajectoryRows.length : 0,
    };
  }
  throw new Error(`No results[] found in ${path}`);
}

function loadBudget(path: string): RegressionBudgetEvaluation {
  const parsed = readJsonFile(path) as Partial<RegressionBudgetEvaluation>;
  if (
    typeof parsed.pass === "boolean"
    && parsed.baseline
    && parsed.candidate
    && parsed.thresholds
    && Array.isArray(parsed.violations)
  ) {
    return parsed as RegressionBudgetEvaluation;
  }
  throw new Error(`Invalid regression budget payload: ${path}`);
}

const regressionPath = getArg("regression") ?? "eval-governor-regression.json";
const budgetPath = getArg("budget") ?? "eval-governor-budget.json";
const canaryPath = getArg("canary");
const lane = getArg("lane") ?? process.env.SYNESIS_HARNESS_SCORECARD_LANE ?? "nightly";
const canaryPrefix = getArg("canary-prefix") ?? "canary-";
const outJson = getArg("out-json") ?? "harness-scorecard.json";
const outMd = getArg("out-md") ?? "harness-scorecard.md";

const regressionEval = loadEvalResults(regressionPath);
const budgetEvaluation = loadBudget(budgetPath);
const canaryEval = canaryPath ? loadEvalResults(canaryPath) : undefined;

const scorecard: HarnessScorecard = buildHarnessScorecard({
  lane,
  budgetEvaluation,
  regressionResults: regressionEval.results,
  canaryResults: canaryEval?.results,
  canaryPrefix,
  trajectoryRowCount: regressionEval.trajectoryRowCount,
});

writeFileSync(outJson, JSON.stringify(scorecard, null, 2), "utf8");
writeFileSync(outMd, renderHarnessScorecardMarkdown(scorecard), "utf8");

console.log("Harness scorecard:");
console.log(`- lane: ${scorecard.lane}`);
console.log(`- redline breached: ${scorecard.redline.breached}`);
console.log(`- budget pass: ${scorecard.budget.pass}`);
console.log(`- canary pass rate: ${scorecard.canary.pass_rate}`);
console.log(`- json: ${outJson}`);
console.log(`- markdown: ${outMd}`);
