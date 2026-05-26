import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

export interface HarnessLabSpec {
  schemaVersion?: "harness_lab_v1";
  name: string;
  description?: string;
  client: HarnessLabClientSpec;
  defaults?: HarnessLabDefaults;
  cases: HarnessLabCaseSpec[];
}

export interface HarnessLabClientSpec {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HarnessLabDefaults {
  timeoutMs?: number;
  workRoot?: string;
  cleanup?: boolean;
  adminUrl?: string;
  adminToken?: string;
}

export interface HarnessLabCaseSpec {
  id: string;
  prompt: string;
  tags?: string[];
  model?: string;
  sessionKey?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  workspace?: {
    files?: Record<string, string>;
  };
  expected?: {
    allowGovernorPause?: boolean;
    requiredSignals?: HarnessLabRiskKind[];
    forbiddenSignals?: HarnessLabRiskKind[];
  };
}

export interface HarnessLabRunOptions {
  dryRun?: boolean;
}

export interface HarnessLabRunResult {
  specName: string;
  clientId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  cases: HarnessLabCaseResult[];
  summary: HarnessLabSummary;
}

export interface HarnessLabCaseResult {
  caseId: string;
  tags: string[];
  workspacePath: string;
  command: HarnessLabRenderedCommand;
  dryRun: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  sessionEvents?: unknown;
  riskReport: HarnessLabRiskReport;
  fixtureDraft: HarnessLabFixtureDraft;
}

export interface HarnessLabRenderedCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export type HarnessLabRiskKind =
  | "governor_pause"
  | "hard_stop"
  | "invalid_tool_arguments"
  | "unsafe_shell_block"
  | "path_confusion"
  | "verification_churn"
  | "discovery_churn"
  | "dependency_install_replay"
  | "identical_tool_repeat"
  | "task_reset"
  | "no_completion_signal"
  | "forbidden_expected_signal"
  | "missing_required_signal";

export interface HarnessLabRiskSignal {
  kind: HarnessLabRiskKind;
  severity: "info" | "warning" | "error";
  detail: string;
}

export interface HarnessLabRiskReport {
  passed: boolean;
  score: number;
  signals: HarnessLabRiskSignal[];
  recommendedNextAction: string;
}

export interface HarnessLabFixtureDraft {
  name: string;
  description: string;
  tags: string[];
  expected: {
    pauseAllowed: boolean;
    forbiddenSignals: HarnessLabRiskKind[];
    requiredSignals: HarnessLabRiskKind[];
  };
  transcriptExcerpt: string;
}

export interface HarnessLabSummary {
  total: number;
  passed: number;
  failed: number;
  avgScore: number;
  signalCounts: Record<string, number>;
}

interface ProcessRunResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const MAX_CAPTURED_OUTPUT_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 180_000;

export async function runHarnessLab(spec: HarnessLabSpec, options: HarnessLabRunOptions = {}): Promise<HarnessLabRunResult> {
  const startedAtDate = new Date();
  const caseResults: HarnessLabCaseResult[] = [];

  for (const testCase of spec.cases) {
    caseResults.push(await runHarnessLabCase(spec, testCase, options));
  }

  const completedAtDate = new Date();
  return {
    specName: spec.name,
    clientId: spec.client.id,
    startedAt: startedAtDate.toISOString(),
    completedAt: completedAtDate.toISOString(),
    durationMs: completedAtDate.getTime() - startedAtDate.getTime(),
    cases: caseResults,
    summary: summarizeHarnessLab(caseResults),
  };
}

export async function runHarnessLabCase(
  spec: HarnessLabSpec,
  testCase: HarnessLabCaseSpec,
  options: HarnessLabRunOptions = {},
): Promise<HarnessLabCaseResult> {
  const caseStartedAt = Date.now();
  const workspacePath = await createWorkspace(spec, testCase);
  const promptFilePath = join(workspacePath, ".synesis-harness-lab", "prompt.txt");
  await writeWorkspaceFile(promptFilePath, testCase.prompt);

  for (const [path, content] of Object.entries(testCase.workspace?.files ?? {})) {
    await writeWorkspaceFile(join(workspacePath, path), content);
  }

  const command = renderCommand(spec, testCase, workspacePath, promptFilePath);
  const runResult = options.dryRun
    ? {
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }
    : await runProcess(command, testCase.timeoutMs ?? spec.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const sessionEvents = await fetchSessionEvents(spec, testCase);
  const riskReport = scoreHarnessLabRun({
    stdout: runResult.stdout,
    stderr: runResult.stderr,
    exitCode: runResult.exitCode,
    timedOut: runResult.timedOut,
    expected: testCase.expected,
  });
  const fixtureDraft = buildHarnessLabFixtureDraft(testCase, runResult, riskReport);

  if (spec.defaults?.cleanup !== false && !options.dryRun) {
    await rm(workspacePath, { recursive: true, force: true });
  }

  return {
    caseId: testCase.id,
    tags: testCase.tags ?? [],
    workspacePath,
    command,
    dryRun: options.dryRun === true,
    exitCode: runResult.exitCode,
    timedOut: runResult.timedOut,
    stdout: runResult.stdout,
    stderr: runResult.stderr,
    durationMs: Date.now() - caseStartedAt,
    sessionEvents,
    riskReport,
    fixtureDraft,
  };
}

export function renderCommand(
  spec: HarnessLabSpec,
  testCase: HarnessLabCaseSpec,
  workspacePath: string,
  promptFilePath: string,
): HarnessLabRenderedCommand {
  const substitutions: Record<string, string> = {
    caseId: testCase.id,
    model: testCase.model ?? "",
    prompt: testCase.prompt,
    promptFile: promptFilePath,
    sessionKey: testCase.sessionKey ?? "",
    workspace: workspacePath,
  };
  const cwd = interpolate(spec.client.cwd ?? "{workspace}", substitutions);
  const args = (spec.client.args ?? []).map((arg) => interpolate(arg, substitutions));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...spec.client.env, ...testCase.env })) {
    env[key] = interpolate(value, substitutions);
  }
  return {
    command: spec.client.command,
    args,
    cwd,
    env,
  };
}

