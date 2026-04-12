#!/usr/bin/env tsx
/**
 * Eval Gym CLI — run multi-turn eval scenarios against any
 * OpenAI-compatible endpoint, score results, and export training data.
 *
 * Env:
 *   SYNESIS_EVAL_TARGET_URL   required — base URL (e.g. http://yarn:8000 or https://openrouter.ai/api/v1)
 *   SYNESIS_EVAL_TARGET_KEY   required — Bearer token / API key
 *   SYNESIS_EVAL_ADMIN_URL    optional — Admin API for governor telemetry (Yarn-only)
 *   SYNESIS_EVAL_ADMIN_TOKEN  optional — Admin bearer token
 *   SYNESIS_EVAL_MODEL        optional — override model for all scenarios
 *   SYNESIS_EVAL_TIMEOUT_MS   optional — per-turn timeout (default 120000)
 *
 * Usage:
 *   npx tsx scripts/eval-gym.ts --category governor_regression
 *   npx tsx scripts/eval-gym.ts --scenario plan-load-exploration-drift
 *   npx tsx scripts/eval-gym.ts --list
 *   npx tsx scripts/eval-gym.ts --category e2e_build --model qwen/qwen3-coder
 *   npx tsx scripts/eval-gym.ts --category governor_regression --export sft --out training.jsonl
 *   npx tsx scripts/eval-gym.ts --all --json --out results.json
 */

