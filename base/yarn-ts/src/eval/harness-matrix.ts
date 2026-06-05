import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runHarnessLab,
  type HarnessLabCaseResult,
  type HarnessLabCaseSpec,
  type HarnessLabClientSpec,
  type HarnessLabRiskKind,
  type HarnessLabRiskSignal,
  type HarnessLabSpec,
} from "./harness-lab.js";

export type HarnessMatrixProfileId =
  | "opencode"
  | "codex-cli"
  | "claude-code"
  | "cursor"
  | "raw-openai";

export type HarnessMatrixFailureCategory =
  | "harness_adapter"
  | "model_behavior"
  | "governor_false_positive"
  | "governor_false_negative"
  | "tool_schema_mismatch"
  | "path_cwd_confusion"
  | "task_state_reset"
  | "verification_churn"
  | "discovery_churn"
  | "missing_completion_signal"
  | "workspace_setup"
  | "test_fixture"
  | "unknown";

export type HarnessMatrixOwner =
  | "governor"
  | "harness_adapter"
  | "model"
  | "tool_schema"
  | "workspace_setup"
  | "test_fixture"
  | "unknown";

export type HarnessMatrixPromotion =
  | "harness-flow-contract"
  | "offline-governor-replay-fixture"
  | "eval-gym-scenario"
  | "harness-adapter-regression"
  | "none";

export interface HarnessMatrixSpec {
  schemaVersion?: "harness_matrix_v1";
  name: string;
  description?: string;
  defaults?: HarnessMatrixDefaults;
  tasks: HarnessMatrixTaskSpec[];
  harnesses: HarnessMatrixHarnessSpec[];
  models: HarnessMatrixModelSpec[];
  cases?: HarnessMatrixCaseSpec[];
}

export interface HarnessMatrixDefaults {
  apiBaseUrl?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  rounds?: number;
  cleanup?: boolean;
  workRoot?: string;
  artifactsRoot?: string;
  expected?: HarnessMatrixExpected;
}

export interface HarnessMatrixTaskSpec {
  id: string;
  prompt?: string;
  promptFile?: string;
  tags?: string[];
  workspace?: HarnessLabCaseSpec["workspace"];
  testerTask?: string;
}

export interface HarnessMatrixHarnessSpec {
  id: HarnessMatrixProfileId | string;
  profile?: HarnessMatrixProfileId;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface HarnessMatrixModelSpec {
  id: string;
  alias?: string;
}

export interface HarnessMatrixExpected {
  successCriteria?: string[];
  forbiddenRiskSignals?: HarnessLabRiskKind[];
  requiredRiskSignals?: HarnessLabRiskKind[];
  allowGovernorPause?: boolean;
}

export interface HarnessMatrixCaseSpec {
  id: string;
  task: string;
  harness: string;
  model: string;
  apiBaseUrl?: string;
  env?: Record<string, string>;
  expected?: HarnessMatrixExpected;
  timeoutMs?: number;
  rounds?: number;
  outputPath?: string;
}

export interface HarnessMatrixRunOptions {
  dryRun?: boolean;
  artifactsRoot?: string;
}

export interface HarnessMatrixRunResult {
  schemaVersion: "harness_matrix_result_v1";
  matrixName: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  dryRun: boolean;
  cases: HarnessMatrixCaseResult[];
  summary: HarnessMatrixSummary;
}

export interface HarnessMatrixCaseResult {
  caseId: string;
  taskId: string;
  harnessId: string;
  harnessProfile: string;
  modelId: string;
  modelAlias?: string;
  round: number;
  passed: boolean;
  score: number;
  riskSignals: HarnessLabRiskSignal[];
  failureCategory: HarnessMatrixFailureCategory;
  likelyOwner: HarnessMatrixOwner;
  recommendedNextAction: string;
  promotionRecommendation: HarnessMatrixPromotion;
  command: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
  };
  dryRun: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  artifactDir?: string;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  workspaceDiffSummary?: string;
  fixtureDraft?: unknown;
}

export interface HarnessMatrixSummary {
  total: number;
  passed: number;
  failed: number;
  avgScore: number;
  failureCategories: Record<string, number>;
  likelyOwners: Record<string, number>;
  promotionRecommendations: Record<string, number>;
}

interface ExpandedMatrixCase {
  id: string;
  task: HarnessMatrixTaskSpec & { prompt: string };
  harness: HarnessMatrixHarnessSpec;
  model: HarnessMatrixModelSpec;
  apiBaseUrl: string;
  env: Record<string, string>;
  expected: HarnessMatrixExpected;
  timeoutMs: number;
  rounds: number;
  round: number;
}

