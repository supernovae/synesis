import type { EvidenceDeltaSummary } from "./evidence-delta.js";

export interface StateTransitionSnapshot {
  objectiveEpochId: number;
  objectiveHash: string;
  chatPhase: string;
  completionStatus: string;
  verificationOutcome: string;
  unresolvedCorrectionCount: number;
  resolvedCorrectionCount: number;
  fileStatusCounts: {
    available: number;
    partial: number;
    unchanged: number;
    stale: number;
    evicted: number;
    missing: number;
  };
  confidenceOverall: number | null;
  confidenceNeedsReground: boolean;
  confidenceReasons: string[];
  scopeBoundaryIndex: number;
  scopeRetainedEvidence: number;
  scopeDroppedPreBoundary: number;
}

export interface StateTransitionDelta {
  changed_fields: string[];
  objective_epoch_advanced: boolean;
  objective_changed: boolean;
  completion_status_changed: boolean;
  verification_outcome_changed: boolean;
  unresolved_corrections_delta: number;
  resolved_corrections_delta: number;
  stale_files_delta: number;
  partial_files_delta: number;
  evicted_files_delta: number;
  confidence_delta: number | null;
  confidence_improved: boolean;
}

export interface StateTransitionRecord {
  schema_version: "state_transition_v1";
  request_id: string;
  from_state: StateTransitionSnapshot | null;
  to_state: StateTransitionSnapshot;
  event: {
    tool_sequence: string[];
    governor_rules: string[];
    governor_pause: boolean;
    evidence_delta: EvidenceDeltaSummary;
    outcome_state: string;
  };
  delta: StateTransitionDelta;
}

