import { describe, expect, it } from "vitest";
import {
  buildBlockedDiscoveryGuidance,
  buildBlockedDiscoveryRecoveryWithSnapshot,
  buildBlockedDiscoveryRecoveryWithoutSnapshot,
} from "../../src/tool-collapse/blocked-discovery-recovery.js";

describe("blocked-discovery-recovery", () => {
  it("includes plain-language feedback alongside guardrail metadata", () => {
    const out = buildBlockedDiscoveryGuidance("minimax-m2.5", [
      { toolName: "Glob", reason: "root_wildcard_glob_blocked", argsPreview: "{\"glob_pattern\":\"*\"}" },
    ]);
    expect(out).toContain("Blocked 1 broad discovery tool call(s)");
    expect(out).toContain("Root-level wildcard globs are disabled");
    expect(out).toContain("startup_policy=minimax_constrained_discovery");
  });

  it("builds a generic fallback recovery block when snapshot is unavailable", () => {
    const base = buildBlockedDiscoveryGuidance("synesis-core", [
      { toolName: "Glob", reason: "root_wildcard_glob_blocked" },
    ]);
    const out = buildBlockedDiscoveryRecoveryWithoutSnapshot(base, "no_project_root");
    expect(out).toContain("Recovery hint:");
    expect(out).toContain("code=\"no_project_root\"");
    expect(out).toContain("next_action=list_dir:.|glob:src/*|search_code:<symbol>");
  });

  it("builds snapshot recovery with preview entries", () => {
    const base = buildBlockedDiscoveryGuidance("synesis-core", [
      { toolName: "Glob", reason: "root_wildcard_glob_blocked" },
    ]);
    const out = buildBlockedDiscoveryRecoveryWithSnapshot(base, [
      { kind: "dir", name: "src" },
      { kind: "file", name: "README.md" },
    ]);
    expect(out.previewCount).toBe(2);
    expect(out.text).toContain("code=\"top_level_snapshot\"");
    expect(out.text).toContain("- dir:src");
    expect(out.text).toContain("- file:README.md");
  });
});
