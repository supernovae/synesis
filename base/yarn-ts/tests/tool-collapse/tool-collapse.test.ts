import { describe, expect, it, vi } from "vitest";
import {
  collapseToolCalls,
  dedupeReadsAndSearchesWithinSegments,
  NEVER_COLLAPSE_NAMES,
  classifyTool,
} from "../../src/tool-collapse/tool-call-collapser.js";
import { ToolCallQueue } from "../../src/tool-collapse/tool-call-queue.js";
import { ToolCallInterceptor, planToSyntheticToolCalls } from "../../src/tool-collapse/tool-call-interceptor.js";
import {
  resolveSafePath,
  isShellCommandAllowed,
  validateCollapsePlan,
  defaultShellAllowlistFromEnv,
} from "../../src/tool-collapse/tool-call-validator.js";
import { executeCollapsePlan, type ToolCollapseExecutor } from "../../src/tool-collapse/tool-call-executor.js";
import { compactExecutionResults } from "../../src/tool-collapse/response-compactor.js";
import type { ParsedToolCall } from "../../src/tool-collapse/types.js";

describe("tool-call-collapser", () => {
  it("dedupes multiple read_file into batch_read", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "a", toolName: "read_file", input: { target_file: "src/a.ts" } },
      { toolCallId: "b", toolName: "read_file", input: { target_file: "src/b.ts" } },
      { toolCallId: "c", toolName: "read_file", input: { target_file: "src/a.ts" } },
    ];
    const plan = collapseToolCalls(calls);
    expect(plan.log.some((e) => e.detail.includes("prepass") && e.originalIds?.includes("c"))).toBe(true);
    const batch = plan.operations.find((o) => o.kind === "batch_read");
    expect(batch?.kind).toBe("batch_read");
    if (batch?.kind === "batch_read") {
      expect(batch.paths).toEqual(["src/a.ts", "src/b.ts"]);
      // Third read of a.ts was interleaved after b.ts → prepass drops it; first a.ts read id only in batch
      expect(batch.pathToAllIds.get("src/a.ts")).toEqual(["a"]);
    }
  });

  it("collapses same path with different line_range into one batch_read (full-file semantics)", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "1", toolName: "read_file", input: { path: "foo.js" } },
      { toolCallId: "2", toolName: "read_file", input: { path: "foo.js", line_range: [0, 200] } },
      { toolCallId: "3", toolName: "read_file", input: { path: "foo.js", line_range: [200, 400] } },
    ];
    const plan = collapseToolCalls(calls);
    const batch = plan.operations.find((o) => o.kind === "batch_read");
    expect(batch?.kind).toBe("batch_read");
    if (batch?.kind === "batch_read") {
      expect(batch.paths).toEqual(["foo.js"]);
      expect(batch.pathToAllIds.get("foo.js")).toEqual(["1", "2", "3"]);
    }
  });

  it("collapses search + read_file into repo_context", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "s", toolName: "codebase_search", input: { query: "foo", path: "src" } },
      { toolCallId: "r", toolName: "read_file", input: { path: "src/x.ts" } },
    ];
    const plan = collapseToolCalls(calls);
    expect(plan.operations[0]?.kind).toBe("repo_context");
  });

  it("keeps consecutive identical searches for batch_search (prepass does not drop)", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "x", toolName: "codebase_search", input: { query: "foo" } },
      { toolCallId: "y", toolName: "codebase_search", input: { query: "foo" } },
    ];
    const prepass = dedupeReadsAndSearchesWithinSegments(calls);
    expect(prepass.calls).toHaveLength(2);
    expect(prepass.droppedSearchIds).toHaveLength(0);
  });

  it("collapses consecutive searches into batch_search", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "a", toolName: "codebase_search", input: { query: "function foo" } },
      { toolCallId: "b", toolName: "codebase_search", input: { query: "foo(" } },
      { toolCallId: "c", toolName: "codebase_search", input: { query: "foo" } },
    ];
    const plan = collapseToolCalls(calls);
    const bs = plan.operations[0];
    expect(bs?.kind).toBe("batch_search");
    if (bs?.kind === "batch_search") {
      expect(bs.items.map((x) => x.query)).toEqual(["function foo", "foo(", "foo"]);
      expect(bs.originalIds).toEqual(["a", "b", "c"]);
    }
  });

  it("merges consecutive apply_patch for same file", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "p1", toolName: "apply_patch", input: { path: "f.ts", patch: "@@ -1 +1 @@\n-a\n+b" } },
      { toolCallId: "p2", toolName: "apply_patch", input: { path: "f.ts", patch: "@@ -2 +2 @@\n-x\n+y" } },
    ];
    const plan = collapseToolCalls(calls);
    const mp = plan.operations[0];
    expect(mp?.kind).toBe("merge_patch");
    if (mp?.kind === "merge_patch") {
      expect(mp.files).toHaveLength(1);
      expect(mp.files[0].originalIds).toEqual(["p1", "p2"]);
      expect(mp.files[0].patch).toContain("@@ -1");
      expect(mp.files[0].patch).toContain("@@ -2");
    }
  });

  it("never collapses synesis server tools", () => {
    expect(NEVER_COLLAPSE_NAMES.has("synesis_knowledge_search")).toBe(true);
    const calls: ParsedToolCall[] = [
      { toolCallId: "k", toolName: "synesis_knowledge_search", input: { q: "x" } },
      { toolCallId: "r", toolName: "read_file", input: { path: "a.ts" } },
    ];
    const plan = collapseToolCalls(calls);
    expect(plan.operations[0]?.kind).toBe("passthrough");
  });

  it("classifies common aliases", () => {
    expect(classifyTool("run_terminal_cmd")).toBe("run_tests");
    expect(classifyTool("view_file")).toBe("read_file");
  });

  it("prepass collapses read,search,read,search (same path/query) to read,search", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "r1", toolName: "read_file", input: { path: "foo.js" } },
      { toolCallId: "s1", toolName: "codebase_search", input: { query: "foo" } },
      { toolCallId: "r2", toolName: "read_file", input: { path: "foo.js" } },
      { toolCallId: "s2", toolName: "codebase_search", input: { query: "foo" } },
    ];
    const prepass = dedupeReadsAndSearchesWithinSegments(calls);
    expect(prepass.calls).toHaveLength(2);
    expect(prepass.calls[0].toolCallId).toBe("r1");
    expect(prepass.calls[1].toolCallId).toBe("s1");
    expect(prepass.droppedReadIds).toEqual(["r2"]);
    expect(prepass.droppedSearchIds).toEqual(["s2"]);
    const plan = collapseToolCalls(calls);
    expect(plan.log.some((e) => e.detail.includes("prepass_segment_dedupe"))).toBe(true);
  });

  it("prepass does not drop second read of same path after apply_patch", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "a", toolName: "read_file", input: { path: "foo.js" } },
      { toolCallId: "p", toolName: "apply_patch", input: { path: "foo.js", patch: "@@\n-a\n+b" } },
      { toolCallId: "b", toolName: "read_file", input: { path: "foo.js" } },
    ];
    const prepass = dedupeReadsAndSearchesWithinSegments(calls);
    expect(prepass.calls).toHaveLength(3);
    expect(prepass.droppedReadIds).toHaveLength(0);
  });

  it("prepass does not drop second read after run_terminal_cmd", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "a", toolName: "read_file", input: { path: "foo.js" } },
      { toolCallId: "t", toolName: "run_terminal_cmd", input: { command: "npm test" } },
      { toolCallId: "b", toolName: "read_file", input: { path: "foo.js" } },
    ];
    const prepass = dedupeReadsAndSearchesWithinSegments(calls);
    expect(prepass.calls).toHaveLength(3);
    expect(prepass.droppedReadIds).toHaveLength(0);
  });

  it("prepass keeps searches with same query but different path scope", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "s1", toolName: "codebase_search", input: { query: "foo", path: "src/" } },
      { toolCallId: "s2", toolName: "codebase_search", input: { query: "foo", path: "lib/" } },
    ];
    const prepass = dedupeReadsAndSearchesWithinSegments(calls);
    expect(prepass.calls).toHaveLength(2);
    expect(prepass.droppedSearchIds).toHaveLength(0);
  });

  it("prepass does not dedupe reads across synesis_knowledge (protected passthrough)", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "r1", toolName: "read_file", input: { path: "foo.js" } },
      { toolCallId: "k", toolName: "synesis_knowledge_search", input: { q: "x" } },
      { toolCallId: "r2", toolName: "read_file", input: { path: "foo.js" } },
    ];
    const prepass = dedupeReadsAndSearchesWithinSegments(calls);
    expect(prepass.calls.map((c) => c.toolCallId)).toEqual(["r1", "k", "r2"]);
    expect(prepass.droppedReadIds).toHaveLength(0);
  });
});

