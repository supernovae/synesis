import { describe, expect, it, vi } from "vitest";
import { classifyCollapsedKindPolicy } from "../../src/tool-prefix-cache/cache-policy.js";
import {
  extractBatchReadMap,
  looksLikeErrorPayload,
  looksLikePartialPayload,
} from "../../src/tool-prefix-cache/payload-extract.js";
import { ToolPrefixCache } from "../../src/tool-prefix-cache/ToolPrefixCache.js";
import { deterministicTruncateMiddle } from "../../src/tool-prefix-cache/summaries.js";
import type { ToolCollapseExecutor } from "../../src/tool-collapse/tool-call-executor.js";

const ROOT = "/tmp/synesis-prefix-cache-test";

describe("classifyCollapsedKindPolicy", () => {
  it("marks read/search/repo as cacheable and patch as invalidate-only", () => {
    expect(classifyCollapsedKindPolicy("batch_read")).toBe("read_write_safe");
    expect(classifyCollapsedKindPolicy("batch_search")).toBe("read_write_safe");
    expect(classifyCollapsedKindPolicy("repo_context")).toBe("read_write_safe");
    expect(classifyCollapsedKindPolicy("merge_patch")).toBe("invalidate_generation");
    expect(classifyCollapsedKindPolicy("run_tests")).toBe("never");
    expect(classifyCollapsedKindPolicy("passthrough")).toBe("never");
  });
});

describe("payload-extract", () => {
  it("extracts paths+contents arrays", () => {
    const m = extractBatchReadMap(
      { paths: ["a.ts", "b.ts"], contents: ["x", "y"] },
      ["a.ts", "b.ts"],
    );
    expect(m.get("a.ts")).toBe("x");
    expect(m.get("b.ts")).toBe("y");
  });

  it("detects error-shaped payloads", () => {
    expect(looksLikeErrorPayload({ ok: false })).toBe(true);
    expect(looksLikeErrorPayload({ error: "x" })).toBe(true);
    expect(looksLikeErrorPayload({ ok: true })).toBe(false);
  });

  it("detects partial payloads", () => {
    expect(looksLikePartialPayload({ partial: true })).toBe(true);
    expect(looksLikePartialPayload({ status: "in_progress" })).toBe(true);
    expect(looksLikePartialPayload({ done: true })).toBe(false);
  });
});

describe("deterministicTruncateMiddle", () => {
  it("is stable for the same input", () => {
    const s = "a".repeat(200);
    expect(deterministicTruncateMiddle(s, 80)).toBe(deterministicTruncateMiddle(s, 80));
  });
});

describe("ToolPrefixCache.wrapExecutor", () => {
  it("returns full batch_read hit without calling inner", async () => {
    const inner: ToolCollapseExecutor = {
      batchRead: vi.fn(async () => ({ paths: ["x.ts"], contents: ["body"] })),
      batchSearch: vi.fn(async () => ({})),
      repoContext: vi.fn(async () => ({})),
      mergePatch: vi.fn(async () => ({})),
      runTests: vi.fn(async () => ({})),
    };
    const cache = new ToolPrefixCache({ maxEntries: 64, maxEntryBytes: 1_000_000 });
    const w1 = cache.wrapExecutor(inner, ROOT);
    await w1.batchRead(["x.ts"]);
    expect(inner.batchRead).toHaveBeenCalledTimes(1);
    await w1.batchRead(["x.ts"]);
    expect(inner.batchRead).toHaveBeenCalledTimes(1);
    expect(cache.getStats().readHits).toBeGreaterThanOrEqual(1);
  });

  it("does not cache error payloads", async () => {
    let n = 0;
    const inner: ToolCollapseExecutor = {
      batchRead: vi.fn(async () => {
        n++;
        return { ok: false, error: "nope" };
      }),
      batchSearch: vi.fn(async () => ({})),
      repoContext: vi.fn(async () => ({})),
      mergePatch: vi.fn(async () => ({})),
      runTests: vi.fn(async () => ({})),
    };
    const cache = new ToolPrefixCache({ maxEntries: 64, maxEntryBytes: 1_000_000 });
    const w = cache.wrapExecutor(inner, ROOT);
    await w.batchRead(["a.ts"]);
    await w.batchRead(["a.ts"]);
    expect(n).toBe(2);
  });

  it("bumps generation on successful merge_patch so batch_search key changes", async () => {
    const inner: ToolCollapseExecutor = {
      batchRead: vi.fn(async () => ({})),
      batchSearch: vi.fn(async (items) => ({ items })),
      repoContext: vi.fn(async () => ({})),
      mergePatch: vi.fn(async () => ({ ok: true })),
      runTests: vi.fn(async () => ({})),
    };
    const cache = new ToolPrefixCache({ maxEntries: 64, maxEntryBytes: 1_000_000 });
    const w = cache.wrapExecutor(inner, ROOT);
    await w.batchSearch([{ query: "foo" }]);
    await w.batchSearch([{ query: "foo" }]);
    expect(inner.batchSearch).toHaveBeenCalledTimes(1);
    await w.mergePatch([{ path: "a.ts", patch: "@@\n-a\n+b" }]);
    await w.batchSearch([{ query: "foo" }]);
    expect(inner.batchSearch).toHaveBeenCalledTimes(2);
    expect(cache.getStats().mutationInvalidations).toBe(1);
  });

  it("passthrough: null workspace disables wrap", async () => {
    const inner: ToolCollapseExecutor = {
      batchRead: vi.fn(async () => ({ paths: ["a.ts"], contents: ["x"] })),
      batchSearch: vi.fn(async () => ({})),
      repoContext: vi.fn(async () => ({})),
      mergePatch: vi.fn(async () => ({})),
      runTests: vi.fn(async () => ({})),
    };
    const cache = new ToolPrefixCache({ maxEntries: 64, maxEntryBytes: 1_000_000 });
    const w = cache.wrapExecutor(inner, null);
    await w.batchRead(["a.ts"]);
    await w.batchRead(["a.ts"]);
    expect(inner.batchRead).toHaveBeenCalledTimes(2);
  });
});
