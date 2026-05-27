import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchHarnessTesterApiTraceSummary } from "./api-traces.js";
import { classifyHarnessTesterRun } from "./classifier.js";
import { buildCommandResult, runHarnessTesterCommand } from "./commands.js";
import { writeHarnessTesterReport } from "./report.js";
import { buildHarnessTesterScores } from "./scoring.js";
import {
  captureWorkspaceSnapshot,
  cleanupHarnessWorkspace,
  prepareHarnessWorkspace,
} from "./workspace.js";
import type {
  HarnessBehaviorSignal,
  HarnessTesterCommandResult,
  HarnessTesterReport,
  HarnessTesterRunOptions,
  HarnessTesterStatus,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000;

export async function runHarnessTesterTask(options: HarnessTesterRunOptions): Promise<HarnessTesterReport> {
  const runId = options.runId ?? randomUUID();
  const sessionKey = `harness-tester-${runId}`;
  const startedAtDate = new Date();
  const artifactsRoot = options.artifactsRoot ?? join(tmpdir(), "synesis-harness-tester-artifacts");
  const runArtifactDir = join(artifactsRoot, runId);
  await mkdir(runArtifactDir, { recursive: true });

  const workspace = await prepareHarnessWorkspace({
    task: options.task,
    runId,
    workRoot: options.workRoot ?? join(runArtifactDir, "workspaces"),
  });

  const setupResults = await runCommands(options.task.setup ?? [], workspace.workspacePath, options);
  const setupFailed = setupResults.some((result) => result.exitCode !== 0 || result.timedOut);
  const harnessResult = setupFailed
    ? buildCommandResult({
        command: "<skipped: setup failed>",
        cwd: workspace.workspacePath,
        exitCode: null,
        stderr: "Harness command skipped because setup failed.",
      })
    : await runHarnessCommand(options, runId, sessionKey, workspace.workspacePath, workspace.promptFilePath);
  const validationResults = setupFailed
    ? []
    : await runCommands(options.task.validate ?? [], workspace.workspacePath, options);
  const workspaceSnapshot = await captureWorkspaceSnapshot(workspace.workspacePath);
  await writeFile(join(runArtifactDir, "workspace.diff"), workspaceSnapshot.diff, "utf-8");
  await writeCommandLogs(runArtifactDir, "setup", setupResults);
  await writeCommandLogs(runArtifactDir, "harness", [harnessResult]);
  await writeCommandLogs(runArtifactDir, "validation", validationResults);

  const apiTrace = await fetchHarnessTesterApiTraceSummary({
    adminUrl: options.adminUrl ?? process.env.SYNESIS_EVAL_ADMIN_URL,
    adminToken: options.adminToken ?? process.env.SYNESIS_EVAL_ADMIN_TOKEN,
    sessionKey,
  });
  const behavioralFlags = classifyHarnessTesterRun({
    task: options.task,
    setupResults,
    harnessResult,
    validationResults,
    workspace: workspaceSnapshot,
    apiTrace,
  });
  const finishedAtDate = new Date();
  const durationSeconds = Number(((finishedAtDate.getTime() - startedAtDate.getTime()) / 1000).toFixed(3));
  const scores = buildHarnessTesterScores({
    setupResults,
    harnessResult,
    validationResults,
    behavioralFlags,
    durationSeconds,
    timeoutSeconds: options.task.timeout_seconds,
  });
  const report: HarnessTesterReport = {
    run_id: runId,
    task_id: options.task.id,
    task_name: options.task.name,
    benchmark: options.task.benchmark ?? "harness-task",
    harness_name: options.harness.name,
    model: options.model,
    api_endpoint: options.apiBaseUrl,
    started_at: startedAtDate.toISOString(),
    finished_at: finishedAtDate.toISOString(),
    duration_seconds: durationSeconds,
    status: determineStatus({ setupResults, harnessResult, validationResults, behavioralFlags }),
    setup_results: setupResults,
    harness_result: harnessResult,
    validation_results: validationResults,
    changed_files: workspaceSnapshot.changedFiles,
    diff_summary: workspaceSnapshot.diffSummary,
    native_scores: scores.native_scores,
    normalized_scores: scores.normalized_scores,
    behavioral_flags: behavioralFlags,
    api_trace_summary: apiTrace,
    harness_log_paths: [
      join(runArtifactDir, "harness-0.stdout.log"),
      join(runArtifactDir, "harness-0.stderr.log"),
    ],
    artifact_paths: [
      runArtifactDir,
      join(runArtifactDir, "workspace.diff"),
      workspace.workspacePath,
    ],
    final_notes: buildFinalNotes(behavioralFlags),
  };
  await writeHarnessTesterReport({ report, artifactsRoot });

  if (report.status === "pass" && options.keepSuccessfulArtifacts !== true) {
    await cleanupHarnessWorkspace(workspace.workspacePath);
  }
  return report;
}

async function runHarnessCommand(
  options: HarnessTesterRunOptions,
  runId: string,
  sessionKey: string,
  workspacePath: string,
  promptFilePath: string,
): Promise<HarnessTesterCommandResult> {
  const command = options.harness.buildCommand({
    task: options.task,
    runId,
    sessionKey,
    workspacePath,
    promptFilePath,
    model: options.model,
    apiBaseUrl: options.apiBaseUrl,
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    env: options.env,
  });
  if (options.dryRun === true) {
    return buildCommandResult({
      command: command.command,
      cwd: command.cwd,
      stdout: "dry-run: harness command not executed",
    });
  }
  return runHarnessTesterCommand(command);
}

async function runCommands(
  commands: string[],
  cwd: string,
  options: Pick<HarnessTesterRunOptions, "dryRun" | "env" | "task">,
): Promise<HarnessTesterCommandResult[]> {
  const results: HarnessTesterCommandResult[] = [];
  for (const command of commands) {
    if (options.dryRun === true) {
      results.push(buildCommandResult({ command, cwd, stdout: "dry-run: command not executed" }));
      continue;
    }
    results.push(await runHarnessTesterCommand({
      command,
      cwd,
      env: { ...options.task.env, ...options.env },
      timeoutMs: (options.task.timeout_seconds ?? 300) * 1000 || DEFAULT_TIMEOUT_MS,
    }));
  }
  return results;
}

async function writeCommandLogs(root: string, label: string, results: HarnessTesterCommandResult[]): Promise<void> {
  await Promise.all(results.map(async (result, index) => {
    await writeFile(join(root, `${label}-${index}.stdout.log`), result.stdout, "utf-8");
    await writeFile(join(root, `${label}-${index}.stderr.log`), result.stderr, "utf-8");
  }));
}

function determineStatus(params: {
  setupResults: HarnessTesterCommandResult[];
  harnessResult: HarnessTesterCommandResult;
  validationResults: HarnessTesterCommandResult[];
  behavioralFlags: HarnessBehaviorSignal[];
}): HarnessTesterStatus {
  if ([...params.setupResults, params.harnessResult, ...params.validationResults].some((result) => result.timedOut)) return "timeout";
  if (params.setupResults.some((result) => result.exitCode !== 0)) return "error";
  if (params.harnessResult.exitCode !== 0) return "error";
  if (params.validationResults.some((result) => result.exitCode !== 0)) return "fail";
  if (params.validationResults.length === 0) return "fail";
  if (params.behavioralFlags.some((signal) => signal.severity === "error")) return "fail";
  return "pass";
}

function buildFinalNotes(signals: HarnessBehaviorSignal[]): string[] {
  if (signals.length === 0) return ["Validation passed without behavioral flags."];
  return signals
    .filter((signal) => signal.severity !== "info")
    .map((signal) => `${signal.flag}: ${signal.detail}`);
}
