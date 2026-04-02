/**
 * Tool call collapsing — types for batching, merging, and safe execution.
 */

export type ToolKind = "read_file" | "search" | "apply_patch" | "run_tests" | "passthrough";

export interface ParsedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface CollapseContext {
  workspaceRoot: string | null;
  shellAllowlist: RegExp[];
}

/** Synthetic collapsed tool names (Synesis-specific; clients opt in). */
export const SYNESIS_BATCH_READ = "synesis_batch_read";
export const SYNESIS_BATCH_SEARCH = "synesis_batch_search";
export const SYNESIS_REPO_CONTEXT = "synesis_repo_context";
export const SYNESIS_MERGE_PATCH = "synesis_merge_patch";
export const SYNESIS_RUN_TESTS = "synesis_run_tests";

export interface CollapseLogEntry {
  phase: "receive" | "collapse" | "validate" | "execute" | "compact";
  detail: string;
  atMs: number;
  originalIds?: string[];
  syntheticName?: string;
}

export interface BatchReadCollapsed {
  kind: "batch_read";
  paths: string[];
  pathToPrimaryId: Map<string, string>;
  pathToAllIds: Map<string, string[]>;
}

export interface RepoContextCollapsed {
  kind: "repo_context";
  search: { query: string; path?: string };
  reads: Array<{ path: string; toolCallId: string }>;
  originalIds: string[];
}

/** Consecutive codebase_search / grep-style calls collapsed to one round-trip. */
export interface BatchSearchCollapsed {
  kind: "batch_search";
  items: Array<{ query: string; path?: string }>;
  originalIds: string[];
}

export interface MergePatchCollapsed {
  kind: "merge_patch";
  files: Array<{ path: string; patch: string; originalIds: string[] }>;
}

export interface RunTestsCollapsed {
  kind: "run_tests";
  command: string;
  originalIds: string[];
}

export interface PassthroughCollapsed {
  kind: "passthrough";
  calls: ParsedToolCall[];
}

export type CollapsedOperation =
  | BatchReadCollapsed
  | BatchSearchCollapsed
  | RepoContextCollapsed
  | MergePatchCollapsed
  | RunTestsCollapsed
  | PassthroughCollapsed;

export interface CollapsePlan {
  operations: CollapsedOperation[];
  log: CollapseLogEntry[];
}

export interface ValidationIssue {
  opIndex: number;
  message: string;
  severity: "error" | "warn";
}

export interface ValidatedPlan {
  plan: CollapsePlan;
  issues: ValidationIssue[];
  ok: boolean;
}

export interface ExecutionResult {
  operationIndex: number;
  kind: CollapsedOperation["kind"];
  payload: unknown;
  error?: string;
}

/** Populated when the interceptor used [`DedupeLayer`](../dedupe/DedupeLayer.ts). */
export interface InterceptDedupeStats {
  droppedExact: number;
  segmentDroppedReads: number;
  segmentDroppedSearches: number;
}

export interface InterceptResult {
  plan: CollapsePlan;
  validated: ValidatedPlan;
  executions: ExecutionResult[];
  compactJson: string;
  usedCollapse: boolean;
  dedupe?: InterceptDedupeStats;
}
