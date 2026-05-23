import { describe, expect, it } from "vitest";

import {
  buildEmptyWorkspaceSystemPrompt,
  decideWorkspaceBoundary,
  inspectWorkspaceRoot,
  projectInstructionFilePresent,
  workspaceFingerprintFromRoot,
} from "../src/governance/workspace-boundary.js";

describe("workspace boundary", () => {
  it("resets when the workspace root changes", () => {
    const nextInspection = {
      root: "/tmp/new",
      fingerprint: workspaceFingerprintFromRoot("/tmp/new"),
      isEmpty: false,
      projectInstructionFiles: [],
      readError: null,
    };

    const decision = decideWorkspaceBoundary({
      previousFingerprint: workspaceFingerprintFromRoot("/tmp/old"),
      previousRoot: "/tmp/old",
      nextInspection,
      hasPersistedState: true,
    });

    expect(decision.resetRequired).toBe(true);
    expect(decision.reason).toBe("workspace_changed");
  });

  it("resets migrated sessions with persisted state in an empty workspace", () => {
    const nextInspection = {
      root: "/tmp/empty",
      fingerprint: workspaceFingerprintFromRoot("/tmp/empty"),
      isEmpty: true,
      projectInstructionFiles: [],
      readError: null,
    };

    const decision = decideWorkspaceBoundary({
      previousFingerprint: null,
      previousRoot: null,
      nextInspection,
      hasPersistedState: true,
    });

    expect(decision.resetRequired).toBe(true);
    expect(decision.reason).toBe("fresh_empty_workspace");
  });

  it("preserves continuity in the same workspace", () => {
    const nextInspection = {
      root: "/repo/app",
      fingerprint: workspaceFingerprintFromRoot("/repo/app"),
      isEmpty: false,
      projectInstructionFiles: ["CLAUDE.md"],
      readError: null,
    };

    const decision = decideWorkspaceBoundary({
      previousFingerprint: workspaceFingerprintFromRoot("/repo/app"),
      previousRoot: "/repo/app",
      nextInspection,
      hasPersistedState: true,
    });

    expect(decision.resetRequired).toBe(false);
    expect(decision.reason).toBe("none");
  });

  it("detects empty roots and project instruction files", async () => {
    const empty = await inspectWorkspaceRoot(
      { projectRoot: "/tmp/empty", shellCwd: null },
      async () => [],
    );
    expect(empty.isEmpty).toBe(true);
    expect(empty.projectInstructionFiles).toEqual([]);

    const withGuidance = await inspectWorkspaceRoot(
      { projectRoot: "/tmp/repo", shellCwd: null },
      async () => [
        { name: "CLAUDE.md", isDirectory: () => false },
        { name: "src", isDirectory: () => true },
      ],
    );
    expect(withGuidance.isEmpty).toBe(false);
    expect(withGuidance.projectInstructionFiles).toEqual(["CLAUDE.md"]);
  });

  it("identifies project guidance read targets", () => {
    expect(projectInstructionFilePresent("CLAUDE.md")).toBe(true);
    expect(projectInstructionFilePresent("docs/CLAUDE.md")).toBe(true);
    expect(projectInstructionFilePresent("src/index.ts")).toBe(false);
  });

  it("empty workspace prompt blocks stale internal narration", () => {
    const prompt = buildEmptyWorkspaceSystemPrompt("/tmp/empty");
    expect(prompt).toContain("Do not create CLAUDE.md automatically");
    expect(prompt).toContain("Do not invent SYNOPSIS_* labels");
    expect(prompt).toContain("Do not claim prior task frames");
    expect(prompt).toContain("Do not inspect parent or sibling directories");
    expect(prompt).toContain("create it here");
    expect(prompt).toContain("/init is the explicit path");
  });
});