const SECRET_KEY_RE = /(?:key|token|secret|auth|password|credential)/i;
const SECRET_VALUE_RE = /\b(?:bearer\s+)?(?:sk-[a-zA-Z0-9_-]{12,}|syn-[a-zA-Z0-9_-]{12,}|[a-zA-Z0-9_-]{32,})\b/gi;
const DEFAULT_TIMEOUT_MS = 180_000;

export async function loadHarnessMatrixSpec(path: string): Promise<HarnessMatrixSpec> {
  const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<HarnessMatrixSpec>;
  return validateHarnessMatrixSpec(parsed, path);
}

export function validateHarnessMatrixSpec(raw: Partial<HarnessMatrixSpec>, source = "matrix"): HarnessMatrixSpec {
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== "harness_matrix_v1") {
    throw new Error(`${source} has unsupported schemaVersion`);
  }
  if (!raw.name || typeof raw.name !== "string") throw new Error(`${source} is missing string name`);
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error(`${source} must define at least one task`);
  if (!Array.isArray(raw.harnesses) || raw.harnesses.length === 0) throw new Error(`${source} must define at least one harness`);
  if (!Array.isArray(raw.models) || raw.models.length === 0) throw new Error(`${source} must define at least one model`);
  for (const task of raw.tasks) {
    if (!task.id || typeof task.id !== "string") throw new Error(`${source} task is missing string id`);
    if (!task.prompt && !task.promptFile && !task.testerTask) {
      throw new Error(`${source} task ${task.id} must define prompt, promptFile, or testerTask`);
    }
  }
  for (const harness of raw.harnesses) {
    if (!harness.id || typeof harness.id !== "string") throw new Error(`${source} harness is missing string id`);
    if (!harness.command || typeof harness.command !== "string") throw new Error(`${source} harness ${harness.id} is missing command`);
  }
  for (const model of raw.models) {
    if (!model.id || typeof model.id !== "string") throw new Error(`${source} model is missing string id`);
  }
  return {
    schemaVersion: raw.schemaVersion,
    name: raw.name,
    description: raw.description,
    defaults: raw.defaults,
    tasks: raw.tasks,
    harnesses: raw.harnesses,
    models: raw.models,
    cases: raw.cases,
  };
}

export async function runHarnessMatrix(
  spec: HarnessMatrixSpec,
  options: HarnessMatrixRunOptions = {},
): Promise<HarnessMatrixRunResult> {
  const startedAtDate = new Date();
  const artifactsRoot = options.artifactsRoot ?? spec.defaults?.artifactsRoot;
  const expanded = await expandHarnessMatrix(spec);
  const caseResults: HarnessMatrixCaseResult[] = [];

  for (const matrixCase of expanded) {
    const labSpec = buildHarnessLabSpec(spec, matrixCase);
    const labResult = await runHarnessLab(labSpec, { dryRun: options.dryRun });
    const labCase = labResult.cases[0];
    if (!labCase) throw new Error(`Harness Lab produced no result for case ${matrixCase.id}`);
    const result = buildMatrixCaseResult(matrixCase, labCase, options.dryRun === true);
    if (artifactsRoot) {
      result.artifactDir = await writeMatrixCaseArtifacts(artifactsRoot, result, labCase, matrixCase.task.prompt);
    }
    caseResults.push(result);
  }

  const completedAtDate = new Date();
  return {
    schemaVersion: "harness_matrix_result_v1",
    matrixName: spec.name,
    startedAt: startedAtDate.toISOString(),
    completedAt: completedAtDate.toISOString(),
    durationMs: completedAtDate.getTime() - startedAtDate.getTime(),
    dryRun: options.dryRun === true,
    cases: caseResults,
    summary: summarizeMatrix(caseResults),
  };
}

