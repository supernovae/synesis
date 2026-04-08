import { describe, expect, it } from "vitest";
import {
  applyDiscoveryGuardrails,
  isRootWildcardGlobCall,
  isEmptyGlobPatternCall,
  broadDiscoverySignature,
} from "../../src/tool-collapse/discovery-guardrails.js";

describe("discovery-guardrails", () => {
  it("blocks root wildcard glob patterns", () => {
    expect(isRootWildcardGlobCall("Glob", { glob_pattern: "*" })).toBe(true);
    expect(isRootWildcardGlobCall("glob", { glob_pattern: "**/*" })).toBe(true);
    expect(isRootWildcardGlobCall("glob", { glob_pattern: "src/*" })).toBe(false);
  });

  it("blocks empty glob patterns", () => {
    expect(isEmptyGlobPatternCall("Glob", { glob_pattern: "" })).toBe(true);
    expect(isEmptyGlobPatternCall("glob", { pattern: "   " })).toBe(true);
    expect(isEmptyGlobPatternCall("glob", { glob_pattern: "src/*" })).toBe(false);
  });

  it("creates stable broad discovery signatures", () => {
    expect(broadDiscoverySignature("glob", { glob_pattern: "src/*" })).toBe("glob:src/*");
    expect(broadDiscoverySignature("list_dir", { path: "." })).toBe("list:.");
  });

  it("collapses same-turn duplicate broad discovery calls", () => {
    const out = applyDiscoveryGuardrails([
      { toolCallId: "1", toolName: "glob", input: { glob_pattern: "src/*" } },
      { toolCallId: "2", toolName: "glob", input: { glob_pattern: "src/*" } },
      { toolCallId: "3", toolName: "list_dir", input: { path: "." } },
      { toolCallId: "4", toolName: "list_dir", input: { path: "." } },
    ]);
    expect(out.calls.map((c) => c.toolCallId)).toEqual(["1", "3"]);
    expect(out.collapsed).toHaveLength(2);
  });

  it("blocks root wildcard before collapse", () => {
    const out = applyDiscoveryGuardrails([
      { toolCallId: "1", toolName: "glob", input: { glob_pattern: "*" } },
      { toolCallId: "2", toolName: "glob", input: { glob_pattern: "*" } },
    ]);
    expect(out.calls).toHaveLength(0);
    expect(out.blocked).toHaveLength(2);
  });

  it("blocks empty glob before collapse", () => {
    const out = applyDiscoveryGuardrails([
      { toolCallId: "1", toolName: "glob", input: { glob_pattern: "" } },
      { toolCallId: "2", toolName: "glob", input: { glob_pattern: "   " } },
    ]);
    expect(out.calls).toHaveLength(0);
    expect(out.blocked).toHaveLength(2);
    expect(out.blocked[0]?.reason).toBe("empty_glob_pattern_blocked");
  });
});
