import {
  decideWorkspaceBoundary,
  inspectWorkspaceRoot,
  type WorkspaceInspection,
} from "../governance/workspace-boundary.js";
import {
  GOVERNOR_PAUSE_CONTEXT_METADATA_KEY,
  GOVERNOR_PAUSE_PENDING_METADATA_KEY,
} from "../governance/governor-pause-context.js";
import { contextFromSessionMetadata } from "../session/workspace-context-handshake.js";
import { isPathInsideRoot, normalizeAbsolutePathHint } from "../path-governance/path-hints.js";

export type HandshakeStatus = "pending" | "ready" | "unavailable";

export type SessionPathHints = {
  projectRoot: string | null;
  shellCwd: string | null;
  platform?: string;
  osVersion?: string;
  shell?: string;
  gitSummary?: string;
  clientModelLabel?: string;
  knowledgeCutoff?: string;
};

function firstNormalizedPath(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = normalizeAbsolutePathHint(value);
    if (normalized) return normalized;
  }
  return null;
}

export interface WorkspaceBoundarySessionState {
  record: { metadata: Record<string, unknown> };
  taskLedger?: unknown;
}

export interface WorkspaceStatePresence {
  hasFileSnapshot?: boolean;
  hasContentDedup?: boolean;
  hasStructuralIndex?: boolean;
  sessionMemoryCount?: number;
}

export interface WorkspaceBoundaryIdentity {
  userId: string;
  orgId: string;
}

export type WorkspaceSessionEventRecorder = (
  sessionKey: string,
  userId: string,
  orgId: string,
  eventType: string,
  source: string,
  summary: string,
  requestId: string,
  metadata?: Record<string, unknown>,
) => void;

export function getHandshakeStatus(meta: Record<string, unknown>): HandshakeStatus | "" {
  const s = String(meta.workspace_context_status ?? "").trim();
  return s === "pending" || s === "ready" || s === "unavailable" ? s : "";
}

