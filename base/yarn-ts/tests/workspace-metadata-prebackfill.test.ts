import { describe, expect, it, vi } from "vitest";
import { applyWorkspaceMetadataPrebackfill } from "../src/pipeline/workspace-metadata-prebackfill.js";
import type { ClientMetadata } from "../src/providers/prefix-optimizer/index.js";

const emptyMetadata: ClientMetadata = {
  workspacePath: null,
  projectRoot: null,
  shellCwd: null,
  osVersion: null,
  platform: null,
  shell: null,
  gitIsRepo: null,
  gitRepoPath: null,
  currentDate: null,
  openFiles: [],
  recentFiles: [],
};

function session() {
  return { record: { metadata: {} as Record<string, unknown> } };
}

describe("workspace metadata prebackfill", () => {
  it("does nothing when path context already has project root and cwd", () => {
    const extractMetadataFromMessages = vi.fn(() => emptyMetadata);

    const result = applyWorkspaceMetadataPrebackfill({
      pathContext: { projectRoot: "/repo", shellCwd: "/repo" },
      adapterBlock: "adapter",
      messages: [],
      session: session(),
      requestId: "req-1",
      extractMetadataFromMessages,
      buildAdapterBlock: vi.fn(() => "new-adapter"),
      setWorkspaceContext: vi.fn(),
    });

    expect(result).toEqual({
      pathContext: { projectRoot: "/repo", shellCwd: "/repo" },
      adapterBlock: "adapter",
      applied: false,
      metadata: null,
    });
    expect(extractMetadataFromMessages).not.toHaveBeenCalled();
  });

  it("fills missing path metadata and records workspace context", () => {
    const state = session();
    const setWorkspaceContext = vi.fn();
    const logInfo = vi.fn();

    const result = applyWorkspaceMetadataPrebackfill({
      pathContext: { projectRoot: null, shellCwd: "/repo", shell: undefined },
      adapterBlock: "old-adapter",
      messages: [{ role: "system", content: "metadata" }],
      session: state,
      requestId: "req-1",
      extractMetadataFromMessages: () => ({
        ...emptyMetadata,
        projectRoot: "/repo",
        shellCwd: "/repo",
        shell: "/bin/zsh",
        platform: "Darwin",
        osVersion: "arm64",
      }),
      buildAdapterBlock: (ctx) => `adapter:${ctx.projectRoot}:${ctx.shellCwd}:${ctx.shell}`,
      setWorkspaceContext,
      logInfo,
      logSessionKey: "sess",
    });

    expect(result.applied).toBe(true);
    expect(result.pathContext).toMatchObject({
      projectRoot: "/repo",
      shellCwd: "/repo",
      shell: "/bin/zsh",
      platform: "Darwin",
      osVersion: "arm64",
    });
    expect(result.adapterBlock).toBe("adapter:/repo:/repo:/bin/zsh");
    expect(setWorkspaceContext).toHaveBeenCalledWith(state, "ready", "req-1", {
      reason: "Extracted from client system message (pre-enrich)",
      projectRoot: "/repo",
      cwd: "/repo",
      shell: "/bin/zsh",
      os: "Darwin",
      arch: "arm64",
    });
    expect(logInfo).toHaveBeenCalledWith(
      {
        sessionKey: "sess",
        projectRoot: "/repo",
        shellCwd: "/repo",
        shell: "/bin/zsh",
        platform: "Darwin",
      },
      "prefix_optimizer_metadata_prebackfill",
    );
  });

  it("does not backfill when metadata has no path anchors", () => {
    const setWorkspaceContext = vi.fn();

    const result = applyWorkspaceMetadataPrebackfill({
      pathContext: { projectRoot: null, shellCwd: null },
      adapterBlock: undefined,
      messages: [],
      session: session(),
      requestId: "req-1",
      extractMetadataFromMessages: () => emptyMetadata,
      buildAdapterBlock: vi.fn(() => "adapter"),
      setWorkspaceContext,
    });

    expect(result.applied).toBe(false);
    expect(result.pathContext).toEqual({ projectRoot: null, shellCwd: null });
    expect(result.adapterBlock).toBeUndefined();
    expect(setWorkspaceContext).not.toHaveBeenCalled();
  });
});