export function scoreHarnessLabRun(input: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  expected?: HarnessLabCaseSpec["expected"];
}): HarnessLabRiskReport {
  const combined = `${input.stdout}\n${input.stderr}`;
  const signals: HarnessLabRiskSignal[] = [];

  addSignalIf(signals, /GOVERNOR PAUSE/i.test(combined), "governor_pause", "warning", "Governor paused the harness run.");
  addSignalIf(signals, /governor:hard_stop|hard stop/i.test(combined), "hard_stop", "error", "Governor hard-stop signal detected.");
  addSignalIf(
    signals,
    /invalid arguments|SchemaError|missing key|Expected array/i.test(combined),
    "invalid_tool_arguments",
    "error",
    "Tool-call schema validation failed.",
  );
  addSignalIf(
    signals,
    /unsafe_shell|blocked unsafe shell command|rm -rf is disallowed/i.test(combined),
    "unsafe_shell_block",
    "warning",
    "Unsafe shell policy blocked a command.",
  );
  addSignalIf(
    signals,
    hasPathConfusionSignal(combined),
    "path_confusion",
    "error",
    "Output suggests cwd/project-root path duplication or repeated missing-path reads.",
  );
  addSignalIf(
    signals,
    /verification_churn_no_edit|Many verification or build steps in a row/i.test(combined),
    "verification_churn",
    "warning",
    "Verification churn guard fired.",
  );
  addSignalIf(
    signals,
    /discovery_churn_nudge|exploration_stall_no_edit|no_progress_loop/i.test(combined),
    "discovery_churn",
    "warning",
    "Discovery churn guard fired.",
  );
  addSignalIf(
    signals,
    /dependency_install_replay/i.test(combined),
    "dependency_install_replay",
    "warning",
    "Dependency-install replay guard fired.",
  );
  addSignalIf(
    signals,
    /identical_tool_repeat|exact same tool with identical arguments/i.test(combined),
    "identical_tool_repeat",
    "warning",
    "Identical tool-call repeat detected.",
  );
  addSignalIf(
    signals,
    hasTaskResetSignal(combined),
    "task_reset",
    "warning",
    "Todo/task state appears to reset after progress.",
  );
  addSignalIf(
    signals,
    input.exitCode !== 0 && !/tests? pass|passed|complete|completed/i.test(combined),
    "no_completion_signal",
    "warning",
    "Run exited without a clear completion signal.",
  );
  addSignalIf(signals, input.timedOut === true, "no_completion_signal", "error", "Harness command timed out.");

  for (const required of input.expected?.requiredSignals ?? []) {
    addSignalIf(
      signals,
      !signals.some((signal) => signal.kind === required),
      "missing_required_signal",
      "error",
      `Expected signal did not occur: ${required}`,
    );
  }
  for (const forbidden of input.expected?.forbiddenSignals ?? []) {
    addSignalIf(
      signals,
      signals.some((signal) => signal.kind === forbidden),
      "forbidden_expected_signal",
      "error",
      `Forbidden signal occurred: ${forbidden}`,
    );
  }

  const pauseSignal = signals.some((signal) => signal.kind === "governor_pause");
  if (pauseSignal && input.expected?.allowGovernorPause === false) {
    signals.push({
      kind: "forbidden_expected_signal",
      severity: "error",
      detail: "Governor pause occurred in a case that expected uninterrupted forward momentum.",
    });
  }

  const score = computeRiskScore(signals);
  return {
    passed: signals.every((signal) => signal.severity !== "error"),
    score,
    signals,
    recommendedNextAction: recommendNextAction(signals),
  };
}

