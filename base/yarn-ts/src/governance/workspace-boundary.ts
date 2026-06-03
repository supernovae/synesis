export const PROJECT_INSTRUCTION_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  ".cursor/rules",
] as const;
const PROJECT_INSTRUCTION_FILE_SET = new Set<string>(PROJECT_INSTRUCTION_FILES);

export interface WorkspacePathHints {
  projectRoot: string | null;
  shellCwd: string | null;
}

export interface WorkspaceInspection {
  root: string | null;
  fingerprint: string | null;
  isEmpty: boolean;
  projectInstructionFiles: string[];
  readError: string | null;
}

export interface WorkspaceBoundaryDecision {
  fingerprint: string | null;
  root: string | null;
  resetRequired: boolean;
  reason: "none" | "workspace_changed" | "fresh_empty_workspace";
}

export function normalizeWorkspaceRoot(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  return trimmed.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

export function workspaceRootFromHints(pathHints: WorkspacePathHints): string | null {
  return normalizeWorkspaceRoot(pathHints.projectRoot ?? pathHints.shellCwd);
}

export function workspaceFingerprintFromRoot(root: string | null): string | null {
  return root ? `workspace:${root}` : null;
}

export function projectInstructionFilePresent(pathValue: string | null | undefined): boolean {
  const normalized = normalizeWorkspaceRoot(pathValue);
  if (!normalized) return false;
  return PROJECT_INSTRUCTION_FILES.some((name) => normalized === name || normalized.endsWith(`/${name}`));
}

export async function inspectWorkspaceRoot(
  pathHints: WorkspacePathHints,
  readDir: (root: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>,
): Promise<WorkspaceInspection> {
  const root = workspaceRootFromHints(pathHints);
  const fingerprint = workspaceFingerprintFromRoot(root);
  if (!root) {
    return {
      root,
      fingerprint,
      isEmpty: false,
      projectInstructionFiles: [],
      readError: null,
    };
  }

  try {
    const entries = await readDir(root);
    const names = entries.map((entry) => entry.name).filter((name) => name && name !== ".DS_Store");
    const instructionFiles = names.filter((name) => PROJECT_INSTRUCTION_FILE_SET.has(name));
    return {
      root,
      fingerprint,
      isEmpty: names.length === 0,
      projectInstructionFiles: instructionFiles,
      readError: null,
    };
  } catch (err) {
    return {
      root,
      fingerprint,
      isEmpty: false,
      projectInstructionFiles: [],
      readError: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }
}

export function decideWorkspaceBoundary(input: {
  previousFingerprint?: string | null;
  previousRoot?: string | null;
  nextInspection: WorkspaceInspection;
  hasPersistedState: boolean;
}): WorkspaceBoundaryDecision {
  const nextFingerprint = input.nextInspection.fingerprint;
  const nextRoot = input.nextInspection.root;
  const previousFingerprint = input.previousFingerprint?.trim() || null;
  const previousRoot = normalizeWorkspaceRoot(input.previousRoot ?? null);
  const previousComparable = previousFingerprint ?? workspaceFingerprintFromRoot(previousRoot);

  if (!nextFingerprint) {
    return {
      fingerprint: nextFingerprint,
      root: nextRoot,
      resetRequired: false,
      reason: "none",
    };
  }

  if (previousComparable && previousComparable !== nextFingerprint) {
    return {
      fingerprint: nextFingerprint,
      root: nextRoot,
      resetRequired: true,
      reason: "workspace_changed",
    };
  }

  if (!previousComparable && input.hasPersistedState && input.nextInspection.isEmpty) {
    return {
      fingerprint: nextFingerprint,
      root: nextRoot,
      resetRequired: true,
      reason: "fresh_empty_workspace",
    };
  }

  return {
    fingerprint: nextFingerprint,
    root: nextRoot,
    resetRequired: false,
    reason: "none",
  };
}

export function buildEmptyWorkspaceSystemPrompt(root: string | null): string {
  const rootLine = root ? `workspace_root=${root}` : "workspace_root=unknown";
  const absentInstructionFiles = PROJECT_INSTRUCTION_FILES.map((name) => `${name}:absent`).join(",");
  return [
    "<SYNESIS_EMPTY_WORKSPACE version=\"1\">",
    rootLine,
    "status=empty_root_without_project_instructions",
    "workspace_inspection=complete",
    `checked_project_instruction_files=${absentInstructionFiles}`,
    "message=This workspace is empty. No project instruction file exists yet.",
    "guidance=Do not claim prior task frames, previous turns, active objectives, or files unless they appear in the current transcript. Do not read implementation filenames from old sessions before confirming they exist in this workspace. Do not re-read or claim absent project instruction files unless the user creates one, runs /init, or the workspace listing changes. Do not surface internal TASK_FRAME or SYNESIS_* tag names to the user. Do not invent SYNOPSIS_* labels.",
    "workspace_boundary=Stay inside workspace_root. Do not inspect parent or sibling directories with `..`, absolute parent paths, ~/src, or find/glob searches outside workspace_root. If this root is empty and the user asked for a new project/codebase, create it here.",
    "normal_start=Do not create CLAUDE.md automatically. Ask what to create, or create first project files only when the user's request is specific enough. For explicit new-codebase prompts, start by creating the requested project files under workspace_root rather than searching sibling projects.",
    "init_command=/init is the explicit path for helping create CLAUDE.md; when used, return or apply bootstrap content safely without overwriting existing guidance unless the user explicitly confirms.",
    "</SYNESIS_EMPTY_WORKSPACE>",
  ].join("\n");
}
