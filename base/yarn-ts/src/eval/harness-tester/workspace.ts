import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommandResult, runHarnessTesterCommand } from "./commands.js";
import type { HarnessTesterCommandResult, HarnessTesterResolvedTask, HarnessTesterWorkspaceSnapshot } from "./types.js";

export interface PreparedHarnessWorkspace {
  workspacePath: string;
  promptFilePath: string;
  baselineResults: HarnessTesterCommandResult[];
}

export async function prepareHarnessWorkspace(params: {
  task: HarnessTesterResolvedTask;
  runId: string;
  workRoot?: string;
}): Promise<PreparedHarnessWorkspace> {
  const root = params.workRoot ?? join(tmpdir(), "synesis-harness-tester");
  await mkdir(root, { recursive: true });
  const workspacePath = await mkdtemp(join(root, `${sanitizeSegment(params.task.id)}-${params.runId.slice(0, 8)}-`));
  await cp(params.task.fixturePath, workspacePath, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).some((segment) => segment === ".git" || segment === "node_modules"),
  });
  const promptFilePath = join(workspacePath, ".synesis-harness-tester", "prompt.txt");
  await mkdir(join(workspacePath, ".synesis-harness-tester"), { recursive: true });
  await writeFile(promptFilePath, params.task.prompt, "utf-8");
  const baselineResults = await initializeGitBaseline(workspacePath);
  return { workspacePath, promptFilePath, baselineResults };
}

export async function cleanupHarnessWorkspace(workspacePath: string): Promise<void> {
  await rm(workspacePath, { recursive: true, force: true });
}

export async function captureWorkspaceSnapshot(workspacePath: string): Promise<HarnessTesterWorkspaceSnapshot> {
  if (!(await isGitAvailable(workspacePath))) {
    return {
      workspacePath,
      gitAvailable: false,
      changedFiles: [],
      diff: "",
      diffSummary: { filesChanged: 0, insertions: 0, deletions: 0 },
    };
  }

  await runHarnessTesterCommand({ command: "git add -N .", cwd: workspacePath, timeoutMs: 10_000 });
  const status = await runHarnessTesterCommand({ command: "git status --porcelain", cwd: workspacePath, timeoutMs: 10_000 });
  const diff = await runHarnessTesterCommand({ command: "git diff -- .", cwd: workspacePath, timeoutMs: 10_000 });
  const numstat = await runHarnessTesterCommand({ command: "git diff --numstat -- .", cwd: workspacePath, timeoutMs: 10_000 });
  const changedFiles = parseChangedFiles(status.stdout);
  return {
    workspacePath,
    gitAvailable: true,
    changedFiles,
    diff: diff.stdout,
    diffSummary: parseNumstat(numstat.stdout),
  };
}

async function initializeGitBaseline(workspacePath: string): Promise<HarnessTesterCommandResult[]> {
  if (!(await isGitAvailable(workspacePath))) {
    return [buildCommandResult({ command: "git --version", cwd: workspacePath, exitCode: 127, stderr: "git unavailable" })];
  }
  const commands = [
    "git init",
    "git add .",
    "git -c user.name=SynesisHarnessTester -c user.email=harness-tester@synesis.local commit --allow-empty --no-gpg-sign -m baseline",
  ];
  const results: HarnessTesterCommandResult[] = [];
  for (const command of commands) {
    results.push(await runHarnessTesterCommand({ command, cwd: workspacePath, timeoutMs: 20_000 }));
  }
  return results;
}

async function isGitAvailable(cwd: string): Promise<boolean> {
  const result = await runHarnessTesterCommand({ command: "git --version", cwd, timeoutMs: 5_000 });
  return result.exitCode === 0;
}

function parseChangedFiles(status: string): string[] {
  return status
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, ""))
    .sort();
}

function parseNumstat(numstat: string): HarnessTesterWorkspaceSnapshot["diffSummary"] {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [inserted, deleted] = line.split(/\s+/);
    filesChanged += 1;
    insertions += inserted === "-" ? 0 : Number(inserted ?? 0);
    deletions += deleted === "-" ? 0 : Number(deleted ?? 0);
  }
  return { filesChanged, insertions, deletions };
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}
