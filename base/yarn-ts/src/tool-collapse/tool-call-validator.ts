import path from "node:path";
import { z } from "zod";
import type { CollapseContext, CollapsedOperation, CollapsePlan, ValidationIssue, ValidatedPlan } from "./types.js";
import {
  SYNESIS_BATCH_READ,
  SYNESIS_BATCH_SEARCH,
  SYNESIS_MERGE_PATCH,
  SYNESIS_REPO_CONTEXT,
  SYNESIS_RUN_TESTS,
} from "./types.js";

const RelPathSchema = z.string().min(1).max(4096);
const WORKSPACE_ROOT_MAX_CHARS = 4096;

export const BatchReadArgsSchema = z.object({
  paths: z.array(RelPathSchema).min(1),
  _synesis_original_tool_call_ids: z.array(z.string()).optional(),
  _synesis_read_semantics: z.enum(["full_file_per_unique_path"]).optional(),
  _synesis_merged_duplicate_path_reads: z.boolean().optional(),
}).strict();

export const BatchSearchArgsSchema = z.object({
  items: z
    .array(
      z.object({
        query: z.string().min(1),
        path: z.string().optional(),
      }).strict(),
    )
    .min(2),
  _synesis_original_tool_call_ids: z.array(z.string()).optional(),
}).strict();

export const RepoContextArgsSchema = z.object({
  query: z.string().min(1),
  search_path: z.string().optional(),
  read_paths: z.array(RelPathSchema).min(1),
  _synesis_original_tool_call_ids: z.array(z.string()).optional(),
}).strict();

export const MergePatchArgsSchema = z.object({
  files: z
    .array(
      z.object({
        path: RelPathSchema,
        patch: z.string().min(1),
      }).strict(),
    )
    .min(1),
  _synesis_original_tool_call_ids: z.array(z.string()).optional(),
}).strict();

export const RunTestsArgsSchema = z.object({
  command: z.string().min(1).max(8000),
  _synesis_original_tool_call_ids: z.array(z.string()).optional(),
}).strict();

function isPathInsideRoot(resolvedFile: string, resolvedRoot: string): boolean {
  const normFile = path.normalize(resolvedFile);
  const normRoot = path.normalize(resolvedRoot);
  if (normFile === normRoot) return true;
  const prefix = normRoot.endsWith(path.sep) ? normRoot : `${normRoot}${path.sep}`;
  return normFile.startsWith(prefix);
}

function isAbsoluteWorkspaceRoot(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function isFilesystemRoot(value: string): boolean {
  if (value.startsWith("/")) {
    return path.posix.resolve(value) === "/";
  }
  if (!path.win32.isAbsolute(value)) {
    return false;
  }
  const normalized = path.win32.normalize(value);
  const parsed = path.win32.parse(normalized);
  return normalized.toLowerCase() === parsed.root.toLowerCase();
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function normalizeWorkspaceRoot(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  if (value.length > WORKSPACE_ROOT_MAX_CHARS) return null;
  if (hasControlCharacter(value)) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!isAbsoluteWorkspaceRoot(trimmed)) return null;
  if (isFilesystemRoot(trimmed)) return null;
  if (trimmed.startsWith("/")) return path.posix.resolve(trimmed);
  return path.win32.normalize(trimmed);
}

export function resolveSafePath(
  workspaceRoot: string | null,
  userPath: string,
): { ok: true; resolved: string } | { ok: false; error: string } {
  const trimmed = userPath.trim();
  if (!trimmed) return { ok: false, error: "empty path" };
  if (trimmed.includes("\0")) return { ok: false, error: "null byte in path" };

  if (!workspaceRoot) {
    return { ok: false, error: "workspace_root required for path validation" };
  }
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!normalizedRoot) {
    return { ok: false, error: "invalid workspace_root" };
  }

  const abs = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.normalize(path.join(normalizedRoot, trimmed));
  const rootResolved = path.resolve(normalizedRoot);
  if (!isPathInsideRoot(abs, rootResolved)) {
    return { ok: false, error: `path escapes workspace: ${userPath}` };
  }
  return { ok: true, resolved: abs };
}

export function isShellCommandAllowed(command: string, allowlist: RegExp[]): boolean {
  const c = command.trim();
  if (!c) return false;
  return allowlist.some((re) => re.test(c));
}

function validateBatchRead(
  op: Extract<CollapsedOperation, { kind: "batch_read" }>,
  ctx: CollapseContext,
  opIndex: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!ctx.workspaceRoot) {
    issues.push({ opIndex, message: "batch_read: missing workspace_root", severity: "error" });
    return issues;
  }
  for (const p of op.paths) {
    const r = resolveSafePath(ctx.workspaceRoot, p);
    if (!r.ok) issues.push({ opIndex, message: `batch_read: ${r.error}: ${p}`, severity: "error" });
  }
  return issues;
}

