#!/usr/bin/env tsx
/**
 * Compare eval-gym candidate results against a baseline and fail on
 * meaningful regressions in pass rate, score, intervention rate,
 * repeated-command anomalies, or turns-to-resolution.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateRegressionBudget } from "../src/eval/regression-budget.js";
import type { ScenarioResult } from "../src/eval/types.js";

interface EvalGymJson {
  results?: ScenarioResult[];
}

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function parseNumArg(name: string): number | undefined {
  const raw = getArg(name);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value for --${name}: ${raw}`);
  }
  return n;
}

function loadResults(path: string): ScenarioResult[] {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as EvalGymJson | ScenarioResult[];
  if (Array.isArray(parsed)) return parsed as ScenarioResult[];
  if (Array.isArray(parsed.results)) return parsed.results;
  throw new Error(`No results[] found in ${path}`);
}

const candidatePath = getArg("candidate");
if (!candidatePath) {
  console.error("ERROR: --candidate <eval-results.json> is required");
  process.exit(1);
}

const baselinePath = getArg("baseline") || process.env.SYNESIS_EVAL_BASELINE_JSON;
if (!baselinePath) {
  console.error("ERROR: --baseline <eval-results.json> or SYNESIS_EVAL_BASELINE_JSON is required");
  process.exit(1);
}

const allowSameBaseline = process.argv.includes("--allow-same-baseline");
if (!allowSameBaseline && resolve(candidatePath) === resolve(baselinePath)) {
  console.error("ERROR: Candidate and baseline paths resolve to the same file.");
  console.error("       Provide a distinct baseline artifact via --baseline or SYNESIS_EVAL_BASELINE_JSON.");
  process.exit(1);
}

const summaryOut = getArg("summary-out") ?? "eval-regression-budget-summary.json";
const candidate = loadResults(candidatePath);
const baseline = loadResults(baselinePath);

const baselineIds = new Set(baseline.map((row) => row.scenarioId));
const candidateIds = new Set(candidate.map((row) => row.scenarioId));
const missingFromCandidate = [...baselineIds].filter((id) => !candidateIds.has(id));
const extraInCandidate = [...candidateIds].filter((id) => !baselineIds.has(id));
if (missingFromCandidate.length > 0 || extraInCandidate.length > 0) {
  console.error("ERROR: Candidate/baseline scenario sets do not match.");
  if (missingFromCandidate.length > 0) {
    console.error(`       Missing in candidate (${missingFromCandidate.length}): ${missingFromCandidate.slice(0, 8).join(", ")}`);
  }
  if (extraInCandidate.length > 0) {
    console.error(`       Extra in candidate (${extraInCandidate.length}): ${extraInCandidate.slice(0, 8).join(", ")}`);
  }
  process.exit(1);
}

const evaluation = evaluateRegressionBudget({
  baseline,
  candidate,
  thresholds: {
    maxPassRateDrop: parseNumArg("max-pass-rate-drop"),
    maxScoreDrop: parseNumArg("max-score-drop"),
    maxInterventionRateIncrease: parseNumArg("max-intervention-rate-increase"),
    maxRepeatedCommandAnomalyRateIncrease: parseNumArg("max-repeated-command-rate-increase"),
    maxAvgTurnsIncrease: parseNumArg("max-turns-increase"),
  },
});

const summary = {
  ...evaluation,
  integrity: {
    candidatePath,
    baselinePath,
    samePathAllowed: allowSameBaseline,
    scenarioCount: candidateIds.size,
  },
};

writeFileSync(summaryOut, JSON.stringify(summary, null, 2), "utf8");

console.log("Regression budget summary:");
console.log(`- Baseline pass rate: ${evaluation.baseline.passRate}`);
console.log(`- Candidate pass rate: ${evaluation.candidate.passRate}`);
console.log(`- Baseline avg score: ${evaluation.baseline.avgScore}`);
console.log(`- Candidate avg score: ${evaluation.candidate.avgScore}`);
console.log(`- Baseline intervention rate: ${evaluation.baseline.interventionRate}`);
console.log(`- Candidate intervention rate: ${evaluation.candidate.interventionRate}`);
console.log(`- Baseline repeated-command anomaly rate: ${evaluation.baseline.repeatedCommandAnomalyRate}`);
console.log(`- Candidate repeated-command anomaly rate: ${evaluation.candidate.repeatedCommandAnomalyRate}`);
console.log(`- Baseline avg turns: ${evaluation.baseline.avgTurnsToResolution}`);
console.log(`- Candidate avg turns: ${evaluation.candidate.avgTurnsToResolution}`);
console.log(`- Summary written to ${summaryOut}`);

if (!evaluation.pass) {
  console.error("Regression budget violated:");
  for (const v of evaluation.violations) {
    console.error(`- ${v.metric}: baseline=${v.baseline} candidate=${v.candidate} delta=${v.delta} threshold=${v.threshold} (${v.direction})`);
  }
  process.exit(1);
}
