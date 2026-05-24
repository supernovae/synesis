import {
  extractClaudeToolResult,
  extractOpenAIToolResult,
  hasBashTool,
  makeWorkspaceHandshakeToolCallId,
  parseWorkspaceContextOutput,
} from "./workspace-context-handshake.js";
import {
  getHandshakeAttempts,
  getHandshakeStatus,
  setSessionWorkspaceContext,
  type SessionPathHints,
  type WorkspaceBoundaryIdentity,
  type WorkspaceBoundarySessionState,
  type WorkspaceSessionEventRecorder,
} from "../state/workspace-session-boundary.js";

export type WorkspaceHandshakeAction =
  | { kind: "continue" }
  | { kind: "send"; toolCallId: string };

export type WorkspaceHandshakeProtocol = "openai" | "claude";

export interface WorkspaceHandshakeRouteInput<TState extends WorkspaceBoundarySessionState> {
  protocol: WorkspaceHandshakeProtocol;
  session: TState;
  sessionKey: string;
  identity: WorkspaceBoundaryIdentity;
  requestId: string;
  pathContext: SessionPathHints;
  messages: unknown[];
  tools: unknown[] | undefined;
  saveSession: (state: TState) => Promise<void>;
  recordSessionEvent: WorkspaceSessionEventRecorder;
  shouldStart?: (state: TState, pathContext: SessionPathHints) => boolean;
}

export function shouldStartWorkspaceHandshake<TState extends WorkspaceBoundarySessionState>(
  state: TState,
  pathCtx: SessionPathHints,
): boolean {
  void state;
  void pathCtx;
  // Fix-forward policy: synthetic workspace handshake is disabled globally.
  // Context anchors must come from headers/metadata only.
  return false;
}

export async function processWorkspaceHandshakeRoute<TState extends WorkspaceBoundarySessionState>(
  input: WorkspaceHandshakeRouteInput<TState>,
): Promise<WorkspaceHandshakeAction> {
  const pendingToolId = String(input.session.record.metadata.workspace_context_tool_call_id ?? "");
  const status = getHandshakeStatus(input.session.record.metadata);
  if (status === "pending" && pendingToolId) {
    processPendingWorkspaceHandshake({ ...input, pendingToolId });
  }

  const shouldStart = input.shouldStart ?? shouldStartWorkspaceHandshake;
  if (!shouldStart(input.session, input.pathContext)) {
    return { kind: "continue" };
  }

  if (!hasBashTool(input.tools)) {
    setSessionWorkspaceContext(input.session, "unavailable", input.requestId, {
      reason: "Bash tool not available for workspace handshake",
    });
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "workspace_context_fallback",
      "workspace-handshake",
      "Workspace context unavailable (Bash tool missing)",
      input.requestId,
    );
    return { kind: "continue" };
  }

  const toolCallId = makeWorkspaceHandshakeToolCallId();
  input.session.record.metadata.workspace_context_attempts = getHandshakeAttempts(input.session.record.metadata) + 1;
  setSessionWorkspaceContext(input.session, "pending", input.requestId, {
    toolCallId,
    reason: "Initializing workspace context",
  });
  input.recordSessionEvent(
    input.sessionKey,
    input.identity.userId,
    input.identity.orgId,
    "workspace_context_init",
    "workspace-handshake",
    "Initializing workspace context",
    input.requestId,
  );
  await input.saveSession(input.session);
  return { kind: "send", toolCallId };
}

function processPendingWorkspaceHandshake<TState extends WorkspaceBoundarySessionState>(
  input: WorkspaceHandshakeRouteInput<TState> & { pendingToolId: string },
): void {
  const toolResult = input.protocol === "claude"
    ? extractClaudeToolResult(input.messages as Array<{ role: string; content: unknown }>, input.pendingToolId)
    : extractOpenAIToolResult(input.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>, input.pendingToolId);
  if (toolResult !== null) {
    const parsedCtx = parseWorkspaceContextOutput(toolResult);
    if (parsedCtx) {
      setSessionWorkspaceContext(input.session, "ready", input.requestId, {
        toolCallId: input.pendingToolId,
        cwd: parsedCtx.cwd,
        projectRoot: parsedCtx.projectRoot,
        shell: parsedCtx.shell,
        os: parsedCtx.os,
        arch: parsedCtx.arch,
      });
      input.recordSessionEvent(
        input.sessionKey,
        input.identity.userId,
        input.identity.orgId,
        "workspace_context_ready",
        "workspace-handshake",
        "Initializing workspace context completed",
        input.requestId,
      );
      return;
    }

    setSessionWorkspaceContext(input.session, "unavailable", input.requestId, {
      toolCallId: input.pendingToolId,
      reason: "workspace context parse failed",
    });
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "workspace_context_fallback",
      "workspace-handshake",
      "Workspace context unavailable (parse failure)",
      input.requestId,
    );
    return;
  }

  setSessionWorkspaceContext(input.session, "unavailable", input.requestId, {
    toolCallId: input.pendingToolId,
    reason: "workspace context tool result not returned",
  });
  input.recordSessionEvent(
    input.sessionKey,
    input.identity.userId,
    input.identity.orgId,
    "workspace_context_fallback",
    "workspace-handshake",
    "Workspace context unavailable (tool result missing/denied)",
    input.requestId,
  );
}