function validateBatchSearch(
  op: Extract<CollapsedOperation, { kind: "batch_search" }>,
  ctx: CollapseContext,
  opIndex: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!ctx.workspaceRoot) {
    return issues;
  }
  for (const it of op.items) {
    if (it.path) {
      const r = resolveSafePath(ctx.workspaceRoot, it.path);
      if (!r.ok) issues.push({ opIndex, message: `batch_search: ${r.error}: ${it.path}`, severity: "error" });
    }
  }
  return issues;
}

function validateRepoContext(
  op: Extract<CollapsedOperation, { kind: "repo_context" }>,
  ctx: CollapseContext,
  opIndex: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!ctx.workspaceRoot) {
    issues.push({ opIndex, message: "repo_context: missing workspace_root", severity: "error" });
    return issues;
  }
  if (op.search.path) {
    const r = resolveSafePath(ctx.workspaceRoot, op.search.path);
    if (!r.ok) issues.push({ opIndex, message: `repo_context search path: ${r.error}`, severity: "error" });
  }
  for (const rd of op.reads) {
    const r = resolveSafePath(ctx.workspaceRoot, rd.path);
    if (!r.ok) issues.push({ opIndex, message: `repo_context read: ${r.error}: ${rd.path}`, severity: "error" });
  }
  return issues;
}

function validateMergePatch(
  op: Extract<CollapsedOperation, { kind: "merge_patch" }>,
  ctx: CollapseContext,
  opIndex: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!ctx.workspaceRoot) {
    issues.push({ opIndex, message: "merge_patch: missing workspace_root", severity: "error" });
    return issues;
  }
  for (const f of op.files) {
    const r = resolveSafePath(ctx.workspaceRoot, f.path);
    if (!r.ok) issues.push({ opIndex, message: `merge_patch: ${r.error}: ${f.path}`, severity: "error" });
    const patch = f.patch;
    if (patch.length < 4 || (!patch.includes("@@") && !patch.startsWith("---") && !patch.startsWith("diff "))) {
      issues.push({ opIndex, message: `merge_patch: patch may be invalid for ${f.path}`, severity: "warn" });
    }
  }
  return issues;
}

function validateRunTests(
  op: Extract<CollapsedOperation, { kind: "run_tests" }>,
  ctx: CollapseContext,
  opIndex: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isShellCommandAllowed(op.command, ctx.shellAllowlist)) {
    issues.push({
      opIndex,
      message: `run_tests: command not on allowlist: ${op.command.slice(0, 200)}`,
      severity: "error",
    });
  }
  return issues;
}

export function validateCollapsePlan(plan: CollapsePlan, ctx: CollapseContext): ValidatedPlan {
  const issues: ValidationIssue[] = [];
  plan.operations.forEach((op, opIndex) => {
    switch (op.kind) {
      case "batch_read":
        issues.push(...validateBatchRead(op, ctx, opIndex));
        break;
      case "batch_search":
        issues.push(...validateBatchSearch(op, ctx, opIndex));
        break;
      case "repo_context":
        issues.push(...validateRepoContext(op, ctx, opIndex));
        break;
      case "merge_patch":
        issues.push(...validateMergePatch(op, ctx, opIndex));
        break;
      case "run_tests":
        issues.push(...validateRunTests(op, ctx, opIndex));
        break;
      default:
        break;
    }
  });
  const errors = issues.filter((i) => i.severity === "error");
  return { plan, issues, ok: errors.length === 0 };
}

export function parseSyntheticToolArgs(
  name: string,
  args: unknown,
): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    if (name === SYNESIS_BATCH_READ) {
      return { ok: true, data: BatchReadArgsSchema.parse(args) };
    }
    if (name === SYNESIS_BATCH_SEARCH) {
      return { ok: true, data: BatchSearchArgsSchema.parse(args) };
    }
    if (name === SYNESIS_REPO_CONTEXT) {
      return { ok: true, data: RepoContextArgsSchema.parse(args) };
    }
    if (name === SYNESIS_MERGE_PATCH) {
      return { ok: true, data: MergePatchArgsSchema.parse(args) };
    }
    if (name === SYNESIS_RUN_TESTS) {
      return { ok: true, data: RunTestsArgsSchema.parse(args) };
    }
    return { ok: false, error: `unknown synthetic tool: ${name}` };
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export function defaultShellAllowlistFromEnv(pattern: string): RegExp[] {
  const parts = pattern
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((p) => new RegExp(p));
}
