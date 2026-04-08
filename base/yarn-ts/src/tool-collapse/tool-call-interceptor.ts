import type { DedupeLayer } from "../dedupe/DedupeLayer.js";
import type { ToolPrefixCache } from "../tool-prefix-cache/ToolPrefixCache.js";
import { applyDiscoveryGuardrails } from "./discovery-guardrails.js";
import { collapseToolCalls } from "./tool-call-collapser.js";
import { executeCollapsePlan, type ToolCollapseExecutor } from "./tool-call-executor.js";
import { compactExecutionResults } from "./response-compactor.js";
import { validateCollapsePlan } from "./tool-call-validator.js";
import type { CollapseContext } from "./types.js";
import type {
  BatchReadCollapsed,
  BatchSearchCollapsed,
  CollapsePlan,
  InterceptDedupeStats,
  InterceptResult,
  MergePatchCollapsed,
  ParsedToolCall,
  RepoContextCollapsed,
  RunTestsCollapsed,
  ValidatedPlan,
} from "./types.js";
import {
  SYNESIS_BATCH_READ,
  SYNESIS_BATCH_SEARCH,
  SYNESIS_MERGE_PATCH,
  SYNESIS_REPO_CONTEXT,
  SYNESIS_RUN_TESTS,
} from "./types.js";

export interface ToolCallInterceptorOptions {
  workspaceRoot: string | null;
  shellAllowlist: RegExp[];
  strictValidation: boolean;
  execute: boolean;
  executor: ToolCollapseExecutor | null;
  /** When set, runs exact + segment dedupe then linear collapse (avoids double segment prepass). */
  dedupeLayer?: DedupeLayer | null;
  /** When set with a non-empty workspaceRoot and execute+executor, wraps the executor (after collapse, before run). */
  toolPrefixCache?: ToolPrefixCache | null;
  log?: (entry: { msg: string; data?: Record<string, unknown> }) => void;
}

function fallbackPassthroughPlan(calls: ParsedToolCall[]): CollapsePlan {
  return {
    operations: calls.map((c) => ({ kind: "passthrough" as const, calls: [c] })),
    log: [{ phase: "collapse", detail: "fallback_passthrough_all", atMs: Date.now() }],
  };
}

function countSdkCalls(plan: CollapsePlan): number {
  let n = 0;
  for (const op of plan.operations) {
    if (op.kind === "passthrough") n += op.calls.length;
    else n += 1;
  }
  return n;
}

/**
 * Map collapsed plan to synthetic Synesis tool calls (or passthrough originals).
 */
export function planToSyntheticToolCalls(
  plan: CollapsePlan,
): Array<{ toolCallId: string; toolName: string; input: Record<string, unknown> }> {
  const out: Array<{ toolCallId: string; toolName: string; input: Record<string, unknown> }> = [];
  for (const op of plan.operations) {
    if (op.kind === "passthrough") {
      for (const c of op.calls) {
        const input =
          typeof c.input === "object" && c.input !== null && !Array.isArray(c.input)
            ? (c.input as Record<string, unknown>)
            : { _raw: c.input };
        out.push({ toolCallId: c.toolCallId, toolName: c.toolName, input });
      }
      continue;
    }
    if (op.kind === "batch_read") {
      const b = op as BatchReadCollapsed;
      const primaryId = b.paths.length > 0 ? (b.pathToPrimaryId.get(b.paths[0]) ?? "synesis_batch") : "synesis_batch";
      const allIds = b.paths.flatMap((p) => b.pathToAllIds.get(p) ?? []);
      const mergedDup = b.paths.some((p) => (b.pathToAllIds.get(p)?.length ?? 0) > 1);
      out.push({
        toolCallId: primaryId,
        toolName: SYNESIS_BATCH_READ,
        input: {
          paths: b.paths,
          _synesis_original_tool_call_ids: allIds,
          _synesis_read_semantics: "full_file_per_unique_path",
          _synesis_merged_duplicate_path_reads: mergedDup,
        },
      });
      continue;
    }
    if (op.kind === "batch_search") {
      const s = op as BatchSearchCollapsed;
      out.push({
        toolCallId: s.originalIds[0] ?? "synesis_batch_search",
        toolName: SYNESIS_BATCH_SEARCH,
        input: {
          items: s.items.map((it) => ({ query: it.query, ...(it.path ? { path: it.path } : {}) })),
          _synesis_original_tool_call_ids: s.originalIds,
        },
      });
      continue;
    }
    if (op.kind === "repo_context") {
      const r = op as RepoContextCollapsed;
      out.push({
        toolCallId: r.originalIds[0] ?? "synesis_repo_ctx",
        toolName: SYNESIS_REPO_CONTEXT,
        input: {
          query: r.search.query,
          search_path: r.search.path,
          read_paths: r.reads.map((x) => x.path),
          _synesis_original_tool_call_ids: r.originalIds,
        },
      });
      continue;
    }
    if (op.kind === "merge_patch") {
      const m = op as MergePatchCollapsed;
      const firstId = m.files[0]?.originalIds[0] ?? "synesis_merge_patch";
      out.push({
        toolCallId: firstId,
        toolName: SYNESIS_MERGE_PATCH,
        input: {
          files: m.files.map((f) => ({ path: f.path, patch: f.patch })),
          _synesis_original_tool_call_ids: m.files.flatMap((f) => f.originalIds),
        },
      });
      continue;
    }
    if (op.kind === "run_tests") {
      const t = op as RunTestsCollapsed;
      out.push({
        toolCallId: t.originalIds[0] ?? "synesis_run_tests",
        toolName: SYNESIS_RUN_TESTS,
        input: {
          command: t.command,
          _synesis_original_tool_call_ids: t.originalIds,
        },
      });
      continue;
    }
  }
  return out;
}