import { runScenarios } from "../src/eval/scenario-runner.js";
import { ALL_SCENARIOS, getScenariosByCategory, getScenarioById, listScenarios } from "../src/eval/scenarios/index.js";
import { materialize, toJsonl, scenarioResultToTrajectoryRow } from "../src/eval/training-materializer.js";
import type { EvalCategory, EvalRunnerConfig, ScenarioResult, TrainingFormat } from "../src/eval/types.js";
import { writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Arg parsing (minimal, no deps)
// ---------------------------------------------------------------------------

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

const TARGET_URL = (process.env.SYNESIS_EVAL_TARGET_URL ?? "").replace(/\/+$/, "");
const API_KEY = (
  process.env.SYNESIS_EVAL_TARGET_KEY ??
  process.env.SYNESIS_TEST_PAT_TOKEN ??
  process.env.SYNESIS_TEST_AUTH ??
  ""
).trim();

const config: EvalRunnerConfig = {
  targetUrl: TARGET_URL,
  apiKey: API_KEY,
  model: process.env.SYNESIS_EVAL_MODEL ?? getArg("model"),
  adminUrl: process.env.SYNESIS_EVAL_ADMIN_URL,
  adminToken: process.env.SYNESIS_EVAL_ADMIN_TOKEN,
  timeoutMs: Number(process.env.SYNESIS_EVAL_TIMEOUT_MS ?? 120_000),
  conversationIdPrefix: "eval-gym",
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --list: print available scenarios
  if (hasFlag("list")) {
    const scenarios = listScenarios();
    console.log("\nAvailable scenarios:\n");
    console.log("  ID                                  Category              Name");
    console.log("  " + "-".repeat(80));
    for (const s of scenarios) {
      console.log(`  ${s.id.padEnd(38)}${s.category.padEnd(22)}${s.name}`);
    }
    console.log(`\n  Total: ${scenarios.length} scenarios\n`);
    return;
  }

  // Validate config
  if (!TARGET_URL) {
    console.error("ERROR: SYNESIS_EVAL_TARGET_URL is required");
    console.error("  Example: SYNESIS_EVAL_TARGET_URL=http://yarn:8000");
    process.exit(1);
  }
  if (!API_KEY) {
    console.error("ERROR: SYNESIS_EVAL_TARGET_KEY or SYNESIS_TEST_PAT_TOKEN is required");
    process.exit(1);
  }

  // Select scenarios
  const categoryArg = getArg("category") as EvalCategory | undefined;
  const scenarioArg = getArg("scenario");
  const runAll = hasFlag("all");

  let selectedScenarios = ALL_SCENARIOS;

  if (scenarioArg) {
    const s = getScenarioById(scenarioArg);
    if (!s) {
      console.error(`ERROR: Unknown scenario '${scenarioArg}'`);
      console.error("  Use --list to see available scenarios");
      process.exit(1);
    }
    selectedScenarios = [s];
  } else if (categoryArg) {
    selectedScenarios = getScenariosByCategory(categoryArg);
    if (selectedScenarios.length === 0) {
      console.error(`ERROR: No scenarios for category '${categoryArg}'`);
      process.exit(1);
    }
  } else if (!runAll) {
    console.error("ERROR: Specify --category, --scenario, --all, or --list");
    console.error("\n  Examples:");
    console.error("    npx tsx scripts/eval-gym.ts --list");
    console.error("    npx tsx scripts/eval-gym.ts --category governor_regression");
    console.error("    npx tsx scripts/eval-gym.ts --scenario plan-load-exploration-drift");
    console.error("    npx tsx scripts/eval-gym.ts --all");
    process.exit(1);
  }

  // Run
  console.log(`\nEval Gym — targeting ${TARGET_URL}`);
  console.log(`Running ${selectedScenarios.length} scenario(s)...\n`);

  const results = await runScenarios(config, selectedScenarios);

  // Print results
  const verbose = hasFlag("verbose");
  printResults(results, verbose);

  // Export training data
  const exportFormat = getArg("export") as TrainingFormat | undefined;
  if (exportFormat) {
    const outPath = getArg("out") ?? `eval-${exportFormat}-${Date.now()}.jsonl`;
    const examples = materialize(results, exportFormat);
    writeFileSync(outPath, toJsonl(examples), "utf-8");
    console.log(`\nExported ${examples.length} ${exportFormat.toUpperCase()} examples to ${outPath}`);
  }

  // JSON output
  if (hasFlag("json")) {
    const outPath = getArg("out") ?? `eval-results-${Date.now()}.json`;
    const output = {
      summary: {
        total: results.length,
        passed: results.filter(r => r.passed).length,
        failed: results.filter(r => !r.passed).length,
        avgScore: Number((results.reduce((s, r) => s + r.score, 0) / results.length).toFixed(3)),
        totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
      },
      results,
      trajectoryRows: results.map(scenarioResultToTrajectoryRow),
    };
    writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
    console.log(`\nFull results written to ${outPath}`);
  }

  // Exit code
  const failed = results.filter(r => !r.passed).length;
  if (failed > 0) {
    console.log(`\n${failed} scenario(s) FAILED`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printResults(results: ScenarioResult[], verbose: boolean) {
  const COL = { id: 38, status: 8, score: 7, turns: 7, anomalies: 10, time: 10 };

  console.log(
    "  " +
    "Scenario".padEnd(COL.id) +
    "Status".padEnd(COL.status) +
    "Score".padEnd(COL.score) +
    "Turns".padEnd(COL.turns) +
    "Anomalies".padEnd(COL.anomalies) +
    "Time".padEnd(COL.time),
  );
  console.log("  " + "-".repeat(COL.id + COL.status + COL.score + COL.turns + COL.anomalies + COL.time));

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    console.log(
      "  " +
      r.scenarioId.padEnd(COL.id) +
      status.padEnd(COL.status) +
      r.score.toFixed(2).padEnd(COL.score) +
      String(r.totalTurns).padEnd(COL.turns) +
      String(r.totalAnomalies).padEnd(COL.anomalies) +
      `${r.durationMs}ms`.padEnd(COL.time),
    );

    if (verbose || !r.passed) {
      for (const reason of r.failureReasons) {
        console.log(`    FAIL: ${reason}`);
      }
      for (const turn of r.turnResults) {
        for (const a of turn.anomalies.filter(a => a.severity === "error")) {
          console.log(`    ANOMALY: ${a.detail}`);
        }
      }
    }
  }

  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const avgScore = results.reduce((s, r) => s + r.score, 0) / total;
  const totalTime = results.reduce((s, r) => s + r.durationMs, 0);
  console.log(`\n  ${passed}/${total} passed | avg score: ${avgScore.toFixed(3)} | total time: ${totalTime}ms\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