export async function expandHarnessMatrix(spec: HarnessMatrixSpec): Promise<ExpandedMatrixCase[]> {
  const tasks = new Map<string, HarnessMatrixTaskSpec & { prompt: string }>();
  for (const task of spec.tasks) {
    tasks.set(task.id, { ...task, prompt: await resolveTaskPrompt(task) });
  }
  const harnesses = new Map(spec.harnesses.map((harness) => [harness.id, harness]));
  const models = new Map(spec.models.map((model) => [model.id, model]));
  const cases: HarnessMatrixCaseSpec[] = spec.cases && spec.cases.length > 0
    ? spec.cases
    : [...tasks.values()].flatMap((task) =>
        [...harnesses.values()].flatMap((harness) =>
          [...models.values()].map((model) => ({
            id: `${task.id}-${harness.id}-${model.alias ?? model.id}`,
            task: task.id,
            harness: harness.id,
            model: model.id,
          })),
        ),
      );

  const expanded: ExpandedMatrixCase[] = [];
  for (const item of cases) {
    const task = tasks.get(item.task);
    const harness = harnesses.get(item.harness);
    const model = models.get(item.model);
    if (!task) throw new Error(`Matrix case ${item.id} references unknown task ${item.task}`);
    if (!harness) throw new Error(`Matrix case ${item.id} references unknown harness ${item.harness}`);
    if (!model) throw new Error(`Matrix case ${item.id} references unknown model ${item.model}`);
    const rounds = Math.max(1, item.rounds ?? spec.defaults?.rounds ?? 1);
    for (let round = 1; round <= rounds; round++) {
      expanded.push({
        id: rounds === 1 ? item.id : `${item.id}-r${round}`,
        task,
        harness,
        model,
        apiBaseUrl: item.apiBaseUrl ?? spec.defaults?.apiBaseUrl ?? "",
        env: { ...(spec.defaults?.env ?? {}), ...(item.env ?? {}) },
        expected: { ...(spec.defaults?.expected ?? {}), ...(item.expected ?? {}) },
        timeoutMs: item.timeoutMs ?? spec.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        rounds,
        round,
      });
    }
  }
  return expanded;
}