export class ToolCallInterceptor {
  constructor(private readonly opts: ToolCallInterceptorOptions) {}

  buildContext(): CollapseContext {
    return {
      workspaceRoot: this.opts.workspaceRoot,
      shellAllowlist: this.opts.shellAllowlist,
    };
  }

  /**
   * Collapse → validate → optional execute → compact JSON.
   * On strict validation failure, falls back to per-call passthrough (no synthetic tools).
   */
  async processImmediate(calls: ParsedToolCall[]): Promise<InterceptResult> {
    const ctx = this.buildContext();
    const incomingCount = calls.length;
    const guarded = applyDiscoveryGuardrails(calls);
    const filteredCalls = guarded.calls as ParsedToolCall[];
    if (guarded.blocked.length > 0) {
      this.opts.log?.({
        msg: "tool_call_blocked_broad_discovery",
        data: {
          count: guarded.blocked.length,
          blocked: guarded.blocked.map((b) => ({ id: b.toolCallId, tool: b.toolName, reason: b.reason })),
        },
      });
    }
    if (guarded.collapsed.length > 0) {
      this.opts.log?.({
        msg: "duplicate_broad_call_collapsed",
        data: {
          count: guarded.collapsed.length,
          collapsed: guarded.collapsed.map((c) => ({
            duplicateId: c.duplicateToolCallId,
            canonicalId: c.canonicalToolCallId,
            signature: c.signature,
          })),
        },
      });
    }
    let dedupeStats: InterceptDedupeStats | undefined;
    let plan =
      this.opts.dedupeLayer != null
        ? (() => {
            const dr = this.opts.dedupeLayer.run(filteredCalls, incomingCount);
            dedupeStats = {
              droppedExact: dr.droppedExactIds.length,
              segmentDroppedReads: dr.segmentDroppedReadIds.length,
              segmentDroppedSearches: dr.segmentDroppedSearchIds.length,
            };
            return dr.plan;
          })()
        : collapseToolCalls(filteredCalls);
    let validated: ValidatedPlan = validateCollapsePlan(plan, ctx);

    if (!validated.ok && this.opts.strictValidation) {
      this.opts.log?.({
        msg: "tool_collapse_validation_fallback",
        data: { issues: validated.issues.map((i) => i.message).join("; ") },
      });
      plan = fallbackPassthroughPlan(filteredCalls);
      validated = validateCollapsePlan(plan, ctx);
    }

    const before = calls.length;
    const after = countSdkCalls(plan);
    const usedCollapse = after < before;

    const baseExecutor = this.opts.execute ? this.opts.executor : null;
    const executor =
      baseExecutor &&
      this.opts.toolPrefixCache &&
      typeof this.opts.workspaceRoot === "string" &&
      this.opts.workspaceRoot.trim()
        ? this.opts.toolPrefixCache.wrapExecutor(baseExecutor, this.opts.workspaceRoot)
        : baseExecutor;
    let executions = await executeCollapsePlan(plan, executor);
    if (!this.opts.execute) {
      executions = [];
    }

    const compactJson =
      executions.length > 0
        ? compactExecutionResults(executions)
        : JSON.stringify({ version: 1, results: [], plan_only: true });

    this.opts.log?.({
      msg: "tool_collapse_processed",
      data: {
        incoming: before,
        operations: plan.operations.length,
        validation_ok: validated.ok,
        usedCollapse,
      },
    });

    return {
      plan,
      validated,
      executions,
      compactJson,
      usedCollapse,
      ...(dedupeStats !== undefined ? { dedupe: dedupeStats } : {}),
    };
  }
}