describe("tool-call-validator", () => {
  const root = "/tmp/synesis-ws";

  it("rejects path traversal", () => {
    const r = resolveSafePath(root, "../etc/passwd");
    expect(r.ok).toBe(false);
  });

  it("resolves safe relative path", () => {
    const r = resolveSafePath(root, "src/foo.ts");
    expect(r.ok).toBe(true);
  });

  it("shell allowlist", () => {
    const re = defaultShellAllowlistFromEnv("^pytest\\s|^go test\\s");
    expect(isShellCommandAllowed("pytest -q", re)).toBe(true);
    expect(isShellCommandAllowed("rm -rf /", re)).toBe(false);
  });

  it("validateCollapsePlan errors without workspace for batch_read", () => {
    const plan = collapseToolCalls([
      { toolCallId: "a", toolName: "read_file", input: { path: "a.ts" } },
      { toolCallId: "b", toolName: "read_file", input: { path: "b.ts" } },
    ]);
    const v = validateCollapsePlan(plan, { workspaceRoot: null, shellAllowlist: [] });
    const batchOp = plan.operations.find((o) => o.kind === "batch_read");
    if (batchOp) {
      expect(v.ok).toBe(false);
    }
  });
});

describe("tool-call-queue", () => {
  it("debounces flush", async () => {
    const q = new ToolCallQueue({ debounceMs: 30 });
    const p = new Promise<ParsedToolCall[]>((resolve) => {
      q.once("flush", resolve);
    });
    q.enqueue({ toolCallId: "1", toolName: "read_file", input: {} });
    q.enqueue({ toolCallId: "2", toolName: "read_file", input: {} });
    const batch = await p;
    expect(batch).toHaveLength(2);
  });

  it("flushNow is immediate", () => {
    const q = new ToolCallQueue({ debounceMs: 100 });
    const batches: ParsedToolCall[][] = [];
    q.on("flush", (b) => batches.push(b));
    q.enqueue({ toolCallId: "x", toolName: "read_file", input: {} });
    q.flushNow();
    expect(batches).toHaveLength(1);
  });
});

