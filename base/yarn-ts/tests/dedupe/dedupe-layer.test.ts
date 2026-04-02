import { describe, expect, it } from "vitest";
import { collapseToolCalls } from "../../src/tool-collapse/tool-call-collapser.js";
import { ToolCallInterceptor } from "../../src/tool-collapse/tool-call-interceptor.js";
import { defaultShellAllowlistFromEnv } from "../../src/tool-collapse/tool-call-validator.js";
import type { ParsedToolCall } from "../../src/tool-collapse/types.js";
import { DedupeLayer } from "../../src/dedupe/DedupeLayer.js";
import {
  patchCallsAreByteIdentical,
  stripConsecutiveExactDuplicates,
} from "../../src/dedupe/ToolCallDedupe.js";
import { normalizeSearchQueryForSafety } from "../../src/dedupe/SemanticDedupe.js";

const layerOpts = { maxCacheEntries: 128, maxSearchQueryChars: 4096 } as const;

describe("stripConsecutiveExactDuplicates", () => {
  it("drops the second consecutive identical read_file", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "a", toolName: "read_file", input: { path: "x.ts" } },
      { toolCallId: "b", toolName: "read_file", input: { path: "x.ts" } },
    ];
    const log: import("../../src/tool-collapse/types.js").CollapseLogEntry[] = [];
    const r = stripConsecutiveExactDuplicates(calls, log);
    expect(r.calls.map((c) => c.toolCallId)).toEqual(["a"]);
    expect(r.droppedIds).toEqual(["b"]);
    expect(r.duplicateOf.get("b")).toBe("a");
  });

  it("keeps identical reads when separated by another call", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "a", toolName: "read_file", input: { path: "x.ts" } },
      { toolCallId: "m", toolName: "get_metadata", input: {} },
      { toolCallId: "b", toolName: "read_file", input: { path: "x.ts" } },
    ];
    const log: import("../../src/tool-collapse/types.js").CollapseLogEntry[] = [];
    const r = stripConsecutiveExactDuplicates(calls, log);
    expect(r.calls.map((c) => c.toolCallId)).toEqual(["a", "m", "b"]);
    expect(r.droppedIds).toHaveLength(0);
  });

  it("does not dedupe consecutive run_terminal_cmd", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "a", toolName: "run_terminal_cmd", input: { command: "npm test" } },
      { toolCallId: "b", toolName: "run_terminal_cmd", input: { command: "npm test" } },
    ];
    const log: import("../../src/tool-collapse/types.js").CollapseLogEntry[] = [];
    const r = stripConsecutiveExactDuplicates(calls, log);
    expect(r.calls).toHaveLength(2);
  });

  it("dedupes consecutive byte-identical apply_patch", () => {
    const input = { path: "f.ts", patch: "@@ -1 +1 @@\n-a\n+b" };
    const calls: ParsedToolCall[] = [
      { toolCallId: "p1", toolName: "apply_patch", input },
      { toolCallId: "p2", toolName: "apply_patch", input },
    ];
    const log: import("../../src/tool-collapse/types.js").CollapseLogEntry[] = [];
    const r = stripConsecutiveExactDuplicates(calls, log);
    expect(r.calls.map((c) => c.toolCallId)).toEqual(["p1"]);
    expect(r.droppedIds).toEqual(["p2"]);
  });

  it("keeps consecutive apply_patch when patch body differs", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "p1", toolName: "apply_patch", input: { path: "f.ts", patch: "A" } },
      { toolCallId: "p2", toolName: "apply_patch", input: { path: "f.ts", patch: "B" } },
    ];
    const log: import("../../src/tool-collapse/types.js").CollapseLogEntry[] = [];
    const r = stripConsecutiveExactDuplicates(calls, log);
    expect(r.calls).toHaveLength(2);
  });
});

