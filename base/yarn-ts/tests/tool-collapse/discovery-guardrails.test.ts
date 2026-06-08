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

  it("does not parse raw string inputs for guardrail decisions", () => {
    expect(isRootWildcardGlobCall("glob", JSON.stringify({ glob_pattern: "*" }))).toBe(false);
    expect(isEmptyGlobPatternCall("glob", JSON.stringify({ glob_pattern: "" }))).toBe(false);
    expect(broadDiscoverySignature("glob", JSON.stringify({ glob_pattern: "src/*" }))).toBeNull();
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

  it("redirects root wildcard to scoped pattern", () => {
    const out = applyDiscoveryGuardrails([
      { toolCallId: "1", toolName: "glob", input: { glob_pattern: "*" } },
      { toolCallId: "2", toolName: "glob", input: { glob_pattern: "**/*" } },
    ]);
    expect(out.calls).toHaveLength(2);
    expect(out.blocked).toHaveLength(0);
    expect(out.redirected).toHaveLength(2);
    expect(out.redirected[0]?.reason).toBe("root_wildcard_glob_redirected");
    expect(out.redirected[0]?.originalPattern).toBe("*");
  });

  it("redirects root wildcard to known top-level dir when available", () => {
    const out = applyDiscoveryGuardrails(
      [{ toolCallId: "1", toolName: "glob", input: { glob_pattern: "*" } }],
      ["cmd", "docs", "pkg", "src"],
    );
    expect(out.calls).toHaveLength(1);
    expect(out.redirected).toHaveLength(1);
    expect(out.redirected[0]?.redirectedPattern).toBe("src/*");
    const rewrittenInput = out.calls[0]?.input as Record<string, unknown>;
    expect(rewrittenInput.glob_pattern).toBe("src/*");
  });

  it("redirects empty glob to scoped pattern", () => {
    const out = applyDiscoveryGuardrails([
      { toolCallId: "1", toolName: "glob", input: { glob_pattern: "" } },
      { toolCallId: "2", toolName: "glob", input: { glob_pattern: "   " } },
    ]);
    expect(out.calls).toHaveLength(2);
    expect(out.blocked).toHaveLength(0);
    expect(out.redirected).toHaveLength(2);
    expect(out.redirected[0]?.reason).toBe("empty_glob_pattern_redirected");
  });

  it("uses first top-level dir as fallback when no src/lib/app/pkg/cmd found", () => {
    const out = applyDiscoveryGuardrails(
      [{ toolCallId: "1", toolName: "glob", input: { glob_pattern: "" } }],
      ["frontend", "backend", "scripts"],
    );
    expect(out.redirected[0]?.redirectedPattern).toBe("frontend/*");
  });

  it("falls back to . when no topLevelDirs provided", () => {
    const out = applyDiscoveryGuardrails(
      [{ toolCallId: "1", toolName: "glob", input: { glob_pattern: "" } }],
    );
    expect(out.redirected[0]?.redirectedPattern).toBe(".");
  });
});
