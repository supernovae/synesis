import { describe, expect, it } from "vitest";
import {
  extractToolSchemaName,
  pruneToolSchemas,
} from "../src/compat/tool-schema-pruning.js";

describe("tool schema pruning", () => {
  it("extracts tool names for OpenAI schemas", () => {
    const name = extractToolSchemaName({
      type: "function",
      function: { name: "Read", description: "read a file" },
    });
    expect(name).toBe("Read");
  });

  it("does not prune when under budget", () => {
    const tools = [
      { type: "function", function: { name: "Read" } },
      { type: "function", function: { name: "Write" } },
    ];
    const out = pruneToolSchemas(tools, 5, [], []);
    expect(out.pruned).toBe(false);
    expect(out.tools).toHaveLength(2);
  });

  it("keeps core tools when budget is tight", () => {
    const tools = [
      { type: "function", function: { name: "Read" } },
      { type: "function", function: { name: "SomeOptionalTool" } },
      { type: "function", function: { name: "Write" } },
      { type: "function", function: { name: "AnotherTool" } },
    ];
    const out = pruneToolSchemas(tools, 2, [], []);
    const names = out.tools.map((t) => extractToolSchemaName(t));
    expect(out.pruned).toBe(true);
    expect(names).toEqual(["Read", "Write"]);
  });

  it("prefers Synesis knowledge tools over web search when pruning (output order follows input)", () => {
    const tools = [
      { type: "function", function: { name: "synesis_web_search" } },
      { type: "function", function: { name: "synesis_knowledge_search" } },
      { type: "function", function: { name: "search_developer_docs" } },
      { type: "function", function: { name: "LowPriorityTool" } },
    ];
    const out = pruneToolSchemas(tools, 2, [], []);
    const names = out.tools.map((t) => extractToolSchemaName(t));
    expect(out.pruned).toBe(true);
    expect(names).toEqual(["synesis_knowledge_search", "search_developer_docs"]);
  });
});