describe("patchCallsAreByteIdentical", () => {
  it("returns true only for same path and patch", () => {
    const a: ParsedToolCall = { toolCallId: "1", toolName: "apply_patch", input: { path: "x", patch: "p" } };
    const b: ParsedToolCall = { toolCallId: "2", toolName: "apply_patch", input: { path: "x", patch: "p" } };
    const c: ParsedToolCall = { toolCallId: "3", toolName: "apply_patch", input: { path: "y", patch: "p" } };
    expect(patchCallsAreByteIdentical(a, b)).toBe(true);
    expect(patchCallsAreByteIdentical(a, c)).toBe(false);
  });
});

describe("DedupeLayer", () => {
  it("runs exact dedupe then linear collapse (no double segment prepass vs collapseToolCalls)", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "a", toolName: "read_file", input: { path: "src/a.ts" } },
      { toolCallId: "dup", toolName: "read_file", input: { path: "src/a.ts" } },
      { toolCallId: "b", toolName: "read_file", input: { path: "src/b.ts" } },
    ];
    const layer = new DedupeLayer(layerOpts);
    const dr = layer.run(calls);
    expect(dr.droppedExactIds).toEqual(["dup"]);
    const ref = collapseToolCalls(calls.filter((c) => c.toolCallId !== "dup"));
    expect(dr.plan.operations.length).toBe(ref.operations.length);
    const drBatch = dr.plan.operations.find((o) => o.kind === "batch_read");
    const refBatch = ref.operations.find((o) => o.kind === "batch_read");
    expect(drBatch?.kind).toBe("batch_read");
    expect(refBatch?.kind).toBe("batch_read");
    if (drBatch?.kind === "batch_read" && refBatch?.kind === "batch_read") {
      expect(drBatch.paths).toEqual(refBatch.paths);
    }
  });

  it("logs segment dedupe once (interleaved duplicate read)", () => {
    const calls: ParsedToolCall[] = [
      { toolCallId: "r1", toolName: "read_file", input: { path: "foo.js" } },
      { toolCallId: "s1", toolName: "codebase_search", input: { query: "q" } },
      { toolCallId: "r2", toolName: "read_file", input: { path: "foo.js" } },
    ];
    const layer = new DedupeLayer(layerOpts);
    const dr = layer.run(calls);
    expect(dr.segmentDroppedReadIds).toContain("r2");
    expect(dr.plan.log.some((e) => e.detail.includes("dedupe_segment"))).toBe(true);
  });
});

describe("normalizeSearchQueryForSafety", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeSearchQueryForSafety("  a   b\tc  ", 100)).toBe("a b c");
  });
});

describe("ToolCallInterceptor + DedupeLayer", () => {
  it("returns dedupe stats when dedupeLayer is attached", async () => {
    const root = "/tmp/synesis-dedupe-test";
    const calls: ParsedToolCall[] = [
      { toolCallId: "a", toolName: "read_file", input: { path: "a.ts" } },
      { toolCallId: "b", toolName: "read_file", input: { path: "a.ts" } },
    ];
    const ix = new ToolCallInterceptor({
      workspaceRoot: root,
      shellAllowlist: defaultShellAllowlistFromEnv("^pytest\\s"),
      strictValidation: true,
      execute: false,
      executor: null,
      dedupeLayer: new DedupeLayer(layerOpts),
    });
    const r = await ix.processImmediate(calls);
    expect(r.dedupe?.droppedExact).toBe(1);
    expect(r.validated.ok).toBe(true);
  });

  it("omits dedupe field when dedupeLayer is unset", async () => {
    const ix = new ToolCallInterceptor({
      workspaceRoot: "/tmp/synesis-dedupe-test",
      shellAllowlist: [],
      strictValidation: true,
      execute: false,
      executor: null,
    });
    const r = await ix.processImmediate([
      { toolCallId: "a", toolName: "read_file", input: { path: "a.ts" } },
    ]);
    expect(r.dedupe).toBeUndefined();
  });
});
