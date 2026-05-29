import { describe, expect, it, vi } from "vitest";
import {
  processWorkspaceHandshakeRoute,
  shouldStartMissingPathWorkspaceHandshake,
  shouldStartWorkspaceHandshake,
} from "../src/session/workspace-handshake-route.js";

function session(metadata: Record<string, unknown> = {}) {
  return {
    record: { metadata },
  };
}

function baseInput(overrides: Partial<Parameters<typeof processWorkspaceHandshakeRoute>[0]> = {}) {
  return {
    protocol: "openai" as const,
    session: session(),
    sessionKey: "sess",
    identity: { userId: "user", orgId: "org" },
    requestId: "req-1",
    pathContext: { projectRoot: "/repo", shellCwd: "/repo" },
    messages: [],
    tools: undefined,
    saveSession: vi.fn(async () => undefined),
    recordSessionEvent: vi.fn(),
    ...overrides,
  };
}

describe("workspace handshake route helper", () => {
  it("keeps synthetic handshake start disabled by default", () => {
    expect(shouldStartWorkspaceHandshake(session(), { projectRoot: "/repo", shellCwd: "/repo" })).toBe(false);
  });

  it("allows coder routes to request a one-shot handshake when path anchors are missing", () => {
    expect(shouldStartMissingPathWorkspaceHandshake(session(), { projectRoot: null, shellCwd: null })).toBe(true);
    expect(shouldStartMissingPathWorkspaceHandshake(session(), { projectRoot: "/repo", shellCwd: "/repo" })).toBe(false);
    expect(shouldStartMissingPathWorkspaceHandshake(session({ workspace_context_attempts: 1 }), { projectRoot: null, shellCwd: null })).toBe(false);
    expect(shouldStartMissingPathWorkspaceHandshake(session({ workspace_context_status: "unavailable" }), { projectRoot: null, shellCwd: null })).toBe(false);
  });

  it("marks pending OpenAI workspace handshake ready from tool result", async () => {
    const state = session({
      workspace_context_status: "pending",
      workspace_context_tool_call_id: "tool-1",
    });
    const recordSessionEvent = vi.fn();

    const action = await processWorkspaceHandshakeRoute(baseInput({
      session: state,
      messages: [
        { role: "tool", tool_call_id: "tool-1", content: "SYNESIS_WORKSPACE_CONTEXT_V1\ncwd=/repo\nproject_root=/repo\nshell=/bin/zsh\nos=Darwin\narch=arm64" },
      ],
      recordSessionEvent,
    }));

    expect(action).toEqual({ kind: "continue" });
    expect(state.record.metadata.workspace_context_status).toBe("ready");
    expect(state.record.metadata.workspace_context_cwd).toBe("/repo");
    expect(state.record.metadata.workspace_context_project_root).toBe("/repo");
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "sess",
      "user",
      "org",
      "workspace_context_ready",
      "workspace-handshake",
      "Initializing workspace context completed",
      "req-1",
    );
  });

  it("marks pending Claude workspace handshake unavailable when result is missing", async () => {
    const state = session({
      workspace_context_status: "pending",
      workspace_context_tool_call_id: "tool-1",
    });
    const recordSessionEvent = vi.fn();

    const action = await processWorkspaceHandshakeRoute(baseInput({
      protocol: "claude",
      session: state,
      messages: [{ role: "user", content: "not a tool result" }],
      recordSessionEvent,
    }));

    expect(action).toEqual({ kind: "continue" });
    expect(state.record.metadata.workspace_context_status).toBe("unavailable");
    expect(state.record.metadata.workspace_context_reason).toBe("workspace context tool result not returned");
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "sess",
      "user",
      "org",
      "workspace_context_fallback",
      "workspace-handshake",
      "Workspace context unavailable (tool result missing/denied)",
      "req-1",
    );
  });

  it("returns a send action and persists state when start is explicitly enabled", async () => {
    const state = session({ workspace_context_attempts: 2 });
    const saveSession = vi.fn(async () => undefined);
    const recordSessionEvent = vi.fn();

    const action = await processWorkspaceHandshakeRoute(baseInput({
      session: state,
      tools: [{ type: "function", function: { name: "Bash" } }],
      saveSession,
      recordSessionEvent,
      shouldStart: () => true,
    }));

    expect(action.kind).toBe("send");
    expect(action.kind === "send" ? action.toolCallId : "").toMatch(/^synesis_workspace_ctx_/);
    expect(action.kind === "send" ? action.toolName : "").toBe("Bash");
    expect(state.record.metadata.workspace_context_status).toBe("pending");
    expect(state.record.metadata.workspace_context_attempts).toBe(3);
    expect(saveSession).toHaveBeenCalledWith(state);
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "sess",
      "user",
      "org",
      "workspace_context_init",
      "workspace-handshake",
      "Initializing workspace context",
      "req-1",
    );
  });

  it("preserves lowercase bash tool names in synthetic handshake responses", async () => {
    const action = await processWorkspaceHandshakeRoute(baseInput({
      pathContext: { projectRoot: null, shellCwd: null },
      tools: [{ type: "function", function: { name: "bash" } }],
      shouldStart: shouldStartMissingPathWorkspaceHandshake,
    }));

    expect(action).toMatchObject({ kind: "send", toolName: "bash" });
  });
});
