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

export interface StateTransitionQualityThresholds {
  forward_progress_min: number;
  regressed_max: number;
  minimum_gap: number;
}

export interface StateTransitionCalibrationSample {
  quality_score: number;
  outcome_state: string;
  evidence_delta: EvidenceDeltaSummary;
  governor_pause: boolean;
  needs_reground: boolean;
}

export interface StateTransitionQualityCalibrationReport {
  schema_version: "state_transition_quality_calibration_v1";
  sample_count: number;
  positive_count: number;
  negative_count: number;
  neutral_count: number;
  applied: boolean;
  previous_thresholds: StateTransitionQualityThresholds;
  calibrated_thresholds: StateTransitionQualityThresholds;
  summary: string;
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
  qualityThresholds?: StateTransitionQualityThresholds;
}

export const DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS: StateTransitionQualityThresholds = {
  forward_progress_min: 0.2,
  regressed_max: -0.35,
  minimum_gap: 0.08,
};

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

function clampThreshold(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Number(Math.max(-0.95, Math.min(0.95, value)).toFixed(3));
}

function normalizeThresholds(
  input?: Partial<StateTransitionQualityThresholds> | null,
  fallback: StateTransitionQualityThresholds = DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS,
): StateTransitionQualityThresholds {
  const minimumGap = clampThreshold(Number(input?.minimum_gap ?? fallback.minimum_gap), fallback.minimum_gap);
  let forwardProgressMin = clampThreshold(
    Number(input?.forward_progress_min ?? fallback.forward_progress_min),
    fallback.forward_progress_min,
  );
  let regressedMax = clampThreshold(
    Number(input?.regressed_max ?? fallback.regressed_max),
    fallback.regressed_max,
  );
  if (forwardProgressMin < regressedMax + minimumGap) {
    const midpoint = (forwardProgressMin + regressedMax) / 2;
    forwardProgressMin = clampThreshold(midpoint + minimumGap / 2, fallback.forward_progress_min);
    regressedMax = clampThreshold(midpoint - minimumGap / 2, fallback.regressed_max);
  }
  return {
    forward_progress_min: forwardProgressMin,
    regressed_max: regressedMax,
    minimum_gap: minimumGap,
  };
}

function percentile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clampedQ = Math.max(0, Math.min(1, q));
  const position = (sorted.length - 1) * clampedQ;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const ratio = position - lower;
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * ratio).toFixed(3));
}