describe("tool-call-interceptor", () => {
  it("redirects root wildcard glob before collapse planning", async () => {
    const ix = new ToolCallInterceptor({
      workspaceRoot: "/tmp/synesis-tool-collapse-test",
      shellAllowlist: [],
      strictValidation: true,
      execute: false,
      executor: null,
    });
    const r = await ix.processImmediate([
      { toolCallId: "a", toolName: "glob", input: { glob_pattern: "*" } },
      { toolCallId: "b", toolName: "read_file", input: { path: "src/a.ts" } },
    ]);
    const syn = planToSyntheticToolCalls(r.plan);
    expect(syn.some((s) => s.toolCallId === "a")).toBe(true);
    expect(syn.some((s) => s.toolCallId === "b")).toBe(true);
  });

  it("fallback passthrough when strict validation fails", async () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "a", toolName: "read_file", input: { path: "a.ts" } },
      { toolCallId: "b", toolName: "read_file", input: { path: "b.ts" } },
    ];
    const ix = new ToolCallInterceptor({
      workspaceRoot: null,
      shellAllowlist: [],
      strictValidation: true,
      execute: false,
      executor: null,
    });
    const r = await ix.processImmediate(calls);
    expect(r.validated.ok).toBe(true); // passthrough plan validates
    expect(r.plan.operations.every((o) => o.kind === "passthrough")).toBe(true);
    expect(r.usedCollapse).toBe(false);
  });

  it("produces synthetic tool calls when valid", async () => {
    const root = "/tmp/synesis-tool-collapse-test";
    const calls: ParsedToolCall[] = [
      { toolCallId: "a", toolName: "read_file", input: { path: "a.ts" } },
      { toolCallId: "b", toolName: "read_file", input: { path: "b.ts" } },
    ];
    const ix = new ToolCallInterceptor({
      workspaceRoot: root,
      shellAllowlist: defaultShellAllowlistFromEnv("^pytest\\s"),
      strictValidation: true,
      execute: false,
      executor: null,
    });
    const r = await ix.processImmediate(calls);
    expect(r.validated.ok).toBe(true);
    const syn = planToSyntheticToolCalls(r.plan);
    expect(syn.some((s) => s.toolName === "synesis_batch_read")).toBe(true);
    const br = syn.find((s) => s.toolName === "synesis_batch_read");
    expect(br?.input._synesis_read_semantics).toBe("full_file_per_unique_path");
    expect(br?.input._synesis_merged_duplicate_path_reads).toBe(false);
  });

  it("marks merged duplicate path reads in synthetic batch_read", async () => {
    const root = "/tmp/synesis-tool-collapse-test";
    const calls: ParsedToolCall[] = [
      { toolCallId: "a", toolName: "read_file", input: { path: "x.ts", line_range: [0, 10] } },
      { toolCallId: "b", toolName: "read_file", input: { path: "x.ts", line_range: [10, 20] } },
    ];
    const ix = new ToolCallInterceptor({
      workspaceRoot: root,
      shellAllowlist: [],
      strictValidation: true,
      execute: false,
      executor: null,
    });
    const r = await ix.processImmediate(calls);
    const syn = planToSyntheticToolCalls(r.plan);
    const br = syn.find((s) => s.toolName === "synesis_batch_read");
    expect(br?.input._synesis_merged_duplicate_path_reads).toBe(true);
  });
});