export function buildHarnessLabFixtureDraft(
  testCase: HarnessLabCaseSpec,
  runResult: Pick<ProcessRunResult, "stdout" | "stderr">,
  riskReport: HarnessLabRiskReport,
): HarnessLabFixtureDraft {
  const transcriptExcerpt = truncateMiddle(`${runResult.stdout}\n${runResult.stderr}`.trim(), 6_000);
  return {
    name: `harness-lab-${testCase.id}`,
    description: `Candidate governor replay fixture from harness lab case '${testCase.id}'.`,
    tags: ["harness_lab", ...(testCase.tags ?? [])],
    expected: {
      pauseAllowed: testCase.expected?.allowGovernorPause ?? !riskReport.signals.some((signal) => signal.kind === "governor_pause"),
      forbiddenSignals: testCase.expected?.forbiddenSignals ?? [],
      requiredSignals: testCase.expected?.requiredSignals ?? [],
    },
    transcriptExcerpt,
  };
}

export function renderHarnessLabMarkdown(result: HarnessLabRunResult): string {
  const lines = [
    `# Harness Lab: ${result.specName}`,
    "",
    `Client: ${result.clientId}`,
    `Cases: ${result.summary.total}`,
    `Passed: ${result.summary.passed}`,
    `Failed: ${result.summary.failed}`,
    `Average score: ${result.summary.avgScore.toFixed(3)}`,
    "",
    "## Signal Counts",
    "",
  ];
  const signalEntries = Object.entries(result.summary.signalCounts).sort(([a], [b]) => a.localeCompare(b));
  if (signalEntries.length === 0) {
    lines.push("- none");
  } else {
    for (const [signal, count] of signalEntries) {
      lines.push(`- ${signal}: ${count}`);
    }
  }
  lines.push("", "## Cases", "");
  for (const testCase of result.cases) {
    lines.push(`### ${testCase.caseId}`, "");
    lines.push(`Score: ${testCase.riskReport.score.toFixed(3)}`);
    lines.push(`Status: ${testCase.riskReport.passed ? "passed" : "failed"}`);
    lines.push(`Recommendation: ${testCase.riskReport.recommendedNextAction}`);
    if (testCase.riskReport.signals.length > 0) {
      lines.push("", "Signals:");
      for (const signal of testCase.riskReport.signals) {
        lines.push(`- ${signal.severity} ${signal.kind}: ${signal.detail}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function summarizeHarnessLab(results: HarnessLabCaseResult[]): HarnessLabSummary {
  const signalCounts: Record<string, number> = {};
  for (const result of results) {
    for (const signal of result.riskReport.signals) {
      signalCounts[signal.kind] = (signalCounts[signal.kind] ?? 0) + 1;
    }
  }
  const total = results.length;
  const passed = results.filter((result) => result.riskReport.passed).length;
  const scoreSum = results.reduce((sum, result) => sum + result.riskReport.score, 0);
  return {
    total,
    passed,
    failed: total - passed,
    avgScore: total === 0 ? 0 : Number((scoreSum / total).toFixed(3)),
    signalCounts,
  };
}

async function createWorkspace(spec: HarnessLabSpec, testCase: HarnessLabCaseSpec): Promise<string> {
  const workRoot = spec.defaults?.workRoot ?? join(tmpdir(), "synesis-harness-lab");
  await mkdir(workRoot, { recursive: true });
  return mkdtemp(join(workRoot, `${sanitizeSegment(testCase.id)}-`));
}

async function writeWorkspaceFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

async function runProcess(command: HarnessLabRenderedCommand, timeoutMs: number): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode: null,
        timedOut,
        stdout,
        stderr: appendBounded(stderr, error.message),
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function fetchSessionEvents(spec: HarnessLabSpec, testCase: HarnessLabCaseSpec): Promise<unknown | undefined> {
  const adminUrl = spec.defaults?.adminUrl;
  const adminToken = spec.defaults?.adminToken;
  if (!adminUrl || !adminToken || !testCase.sessionKey) return undefined;
  try {
    const url = new URL("/api/v1/yarn/session-events", adminUrl);
    url.searchParams.set("session_key", testCase.sessionKey);
    url.searchParams.set("limit", "100");
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    if (!response.ok) {
      return {
        status: "unavailable",
        detail: `${response.status} ${response.statusText}`,
      };
    }
    return response.json();
  } catch (error) {
    return {
      status: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadPrompt(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

export async function loadHarnessLabSpec(path: string): Promise<HarnessLabSpec> {
  const content = await loadPrompt(path);
  return JSON.parse(content) as HarnessLabSpec;
}

function interpolate(value: string, substitutions: Record<string, string>): string {
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => substitutions[key] ?? match);
}

function addSignalIf(
  signals: HarnessLabRiskSignal[],
  condition: boolean,
  kind: HarnessLabRiskKind,
  severity: HarnessLabRiskSignal["severity"],
  detail: string,
): void {
  if (condition) {
    signals.push({ kind, severity, detail });
  }
}

function hasPathConfusionSignal(output: string): boolean {
  return (
    /\/src\/test\/src\/test\//.test(output) ||
    /File not found: .*\/([^/\s]+\/){2,}.*\1/.test(output) ||
    /path duplication|duplicate path/i.test(output)
  );
}

function hasTaskResetSignal(output: string): boolean {
  const todoBlocks = output.match(/# Todos[\s\S]{0,1200}/g) ?? [];
  if (todoBlocks.length < 2) return false;
  const sawCompleted = todoBlocks.some((block) => /\[[x✓]\]/i.test(block));
  const laterPendingReset = todoBlocks.slice(1).some((block) => /\[ \].*\n\[ \]/.test(block) && !/\[[x✓]\]/i.test(block));
  return sawCompleted && laterPendingReset;
}

function computeRiskScore(signals: HarnessLabRiskSignal[]): number {
  const penalty = signals.reduce((sum, signal) => {
    if (signal.severity === "error") return sum + 0.3;
    if (signal.severity === "warning") return sum + 0.15;
    return sum + 0.05;
  }, 0);
  return Number(Math.max(0, 1 - penalty).toFixed(3));
}

function recommendNextAction(signals: HarnessLabRiskSignal[]): string {
  if (signals.some((signal) => signal.kind === "path_confusion")) {
    return "Preserve discovered workspace root and add path-stability replay coverage.";
  }
  if (signals.some((signal) => signal.kind === "invalid_tool_arguments")) {
    return "Capture the malformed tool call and add schema-repair or model-adapter coverage.";
  }
  if (signals.some((signal) => signal.kind === "verification_churn" || signal.kind === "discovery_churn")) {
    return "Promote the transcript into governor replay fixtures and tune forward-momentum boundaries.";
  }
  if (signals.some((signal) => signal.kind === "task_reset")) {
    return "Add task-ledger continuity checks and model-family task update guidance.";
  }
  if (signals.length === 0) {
    return "No action required; consider adding this as a happy-path regression baseline.";
  }
  return "Inspect the transcript excerpt and promote the smallest reproducible sequence to a replay fixture.";
}

function appendBounded(existing: string, chunk: string): string {
  const next = `${existing}${chunk}`;
  if (next.length <= MAX_CAPTURED_OUTPUT_CHARS) return next;
  return next.slice(next.length - MAX_CAPTURED_OUTPUT_CHARS);
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = value.slice(0, Math.floor(maxChars / 2));
  const tail = value.slice(value.length - Math.floor(maxChars / 2));
  return `${head}\n... [truncated] ...\n${tail}`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "case";
}