export interface BuildStateTransitionRecordOptions {
  requestId: string;
  previousSnapshot: StateTransitionSnapshot | null;
  currentSnapshot: StateTransitionSnapshot;
  toolSequence: string[];
  governorRules: string[];
  governorPause: boolean;
  evidenceDelta: EvidenceDeltaSummary;
  outcomeState: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asNullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function cleanCount(value: unknown): number {
  return Math.max(0, Math.trunc(asNumber(value, 0)));
}

function normalizeStatusCounts(value: unknown): StateTransitionSnapshot["fileStatusCounts"] {
  const row = asRecord(value);
  return {
    available: cleanCount(row?.available),
    partial: cleanCount(row?.partial),
    unchanged: cleanCount(row?.unchanged),
    stale: cleanCount(row?.stale),
    evicted: cleanCount(row?.evicted),
    missing: cleanCount(row?.missing),
  };
}

function normalizeConfidence(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const normalized = Math.max(0, Math.min(1, value));
  return Number(normalized.toFixed(3));
}

export function buildStateTransitionSnapshotFromMetadata(
  metadata: Record<string, unknown>,
): StateTransitionSnapshot {
  const chat = asRecord(metadata.chat_state_snapshot);
  const file = asRecord(metadata.file_state_snapshot);
  const fileStatusCounts = normalizeStatusCounts(file?.statusCounts);
  return {
    objectiveEpochId: cleanCount(metadata.objective_epoch_id),
    objectiveHash: asString(metadata.objective_epoch_objective_hash),
    chatPhase: asString(chat?.phase, "unknown"),
    completionStatus: asString(chat?.completionStatus, "unknown"),
    verificationOutcome: asString(chat?.lastVerificationOutcome, "unknown"),
    unresolvedCorrectionCount: cleanCount(chat?.unresolvedCorrectionCount),
    resolvedCorrectionCount: cleanCount(chat?.resolvedCorrectionCount),
    fileStatusCounts,
    confidenceOverall: normalizeConfidence(asNullableNumber(metadata.state_confidence_overall)),
    confidenceNeedsReground: asBoolean(metadata.state_confidence_needs_reground),
    confidenceReasons: asStringArray(metadata.state_confidence_reasons),
    scopeBoundaryIndex: asNumber(metadata.objective_scope_boundary_index, -1),
    scopeRetainedEvidence: cleanCount(metadata.objective_scope_retained_evidence),
    scopeDroppedPreBoundary: cleanCount(metadata.objective_scope_dropped_pre_boundary),
  };
}

export function decodeStateTransitionSnapshot(value: unknown): StateTransitionSnapshot | null {
  const row = asRecord(value);
  if (!row) return null;
  return {
    objectiveEpochId: cleanCount(row.objectiveEpochId),
    objectiveHash: asString(row.objectiveHash),
    chatPhase: asString(row.chatPhase, "unknown"),
    completionStatus: asString(row.completionStatus, "unknown"),
    verificationOutcome: asString(row.verificationOutcome, "unknown"),
    unresolvedCorrectionCount: cleanCount(row.unresolvedCorrectionCount),
    resolvedCorrectionCount: cleanCount(row.resolvedCorrectionCount),
    fileStatusCounts: normalizeStatusCounts(row.fileStatusCounts),
    confidenceOverall: normalizeConfidence(asNullableNumber(row.confidenceOverall)),
    confidenceNeedsReground: asBoolean(row.confidenceNeedsReground),
    confidenceReasons: asStringArray(row.confidenceReasons),
    scopeBoundaryIndex: asNumber(row.scopeBoundaryIndex, -1),
    scopeRetainedEvidence: cleanCount(row.scopeRetainedEvidence),
    scopeDroppedPreBoundary: cleanCount(row.scopeDroppedPreBoundary),
  };
}

export function encodeStateTransitionSnapshot(
  snapshot: StateTransitionSnapshot,
): Record<string, unknown> {
  return {
    objectiveEpochId: snapshot.objectiveEpochId,
    objectiveHash: snapshot.objectiveHash,
    chatPhase: snapshot.chatPhase,
    completionStatus: snapshot.completionStatus,
    verificationOutcome: snapshot.verificationOutcome,
    unresolvedCorrectionCount: snapshot.unresolvedCorrectionCount,
    resolvedCorrectionCount: snapshot.resolvedCorrectionCount,
    fileStatusCounts: snapshot.fileStatusCounts,
    confidenceOverall: snapshot.confidenceOverall,
    confidenceNeedsReground: snapshot.confidenceNeedsReground,
    confidenceReasons: snapshot.confidenceReasons,
    scopeBoundaryIndex: snapshot.scopeBoundaryIndex,
    scopeRetainedEvidence: snapshot.scopeRetainedEvidence,
    scopeDroppedPreBoundary: snapshot.scopeDroppedPreBoundary,
  };
}

function computeChangedFields(
  previousSnapshot: StateTransitionSnapshot | null,
  currentSnapshot: StateTransitionSnapshot,
): string[] {
  if (!previousSnapshot) {
    return [
      "objective_epoch",
      "chat_phase",
      "completion_status",
      "verification_outcome",
      "file_status_counts",
      "confidence",
      "scope",
    ];
  }
  const changed: string[] = [];
  if (previousSnapshot.objectiveEpochId !== currentSnapshot.objectiveEpochId) changed.push("objective_epoch");
  if (previousSnapshot.objectiveHash !== currentSnapshot.objectiveHash) changed.push("objective_hash");
  if (previousSnapshot.chatPhase !== currentSnapshot.chatPhase) changed.push("chat_phase");
  if (previousSnapshot.completionStatus !== currentSnapshot.completionStatus) changed.push("completion_status");
  if (previousSnapshot.verificationOutcome !== currentSnapshot.verificationOutcome) changed.push("verification_outcome");
  if (previousSnapshot.unresolvedCorrectionCount !== currentSnapshot.unresolvedCorrectionCount) changed.push("unresolved_corrections");
  if (previousSnapshot.resolvedCorrectionCount !== currentSnapshot.resolvedCorrectionCount) changed.push("resolved_corrections");
  if (
    previousSnapshot.fileStatusCounts.stale !== currentSnapshot.fileStatusCounts.stale
    || previousSnapshot.fileStatusCounts.partial !== currentSnapshot.fileStatusCounts.partial
    || previousSnapshot.fileStatusCounts.evicted !== currentSnapshot.fileStatusCounts.evicted
    || previousSnapshot.fileStatusCounts.available !== currentSnapshot.fileStatusCounts.available
    || previousSnapshot.fileStatusCounts.unchanged !== currentSnapshot.fileStatusCounts.unchanged
    || previousSnapshot.fileStatusCounts.missing !== currentSnapshot.fileStatusCounts.missing
  ) {
    changed.push("file_status_counts");
  }
  if (previousSnapshot.confidenceOverall !== currentSnapshot.confidenceOverall) changed.push("confidence");
  if (previousSnapshot.confidenceNeedsReground !== currentSnapshot.confidenceNeedsReground) changed.push("reground_gate");
  if (
    previousSnapshot.scopeBoundaryIndex !== currentSnapshot.scopeBoundaryIndex
    || previousSnapshot.scopeRetainedEvidence !== currentSnapshot.scopeRetainedEvidence
    || previousSnapshot.scopeDroppedPreBoundary !== currentSnapshot.scopeDroppedPreBoundary
  ) {
    changed.push("scope");
  }
  return changed;
}

export function buildStateTransitionRecord(
  options: BuildStateTransitionRecordOptions,
): StateTransitionRecord {
  const previousSnapshot = options.previousSnapshot;
  const currentSnapshot = options.currentSnapshot;
  const previousStale = previousSnapshot?.fileStatusCounts.stale ?? 0;
  const previousPartial = previousSnapshot?.fileStatusCounts.partial ?? 0;
  const previousEvicted = previousSnapshot?.fileStatusCounts.evicted ?? 0;
  const previousUnresolved = previousSnapshot?.unresolvedCorrectionCount ?? 0;
  const previousResolved = previousSnapshot?.resolvedCorrectionCount ?? 0;
  const previousConfidence = previousSnapshot?.confidenceOverall ?? null;
  const nextConfidence = currentSnapshot.confidenceOverall;
  const confidenceDelta =
    previousConfidence === null || nextConfidence === null
      ? null
      : Number((nextConfidence - previousConfidence).toFixed(3));

  const delta: StateTransitionDelta = {
    changed_fields: computeChangedFields(previousSnapshot, currentSnapshot),
    objective_epoch_advanced: previousSnapshot
      ? currentSnapshot.objectiveEpochId > previousSnapshot.objectiveEpochId
      : currentSnapshot.objectiveEpochId > 0,
    objective_changed: previousSnapshot
      ? currentSnapshot.objectiveHash !== previousSnapshot.objectiveHash
      : Boolean(currentSnapshot.objectiveHash),
    completion_status_changed: previousSnapshot
      ? currentSnapshot.completionStatus !== previousSnapshot.completionStatus
      : true,
    verification_outcome_changed: previousSnapshot
      ? currentSnapshot.verificationOutcome !== previousSnapshot.verificationOutcome
      : true,
    unresolved_corrections_delta: currentSnapshot.unresolvedCorrectionCount - previousUnresolved,
    resolved_corrections_delta: currentSnapshot.resolvedCorrectionCount - previousResolved,
    stale_files_delta: currentSnapshot.fileStatusCounts.stale - previousStale,
    partial_files_delta: currentSnapshot.fileStatusCounts.partial - previousPartial,
    evicted_files_delta: currentSnapshot.fileStatusCounts.evicted - previousEvicted,
    confidence_delta: confidenceDelta,
    confidence_improved: confidenceDelta !== null && confidenceDelta > 0.02,
  };

  return {
    schema_version: "state_transition_v1",
    request_id: options.requestId,
    from_state: previousSnapshot,
    to_state: currentSnapshot,
    event: {
      tool_sequence: options.toolSequence,
      governor_rules: options.governorRules,
      governor_pause: options.governorPause,
      evidence_delta: options.evidenceDelta,
      outcome_state: options.outcomeState,
    },
    delta,
  };
}

export function summarizeStateTransition(record: StateTransitionRecord): string {
  const fromEpoch = record.from_state?.objectiveEpochId ?? 0;
  const toEpoch = record.to_state.objectiveEpochId;
  const fromConfidence = record.from_state?.confidenceOverall;
  const toConfidence = record.to_state.confidenceOverall;
  const changed = record.delta.changed_fields.join(",") || "none";
  return [
    `epoch=${fromEpoch}->${toEpoch}`,
    `confidence=${fromConfidence ?? "n/a"}->${toConfidence ?? "n/a"}`,
    `stale_delta=${record.delta.stale_files_delta}`,
    `changed=${changed}`,
  ].join(" ");
}
