#!/usr/bin/env tsx
/**
 * Dual-Agent Loop — orchestrates the governor worker and monitor in a
 * feedback loop across N iterations.
 *
 * Each iteration:
 *   1. Worker runs Go-task scenarios (simulated or live) → session.json
 *   2. Monitor analyses the session → analysis.json
 *   3. Print analysis summary (and optionally write fixture files)
 *   4. Optionally feed threshold suggestions back as additional context
 *      for the next worker run (advisory only — thresholds are not auto-applied)
 *
 * The loop exits 0 if all iterations complete. It exits 1 if any worker
 * scenario failed (useful for CI gates).
 *
 * Env:
 *   SYNESIS_YARN_URL        required — Yarn base URL (worker target)
 *   SYNESIS_YARN_TOKEN      required — Bearer token for Yarn
 *   SYNESIS_ADMIN_URL       optional — Admin API for governor telemetry
 *   SYNESIS_ADMIN_TOKEN     optional — Admin bearer token
 *   SYNESIS_MONITOR_URL     optional — LLM URL for monitor (defaults to Yarn URL)
 *   SYNESIS_MONITOR_KEY     optional — LLM key for monitor (defaults to Yarn token)
 *   SYNESIS_MONITOR_MODEL   optional — model override for monitor
 *   SYNESIS_SANDBOX_URL     optional — Sandbox warm pool URL (live mode)
 *   SYNESIS_SANDBOX_SECRET  optional — Sandbox auth secret (live mode)
 *
 * Usage:
 *   npx tsx scripts/dual-agent-loop.ts \
 *     --iterations 3 \
 *     --mode live \
 *     --scenario go-cli-stall-loop \
 *     --out-dir /tmp/governor-loop \
 *     [--write-fixtures]
 *
 *   npx tsx scripts/dual-agent-loop.ts --iterations 1 --mode simulated --all
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Arg helpers
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
// Script paths
// ---------------------------------------------------------------------------

const SCRIPTS_DIR = dirname(new URL(import.meta.url).pathname);
const WORKER_SCRIPT = join(SCRIPTS_DIR, "governor-worker.ts");
const MONITOR_SCRIPT = join(SCRIPTS_DIR, "governor-monitor.ts");

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "." : path.slice(0, i);
}

// ---------------------------------------------------------------------------
// Subprocess helper — runs a tsx script synchronously and streams output
// ---------------------------------------------------------------------------

function runScript(script: string, args: string[], label: string): { exitCode: number } {
  console.log(`\n[loop] ${label}`);
  const result = spawnSync("npx", ["tsx", script, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) {
    console.log(`[loop] ${label} exited with code ${exitCode}`);
  }
  return { exitCode };
}

// ---------------------------------------------------------------------------
// Analysis summary
// ---------------------------------------------------------------------------

interface ThresholdSuggestion {
  threshold: string;
  current: number;
  suggested: number;
  reason: string;
}

interface LoopAnalysis {
  threshold_suggestions?: ThresholdSuggestion[];
  misfires?: unknown[];
  missing_fires?: unknown[];
  new_rule_ideas?: unknown[];
  new_test_fixtures?: unknown[];
}

function printAnalysisSummary(analysisPath: string, iteration: number) {
  if (!existsSync(analysisPath)) {
    console.log(`[loop] No analysis file at ${analysisPath}`);
    return;
  }
  try {
    const analysis = JSON.parse(readFileSync(analysisPath, "utf-8")) as LoopAnalysis;
    console.log(`\n[loop] Iteration ${iteration} analysis summary:`);
    console.log(`  misfires:              ${analysis.misfires?.length ?? 0}`);
    console.log(`  missing_fires:         ${analysis.missing_fires?.length ?? 0}`);
    console.log(`  threshold_suggestions: ${analysis.threshold_suggestions?.length ?? 0}`);
    console.log(`  new_rule_ideas:        ${analysis.new_rule_ideas?.length ?? 0}`);
    console.log(`  new_test_fixtures:     ${analysis.new_test_fixtures?.length ?? 0}`);

    if (analysis.threshold_suggestions?.length) {
      console.log("\n  Suggested threshold changes (advisory — not auto-applied):");
      for (const s of analysis.threshold_suggestions) {
        console.log(`    ${s.threshold}: ${s.current} → ${s.suggested}  (${s.reason})`);
      }
    }
  } catch {
    console.log(`[loop] Could not parse analysis at ${analysisPath}`);
  }
}

// ---------------------------------------------------------------------------
// Aggregate report
// ---------------------------------------------------------------------------

interface IterationRecord {
  iteration: number;
  mode: string;
  sessionPath: string;
  analysisPath: string;
  workerExitCode: number;
  monitorExitCode: number;
}

function writeAggregateReport(outDir: string, records: IterationRecord[]) {
  const path = join(outDir, "loop-report.json");
  const report = {
    timestamp: new Date().toISOString(),
    totalIterations: records.length,
    workerFailures: records.filter(r => r.workerExitCode !== 0).length,
    monitorFailures: records.filter(r => r.monitorExitCode !== 0).length,
    iterations: records,
  };
  writeFileSync(path, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\n[loop] Aggregate report: ${path}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const iterations = Number(getArg("iterations") ?? "1");
  const mode = getArg("mode") ?? "simulated";
  const outDir = getArg("out-dir") ?? `/tmp/governor-loop-${Date.now()}`;
  const writeFixtures = hasFlag("write-fixtures");
  const scenarioArg = getArg("scenario");
  const runAll = hasFlag("all");

  if (!scenarioArg && !runAll) {
    console.error(
      "ERROR: Specify --scenario <id> or --all\n" +
        "  Example: npx tsx scripts/dual-agent-loop.ts --iterations 2 --all --mode simulated",
    );
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  console.log(`\nDual-Agent Loop`);
  console.log(`  Mode:       ${mode}`);
  console.log(`  Iterations: ${iterations}`);
  console.log(`  Out dir:    ${outDir}`);

  const records: IterationRecord[] = [];
  let anyWorkerFailed = false;

  for (let i = 1; i <= iterations; i++) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Iteration ${i} / ${iterations}`);
    console.log("=".repeat(60));

    const iterDir = join(outDir, `iter-${i}`);
    mkdirSync(iterDir, { recursive: true });

    const sessionPath = join(iterDir, "session.json");
    const analysisPath = join(iterDir, "analysis.json");

    // ---- Worker ----
    const workerArgs: string[] = [
      "--mode", mode,
      "--out", sessionPath,
    ];
    if (scenarioArg) workerArgs.push("--scenario", scenarioArg);
    if (runAll) workerArgs.push("--all");

    const { exitCode: workerExit } = runScript(
      WORKER_SCRIPT,
      workerArgs,
      `Worker (iter ${i})`,
    );
    if (workerExit !== 0) anyWorkerFailed = true;

    // ---- Monitor ----
    const monitorArgs: string[] = [
      "--session", sessionPath,
      "--out", analysisPath,
    ];
    if (writeFixtures) monitorArgs.push("--write-fixtures");

    const { exitCode: monitorExit } = runScript(
      MONITOR_SCRIPT,
      monitorArgs,
      `Monitor (iter ${i})`,
    );

    records.push({
      iteration: i,
      mode,
      sessionPath,
      analysisPath,
      workerExitCode: workerExit,
      monitorExitCode: monitorExit,
    });

    printAnalysisSummary(analysisPath, i);
  }

  writeAggregateReport(outDir, records);

  const workerFails = records.filter(r => r.workerExitCode !== 0).length;
  console.log(`\n[loop] Done. ${workerFails}/${iterations} iteration(s) had worker failures.`);

  process.exit(anyWorkerFailed ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
