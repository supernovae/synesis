import type { ChatStateSnapshot } from "../governance/chat-state.js";
import type { FileStateSnapshot } from "../governance/file-state.js";
import type {
  GovernorPauseChatStateSummary,
  GovernorPauseFileStateSummary,
} from "../governance/execution-governor.js";

export type PersistenceChatStateSummary = GovernorPauseChatStateSummary & Record<string, unknown>;
export type PersistenceFileStateSummary = GovernorPauseFileStateSummary & Record<string, unknown>;

export interface PersistenceStateChannelSummary {
  objectiveEpochId: number;
  objectiveScopeBoundaryIndex: number;
  objectiveScopeRetainedEvidence: number;
  objectiveScopeDroppedPreBoundary: number;
  objectiveScopeSummary?: Record<string, unknown>;
  stateConfidenceChat: number;
  stateConfidenceFile: number;
  stateConfidenceOverall: number;
  stateConfidenceNeedsReground: boolean;
  stateConfidenceRecommendedPath: string;
  stateConfidenceReasons: string[];
  stateConfidenceSummary?: Record<string, unknown>;
}

export interface PersistenceStateChannelPreparation {
  persistedChatSnapshot: Partial<ChatStateSnapshot> | null;
  persistedFileSnapshot: FileStateSnapshot | null;
  chatStateSummary: PersistenceChatStateSummary | undefined;
  fileStateSummary: PersistenceFileStateSummary | undefined;
  stateChannelSummary: PersistenceStateChannelSummary;
  objectiveScopeSummary?: Record<string, unknown>;
  stateConfidenceSummary?: Record<string, unknown>;
}