export function getHandshakeAttempts(meta: Record<string, unknown>): number {
  const n = Number(meta.workspace_context_attempts ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function mergeSessionPathHints<TState extends WorkspaceBoundarySessionState>(
  base: SessionPathHints,
  state: TState,
): SessionPathHints {
  const fromSession = contextFromSessionMetadata(state.record.metadata);
  if (!fromSession) return base;
  const coalescedRoot = fromSession.projectRoot || fromSession.cwd;
  const coalescedCwd = fromSession.cwd || fromSession.projectRoot;
  const projectRoot = firstNormalizedPath(base.projectRoot, coalescedRoot);
  const rawShellCwd = firstNormalizedPath(base.shellCwd, coalescedCwd);
  const shellCwd = projectRoot && rawShellCwd && !isPathInsideRoot(rawShellCwd, projectRoot)
    ? null
    : rawShellCwd;
  return {
    ...base,
    projectRoot,
    shellCwd,
    shell: base.shell ?? fromSession.shell,
    platform: base.platform ?? fromSession.os,
    osVersion: base.osVersion ?? fromSession.arch,
  };
}

export function setSessionWorkspaceContext<TState extends WorkspaceBoundarySessionState>(
  state: TState,
  status: HandshakeStatus,
  reqId: string,
  details?: { toolCallId?: string; reason?: string; cwd?: string; projectRoot?: string; shell?: string; os?: string; arch?: string },
): void {
  state.record.metadata.workspace_context_status = status;
  state.record.metadata.workspace_context_updated_at = Date.now();
  if (details?.toolCallId) {
    state.record.metadata.workspace_context_tool_call_id = details.toolCallId;
  }
  if (details?.reason) {
    state.record.metadata.workspace_context_reason = details.reason.slice(0, 300);
  }
  const projectRoot = normalizeAbsolutePathHint(details?.projectRoot);
  const rawCwd = normalizeAbsolutePathHint(details?.cwd);
  const cwd = projectRoot && rawCwd && !isPathInsideRoot(rawCwd, projectRoot) ? null : rawCwd;
  if (details && "cwd" in details) {
    if (cwd) state.record.metadata.workspace_context_cwd = cwd;
    else delete state.record.metadata.workspace_context_cwd;
  }
  if (details && "projectRoot" in details) {
    if (projectRoot) state.record.metadata.workspace_context_project_root = projectRoot;
    else delete state.record.metadata.workspace_context_project_root;
  }
  if (details?.shell) state.record.metadata.workspace_context_shell = details.shell;
  if (details?.os) state.record.metadata.workspace_context_os = details.os;
  if (details?.arch) state.record.metadata.workspace_context_arch = details.arch;
  state.record.metadata.last_trace_id = reqId;
}

export function hasPersistedWorkspaceState<TState extends WorkspaceBoundarySessionState>(
  state: TState,
  presence: WorkspaceStatePresence = {},
): boolean {
  const meta = state.record.metadata;
  return Boolean(
    meta.chat_state_snapshot
      || meta.file_state_snapshot
      || meta.objective_epoch_id
      || meta.objective_epoch_objective_text
      || meta.objective_scope_boundary_index
      || meta.plan_graph
      || meta.plan_content_shadow
      || meta.plan_file_path
      || meta.requirement_checklist
      || meta.task_intake
      || meta.task_ledger
      || state.taskLedger
      || presence.hasFileSnapshot
      || presence.hasContentDedup
      || presence.hasStructuralIndex
      || (presence.sessionMemoryCount ?? 0) > 0
  );
}

export function previousWorkspaceRootFromMetadata(meta: Record<string, unknown>): string | null {
  const projectRoot = typeof meta.workspace_context_project_root === "string"
    ? meta.workspace_context_project_root
    : "";
  const cwd = typeof meta.workspace_context_cwd === "string"
    ? meta.workspace_context_cwd
    : "";
  const workspaceRoot = typeof meta.workspace_root === "string"
    ? meta.workspace_root
    : "";
  return normalizeAbsolutePathHint(projectRoot)
    ?? normalizeAbsolutePathHint(cwd)
    ?? normalizeAbsolutePathHint(workspaceRoot);
}

export function clearWorkspaceScopedMetadata(meta: Record<string, unknown>): void {
  for (const key of [
    "chat_state_snapshot",
    "file_state_snapshot",
    "objective_epoch_id",
    "objective_epoch_objective_hash",
    "objective_epoch_objective_text",
    "objective_epoch_anchor_user_hash",
    "objective_epoch_set_request",
    "objective_scope_boundary_index",
    "objective_scope_retained_evidence",
    "objective_scope_dropped_pre_boundary",
    "objective_epoch_pruning_frozen_boundary",
    "objective_epoch_pruning_frozen_at_request",
    "objective_epoch_pruning_frozen_message_count",
    "plan_graph",
    "plan_content_shadow",
    "plan_file_path",
    "requirement_checklist",
    "task_intake",
    "task_ledger",
    "state_confidence_chat",
    "state_confidence_file",
    "state_confidence_overall",
    "state_confidence_needs_reground",
    "state_confidence_recommended_path",
    "state_confidence_reasons",
    "latest_user_prompt",
    "trace_root_prompt",
    "planner_todo_packet",
    "planner_todo_packet_source_hash",
    "planner_todo_packet_model",
    "planner_todo_packet_updated_at",
    "planner_todo_packet_ambiguity",
    "planner_todo_packet_todos",
    "planner_todo_packet_questions",
    "planner_todo_packet_carrier",
    "current_work_packet",
    GOVERNOR_PAUSE_CONTEXT_METADATA_KEY,
    GOVERNOR_PAUSE_PENDING_METADATA_KEY,
  ]) {
    delete meta[key];
  }
}

export function buildFreshImplicitSessionNotice(clientKind: string, messageCount: number): string {
  const safeClientKind = clientKind.replace(/[<>&"]/g, (ch) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "\"": "&quot;",
  })[ch] ?? ch);
  return [
    `<SESSION_BOUNDARY_NOTICE client="${safeClientKind}" mode="fresh_transcript">`,
    `The client sent a fresh transcript without an explicit resume id (${messageCount} message${messageCount === 1 ? "" : "s"}).`,
    "Prior implicit harness state for this workspace was cleared. Treat this as a fresh run: rely only on the current transcript and filesystem, not older tasks or conclusions.",
    "</SESSION_BOUNDARY_NOTICE>",
  ].join("\n");
}

export async function applyWorkspaceBoundary<TState extends WorkspaceBoundarySessionState>(input: {
  state: TState;
  sessionKey: string;
  identity: WorkspaceBoundaryIdentity;
  requestId: string;
  pathHints: SessionPathHints;
  readDir: (root: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  hasPersistedState: boolean;
  resetWorkspaceState: (sessionKey: string, state: TState) => void;
  recordSessionEvent: WorkspaceSessionEventRecorder;
}): Promise<WorkspaceInspection> {
  const inspection = await inspectWorkspaceRoot(input.pathHints, input.readDir);
  const decision = decideWorkspaceBoundary({
    previousFingerprint: typeof input.state.record.metadata.workspace_fingerprint === "string"
      ? input.state.record.metadata.workspace_fingerprint
      : null,
    previousRoot: previousWorkspaceRootFromMetadata(input.state.record.metadata),
    nextInspection: inspection,
    hasPersistedState: input.hasPersistedState,
  });

  if (decision.resetRequired) {
    input.resetWorkspaceState(input.sessionKey, input.state);
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "workspace_boundary_reset",
      "workspace-boundary",
      `reason=${decision.reason} root=${decision.root ?? "<unknown>"}`,
      input.requestId,
      {
        reason: decision.reason,
        workspace_root: decision.root,
        workspace_empty: inspection.isEmpty,
        project_instruction_files: inspection.projectInstructionFiles,
      },
    );
  }

  if (inspection.fingerprint) {
    input.state.record.metadata.workspace_fingerprint = inspection.fingerprint;
  }
  if (inspection.root) {
    input.state.record.metadata.workspace_root = inspection.root;
  }
  const projectRoot = normalizeAbsolutePathHint(input.pathHints.projectRoot);
  const rawShellCwd = normalizeAbsolutePathHint(input.pathHints.shellCwd);
  const shellCwd = projectRoot && rawShellCwd && !isPathInsideRoot(rawShellCwd, projectRoot)
    ? null
    : rawShellCwd;
  if (projectRoot) input.state.record.metadata.workspace_context_project_root = projectRoot;
  if (shellCwd) input.state.record.metadata.workspace_context_cwd = shellCwd;
  input.state.record.metadata.workspace_empty = inspection.isEmpty;
  input.state.record.metadata.workspace_project_guidance_absent =
    inspection.isEmpty && inspection.projectInstructionFiles.length === 0;
  if (inspection.projectInstructionFiles.length > 0) {
    input.state.record.metadata.workspace_project_instruction_files = inspection.projectInstructionFiles;
  } else {
    delete input.state.record.metadata.workspace_project_instruction_files;
  }
  if (inspection.readError) {
    input.state.record.metadata.workspace_inspection_error = inspection.readError;
  } else {
    delete input.state.record.metadata.workspace_inspection_error;
  }
  return inspection;
}
