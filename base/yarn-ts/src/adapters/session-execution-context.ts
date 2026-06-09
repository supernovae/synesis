/**
 * Session execution context — client→yarn contract for project_root, shell_cwd, runtime.
 * @see docs/clients/SESSION_EXECUTION_CONTEXT.md
 */

import path from "node:path";
import { isPathInsideRoot, normalizeAbsolutePathHint } from "../path-governance/path-hints.js";

const MAX_GIT_SUMMARY = 500;
const MAX_LABEL = 256;
const MAX_CUTOFF = 128;
const MAX_RUNTIME_FIELD = 128;
const GIT_POLICY_MODES = new Set(["off", "advisory", "enforced"]);

export type GitPolicyMode = "off" | "advisory" | "enforced";

export interface ParseSessionExecutionContextOptions {
  gitPolicyMode?: GitPolicyMode;
}

export interface ParsedSessionExecutionContext {
  projectRoot: string | null;
  shellCwd: string | null;
  platform?: string;
  osVersion?: string;
  shell?: string;
  gitSummary?: string;
  gitIsRepo?: boolean;
  gitBranch?: string;
  gitDirty?: boolean;
  gitHasUntracked?: boolean;
  gitAhead?: number;
  gitBehind?: number;
  gitPolicyMode?: GitPolicyMode;
  clientModelLabel?: string;
  knowledgeCutoff?: string;
}

function headerOne(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0].trim() : undefined;
  return typeof v === "string" ? v.trim() : undefined;
}

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string | undefined {
  if (!meta) return undefined;
  const v = meta[key];
  return typeof v === "string" ? v.trim() : undefined;
}

function nestedSynesis(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const nested = meta?.synesis;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : null;
}