function metadataObject(metadata: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = metadata[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function trimStateChannelSnippet(text: string, max = 2000): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function readPersistedChatStateSnapshot(
  metadata: Record<string, unknown>,
): Partial<ChatStateSnapshot> | null {
  const raw = metadataObject(metadata, "chat_state_snapshot");
  if (!raw) return null;

  const phase = typeof raw.phase === "string" ? raw.phase.trim().toLowerCase() : "";
  const completionStatus = typeof raw.completionStatus === "string" ? raw.completionStatus.trim().toLowerCase() : "";
  const verificationOutcome = typeof raw.lastVerificationOutcome === "string"
    ? raw.lastVerificationOutcome.trim().toLowerCase()
    : "";
  const updatedAt = Number(raw.updatedAt ?? 0);

  const snapshot: Partial<ChatStateSnapshot> = {};
  if (typeof raw.activeObjective === "string") snapshot.activeObjective = raw.activeObjective;
  if (typeof raw.pendingUserDirective === "string") snapshot.pendingUserDirective = raw.pendingUserDirective;
  if (phase === "interpret" || phase === "inspect" || phase === "edit" || phase === "verify" || phase === "recover" || phase === "finalize") {
    snapshot.phase = phase as ChatStateSnapshot["phase"];
  }
  if (completionStatus === "in_progress" || completionStatus === "blocked" || completionStatus === "ready_to_finalize" || completionStatus === "complete_claimed") {
    snapshot.completionStatus = completionStatus as ChatStateSnapshot["completionStatus"];
  }
  if (verificationOutcome === "pass" || verificationOutcome === "fail" || verificationOutcome === "unknown") {
    snapshot.lastVerificationOutcome = verificationOutcome as ChatStateSnapshot["lastVerificationOutcome"];
  }
  if (typeof raw.transcriptSummary === "string") snapshot.transcriptSummary = raw.transcriptSummary;
  if (Number.isFinite(Number(raw.unresolvedCorrectionCount))) {
    snapshot.unresolvedCorrectionCount = Number(raw.unresolvedCorrectionCount);
  }
  if (Number.isFinite(Number(raw.resolvedCorrectionCount))) {
    snapshot.resolvedCorrectionCount = Number(raw.resolvedCorrectionCount);
  }
  if (Number.isFinite(updatedAt) && updatedAt > 0) snapshot.updatedAt = updatedAt;
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

export function readPersistedFileStateSnapshot(metadata: Record<string, unknown>): FileStateSnapshot | null {
  const raw = metadataObject(metadata, "file_state_snapshot");
  if (!raw) return null;
  const fileCount = Number(raw.fileCount ?? 0);
  const statusCountsRaw = metadataObject(raw, "statusCounts") ?? {};
  const staleFiles = Array.isArray(raw.staleFiles) ? raw.staleFiles.map((value) => String(value)).slice(0, 8) : [];
  const partialFiles = Array.isArray(raw.partialFiles) ? raw.partialFiles.map((value) => String(value)).slice(0, 8) : [];
  const evictedFiles = Array.isArray(raw.evictedFiles) ? raw.evictedFiles.map((value) => String(value)).slice(0, 8) : [];
  const updatedAt = Number(raw.updatedAt ?? Date.now());
  const statusCounts = {
    available: Number(statusCountsRaw.available ?? 0),
    partial: Number(statusCountsRaw.partial ?? 0),
    unchanged: Number(statusCountsRaw.unchanged ?? 0),
    stale: Number(statusCountsRaw.stale ?? 0),
    evicted: Number(statusCountsRaw.evicted ?? 0),
    missing: Number(statusCountsRaw.missing ?? 0),
  };
  return {
    fileCount: Number.isFinite(fileCount) ? fileCount : 0,
    statusCounts,
    staleFiles,
    partialFiles,
    evictedFiles,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

export function summarizeChatSnapshotForGovernor(
  snapshot: Partial<ChatStateSnapshot> | null,
): PersistenceChatStateSummary | undefined {
  if (!snapshot) return undefined;
  const completionStatus = snapshot.completionStatus;
  const verificationOutcome = snapshot.lastVerificationOutcome;
  if (
    completionStatus !== "in_progress"
    && completionStatus !== "blocked"
    && completionStatus !== "ready_to_finalize"
    && completionStatus !== "complete_claimed"
  ) {
    return undefined;
  }
  if (
    verificationOutcome !== "pass"
    && verificationOutcome !== "fail"
    && verificationOutcome !== "unknown"
  ) {
    return undefined;
  }
  return {
    active_objective: typeof snapshot.activeObjective === "string" ? trimStateChannelSnippet(snapshot.activeObjective, 220) : null,
    pending_user_directive: typeof snapshot.pendingUserDirective === "string" ? trimStateChannelSnippet(snapshot.pendingUserDirective, 220) : null,
    completion_status: completionStatus,
    last_verification_outcome: verificationOutcome,
    narration_residue_present: false,
  } as PersistenceChatStateSummary;
}

export function summarizeFileStateForGovernor(snapshot: FileStateSnapshot): PersistenceFileStateSummary {
  return {
    files_total: snapshot.fileCount,
    status_counts: snapshot.statusCounts,
    stale_files: snapshot.staleFiles,
    partial_files: snapshot.partialFiles,
    evicted_files: snapshot.evictedFiles,
  } as PersistenceFileStateSummary;
}

export function buildPersistenceStateChannelSummary(
  metadata: Record<string, unknown>,
): PersistenceStateChannelSummary {
  const objectiveEpochId = Number(metadata.objective_epoch_id ?? 0);
  const objectiveScopeBoundaryIndex = Number(metadata.objective_scope_boundary_index ?? -1);
  const objectiveScopeRetainedEvidence = Number(metadata.objective_scope_retained_evidence ?? 0);
  const objectiveScopeDroppedPreBoundary = Number(metadata.objective_scope_dropped_pre_boundary ?? 0);
  const stateConfidenceChat = Number(metadata.state_confidence_chat ?? NaN);
  const stateConfidenceFile = Number(metadata.state_confidence_file ?? NaN);
  const stateConfidenceOverall = Number(metadata.state_confidence_overall ?? NaN);
  const stateConfidenceNeedsReground = metadata.state_confidence_needs_reground === true;
  const stateConfidenceRecommendedPath = typeof metadata.state_confidence_recommended_path === "string"
    ? metadata.state_confidence_recommended_path
    : "";
  const stateConfidenceReasons = Array.isArray(metadata.state_confidence_reasons)
    ? metadata.state_confidence_reasons.map((value) => String(value))
    : [];
  const objectiveScopeSummary = objectiveEpochId > 0
    ? {
        epoch_id: objectiveEpochId,
        boundary_index: objectiveScopeBoundaryIndex,
        retained_evidence: objectiveScopeRetainedEvidence,
        dropped_pre_boundary: objectiveScopeDroppedPreBoundary,
      }
    : undefined;
  const stateConfidenceSummary = Number.isFinite(stateConfidenceOverall)
    ? {
        chat: Number.isFinite(stateConfidenceChat) ? stateConfidenceChat : undefined,
        file: Number.isFinite(stateConfidenceFile) ? stateConfidenceFile : undefined,
        overall: stateConfidenceOverall,
        needs_reground: stateConfidenceNeedsReground,
        recommended_path: stateConfidenceRecommendedPath || undefined,
        reasons: stateConfidenceReasons.length > 0 ? stateConfidenceReasons : undefined,
      }
    : undefined;

  return {
    objectiveEpochId,
    objectiveScopeBoundaryIndex,
    objectiveScopeRetainedEvidence,
    objectiveScopeDroppedPreBoundary,
    objectiveScopeSummary,
    stateConfidenceChat,
    stateConfidenceFile,
    stateConfidenceOverall,
    stateConfidenceNeedsReground,
    stateConfidenceRecommendedPath,
    stateConfidenceReasons,
    stateConfidenceSummary,
  };
}

export function preparePersistenceStateChannels(
  metadata: Record<string, unknown>,
): PersistenceStateChannelPreparation {
  const persistedChatSnapshot = readPersistedChatStateSnapshot(metadata);
  const persistedFileSnapshot = readPersistedFileStateSnapshot(metadata);
  const chatStateSummary = summarizeChatSnapshotForGovernor(persistedChatSnapshot);
  const fileStateSummary = persistedFileSnapshot
    ? summarizeFileStateForGovernor(persistedFileSnapshot)
    : undefined;
  const stateChannelSummary = buildPersistenceStateChannelSummary(metadata);
  return {
    persistedChatSnapshot,
    persistedFileSnapshot,
    chatStateSummary,
    fileStateSummary,
    stateChannelSummary,
    objectiveScopeSummary: stateChannelSummary.objectiveScopeSummary,
    stateConfidenceSummary: stateChannelSummary.stateConfidenceSummary,
  };
}
