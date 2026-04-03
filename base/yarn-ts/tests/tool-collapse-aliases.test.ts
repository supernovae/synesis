import { describe, expect, it } from "vitest";
import { classifyTool, collapseToolCalls } from "../src/tool-collapse/tool-call-collapser.js";

describe("tool alias classification", () => {
  it("classifies canonical and parity aliases", () => {
    expect(classifyTool("read_file")).toBe("read_file");
    expect(classifyTool("Read")).toBe("read_file");
    expect(classifyTool("search_code")).toBe("search");
    expect(classifyTool("rg")).toBe("search");
    expect(classifyTool("apply_patch")).toBe("apply_patch");
    expect(classifyTool("run_test")).toBe("run_tests");
  });

  it("collapses parity aliases for read/search", () => {
    const plan = collapseToolCalls([
      { toolCallId: "1", toolName: "read_file", input: { path: "a.ts" } },
      { toolCallId: "2", toolName: "Read", input: { file_path: "b.ts" } },
      { toolCallId: "3", toolName: "search_code", input: { query: "foo" } },
      { toolCallId: "4", toolName: "rg", input: { pattern: "bar" } },
    ]);
    expect(plan.operations.some((o) => o.kind === "batch_read")).toBe(true);
    expect(plan.operations.some((o) => o.kind === "batch_search")).toBe(true);
  });

  it("handles large tool batches without blowing up", () => {
    const calls = Array.from({ length: 300 }, (_, i) => ({
      toolCallId: String(i + 1),
      toolName: i % 2 === 0 ? "read_file" : "Read",
      input: { path: `src/file-${i}.ts` },
    }));
    const start = Date.now();
    const plan = collapseToolCalls(calls);
    const elapsed = Date.now() - start;
    expect(plan.operations.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });
});

