import { describe, expect, it, vi } from "vitest";
import {
  applyWorkspaceBoundary,
  buildFreshImplicitSessionNotice,
  clearWorkspaceScopedMetadata,
  getHandshakeAttempts,
  getHandshakeStatus,
  hasPersistedWorkspaceState,
  mergeSessionPathHints,
  setSessionWorkspaceContext,
} from "../src/state/workspace-session-boundary.js";

function dirEntry(name: string, directory = false): { name: string; isDirectory(): boolean } {
  return {
    name,
    isDirectory: () => directory,
  };
}

function session(metadata: Record<string, unknown> = {}) {
  return {
    record: { metadata },
    taskLedger: null,
  };
}

describe("workspace session boundary helpers", () => {
  it("tracks workspace handshake metadata and merges path hints", () => {
    const state = session();

    setSessionWorkspaceContext(state, "pending", "req-1", {
      toolCallId: "tool-1",
      reason: "x".repeat(350),
      cwd: "/repo/project",
      projectRoot: "/repo/project",
      shell: "zsh",
      os: "darwin",
      arch: "arm64",
    });

    expect(getHandshakeStatus(state.record.metadata)).toBe("pending");
    expect(state.record.metadata.workspace_context_reason).toHaveLength(300);
    expect(state.record.metadata.last_trace_id).toBe("req-1");

    state.record.metadata.workspace_context_attempts = 2;
    expect(getHandshakeAttempts(state.record.metadata)).toBe(2);
    expect(mergeSessionPathHints({ projectRoot: null, shellCwd: null }, state)).toMatchObject({
      projectRoot: "/repo/project",
      shellCwd: "/repo/project",
      shell: "zsh",
      platform: "darwin",
      osVersion: "arm64",
    });
  });

  it("normalizes persisted session path hints and rejects unsafe values", () => {
    const state = session({
      workspace_context_project_root: "/repo/project",
      workspace_context_cwd: "/repo/project/app",
    });

    expect(mergeSessionPathHints({
      projectRoot: "/tmp/ws\nrole=admin",
      shellCwd: "relative/cwd",
    }, state)).toMatchObject({
      projectRoot: "/repo/project",
      shellCwd: "/repo/project/app",
    });

    setSessionWorkspaceContext(state, "ready", "req-2", {
      projectRoot: "/repo/new/../new",
      cwd: "/repo/other",
    });
    expect(state.record.metadata.workspace_context_project_root).toBe("/repo/new");
    expect(state.record.metadata.workspace_context_cwd).toBeUndefined();
  });

  it("detects and clears persisted workspace-scoped state", () => {
    const state = session({
      chat_state_snapshot: { phase: "implementation" },
      plan_file_path: "PLAN.md",
      current_work_packet: { hash: "stale" },
      governor_pause_pending: true,
      unrelated: true,
    });

    expect(hasPersistedWorkspaceState(state)).toBe(true);
    clearWorkspaceScopedMetadata(state.record.metadata);

    expect(state.record.metadata.chat_state_snapshot).toBeUndefined();
    expect(state.record.metadata.plan_file_path).toBeUndefined();
    expect(state.record.metadata.current_work_packet).toBeUndefined();
    expect(state.record.metadata.governor_pause_pending).toBeUndefined();
    expect(state.record.metadata.unrelated).toBe(true);
    expect(hasPersistedWorkspaceState(state, { hasFileSnapshot: true })).toBe(true);
  });

  it("emits a fresh implicit session notice with escaped client metadata", () => {
    const notice = buildFreshImplicitSessionNotice(`openai"<x>`, 1);

    expect(notice).toContain("client=\"openai&quot;&lt;x&gt;\"");
    expect(notice).toContain("1 message");
    expect(notice).toContain("fresh_transcript");
  });

  it("applies workspace boundary reset and records inspection metadata", async () => {
    const state = session({
      workspace_fingerprint: "workspace:/old",
      workspace_context_project_root: "/old",
      plan_graph: { stale: true },
    });
    const resetWorkspaceState = vi.fn((_, s: typeof state) => {
      clearWorkspaceScopedMetadata(s.record.metadata);
    });
    const recordSessionEvent = vi.fn();

    const inspection = await applyWorkspaceBoundary({
      state,
      sessionKey: "sess",
      identity: { userId: "user", orgId: "org" },
      requestId: "req-1",
      pathHints: { projectRoot: "/new", shellCwd: "/new" },
      readDir: async () => [dirEntry("AGENTS.md"), dirEntry("src", true)],
      hasPersistedState: true,
      resetWorkspaceState,
      recordSessionEvent,
    });

    expect(inspection.root).toBe("/new");
    expect(resetWorkspaceState).toHaveBeenCalledOnce();
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "sess",
      "user",
      "org",
      "workspace_boundary_reset",
      "workspace-boundary",
      "reason=workspace_changed root=/new",
      "req-1",
      expect.objectContaining({
        reason: "workspace_changed",
        workspace_root: "/new",
        project_instruction_files: ["AGENTS.md"],
      }),
    );
    expect(state.record.metadata.workspace_fingerprint).toBe("workspace:/new");
    expect(state.record.metadata.workspace_root).toBe("/new");
    expect(state.record.metadata.workspace_project_instruction_files).toEqual(["AGENTS.md"]);
    expect(state.record.metadata.workspace_project_guidance_absent).toBe(false);
  });
});