function asCalibrationSample(value: unknown): StateTransitionCalibrationSample | null {
  const row = asRecord(value);
  if (!row) return null;
  const score = Number(row.quality_score);
  if (!Number.isFinite(score)) return null;
  return {
    quality_score: clampScore(score),
    outcome_state: asString(row.outcome_state, "unknown"),
    evidence_delta: asString(row.evidence_delta, "unknown") as EvidenceDeltaSummary,
    governor_pause: asBoolean(row.governor_pause),
    needs_reground: asBoolean(row.needs_reground),
  };
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

export function decodeStateTransitionQualityThresholds(value: unknown): StateTransitionQualityThresholds | null {
  const row = asRecord(value);
  if (!row) return null;
  return normalizeThresholds({
    forward_progress_min: asNumber(row.forward_progress_min, DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS.forward_progress_min),
    regressed_max: asNumber(row.regressed_max, DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS.regressed_max),
    minimum_gap: asNumber(row.minimum_gap, DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS.minimum_gap),
  });
}

export function encodeStateTransitionQualityThresholds(
  thresholds: StateTransitionQualityThresholds,
): Record<string, unknown> {
  const normalized = normalizeThresholds(thresholds);
  return {
    forward_progress_min: normalized.forward_progress_min,
    regressed_max: normalized.regressed_max,
    minimum_gap: normalized.minimum_gap,
  };
}

export function decodeStateTransitionCalibrationSamples(
  value: unknown,
  maxSamples = 128,
): StateTransitionCalibrationSample[] {
  if (!Array.isArray(value)) return [];
  const samples: StateTransitionCalibrationSample[] = [];
  for (const row of value) {
    const sample = asCalibrationSample(row);
    if (!sample) continue;
    samples.push(sample);
    if (samples.length >= maxSamples) break;
  }
  return samples;
}

export function encodeStateTransitionCalibrationSamples(
  samples: readonly StateTransitionCalibrationSample[],
  maxSamples = 128,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const sliced = samples.slice(Math.max(0, samples.length - maxSamples));
  for (const sample of sliced) {
    out.push({
      quality_score: clampScore(sample.quality_score),
      outcome_state: sample.outcome_state,
      evidence_delta: sample.evidence_delta,
      governor_pause: sample.governor_pause,
      needs_reground: sample.needs_reground,
    });
  }
  return out;
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

function calibrationBucket(sample: StateTransitionCalibrationSample): "positive" | "negative" | "neutral" {
  if (sample.needs_reground) return "negative";
  if (sample.evidence_delta === "regressed" || sample.outcome_state === "stalled" || sample.governor_pause) {
    return "negative";
  }
  if (
    (sample.outcome_state === "verified" || sample.outcome_state === "completed")
    && sample.evidence_delta !== "stalled"
    && !sample.governor_pause
  ) {
    return "positive";
  }
  return "neutral";
}

function blend(base: number, candidate: number | null, alpha: number): number {
  if (candidate === null || !Number.isFinite(candidate)) return base;
  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  return base * (1 - clampedAlpha) + candidate * clampedAlpha;
}

export function calibrateStateTransitionQualityThresholds(input: {
  samples: readonly StateTransitionCalibrationSample[];
  baseThresholds?: StateTransitionQualityThresholds;
  minSamples?: number;
  minPositive?: number;
  minNegative?: number;
  smoothing?: number;
}): StateTransitionQualityCalibrationReport {
  const baseThresholds = normalizeThresholds(input.baseThresholds);
  const minSamples = Math.max(4, Math.trunc(input.minSamples ?? 12));
  const minPositive = Math.max(2, Math.trunc(input.minPositive ?? 3));
  const minNegative = Math.max(2, Math.trunc(input.minNegative ?? 3));
  const smoothing = Number.isFinite(Number(input.smoothing)) ? Number(input.smoothing) : 0.5;

  const positiveScores: number[] = [];
  const negativeScores: number[] = [];
  const neutralScores: number[] = [];
  for (const sample of input.samples) {
    if (!Number.isFinite(sample.quality_score)) continue;
    const clamped = clampScore(sample.quality_score);
    const bucket = calibrationBucket(sample);
    if (bucket === "positive") positiveScores.push(clamped);
    else if (bucket === "negative") negativeScores.push(clamped);
    else neutralScores.push(clamped);
  }

  const sampleCount = positiveScores.length + negativeScores.length + neutralScores.length;
  let calibratedThresholds = baseThresholds;
  let applied = false;
  if (sampleCount >= minSamples && positiveScores.length >= minPositive && negativeScores.length >= minNegative) {
    const positiveP25 = percentile(positiveScores, 0.25);
    const negativeP75 = percentile(negativeScores, 0.75);
    calibratedThresholds = normalizeThresholds({
      forward_progress_min: blend(baseThresholds.forward_progress_min, positiveP25, smoothing),
      regressed_max: blend(baseThresholds.regressed_max, negativeP75, smoothing),
      minimum_gap: baseThresholds.minimum_gap,
    }, baseThresholds);
    applied = true;
  }

  return {
    schema_version: "state_transition_quality_calibration_v1",
    sample_count: sampleCount,
    positive_count: positiveScores.length,
    negative_count: negativeScores.length,
    neutral_count: neutralScores.length,
    applied,
    previous_thresholds: baseThresholds,
    calibrated_thresholds: calibratedThresholds,
    summary: [
      `samples=${sampleCount}`,
      `positive=${positiveScores.length}`,
      `negative=${negativeScores.length}`,
      `forward_min=${calibratedThresholds.forward_progress_min}`,
      `regressed_max=${calibratedThresholds.regressed_max}`,
      `applied=${applied}`,
    ].join(" "),
  };
}

export function buildStateTransitionCalibrationSample(
  record: StateTransitionRecord,
): StateTransitionCalibrationSample {
  return {
    quality_score: record.quality.score,
    outcome_state: record.event.outcome_state,
    evidence_delta: record.event.evidence_delta,
    governor_pause: record.event.governor_pause,
    needs_reground: record.to_state.confidenceNeedsReground,
  };
}

export function assessStateTransitionQuality(input: {
  delta: StateTransitionDelta;
  toState: StateTransitionSnapshot;
  event: StateTransitionEvent;
  thresholds?: StateTransitionQualityThresholds;
}): StateTransitionQualityAssessment {
  const { delta, toState, event } = input;
  const thresholds = normalizeThresholds(input.thresholds);
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
    : (event.evidence_delta === "regressed" || qualityScore <= thresholds.regressed_max)
      ? "regressed"
      : qualityScore >= thresholds.forward_progress_min
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
    thresholds: options.qualityThresholds,
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
