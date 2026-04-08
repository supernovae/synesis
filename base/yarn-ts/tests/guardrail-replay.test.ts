import { describe, expect, it } from "vitest";
import { applyDiscoveryGuardrails } from "../src/tool-collapse/discovery-guardrails.js";

describe("guardrail replay: test-generation discovery loop", () => {
  it("blocks repeated root wildcard discovery and preserves actionable calls", () => {
    const replayCalls = [
      { toolCallId: "search-1", toolName: "Glob", input: { glob_pattern: "*" } },
      { toolCallId: "search-2", toolName: "Glob", input: { glob_pattern: "*" } },
      { toolCallId: "search-3", toolName: "Glob", input: { glob_pattern: "*" } },
      { toolCallId: "next-1", toolName: "list_dir", input: { path: "src" } },
      { toolCallId: "next-2", toolName: "search_code", input: { query: "retry behavior", path: "src" } },
    ];
    const out = applyDiscoveryGuardrails(replayCalls);
    expect(out.blocked).toHaveLength(3);
    expect(out.calls.map((c) => c.toolCallId)).toEqual(["next-1", "next-2"]);
  });
});
