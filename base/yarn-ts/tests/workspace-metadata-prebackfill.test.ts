import { describe, expect, it, vi } from "vitest";
import {
  applyWorkspaceMetadataPrebackfill,
  mergePathContextWithClientMetadata,
} from "../src/pipeline/workspace-metadata-prebackfill.js";
import type { ClientMetadata } from "../src/providers/prefix-optimizer/index.js";
import type { SessionPathHints } from "../src/state/workspace-session-boundary.js";

describe("workspace metadata prebackfill", () => {
  it("merges OpenCode-style message metadata into early path context without clobbering headers", () => {
    const merged = mergePathContextWithClientMetadata(
      { projectRoot: null, shellCwd: "/from-header", shell: undefined },
      {
        ...emptyMetadata(),
        projectRoot: "/from-system-root",
        shellCwd: "/from-system-cwd",
        shell: "zsh",
        platform: "darwin",
      },
    );

    expect(merged).toMatchObject({
      projectRoot: "/from-system-root",
      shellCwd: "/from-header",
      shell: "zsh",
      platform: "darwin",
    });
  });

  it("does nothing when path context already has project root and cwd", () => {
    const extractMetadataFromMessages = vi.fn(() => emptyMetadata());

    const result = applyWorkspaceMetadataPrebackfill({
      pathContext: { projectRoot: "/repo", shellCwd: "/repo" },
      adapterBlock: "adapter",
      messages: [],
      session: makeSession(),
      requestId: "req-0",
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
    const session = makeSession();
    const setWorkspaceContext = vi.fn();
    const logInfo = vi.fn();

    const result = applyWorkspaceMetadataPrebackfill({
      pathContext: { projectRoot: null, shellCwd: "/repo", shell: undefined },
      adapterBlock: "old-adapter",
      messages: [{ role: "system", content: "metadata" }],
      session,
      requestId: "req-1",
      extractMetadataFromMessages: () => ({
        ...emptyMetadata(),
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
    expect(setWorkspaceContext).toHaveBeenCalledWith(session, "ready", "req-1", {
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
        inferredRoot: null,
        shell: "/bin/zsh",
        platform: "Darwin",
      },
      "prefix_optimizer_metadata_prebackfill",
    );
  });

  it("does not backfill when metadata has no path anchors or inferred root", () => {
    const setWorkspaceContext = vi.fn();

    const result = applyWorkspaceMetadataPrebackfill({
      pathContext: { projectRoot: null, shellCwd: null },
      adapterBlock: undefined,
      messages: [],
      session: makeSession(),
      requestId: "req-empty",
      extractMetadataFromMessages: () => emptyMetadata(),
      buildAdapterBlock: vi.fn(() => "adapter"),
      setWorkspaceContext,
    });

    expect(result.applied).toBe(false);
    expect(result.pathContext).toEqual({ projectRoot: null, shellCwd: null });
    expect(result.adapterBlock).toBeUndefined();
    expect(setWorkspaceContext).not.toHaveBeenCalled();
  });

  it("infers project root and shell cwd from a prior pwd tool result", () => {
    const session = makeSession();
    const result = applyWorkspaceMetadataPrebackfill({
      pathContext: emptyPathContext(),
      adapterBlock: undefined,
      messages: [
        {
          role: "assistant",
          tool_calls: [{
            id: "pwd-1",
            function: { name: "Bash", arguments: JSON.stringify({ command: "pwd" }) },
          }],
        },
        { role: "tool", tool_call_id: "pwd-1", content: "/home/byron/src/test\n" },
      ],
      session,
      requestId: "req-1",
      extractMetadataFromMessages: () => emptyMetadata(),
      buildAdapterBlock: (pathContext) => `project_root=${pathContext.projectRoot}\nshell_cwd=${pathContext.shellCwd}`,
      setWorkspaceContext: (state, status, requestId, details) => {
        state.record.metadata.status = status;
        state.record.metadata.requestId = requestId;
        state.record.metadata.projectRoot = details.projectRoot;
        state.record.metadata.cwd = details.cwd;
        state.record.metadata.reason = details.reason;
      },
    });

    expect(result.applied).toBe(true);
    expect(result.pathContext.projectRoot).toBe("/home/byron/src/test");
    expect(result.pathContext.shellCwd).toBe("/home/byron/src/test");
    expect(session.record.metadata.reason).toContain("Inferred from prior tool execution evidence");
  });

  it("infers the canonical root from duplicated path-not-found output", () => {
    const session = makeSession();
    const result = applyWorkspaceMetadataPrebackfill({
      pathContext: emptyPathContext(),
      adapterBlock: undefined,
      messages: [
        {
          role: "assistant",
          tool_calls: [{
            id: "read-1",
            function: { name: "Read", arguments: JSON.stringify({ file_path: "src/test/taskpulse/app/main.py" }) },
          }],
        },
        {
          role: "tool",
          tool_call_id: "read-1",
          content: "File not found: /home/byron/src/test/src/test/taskpulse/app/main.py",
        },
      ],
      session,
      requestId: "req-2",
      extractMetadataFromMessages: () => emptyMetadata(),
      buildAdapterBlock: (pathContext) => `project_root=${pathContext.projectRoot}`,
      setWorkspaceContext: vi.fn(),
    });

    expect(result.applied).toBe(true);
    expect(result.pathContext.projectRoot).toBe("/home/byron/src/test");
    expect(result.pathContext.shellCwd).toBe("/home/byron/src/test");
  });

  it("preserves explicit client path context over inferred shell evidence", () => {
    const session = makeSession();
    const result = applyWorkspaceMetadataPrebackfill({
      pathContext: {
        ...emptyPathContext(),
        projectRoot: "/workspace/project",
        shellCwd: "/workspace/project/app",
      },
      adapterBlock: "existing",
      messages: [
        {
          role: "assistant",
          tool_calls: [{
            id: "pwd-1",
            function: { name: "Bash", arguments: JSON.stringify({ command: "pwd" }) },
          }],
        },
        { role: "tool", tool_call_id: "pwd-1", content: "/wrong/root\n" },
      ],
      session,
      requestId: "req-3",
      extractMetadataFromMessages: () => emptyMetadata(),
      buildAdapterBlock: () => "rebuilt",
      setWorkspaceContext: vi.fn(),
    });

    expect(result.applied).toBe(false);
    expect(result.pathContext.projectRoot).toBe("/workspace/project");
    expect(result.pathContext.shellCwd).toBe("/workspace/project/app");
    expect(result.adapterBlock).toBe("existing");
  });
});

function emptyPathContext(): SessionPathHints {
  return {
    projectRoot: null,
    shellCwd: null,
  };
}

function makeSession() {
  return { record: { metadata: {} as Record<string, unknown> } };
}

function emptyMetadata(): ClientMetadata {
  return {
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
}
