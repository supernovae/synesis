import { describe, expect, it } from "vitest";

import {
  buildBlockedDiscoveryGuidance,
  buildBlockedDiscoveryRecoveryWithoutSnapshot,
} from "../src/tool-collapse/blocked-discovery-recovery.js";

describe("blocked discovery recovery", () => {
  it("uses empty-workspace language for root_empty recovery", () => {
    const base = buildBlockedDiscoveryGuidance("minimax", [
      { toolName: "Glob", reason: "empty_glob_pattern_blocked" },
    ]);
    const recovery = buildBlockedDiscoveryRecoveryWithoutSnapshot(base, "root_empty");

    expect(recovery).toContain("workspace root appears empty");
    expect(recovery).toContain("Do not claim prior task frames");
    expect(recovery).toContain("use_init_for_CLAUDE.md");
    expect(recovery).not.toContain("Read README.md or package.json to discover structure");
  });
});