function nestedSynesisString(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): string | undefined {
  const nested = nestedSynesis(meta);
  if (!nested) return undefined;
  for (const key of keys) {
    const v = nested[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function metaBool(meta: Record<string, unknown> | null | undefined, key: string): boolean | undefined {
  if (!meta) return undefined;
  const raw = meta[key];
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().toLowerCase();
  if (t === "true" || t === "1" || t === "yes") return true;
  if (t === "false" || t === "0" || t === "no") return false;
  return undefined;
}

function metaInt(meta: Record<string, unknown> | null | undefined, key: string): number | undefined {
  if (!meta) return undefined;
  const raw = meta[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.trunc(raw));
  if (typeof raw !== "string") return undefined;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.trunc(n));
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function replaceControlCharsWithSpace(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    out += code <= 31 || code === 127 ? " " : char;
  }
  return out;
}

function promptContextScalar(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = replaceControlCharsWithSpace(value)
    .replace(/[<>"`=]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) return undefined;
  return truncate(sanitized, max);
}

function parseHeaderBool(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): boolean | undefined {
  const v = headerOne(headers, name);
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  if (t === "true" || t === "1" || t === "yes") return true;
  if (t === "false" || t === "0" || t === "no") return false;
  return undefined;
}

function parseHeaderInt(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): number | undefined {
  const v = headerOne(headers, name);
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.trunc(n));
}

function parseGitFactsFromSummary(summary: string | undefined): Partial<ParsedSessionExecutionContext> {
  if (!summary) return {};
  const out: Partial<ParsedSessionExecutionContext> = {};
  const s = summary.trim();
  if (!s) return out;
  const lines = s.split(/\r?\n/);
  const first = lines[0] ?? "";
  const branchMatch = /^##\s+([^\s.[]+)/.exec(first);
  if (branchMatch?.[1]) {
    out.gitIsRepo = true;
    out.gitBranch = branchMatch[1];
  }
  const aheadBehind = /\[(?:ahead\s+(\d+))?(?:,\s*)?(?:behind\s+(\d+))?\]/.exec(first);
  if (aheadBehind) {
    if (aheadBehind[1]) out.gitAhead = Math.max(0, Math.trunc(Number(aheadBehind[1])));
    if (aheadBehind[2]) out.gitBehind = Math.max(0, Math.trunc(Number(aheadBehind[2])));
  }
  if (/\n\?\?\s/m.test(s)) out.gitHasUntracked = true;
  if (/\n(?:\?\?|[ MADRCU][MADRCU? ]?)\s/m.test(s)) out.gitDirty = true;
  return out;
}

/**
 * Parse project root, cwd, and optional fields from headers and optional metadata
 * (Anthropic body.metadata or OpenAI passthrough metadata).
 */
export function parseSessionExecutionContext(
  headers: Record<string, string | string[] | undefined>,
  metadata?: Record<string, unknown> | null,
  options?: ParseSessionExecutionContextOptions,
): ParsedSessionExecutionContext {
  const fromMetaRoot = metaString(metadata, "synesis_project_root")
    ?? nestedSynesisString(metadata, ["projectRoot", "project_root"]);
  const fromHeaderProject = headerOne(headers, "x-synesis-project-root");
  const fromHeaderLegacy = headerOne(headers, "x-synesis-workspace-root");
  const projectRoot = normalizeAbsolutePathHint(fromMetaRoot || fromHeaderProject || fromHeaderLegacy);

  const fromMetaCwd = metaString(metadata, "synesis_shell_cwd")
    ?? nestedSynesisString(metadata, ["shellCwd", "shell_cwd", "cwd"]);
  const fromHeaderCwd = headerOne(headers, "x-synesis-shell-cwd");
  const rawShellCwd = normalizeAbsolutePathHint(fromMetaCwd || fromHeaderCwd);
  const shellCwd = projectRoot && rawShellCwd && !isPathInsideRoot(rawShellCwd, projectRoot)
    ? null
    : rawShellCwd;

  let platform: string | undefined;
  let osVersion: string | undefined;
  let shell: string | undefined;
  const nested = nestedSynesis(metadata);
  const rt = metadata?.synesis_runtime
    ?? (nested?.runtime && typeof nested.runtime === "object" ? nested.runtime : undefined);
  if (rt && typeof rt === "object" && rt !== null) {
    const o = rt as Record<string, unknown>;
    platform = promptContextScalar(typeof o.platform === "string" ? o.platform : undefined, MAX_RUNTIME_FIELD);
    osVersion = promptContextScalar(typeof o.os_version === "string" ? o.os_version : undefined, MAX_RUNTIME_FIELD);
    shell = promptContextScalar(typeof o.shell === "string" ? o.shell : undefined, MAX_RUNTIME_FIELD);
  }

  const gitRaw = metaString(metadata, "synesis_git_summary");
  const gitSummaryRaw = gitRaw ? truncate(gitRaw, MAX_GIT_SUMMARY) : undefined;
  const inferredGit = parseGitFactsFromSummary(gitSummaryRaw);
  const gitSummary = promptContextScalar(gitSummaryRaw, MAX_GIT_SUMMARY);
  const gitIsRepo = metaBool(metadata, "synesis_git_is_repo")
    ?? parseHeaderBool(headers, "x-synesis-git-is-repo")
    ?? inferredGit.gitIsRepo;
  const gitBranch = promptContextScalar(metaString(metadata, "synesis_git_branch")
    ?? headerOne(headers, "x-synesis-git-branch")
    ?? inferredGit.gitBranch, MAX_LABEL);
  const gitDirty = metaBool(metadata, "synesis_git_dirty")
    ?? parseHeaderBool(headers, "x-synesis-git-dirty")
    ?? inferredGit.gitDirty;
  const gitHasUntracked = metaBool(metadata, "synesis_git_has_untracked")
    ?? parseHeaderBool(headers, "x-synesis-git-has-untracked")
    ?? inferredGit.gitHasUntracked;
  const gitAhead = metaInt(metadata, "synesis_git_ahead")
    ?? parseHeaderInt(headers, "x-synesis-git-ahead")
    ?? inferredGit.gitAhead;
  const gitBehind = metaInt(metadata, "synesis_git_behind")
    ?? parseHeaderInt(headers, "x-synesis-git-behind")
    ?? inferredGit.gitBehind;
  const policyCandidate = (options?.gitPolicyMode ?? "").trim().toLowerCase();
  const gitPolicyMode = GIT_POLICY_MODES.has(policyCandidate)
    ? (policyCandidate as GitPolicyMode)
    : undefined;

  const labelRaw = metaString(metadata, "synesis_client_model_label");
  const clientModelLabel = promptContextScalar(labelRaw, MAX_LABEL);

  const cutoffRaw = metaString(metadata, "synesis_knowledge_cutoff");
  const knowledgeCutoff = promptContextScalar(cutoffRaw, MAX_CUTOFF);

  return {
    projectRoot,
    shellCwd,
    platform,
    osVersion,
    shell,
    gitSummary,
    gitIsRepo,
    gitBranch,
    gitDirty,
    gitHasUntracked,
    gitAhead,
    gitBehind,
    gitPolicyMode,
    clientModelLabel,
    knowledgeCutoff,
  };
}

/** Repo-relative path from project_root to shell_cwd when cwd is inside the repo; otherwise null. */
function taskDirRelativeToRepo(projectRoot: string, shellCwd: string): string | null {
  try {
    const r = path.resolve(projectRoot);
    const c = path.resolve(shellCwd);
    const rel = path.relative(r, c);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  } catch {
    return null;
  }
}

function hasAnyOptional(ctx: ParsedSessionExecutionContext): boolean {
  return !!(
    ctx.platform ||
    ctx.osVersion ||
    ctx.shell ||
    ctx.gitSummary ||
    ctx.gitIsRepo !== undefined ||
    ctx.gitBranch ||
    ctx.gitDirty !== undefined ||
    ctx.gitHasUntracked !== undefined ||
    ctx.gitAhead !== undefined ||
    ctx.gitBehind !== undefined ||
    ctx.gitPolicyMode ||
    ctx.clientModelLabel ||
    ctx.knowledgeCutoff
  );
}

/**
 * Non-empty system block, or empty string if no context was provided.
 */
export function toSessionExecutionContextSystemBlock(ctx: ParsedSessionExecutionContext): string {
  if (!ctx.projectRoot && !ctx.shellCwd && !hasAnyOptional(ctx)) {
    return "";
  }

  const lines: string[] = ["<SESSION_EXECUTION_CONTEXT>"];
  if (ctx.projectRoot) {
    lines.push(`project_root=${ctx.projectRoot}`);
    lines.push(
      "Treat project_root as the repository/workspace anchor. Create new work under it; do not nest multiple directories with the same name.",
    );
    lines.push(
      "If the workspace is empty, add the requested project files at the root instead of mkdir && cd into repeated path segments.",
    );
    lines.push(
      "For client-native Read/Write/Edit/Update tools, use paths relative to shell_cwd/current working directory when it is set; otherwise use project_root. Do not prepend project_root or shell_cwd segments to relative file paths.",
    );
    lines.push(
      "When running build or test commands, remember that they run from the current shell directory. If the project is in a subdirectory, run the command from that subdirectory or use the toolchain's working-directory option.",
    );
    lines.push(
      "Language package identity must come from explicit user input or repository metadata in the target project, not from platform/workspace names, hostnames, or headers such as `project_root` / `shell_cwd`.",
    );
  }
  if (ctx.shellCwd) {
    lines.push(`shell_cwd=${ctx.shellCwd}`);
    lines.push(
      "shell_cwd is the current task directory on the client when provided; prefer editing within the existing tree under project_root when both are set.",
    );
    if (!ctx.projectRoot) {
      lines.push(
        "Without project_root: do not mkdir && cd into a subfolder that repeats the last path segment of shell_cwd. Add the requested project files at shell_cwd when it is already the project root.",
      );
    }
  }
  if (ctx.projectRoot || ctx.shellCwd) {
    lines.push(
      "When summarizing verification for the user (bullets, final messages), use human-readable paths: repo-relative directories, scoped package globs, or state the working directory using project_root or shell_cwd when given. Avoid bare build/test command lines without anchoring where the command ran.",
    );
  }
  if (ctx.projectRoot || ctx.shellCwd) {
    lines.push("<FILE_PATH_RESOLUTION>");
    lines.push(
      "Read/Write/Edit/Update file_path: use paths relative to shell_cwd/current working directory when it is set. If only project_root is available, use paths relative to project_root.",
    );
    lines.push(
      "Do not invent a sibling directory or alternate checkout name (e.g. a folder next to the real repo). Strip bogus parent segments and anchor paths under project_root or shell_cwd.",
    );
    lines.push(
      "project_root is the broader workspace/repo boundary for context. shell_cwd is the file-tool execution root for client-native tools; when both are set and shell_cwd is a subdirectory, do not include that subdirectory prefix in file_path.",
    );
    lines.push(
      "Do not request access to parent/sibling directories such as ../, ~/src, or the parent of project_root just to discover files. If a file is missing, inspect the current workspace root with pwd/ls and then create or edit only inside shell_cwd/project_root.",
    );
    lines.push(
      "In a fresh or empty workspace, do not read guessed application files before they exist. Confirm the root with a narrow listing, then create the requested scaffold from that root.",
    );
    const pr = ctx.projectRoot?.trim();
    const cw = ctx.shellCwd?.trim();
    if (pr && cw && pr !== cw) {
      const sub = taskDirRelativeToRepo(pr, cw);
      if (sub) {
        lines.push(`Current shell working directory for this session is repo-relative: ${sub}`);
      }
    }
    lines.push("</FILE_PATH_RESOLUTION>");
  }
  if (ctx.platform) lines.push(`platform=${ctx.platform}`);
  if (ctx.osVersion) lines.push(`os_version=${ctx.osVersion}`);
  if (ctx.shell) lines.push(`shell=${ctx.shell}`);
  if (ctx.gitPolicyMode) lines.push(`git_policy_mode=${ctx.gitPolicyMode}`);
  if (ctx.gitSummary) lines.push(`git_summary=${ctx.gitSummary}`);
  if (ctx.gitIsRepo !== undefined) lines.push(`is_git_repo=${ctx.gitIsRepo}`);
  if (ctx.gitBranch) lines.push(`git_branch=${ctx.gitBranch}`);
  if (ctx.gitDirty !== undefined) lines.push(`git_dirty=${ctx.gitDirty}`);
  if (ctx.gitHasUntracked !== undefined) lines.push(`git_has_untracked=${ctx.gitHasUntracked}`);
  if (ctx.gitAhead !== undefined || ctx.gitBehind !== undefined) {
    lines.push(`git_ahead_behind=${ctx.gitAhead ?? 0}/${ctx.gitBehind ?? 0}`);
  }
  if (ctx.gitIsRepo === true) {
    lines.push(
      "Git repo detected: run status/diff before finalizing, keep commits focused, and avoid staging credentials or secrets.",
    );
    if (ctx.gitPolicyMode === "enforced") {
      lines.push(
        "Git policy mode is enforced: expect guarded git tools to block risky add/commit behavior without preflight hygiene.",
      );
    } else if (ctx.gitPolicyMode === "advisory") {
      lines.push(
        "Git policy mode is advisory: prefer branch-aware, status-first, diff-before-final workflows in this session.",
      );
    }
  } else if (ctx.gitIsRepo === false) {
    lines.push(
      "No git repository detected for this workspace anchor. Scaffold normally and suggest git init only when the user asks for repository workflows.",
    );
  }
  if (ctx.clientModelLabel) lines.push(`client_model_label=${ctx.clientModelLabel}`);
  if (ctx.knowledgeCutoff) lines.push(`knowledge_cutoff=${ctx.knowledgeCutoff}`);
  lines.push("</SESSION_EXECUTION_CONTEXT>");
  return lines.join("\n");
}

/**
 * When no SESSION_EXECUTION_CONTEXT (client sent no roots/cwd), still nudge Claude Code–style agents
 * that commonly hit duplicate-segment paths. Stock Claude Code does not send synesis headers by default.
 */
function pathHygieneFallbackBlock(): string {
  return [
    "<PATH_HYGIENE>",
    "No project_root or shell_cwd was provided by the client. Infer the workspace from the user's task and the first successful pwd in Bash; default to staying in that directory for new files.",
    "This block contains generic path hygiene rules, not facts about the user's files. Do not treat placeholder names or paths here as files that exist.",
    "Do not mkdir && cd into a nested folder whose name repeats the current directory. If you are already inside the project folder, create the requested files there.",
    "If pwd is already the workspace root, file-tool paths are relative to that cwd. Use the project-relative path observed in the workspace; do not prepend parent directory segments copied from pwd.",
    "If a path error shows a duplicated cwd/project-root segment, strip the repeated segment before retrying. Do not regenerate the project because one path lookup failed.",
    "In a fresh or empty workspace, do not read guessed source, test, or package files before they exist. Confirm the root with `pwd`/`ls`, then create the requested scaffold from that root.",
    "After a path miss, run one narrow location check (pwd plus ls/find for the intended project folder), then create or edit only the missing file at the corrected path.",
    "A failed install/test because requirements.txt or a source file is missing at one path is evidence about that path only; it is not evidence that previous successful writes are invalid.",
    "Shell cd only affects Bash; keep Read/Write/Edit paths consistent with the directory you mean to modify.",
    "When running build or test commands, remember that they run from the current shell directory. If the project is in a subdirectory, run the command from that subdirectory or use the toolchain's working-directory option.",
    "Do not infer package/module ownership from surrounding platform names. For new repositories, ask for module/import path (or use a neutral placeholder like `example.com/<name>` until provided).",
    "When summarizing verification for the user, use human-readable paths (repo-relative dirs, scoped globs, or state pwd after inferring it) instead of bare build/test commands without context.",
    "Before rm or other destructive commands, list the target path and confirm; avoid guessing with wildcards on project trees.",
    "</PATH_HYGIENE>",
  ].join("\n");
}

function shouldAppendPathHygieneFallback(coderClientHint: string | null | undefined): boolean {
  const c = (coderClientHint ?? "").trim().toLowerCase();
  return c === "claude-code"
    || c.includes("claude-code")
    || c === "opencode"
    || c.includes("opencode")
    || c === "synesis-acp"
    || c.includes("synesis-acp");
}

/**
 * Append client adapter block with optional SESSION_EXECUTION_CONTEXT (unified; replaces legacy WORKSPACE_ROOT-only block).
 * @param coderClientHint optional `x-synesis-client` value; when it names a coding harness and no session block was built, appends PATH_HYGIENE fallback.
 */
export function appendPathContextToAdapterBlock(
  adapterBlock: string,
  headers: Record<string, string | string[] | undefined>,
  metadata?: Record<string, unknown> | null,
  coderClientHint?: string | null,
  options?: ParseSessionExecutionContextOptions,
): string {
  const ctx = parseSessionExecutionContext(headers, metadata, options);
  const block = toSessionExecutionContextSystemBlock(ctx);
  if (block) return `${adapterBlock}\n\n${block}`;
  if (shouldAppendPathHygieneFallback(coderClientHint)) {
    return `${adapterBlock}\n\n${pathHygieneFallbackBlock()}`;
  }
  return adapterBlock;
}

/** Effective workspace root for tool-collapse path validation (metadata + headers). */
export function resolveWorkspaceRootForCollapse(
  headers: Record<string, string | string[] | undefined>,
  metadata?: Record<string, unknown> | null,
): string | null {
  return parseSessionExecutionContext(headers, metadata).projectRoot;
}