export function renderHarnessMatrixMarkdown(result: HarnessMatrixRunResult): string {
  const lines = [
    `# Harness Matrix: ${result.matrixName}`,
    "",
    `Dry run: ${result.dryRun ? "yes" : "no"}`,
    `Cases: ${result.summary.total}`,
    `Passed: ${result.summary.passed}`,
    `Failed: ${result.summary.failed}`,
    `Average score: ${result.summary.avgScore.toFixed(3)}`,
    "",
    "## Failure Categories",
    "",
  ];
  appendCounts(lines, result.summary.failureCategories);
  lines.push("", "## Likely Owners", "");
  appendCounts(lines, result.summary.likelyOwners);
  lines.push("", "## Cases", "");
  for (const testCase of result.cases) {
    lines.push(`### ${testCase.caseId}`, "");
    lines.push(`Harness: ${testCase.harnessId} (${testCase.harnessProfile})`);
    lines.push(`Model: ${testCase.modelAlias ?? testCase.modelId}`);
    lines.push(`Status: ${testCase.passed ? "passed" : "failed"}`);
    lines.push(`Score: ${testCase.score.toFixed(3)}`);
    lines.push(`Failure category: ${testCase.failureCategory}`);
    lines.push(`Likely owner: ${testCase.likelyOwner}`);
    lines.push(`Promotion: ${testCase.promotionRecommendation}`);
    lines.push(`Next action: ${testCase.recommendedNextAction}`);
    if (testCase.riskSignals.length > 0) {
      lines.push("", "Signals:");
      for (const signal of testCase.riskSignals) {
        lines.push(`- ${signal.severity} ${signal.kind}: ${signal.detail}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function redactSecrets(value: string, env: Record<string, string> = {}): string {
  let redacted = value;
  for (const [key, candidate] of Object.entries(env)) {
    if (!candidate || !SECRET_KEY_RE.test(key)) continue;
    redacted = redacted.split(candidate).join("<redacted>");
  }
  return redacted.replace(SECRET_VALUE_RE, (match) => match.toLowerCase().startsWith("bearer ") ? "Bearer <redacted>" : "<redacted>");
}

export function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = SECRET_KEY_RE.test(key) ? "<redacted>" : redactSecrets(value, env);
  }
  return out;
}

export function classifyHarnessMatrixFailure(signals: HarnessLabRiskSignal[], allowGovernorPause?: boolean): {
  category: HarnessMatrixFailureCategory;
  owner: HarnessMatrixOwner;
  promotion: HarnessMatrixPromotion;
  nextAction: string;
} {
  const kinds = new Set(signals.map((signal) => signal.kind));
  const hasForbiddenPause = kinds.has("governor_pause") && allowGovernorPause === false;
  if (kinds.has("invalid_tool_arguments")) {
    return {
      category: "tool_schema_mismatch",
      owner: "tool_schema",
      promotion: "harness-adapter-regression",
      nextAction: "Capture the malformed tool call and add tool-schema or adapter regression coverage.",
    };
  }
  if (kinds.has("path_confusion")) {
    return {
      category: "path_cwd_confusion",
      owner: "model",
      promotion: "harness-flow-contract",
      nextAction: "Promote the minimal transcript to a path-stability harness-flow contract.",
    };
  }
  if (kinds.has("task_reset")) {
    return {
      category: "task_state_reset",
      owner: "model",
      promotion: "harness-flow-contract",
      nextAction: "Add a task-continuity lifecycle contract and preserve the transcript excerpt.",
    };
  }
  if (hasForbiddenPause) {
    return {
      category: "governor_false_positive",
      owner: "governor",
      promotion: "offline-governor-replay-fixture",
      nextAction: "Convert the smallest governor decision window into an offline replay fixture before changing rules.",
    };
  }
  if (kinds.has("verification_churn")) {
    return {
      category: "verification_churn",
      owner: "model",
      promotion: "offline-governor-replay-fixture",
      nextAction: "Promote the repeated verification window into a replay fixture and check repair guidance.",
    };
  }
  if (kinds.has("discovery_churn") || kinds.has("identical_tool_repeat") || kinds.has("dependency_install_replay")) {
    return {
      category: "discovery_churn",
      owner: "model",
      promotion: "offline-governor-replay-fixture",
      nextAction: "Promote the smallest no-progress loop into a replay fixture.",
    };
  }
  if (kinds.has("no_completion_signal")) {
    return {
      category: "missing_completion_signal",
      owner: "model",
      promotion: "eval-gym-scenario",
      nextAction: "Add a model-in-loop scenario requiring validation and completion evidence.",
    };
  }
  if (kinds.has("unsafe_shell_block") || kinds.has("hard_stop")) {
    return {
      category: "harness_adapter",
      owner: "harness_adapter",
      promotion: "harness-adapter-regression",
      nextAction: "Check harness invocation, permissions, and command template before changing governor logic.",
    };
  }
  if (signals.length === 0) {
    return {
      category: "unknown",
      owner: "unknown",
      promotion: "none",
      nextAction: "No action required; use as a happy-path comparison baseline.",
    };
  }
  return {
    category: "unknown",
    owner: "unknown",
    promotion: "none",
    nextAction: "Inspect artifacts and classify manually before promoting to deterministic coverage.",
  };
}

function buildHarnessLabSpec(spec: HarnessMatrixSpec, matrixCase: ExpandedMatrixCase): HarnessLabSpec {
  const substitutions = substitutionsFor(matrixCase);
  const envInput: Record<string, string> = {
    ...(matrixCase.env ?? {}),
    ...(matrixCase.harness.env ?? {}),
    OPENAI_BASE_URL: matrixCase.apiBaseUrl,
  };
  if (matrixCase.env.OPENAI_API_KEY || matrixCase.env.SYNESIS_EVAL_TARGET_KEY) {
    envInput.OPENAI_API_KEY = matrixCase.env.OPENAI_API_KEY ?? matrixCase.env.SYNESIS_EVAL_TARGET_KEY ?? "";
  }
  const client: HarnessLabClientSpec = {
    id: matrixCase.harness.id,
    command: renderTemplate(matrixCase.harness.command, substitutions) ?? matrixCase.harness.command,
    args: (matrixCase.harness.args ?? []).map((arg) => renderTemplate(arg, substitutions) ?? arg),
    cwd: matrixCase.harness.cwd,
    env: renderTemplateRecord(envInput, substitutions),
  };
  return {
    schemaVersion: "harness_lab_v1",
    name: `${spec.name}:${matrixCase.id}`,
    description: spec.description,
    client,
    defaults: {
      timeoutMs: matrixCase.timeoutMs,
      cleanup: spec.defaults?.cleanup ?? true,
      workRoot: spec.defaults?.workRoot,
    },
    cases: [{
      id: matrixCase.id,
      prompt: matrixCase.task.prompt,
      tags: [...(matrixCase.task.tags ?? []), matrixCase.harness.profile ?? matrixCase.harness.id, matrixCase.model.alias ?? matrixCase.model.id],
      model: matrixCase.model.alias ?? matrixCase.model.id,
      sessionKey: `harness-matrix-${matrixCase.id}`,
      workspace: matrixCase.task.workspace,
      timeoutMs: matrixCase.timeoutMs,
      env: matrixCase.env,
      expected: {
        allowGovernorPause: matrixCase.expected.allowGovernorPause,
        forbiddenSignals: matrixCase.expected.forbiddenRiskSignals,
        requiredSignals: matrixCase.expected.requiredRiskSignals,
      },
    }],
  };
}

function buildMatrixCaseResult(matrixCase: ExpandedMatrixCase, labCase: HarnessLabCaseResult, dryRun: boolean): HarnessMatrixCaseResult {
  const attribution = classifyHarnessMatrixFailure(labCase.riskReport.signals, matrixCase.expected.allowGovernorPause);
  const redactedEnv = redactEnv(labCase.command.env);
  const commandText = redactSecrets(labCase.command.command, labCase.command.env);
  const redactedArgs = labCase.command.args.map((arg) => redactSecrets(arg, labCase.command.env));
  return {
    caseId: matrixCase.id,
    taskId: matrixCase.task.id,
    harnessId: matrixCase.harness.id,
    harnessProfile: matrixCase.harness.profile ?? matrixCase.harness.id,
    modelId: matrixCase.model.id,
    modelAlias: matrixCase.model.alias,
    round: matrixCase.round,
    passed: labCase.riskReport.passed,
    score: labCase.riskReport.score,
    riskSignals: labCase.riskReport.signals,
    failureCategory: attribution.category,
    likelyOwner: attribution.owner,
    recommendedNextAction: attribution.nextAction,
    promotionRecommendation: attribution.promotion,
    command: {
      command: commandText,
      args: redactedArgs,
      cwd: labCase.command.cwd,
      env: redactedEnv,
    },
    dryRun,
    exitCode: labCase.exitCode,
    timedOut: labCase.timedOut,
    durationMs: labCase.durationMs,
    stdoutExcerpt: excerpt(redactSecrets(labCase.stdout, labCase.command.env)),
    stderrExcerpt: excerpt(redactSecrets(labCase.stderr, labCase.command.env)),
    fixtureDraft: labCase.fixtureDraft,
  };
}

async function writeMatrixCaseArtifacts(
  artifactsRoot: string,
  result: HarnessMatrixCaseResult,
  labCase: HarnessLabCaseResult,
  prompt: string,
): Promise<string> {
  const artifactDir = join(artifactsRoot, sanitizeSegment(result.caseId));
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "prompt.txt"), prompt, "utf-8");
  await writeFile(join(artifactDir, "command.json"), `${JSON.stringify(result.command, null, 2)}\n`, "utf-8");
  await writeFile(join(artifactDir, "stdout.txt"), result.stdoutExcerpt, "utf-8");
  await writeFile(join(artifactDir, "stderr.txt"), result.stderrExcerpt, "utf-8");
  await writeFile(join(artifactDir, "fixture-draft.json"), `${JSON.stringify(labCase.fixtureDraft, null, 2)}\n`, "utf-8");
  return artifactDir;
}

async function resolveTaskPrompt(task: HarnessMatrixTaskSpec): Promise<string> {
  if (task.prompt) return task.prompt;
  if (task.promptFile) return readFile(task.promptFile, "utf-8");
  if (task.testerTask) {
    const parsed = JSON.parse(await readFile(task.testerTask, "utf-8")) as { prompt?: string };
    if (typeof parsed.prompt === "string" && parsed.prompt) return parsed.prompt;
  }
  throw new Error(`Task ${task.id} could not resolve a prompt`);
}

function substitutionsFor(matrixCase: ExpandedMatrixCase): Record<string, string> {
  return {
    apiBaseUrl: matrixCase.apiBaseUrl,
    harness: matrixCase.harness.id,
    modelId: matrixCase.model.id,
    task: matrixCase.task.id,
  };
}

function renderTemplate(value: string | undefined, substitutions: Record<string, string>): string | undefined {
  if (value === undefined) return undefined;
  return value
    .replace(/\{env:([a-zA-Z0-9_]+)\}/g, (_match, key: string) => process.env[key] ?? "")
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => substitutions[key] ?? match);
}

function renderTemplateRecord(values: Record<string, string>, substitutions: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = renderTemplate(value, substitutions) ?? "";
  }
  return out;
}

function summarizeMatrix(results: HarnessMatrixCaseResult[]): HarnessMatrixSummary {
  const failures = results.filter((result) => !result.passed);
  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: failures.length,
    avgScore: results.length === 0 ? 0 : Number((results.reduce((sum, result) => sum + result.score, 0) / results.length).toFixed(3)),
    failureCategories: countBy(failures.map((result) => result.failureCategory)),
    likelyOwners: countBy(failures.map((result) => result.likelyOwner)),
    promotionRecommendations: countBy(results.map((result) => result.promotionRecommendation)),
  };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function appendCounts(lines: string[], counts: Record<string, number>): void {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    lines.push("- none");
    return;
  }
  for (const [key, value] of entries) lines.push(`- ${key}: ${value}`);
}

function excerpt(value: string, maxChars = 4_000): string {
  if (value.length <= maxChars) return value;
  const half = Math.floor(maxChars / 2);
  return `${value.slice(0, half)}\n... [truncated] ...\n${value.slice(value.length - half)}`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "case";
}
