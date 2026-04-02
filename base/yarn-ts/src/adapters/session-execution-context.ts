/**
 * Session execution context — client→yarn contract for project_root, shell_cwd, runtime.
 * @see docs/clients/SESSION_EXECUTION_CONTEXT.md
 */

const MAX_GIT_SUMMARY = 500;
const MAX_LABEL = 256;
const MAX_CUTOFF = 128;

export interface ParsedSessionExecutionContext {
  projectRoot: string | null;
  shellCwd: string | null;
  platform?: string;
  osVersion?: string;
  shell?: string;
  gitSummary?: string;
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

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Parse project root, cwd, and optional fields from headers and optional metadata
 * (Anthropic body.metadata or OpenAI passthrough metadata).
 */
export function parseSessionExecutionContext(
  headers: Record<string, string | string[] | undefined>,
  metadata?: Record<string, unknown> | null,
): ParsedSessionExecutionContext {
  const fromMetaRoot = metaString(metadata, "synesis_project_root");
  const fromHeaderProject = headerOne(headers, "x-synesis-project-root");
  const fromHeaderLegacy = headerOne(headers, "x-synesis-workspace-root");
  const projectRoot = (fromMetaRoot || fromHeaderProject || fromHeaderLegacy || "").trim() || null;

  const fromMetaCwd = metaString(metadata, "synesis_shell_cwd");
  const fromHeaderCwd = headerOne(headers, "x-synesis-shell-cwd");
  const shellCwd = (fromMetaCwd || fromHeaderCwd || "").trim() || null;

  let platform: string | undefined;
  let osVersion: string | undefined;
  let shell: string | undefined;
  const rt = metadata?.synesis_runtime;
  if (rt && typeof rt === "object" && rt !== null) {
    const o = rt as Record<string, unknown>;
    if (typeof o.platform === "string" && o.platform.trim()) platform = o.platform.trim();
    if (typeof o.os_version === "string" && o.os_version.trim()) osVersion = o.os_version.trim();
    if (typeof o.shell === "string" && o.shell.trim()) shell = o.shell.trim();
  }

  const gitRaw = metaString(metadata, "synesis_git_summary");
  const gitSummary = gitRaw ? truncate(gitRaw, MAX_GIT_SUMMARY) : undefined;

  const labelRaw = metaString(metadata, "synesis_client_model_label");
  const clientModelLabel = labelRaw ? truncate(labelRaw, MAX_LABEL) : undefined;

  const cutoffRaw = metaString(metadata, "synesis_knowledge_cutoff");
  const knowledgeCutoff = cutoffRaw ? truncate(cutoffRaw, MAX_CUTOFF) : undefined;

  return {
    projectRoot,
    shellCwd,
    platform,
    osVersion,
    shell,
    gitSummary,
    clientModelLabel,
    knowledgeCutoff,
  };
}

function hasAnyOptional(ctx: ParsedSessionExecutionContext): boolean {
  return !!(
    ctx.platform ||
    ctx.osVersion ||
    ctx.shell ||
    ctx.gitSummary ||
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
      "Treat project_root as the repository/workspace anchor. Create new work under it; do not nest multiple directories with the same name (e.g. avoid proj/proj/proj).",
    );
    lines.push(
      "If the workspace is empty, add files at the root (e.g. go.mod, main.go) instead of mkdir && cd into repeated path segments.",
    );
    lines.push(
      "Keep Read/Write/Edit paths relative to project_root. Shell cd only affects Bash; file tools stay workspace-relative to project_root.",
    );
  }
  if (ctx.shellCwd) {
    lines.push(`shell_cwd=${ctx.shellCwd}`);
    lines.push(
      "shell_cwd is the current task directory on the client when provided; prefer editing within the existing tree under project_root when both are set.",
    );
  }
  if (ctx.platform) lines.push(`platform=${ctx.platform}`);
  if (ctx.osVersion) lines.push(`os_version=${ctx.osVersion}`);
  if (ctx.shell) lines.push(`shell=${ctx.shell}`);
  if (ctx.gitSummary) lines.push(`git_summary=${ctx.gitSummary}`);
  if (ctx.clientModelLabel) lines.push(`client_model_label=${ctx.clientModelLabel}`);
  if (ctx.knowledgeCutoff) lines.push(`knowledge_cutoff=${ctx.knowledgeCutoff}`);
  lines.push("</SESSION_EXECUTION_CONTEXT>");
  return lines.join("\n");
}

/**
 * Append client adapter block with optional SESSION_EXECUTION_CONTEXT (unified; replaces legacy WORKSPACE_ROOT-only block).
 */
export function appendPathContextToAdapterBlock(
  adapterBlock: string,
  headers: Record<string, string | string[] | undefined>,
  metadata?: Record<string, unknown> | null,
): string {
  const ctx = parseSessionExecutionContext(headers, metadata);
  const block = toSessionExecutionContextSystemBlock(ctx);
  return block ? `${adapterBlock}\n\n${block}` : adapterBlock;
}

/** Effective workspace root for tool-collapse path validation (metadata + headers). */
export function resolveWorkspaceRootForCollapse(
  headers: Record<string, string | string[] | undefined>,
  metadata?: Record<string, unknown> | null,
): string | null {
  return parseSessionExecutionContext(headers, metadata).projectRoot;
}
