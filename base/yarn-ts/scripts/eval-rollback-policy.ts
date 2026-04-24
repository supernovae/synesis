#!/usr/bin/env tsx
/**
 * Apply canary rollback policy over scorecard history.
 *
 * The policy recommends holding rollout when red-line KPI breaches
 * persist for N consecutive runs.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  applyRollbackPolicy,
  renderHarnessScorecardMarkdown,
  type HarnessScorecard,
  type HarnessScorecardHistoryEntry,
} from "../src/eval/harness-scorecard.js";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function parseThreshold(raw: string | undefined): number {
  const fallback = 2;
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const scorecardPath = getArg("scorecard") ?? "harness-scorecard.json";
const historyInPath = getArg("history-in") ?? "harness-scorecard-history.json";
const historyOutPath = getArg("history-out") ?? historyInPath;
const decisionOutPath = getArg("decision-out") ?? "harness-rollback-decision.json";
const markdownOutPath = getArg("markdown-out");
const threshold = parseThreshold(
  getArg("breach-threshold") ?? process.env.SYNESIS_HARNESS_ROLLBACK_CONSECUTIVE_BREACHES,
);
const maxHistory = parseThreshold(getArg("max-history") ?? "90");
const enforce = process.argv.includes("--enforce");

const scorecard = JSON.parse(readFileSync(scorecardPath, "utf8")) as HarnessScorecard;
const history = existsSync(historyInPath)
  ? (JSON.parse(readFileSync(historyInPath, "utf8")) as HarnessScorecardHistoryEntry[])
  : [];

const { decision, updatedHistory } = applyRollbackPolicy({
  scorecard,
  history,
  breachThreshold: threshold,
  maxHistory,
});

writeFileSync(historyOutPath, JSON.stringify(updatedHistory, null, 2), "utf8");
writeFileSync(decisionOutPath, JSON.stringify(decision, null, 2), "utf8");
if (markdownOutPath) {
  writeFileSync(markdownOutPath, renderHarnessScorecardMarkdown(scorecard, decision), "utf8");
}

console.log("Rollback policy decision:");
console.log(`- action: ${decision.action}`);
console.log(`- hold_rollout: ${decision.hold_rollout}`);
console.log(`- consecutive red-line breaches: ${decision.consecutive_redline_breaches}`);
console.log(`- threshold: ${decision.threshold}`);
console.log(`- reason: ${decision.reason}`);
console.log(`- history out: ${historyOutPath}`);
console.log(`- decision out: ${decisionOutPath}`);

if (decision.hold_rollout && enforce) {
  console.error("Rollback policy triggered hold_rollout in enforce mode.");
  process.exit(1);
}
