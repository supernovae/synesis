#!/usr/bin/env tsx
/**
 * Harness Tester CLI — runs developer harnesses against Synesis' OpenAI-compatible API
 * in isolated workspaces with deterministic validation and behavioral reports.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createHarnessAdapter,
  loadHarnessBenchmarkTask,
  loadHarnessTesterSuite,
  loadHarnessTesterTask,
  readHarnessTesterReport,
  renderHarnessTesterSummaryTable,
  runHarnessTesterTask,
} from "../src/eval/harness-tester/index.js";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "run") {
    await runSingleTask();
    return;
  }
  if (command === "run-suite") {
    await runSuite();
    return;
  }
  if (command === "run-benchmark") {
    await runBenchmark();
    return;
  }
  if (command === "report") {
    await showReport();
    return;
  }
  usage(1);
}

async function runSingleTask(): Promise<void> {
  const taskPath = requiredArg("task");
  const report = await runLoadedTask(taskPath);
  console.log(renderHarnessTesterSummaryTable([report]));
  maybeWriteJson([report]);
  if (!hasFlag("allow-failures") && report.status !== "pass") process.exit(1);
}

async function runSuite(): Promise<void> {
  const suite = await loadHarnessTesterSuite(requiredArg("suite"));
  const reports = [];
  for (const taskPath of suite.tasks) {
    reports.push(await runLoadedTask(taskPath));
  }
  console.log(renderHarnessTesterSummaryTable(reports));
  maybeWriteJson(reports);
  if (!hasFlag("allow-failures") && reports.some((report) => report.status !== "pass")) process.exit(1);
}

async function runBenchmark(): Promise<void> {
  const taskPath = requiredArg("task");
  const report = await runLoadedTask(taskPath, { benchmark: true });
  console.log(renderHarnessTesterSummaryTable([report]));
  maybeWriteJson([report]);
  if (!hasFlag("allow-failures") && report.status !== "pass") process.exit(1);
}

async function showReport(): Promise<void> {
  const reportPath = getArg("report");
  const runId = getArg("run-id");
  const artifactsRoot = getArg("artifacts-root") ?? "harness-tester-artifacts";
  const path = reportPath ?? (runId ? join(artifactsRoot, runId, "report.json") : undefined);
  if (!path) {
    console.error("ERROR: report requires --report <path> or --run-id <id>");
    usage(1);
  }
  if (!existsSync(path)) {
    console.error(`ERROR: report not found: ${path}`);
    process.exit(1);
  }
  const report = await readHarnessTesterReport(path);
  console.log(renderHarnessTesterSummaryTable([report]));
}

async function runLoadedTask(taskPath: string, options: { benchmark?: boolean } = {}) {
  const task = options.benchmark ? await loadHarnessBenchmarkTask(taskPath) : await loadHarnessTesterTask(taskPath);
  return runHarnessTesterTask({
    task,
    harness: createHarnessAdapter(getArg("harness") ?? "opencode", {
      command: getArg("harness-command"),
      args: getArg("harness-args")?.split(" "),
    }),
    model: getArg("model") ?? process.env.SYNESIS_HARNESS_TESTER_MODEL ?? "qwen3-coder",
    apiBaseUrl: getArg("api-base-url") ?? process.env.OPENAI_BASE_URL ?? "http://localhost:8000/v1",
    apiKey: getArg("api-key") ?? process.env.OPENAI_API_KEY,
    artifactsRoot: getArg("artifacts-root") ?? "harness-tester-artifacts",
    workRoot: getArg("work-root"),
    keepSuccessfulArtifacts: hasFlag("keep-artifacts"),
    dryRun: hasFlag("dry-run"),
    adminUrl: getArg("admin-url") ?? process.env.SYNESIS_EVAL_ADMIN_URL,
    adminToken: getArg("admin-token") ?? process.env.SYNESIS_EVAL_ADMIN_TOKEN,
  });
}

function maybeWriteJson(reports: unknown[]): void {
  const out = getArg("out");
  if (!out) return;
  writeFileSync(out, `${JSON.stringify(reports, null, 2)}\n`, "utf-8");
  console.log(`Harness tester JSON written to ${out}`);
}

function requiredArg(name: string): string {
  const value = getArg(name);
  if (!value) {
    console.error(`ERROR: --${name} is required`);
    usage(1);
  }
  return value;
}

function usage(exitCode: number): never {
  console.error([
    "Usage:",
    "  npm run harness:tester -- run --task <task.json> --harness opencode --model <model> --api-base-url <url>",
    "  npm run harness:tester -- run-suite --suite <suite.json> --harness opencode --model <model>",
    "  npm run harness:tester -- run-benchmark --task <benchmark-task.json> --harness opencode --model <model>",
    "  npm run harness:tester -- report --run-id <run_id> --artifacts-root <dir>",
  ].join("\n"));
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