describe("tool-call-executor", () => {
  it("invokes executor per collapsed op", async () => {
    const ex: ToolCollapseExecutor = {
      batchRead: vi.fn(async (paths) => ({ paths })),
      batchSearch: vi.fn(async () => ({})),
      repoContext: vi.fn(async () => ({})),
      mergePatch: vi.fn(async () => ({})),
      runTests: vi.fn(async () => ({})),
    };
    const plan = collapseToolCalls([
      { toolCallId: "a", toolName: "read_file", input: { path: "x.ts" } },
      { toolCallId: "b", toolName: "read_file", input: { path: "y.ts" } },
    ]);
    const results = await executeCollapsePlan(plan, ex);
    expect(ex.batchRead).toHaveBeenCalled();
    expect(results.some((r) => r.kind === "batch_read")).toBe(true);
  });

  it("invokes batchSearch for batch_search op", async () => {
    const ex: ToolCollapseExecutor = {
      batchRead: vi.fn(async () => ({})),
      batchSearch: vi.fn(async (items) => ({ items })),
      repoContext: vi.fn(async () => ({})),
      mergePatch: vi.fn(async () => ({})),
      runTests: vi.fn(async () => ({})),
    };
    const plan = collapseToolCalls([
      { toolCallId: "a", toolName: "grep", input: { pattern: "foo" } },
      { toolCallId: "b", toolName: "grep", input: { pattern: "bar" } },
    ]);
    const results = await executeCollapsePlan(plan, ex);
    expect(ex.batchSearch).toHaveBeenCalledWith([
      { query: "foo", path: undefined },
      { query: "bar", path: undefined },
    ]);
    expect(results.some((r) => r.kind === "batch_search")).toBe(true);
  });
});

describe("response-compactor", () => {
  it("emits deterministic JSON", () => {
    const j = compactExecutionResults([
      { operationIndex: 0, kind: "batch_read", payload: { z: 1, a: 2 } },
    ]);
    const o = JSON.parse(j) as { results: unknown[] };
    expect(o.results).toHaveLength(1);
  });
});
