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

export interface StateTransitionEvent {
  tool_sequence: string[];
  governor_rules: string[];
  governor_pause: boolean;
  evidence_delta: EvidenceDeltaSummary;
  outcome_state: string;
}

export type StateTransitionQualityLabel =
  | "forward_progress"
  | "stalled"
  | "regressed"
  | "reground_required";

export interface StateTransitionQualityAssessment {
  label: StateTransitionQualityLabel;
  score: number;
  reasons: string[];
  recommended_action: "continue" | "recover" | "reground";
}

export interface StateTransitionTrainingRow {
  schema_version: "state_transition_training_v1";
  request_id: string;
  quality_label: StateTransitionQualityLabel;
  quality_score: number;
  quality_reasons: string[];
  recommended_action: "continue" | "recover" | "reground";
  outcome_state: string;
  evidence_delta: EvidenceDeltaSummary;
  governor_pause: boolean;
  objective_epoch_advanced: boolean;
  objective_changed: boolean;
  confidence_delta: number | null;
  stale_files_delta: number;
  partial_files_delta: number;
  evicted_files_delta: number;
  unresolved_corrections_delta: number;
  resolved_corrections_delta: number;
}

export interface StateTransitionRecord {
  schema_version: "state_transition_v1";
  request_id: string;
  from_state: StateTransitionSnapshot | null;
  to_state: StateTransitionSnapshot;
  event: StateTransitionEvent;
  delta: StateTransitionDelta;
  quality: StateTransitionQualityAssessment;
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

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.max(-1, Math.min(1, value)).toFixed(3));
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
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

export function assessStateTransitionQuality(input: {
  delta: StateTransitionDelta;
  toState: StateTransitionSnapshot;
  event: StateTransitionEvent;
}): StateTransitionQualityAssessment {
  const { delta, toState, event } = input;
  const reasons: string[] = [];
  let score = 0;

  if (event.evidence_delta === "improved") {
    score += 0.35;
    reasons.push("evidence_improved");
  } else if (event.evidence_delta === "regressed") {
    score -= 0.45;
    reasons.push("evidence_regressed");
  } else if (event.evidence_delta === "stalled") {
    score -= 0.2;
    reasons.push("evidence_stalled");
  } else if (event.evidence_delta === "changed") {
    score += 0.05;
    reasons.push("evidence_changed");
  }

  if (delta.confidence_delta !== null) {
    score += delta.confidence_delta * 0.6;
    if (delta.confidence_delta > 0.02) reasons.push("confidence_rising");
    if (delta.confidence_delta < -0.02) reasons.push("confidence_falling");
  }
  if (delta.confidence_improved) {
    reasons.push("confidence_improved");
  }

  if (delta.stale_files_delta < 0) {
    score += 0.2;
    reasons.push("stale_files_reduced");
  } else if (delta.stale_files_delta > 0) {
    score -= 0.25;
    reasons.push("stale_files_increased");
  }

  if (delta.partial_files_delta < 0) {
    score += 0.1;
    reasons.push("partial_files_reduced");
  } else if (delta.partial_files_delta > 0) {
    score -= 0.12;
    reasons.push("partial_files_increased");
  }

  if (delta.evicted_files_delta < 0) {
    score += 0.08;
    reasons.push("evicted_files_reduced");
  } else if (delta.evicted_files_delta > 0) {
    score -= 0.12;
    reasons.push("evicted_files_increased");
  }

  if (delta.unresolved_corrections_delta < 0) {
    score += 0.15;
    reasons.push("unresolved_corrections_reduced");
  } else if (delta.unresolved_corrections_delta > 0) {
    score -= 0.15;
    reasons.push("unresolved_corrections_increased");
  }

  if (delta.resolved_corrections_delta > 0) {
    score += 0.12;
    reasons.push("resolved_corrections_increased");
  }

  if (event.governor_pause) {
    score -= 0.25;
    reasons.push("governor_intervened");
  }

  if (event.outcome_state === "verified" || event.outcome_state === "completed") {
    score += 0.25;
    reasons.push("verified_outcome");
  } else if (event.outcome_state === "stalled") {
    score -= 0.25;
    reasons.push("stalled_outcome");
  }

  if (delta.changed_fields.length === 0) {
    score -= 0.1;
    reasons.push("no_state_change");
  }

  if (toState.confidenceNeedsReground) {
    score -= 0.3;
    reasons.push("reground_required");
  }

  const qualityScore = clampScore(score);
  const label: StateTransitionQualityLabel = toState.confidenceNeedsReground
    ? "reground_required"
    : (event.evidence_delta === "regressed" || qualityScore <= -0.35)
      ? "regressed"
      : qualityScore >= 0.2
        ? "forward_progress"
        : "stalled";
  const recommendedAction: StateTransitionQualityAssessment["recommended_action"] = label === "reground_required"
    ? "reground"
    : label === "regressed"
      ? "recover"
      : "continue";

  return {
    label,
    score: qualityScore,
    reasons: unique(reasons),
    recommended_action: recommendedAction,
  };
}

export function materializeStateTransitionTrainingRow(
  record: StateTransitionRecord,
): StateTransitionTrainingRow {
  return {
    schema_version: "state_transition_training_v1",
    request_id: record.request_id,
    quality_label: record.quality.label,
    quality_score: record.quality.score,
    quality_reasons: record.quality.reasons,
    recommended_action: record.quality.recommended_action,
    outcome_state: record.event.outcome_state,
    evidence_delta: record.event.evidence_delta,
    governor_pause: record.event.governor_pause,
    objective_epoch_advanced: record.delta.objective_epoch_advanced,
    objective_changed: record.delta.objective_changed,
    confidence_delta: record.delta.confidence_delta,
    stale_files_delta: record.delta.stale_files_delta,
    partial_files_delta: record.delta.partial_files_delta,
    evicted_files_delta: record.delta.evicted_files_delta,
    unresolved_corrections_delta: record.delta.unresolved_corrections_delta,
    resolved_corrections_delta: record.delta.resolved_corrections_delta,
  };
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
  const event: StateTransitionEvent = {
    tool_sequence: options.toolSequence,
    governor_rules: options.governorRules,
    governor_pause: options.governorPause,
    evidence_delta: options.evidenceDelta,
    outcome_state: options.outcomeState,
  };
  const quality = assessStateTransitionQuality({
    delta,
    toState: currentSnapshot,
    event,
  });

  return {
    schema_version: "state_transition_v1",
    request_id: options.requestId,
    from_state: previousSnapshot,
    to_state: currentSnapshot,
    event,
    delta,
    quality,
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
    `quality=${record.quality.label}:${record.quality.score}`,
    `stale_delta=${record.delta.stale_files_delta}`,
    `changed=${changed}`,
  ].join(" ");
}
