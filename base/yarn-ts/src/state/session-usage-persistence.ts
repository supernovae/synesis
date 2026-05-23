import type { SessionContinuity, SessionRecord } from "./session-store.js";
import type { SessionEventInsert, UsageEvent } from "./usage-writer.js";
import type { LlmUsage, PricingRates, TraceRecord } from "@synesis/telemetry";
import type { DecisionSnapshot } from "../telemetry/decision-snapshot.js";
import {
  DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS,
  buildStateTransitionCalibrationSample,
  buildStateTransitionRecord,
  calibrateStateTransitionQualityThresholds,
  decodeStateTransitionCalibrationSamples,
  decodeStateTransitionQualityThresholds,
  encodeStateTransitionCalibrationSamples,
  encodeStateTransitionQualityThresholds,
  materializeStateTransitionTrainingRow,
  summarizeStateTransition,
  type StateTransitionSnapshot,
  type StateTransitionQualityCalibrationReport,
  type StateTransitionQualityThresholds,
  type StateTransitionRecord,
  type StateTransitionTrainingRow,
} from "../governance/state-transition-ledger.js";
import type {
  GlobalCalibrationObservation,
  GlobalThresholdResolution,
  StateTransitionGlobalCalibrator,
} from "../governance/state-transition-global-calibrator.js";
import type { EvidenceDeltaSummary } from "../governance/evidence-delta.js";

export interface SessionUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface SessionUsageWithCost extends SessionUsageSummary {
  cacheCreationTokens: number;
  costUsd: number;
}

export interface SessionUsagePersistenceState {
  record: SessionRecord;
  consecutiveToolCalls: number;
  stagnantToolCycles: number;
  lastToolSignalHash: string;
  awaitingToolLoopUserAck: boolean;
  toolLoopAckAnchorUserHash: string;
  toolLoopNoUserAckCount: number;
  blockBroadVerificationUntilEdit: boolean;
  blockFailingVerificationUntilEdit: boolean;
}

export interface ApplySessionUsagePersistenceInput {
  requestId: string;
  resolvedModelId: string;
  traceModel: string;
  usage: SessionUsageSummary;
  tokensSavedByReduction: number;
  normalizedEstimatedCostUsd: number;
  normalizedActualCostUsd: number;
  finishReason: string;
  tokenEconomicsWarnings: unknown;
}

export interface ApplyGovernorTelemetryMetadataInput {
  record: SessionRecord;
  snapshot?: DecisionSnapshot;
}

export interface SessionTraceLinks {
  previousTraceId: string | undefined;
  parentTraceId: string | undefined;
  rootTraceId: string;
}

export interface UsageCostBreakdown {
  tokens_uncached_input?: number;
  tokens_cache_read?: number;
  tokens_cache_write?: number;
  input_cost_usd?: number;
  cache_read_cost_usd?: number;
  cache_write_cost_usd?: number;
  output_cost_usd?: number;
  estimated_no_cache_cost_usd?: number;
  cache_savings_usd?: number;
}

export interface BuildUsageEventInput {
  record: SessionRecord;
  requestId: string;
  resolvedModelId: string;
  traceModel: string;
  usage: SessionUsageSummary;
  costBreakdown: UsageCostBreakdown;
  tokensSavedByReduction: number;
  latencyMs: number;
  normalizedEstimatedCostUsd: number;
  normalizedActualCostUsd: number;
  pricingSource: string;
  escalated: boolean;
  toolCallsCount: number;
  finishReason: string;
}

export interface InitialSessionPersistenceWriter {
  enqueueSessionUpsert(record: SessionRecord): void;
  enqueueSessionEvent(event: SessionEventInsert): void;
  enqueueContinuityUpsert(
    userId: string,
    orgId: string,
    sessionKey: string,
    continuity: SessionContinuity,
  ): void;
  enqueueUsageInsert(event: UsageEvent): void;
}

export interface RunInitialSessionPersistenceWritesInput {
  record: SessionRecord;
  requestId: string;
  writer: InitialSessionPersistenceWriter;
  saveSession: () => void | Promise<void>;
  conversationMemoryEnabled: boolean;
  tokenEconomicsRecommendation: string;
  tokenEconomicsWarnings: string[];
  tokenEconomicsMetadata: Record<string, unknown>;
  usage: SessionUsageSummary;
  costBreakdown: UsageCostBreakdown;
  resolvedModelId: string;
  traceModel: string;
  tokensSavedByReduction: number;
  latencyMs: number;
  normalizedEstimatedCostUsd: number;
  normalizedActualCostUsd: number;
  pricingSource: string;
  escalated: boolean;
  toolCallsCount: number;
  finishReason: string;
}

export interface BuildTelemetryUsageInput {
  usage: SessionUsageWithCost;
  normalizedEstimatedCostUsd: number;
}

export interface BuildTokenEconomicsWarningEventInput {
  record: SessionRecord;
  requestId: string;
  recommendation: string;
  warnings: string[];
  metadataJson: Record<string, unknown>;
  usage: Pick<SessionUsageSummary, "inputTokens" | "outputTokens">;
}

export interface BuildYarnTraceRecordInput {
  requestId: string;
  record: SessionRecord;
  parentTraceId?: string;
  rootTraceId: string;
  traceModel: string;
  resolvedModelId: string;
  backendModel?: string;
  clientRequestedModel?: string;
  telemetryUsage: LlmUsage;
  normalizedEstimatedCostUsd: number;
  latencyMs: number;
  tierRates: PricingRates;
  rootPromptSnippet: string;
  latestPromptSnippet: string;
  snapshotTraceFields?: Partial<TraceRecord> & { trace_context?: Record<string, unknown> };
  chatStateSummary?: unknown;
  fileStateSummary?: unknown;
  objectiveScopeSummary?: unknown;
  stateConfidenceSummary?: unknown;
  stateTransitionSummary?: unknown;
  tokenEconomics?: unknown;
  optimizationLedger?: unknown;
  finishReason: string;
}

export type YarnTraceRecord = TraceRecord & {
  optimization_ledger?: unknown;
};

export type TrajectoryOutcomeState = "verified" | "partial" | "stalled" | "policy_reject" | "user_abort";
export type TrajectoryFailureStage = "discovery" | "mutation" | "verification" | "policy" | null;
export type TrajectoryBucket = "micro" | "repo" | "feature" | "investigation";
export type TrajectoryToolKind = "discovery" | "evidence" | "mutation" | "verification" | "other";
export type TrajectoryToolKindCounts = {
  discovery: number;
  evidence: number;
  mutation: number;
  verification: number;
  other: number;
};

export interface RequestTrajectoryInput {
  toolSequence?: string[];
  retryCountTotal?: number;
  taskBucket?: TrajectoryBucket;
  filesReadCount?: number;
  bytesReadTotal?: number;
  prematureStopSignals?: number;
  verificationSteps?: string[];
  diagnostics?: {
    structuredErrorsCount?: number;
    diagnosticLinesCount?: number;
    structuredErrorCoverage?: number;
  };
  completionGateBlocked?: boolean;
  criticBlocked?: boolean;
  patchOpsCount?: number;
  wholeWriteOpsCount?: number;
  outcomeState?: TrajectoryOutcomeState;
  failureStage?: TrajectoryFailureStage;
}

export interface BuildRequestTrajectoryMetricsInput {
  trajectory?: RequestTrajectoryInput;
  snapshot?: DecisionSnapshot;
  finishReason: string;
}

export interface RequestTrajectoryMetrics {
  toolSequence: string[];
  patchOpsCount: number;
  wholeWriteOpsCount: number;
  filesWrittenCount: number;
  filesReadCount: number;
  bytesReadTotal?: number;
  readEditRatio?: number;
  patchRatio?: number;
  wholeWriteRatio?: number;
  prematureStopSignals: number;
  verificationSteps: string[];
  countsByKind: TrajectoryToolKindCounts;
  taskBucket: TrajectoryBucket;
  firstPassVerifyOk: boolean;
  structuredErrorsCount: number;
  diagnosticLinesCount: number;
  structuredErrorCoverage: number;
  completionGateBlocked: boolean;
  criticBlocked: boolean;
  outcomeState: TrajectoryOutcomeState;
  failureStage: TrajectoryFailureStage;
}

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

export interface HourlyTokenWindowSnapshot {
  sessionTokensInWindow: number;
  userTokensInWindow: number;
}

export interface BuildHourlyTokenThrottleEventsInput {
  record: SessionRecord;
  requestId: string;
  snapshot: HourlyTokenWindowSnapshot;
  previousSessionWindowTokens: number;
  previousUserWindowTokens: number;
  windowMs: number;
  sessionLimit: number;
  userLimit: number;
}

export interface HourlyTokenWindowCounter {
  addInputTokensAndReadHourlyWindow(
    sessionKey: string,
    userId: string,
    inputTokens: number,
  ): Promise<HourlyTokenWindowSnapshot | null>;
}

export interface RunHourlyTokenThrottleUpdateInput {
  enabled: boolean;
  record: SessionRecord;
  requestId: string;
  inputTokens: number;
  counter: HourlyTokenWindowCounter;
  windowMs: number;
  sessionLimit: number;
  userLimit: number;
  recordEvent: (event: SessionEventInsert) => void;
  saveSession: () => void | Promise<void>;
  warn?: (err: unknown) => void;
}

export interface StateTransitionSummary {
  changed_fields: string[];
  objective_epoch_advanced: boolean;
  objective_changed: boolean;
  confidence_improved: boolean;
  stale_files_delta: number;
  partial_files_delta: number;
  evicted_files_delta: number;
  quality_label: string;
  quality_score: number;
  quality_reasons: string[];
  recommended_action: string;
  quality_thresholds: StateTransitionQualityThresholds;
  quality_calibration_applied: boolean;
  quality_calibration_sample_count: number;
  quality_global_scope: GlobalThresholdResolution["selected_scope"];
  quality_global_sample_count: number;
  quality_global_weight: number;
}

export interface BuildStateTransitionSummaryInput {
  stateTransitionRecord: StateTransitionRecord;
  activeQualityThresholds: StateTransitionQualityThresholds;
  stateTransitionCalibration: StateTransitionQualityCalibrationReport;
  globalThresholdResolutionAfter: GlobalThresholdResolution;
  globalSampleCountAfter: number;
  globalWeightAfter: number;
}

export interface BuildRequestTrajectoryEventInput {
  record: SessionRecord;
  requestId: string;
  traceModel: string;
  snapshot?: DecisionSnapshot;
  escalated: boolean;
  toolSequence: string[];
  taskBucket: string;
  countsByKind: TrajectoryToolKindCounts;
  retryCountTotal: number;
  blindRetryCount: number;
  filesReadCount: number;
  bytesReadTotal?: number;
  filesWrittenCount: number;
  readEditRatio?: number;
  patchOpsCount: number;
  wholeWriteOpsCount: number;
  patchRatio?: number;
  wholeWriteRatio?: number;
  verificationSteps: string[];
  firstPassVerifyOk: boolean;
  structuredErrorsCount: number;
  diagnosticLinesCount: number;
  structuredErrorCoverage: number;
  completionGateBlocked: boolean;
  criticBlocked: boolean;
  usage: SessionUsageWithCost;
  tokensSavedByReduction: number;
  latencyMs: number;
  tokenEconomics: Record<string, unknown>;
  outcomeState: TrajectoryOutcomeState;
  failureStage: TrajectoryFailureStage;
  chatStateSummary?: Record<string, unknown>;
  fileStateSummary?: Record<string, unknown>;
  objectiveScopeSummary?: Record<string, unknown>;
  stateConfidenceSummary?: Record<string, unknown>;
  stateTransitionSummary?: StateTransitionSummary;
  evidenceDelta: unknown;
  chatPhase?: string;
  chatCompletionStatus?: string;
  fileStatusCounts?: {
    stale?: number;
    partial?: number;
    evicted?: number;
  };
  objectiveEpochId: number;
  objectiveScopeBoundaryIndex: number;
  objectiveScopeRetainedEvidence: number;
  objectiveScopeDroppedPreBoundary: number;
  stateConfidenceOverall: number;
  stateConfidenceNeedsReground: boolean;
  stateConfidenceReasons: string[];
  stateTransitionRecord: StateTransitionRecord;
  activeQualityThresholds: StateTransitionQualityThresholds;
  stateTransitionCalibration: StateTransitionQualityCalibrationReport;
  globalThresholdResolutionAfter: GlobalThresholdResolution;
  globalSampleCountAfter: number;
  prematureStopSignals: number;
}

export interface BuildStateTransitionEventsInput {
  record: SessionRecord;
  requestId: string;
  stateTransitionRecord: StateTransitionRecord;
  stateTransitionTrainingRow: StateTransitionTrainingRow;
  activeQualityThresholds: StateTransitionQualityThresholds;
  stateTransitionCalibration: StateTransitionQualityCalibrationReport;
  globalThresholdResolutionAfter: GlobalThresholdResolution;
  globalCalibrationObservation: GlobalCalibrationObservation;
  thresholdShift: number;
  globalThresholdShift: number;
  globalSampleCountAfter: number;
}

export interface BuildPersistenceTelemetryEventBundleInput {
  record: SessionRecord;
  requestId: string;
  traceModel: string;
  snapshot?: DecisionSnapshot;
  escalated: boolean;
  trajectory?: RequestTrajectoryInput;
  trajectoryMetrics: RequestTrajectoryMetrics;
  blindRetryCount: number;
  usage: SessionUsageWithCost;
  tokensSavedByReduction: number;
  latencyMs: number;
  tokenEconomics: Record<string, unknown>;
  chatStateSummary?: Record<string, unknown>;
  fileStateSummary?: Record<string, unknown>;
  objectiveScopeSummary?: Record<string, unknown>;
  stateConfidenceSummary?: Record<string, unknown>;
  evidenceDelta: EvidenceDeltaSummary;
  chatPhase?: string;
  chatCompletionStatus?: string;
  fileStatusCounts?: {
    stale?: number;
    partial?: number;
    evicted?: number;
  };
  stateChannelSummary: PersistenceStateChannelSummary;
  stateTransitionCalibrationRun: StateTransitionCalibrationRun;
}

export interface PersistenceTelemetryEventBundle {
  stateTransitionSummary: StateTransitionSummary;
  sessionEvents: SessionEventInsert[];
}

export interface RunStateTransitionCalibrationInput {
  metadata: Record<string, unknown>;
  requestId: string;
  orgId: string;
  modelId: string;
  previousSnapshot: StateTransitionSnapshot | null;
  currentSnapshot: StateTransitionSnapshot;
  toolSequence: string[];
  governorRules: string[];
  governorPause: boolean;
  evidenceDelta: EvidenceDeltaSummary;
  outcomeState: string;
  globalCalibrator: StateTransitionGlobalCalibrator;
}

export interface StateTransitionCalibrationRun {
  persistedQualityThresholds: StateTransitionQualityThresholds;
  globalThresholdResolutionBefore: GlobalThresholdResolution;
  globalThresholdResolutionAfter: GlobalThresholdResolution;
  globalCalibrationObservation: GlobalCalibrationObservation;
  globalSampleCountAfter: number;
  globalWeightAfter: number;
  activeQualityThresholds: StateTransitionQualityThresholds;
  stateTransitionRecord: StateTransitionRecord;
  stateTransitionTrainingRow: StateTransitionTrainingRow;
  stateTransitionCalibration: StateTransitionQualityCalibrationReport;
  thresholdShift: number;
  globalThresholdShift: number;
}

function metadataString(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === "string" ? value : "";
}

function normalizeStateTransitionQualityThresholds(
  thresholds: StateTransitionQualityThresholds,
): StateTransitionQualityThresholds {
  return decodeStateTransitionQualityThresholds(encodeStateTransitionQualityThresholds(thresholds))
    ?? DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS;
}

export function blendStateTransitionQualityThresholds(
  localThresholds: StateTransitionQualityThresholds,
  globalThresholds: StateTransitionQualityThresholds,
  globalWeight: number,
): StateTransitionQualityThresholds {
  const normalizedLocal = normalizeStateTransitionQualityThresholds(localThresholds);
  const normalizedGlobal = normalizeStateTransitionQualityThresholds(globalThresholds);
  const weight = Math.max(0, Math.min(1, Number.isFinite(globalWeight) ? globalWeight : 0));
  return normalizeStateTransitionQualityThresholds({
    forward_progress_min: Number(
      (normalizedLocal.forward_progress_min * (1 - weight) + normalizedGlobal.forward_progress_min * weight).toFixed(3),
    ),
    regressed_max: Number(
      (normalizedLocal.regressed_max * (1 - weight) + normalizedGlobal.regressed_max * weight).toFixed(3),
    ),
    minimum_gap: Number(
      (normalizedLocal.minimum_gap * (1 - weight) + normalizedGlobal.minimum_gap * weight).toFixed(3),
    ),
  });
}

function metadataObject(metadata: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = metadata[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function runStateTransitionCalibration(
  input: RunStateTransitionCalibrationInput,
): StateTransitionCalibrationRun {
  const persistedQualityThresholds =
    decodeStateTransitionQualityThresholds(
      metadataObject(input.metadata, "state_transition_quality_thresholds"),
    )
    ?? DEFAULT_STATE_TRANSITION_QUALITY_THRESHOLDS;
  const globalThresholdResolutionBefore = input.globalCalibrator.resolveThresholds({
    orgId: input.orgId,
    modelId: input.modelId,
    fallbackThresholds: persistedQualityThresholds,
  });
  const globalSampleCountBefore = Math.max(
    globalThresholdResolutionBefore.org_model_sample_count,
    globalThresholdResolutionBefore.model_sample_count,
  );
  const globalWeightBefore = globalThresholdResolutionBefore.selected_scope === "none"
    ? 0
    : Math.min(0.55, Math.max(0.2, globalSampleCountBefore / 80));
  const seededQualityThresholds = blendStateTransitionQualityThresholds(
    persistedQualityThresholds,
    globalThresholdResolutionBefore.selected_thresholds,
    globalWeightBefore,
  );
  const stateTransitionRecord = buildStateTransitionRecord({
    requestId: input.requestId,
    previousSnapshot: input.previousSnapshot,
    currentSnapshot: input.currentSnapshot,
    toolSequence: input.toolSequence,
    governorRules: input.governorRules,
    governorPause: input.governorPause,
    evidenceDelta: input.evidenceDelta,
    outcomeState: input.outcomeState,
    qualityThresholds: seededQualityThresholds,
  });
  const stateTransitionSample = buildStateTransitionCalibrationSample(stateTransitionRecord);
  const storedCalibrationSamples = decodeStateTransitionCalibrationSamples(
    input.metadata.state_transition_quality_samples,
    64,
  );
  const nextCalibrationSamples = [
    ...storedCalibrationSamples,
    stateTransitionSample,
  ].slice(-64);
  input.metadata.state_transition_quality_samples = encodeStateTransitionCalibrationSamples(
    nextCalibrationSamples,
    64,
  );
  const stateTransitionCalibration = calibrateStateTransitionQualityThresholds({
    samples: nextCalibrationSamples,
    baseThresholds: seededQualityThresholds,
    minSamples: 12,
    minPositive: 3,
    minNegative: 3,
    smoothing: 0.45,
  });
  const sessionCalibratedThresholds = stateTransitionCalibration.calibrated_thresholds;
  const globalCalibrationObservation = input.globalCalibrator.observeAndCalibrate({
    orgId: input.orgId,
    modelId: input.modelId,
    sample: stateTransitionSample,
    fallbackThresholds: sessionCalibratedThresholds,
  });
  const globalThresholdResolutionAfter = globalCalibrationObservation.resolution;
  const globalSampleCountAfter = Math.max(
    globalThresholdResolutionAfter.org_model_sample_count,
    globalThresholdResolutionAfter.model_sample_count,
  );
  const globalWeightAfter = globalThresholdResolutionAfter.selected_scope === "none"
    ? 0
    : Math.min(0.65, Math.max(0.25, globalSampleCountAfter / 96));
  const activeQualityThresholds = blendStateTransitionQualityThresholds(
    sessionCalibratedThresholds,
    globalThresholdResolutionAfter.selected_thresholds,
    globalWeightAfter,
  );
  input.metadata.state_transition_quality_thresholds = encodeStateTransitionQualityThresholds(
    activeQualityThresholds,
  );
  input.metadata.state_transition_quality_global_scope = globalThresholdResolutionAfter.selected_scope;
  input.metadata.state_transition_quality_global_sample_count = globalSampleCountAfter;
  if (stateTransitionCalibration.applied) {
    input.metadata.state_transition_quality_calibrated_at = Date.now();
  }
  const stateTransitionTrainingRow = materializeStateTransitionTrainingRow(stateTransitionRecord);
  const thresholdShift = Math.abs(
    activeQualityThresholds.forward_progress_min - persistedQualityThresholds.forward_progress_min,
  ) + Math.abs(
    activeQualityThresholds.regressed_max - persistedQualityThresholds.regressed_max,
  );
  const globalThresholdShift = Math.abs(
    globalThresholdResolutionAfter.selected_thresholds.forward_progress_min
      - globalThresholdResolutionBefore.selected_thresholds.forward_progress_min,
  ) + Math.abs(
    globalThresholdResolutionAfter.selected_thresholds.regressed_max
      - globalThresholdResolutionBefore.selected_thresholds.regressed_max,
  );

  return {
    persistedQualityThresholds,
    globalThresholdResolutionBefore,
    globalThresholdResolutionAfter,
    globalCalibrationObservation,
    globalSampleCountAfter,
    globalWeightAfter,
    activeQualityThresholds,
    stateTransitionRecord,
    stateTransitionTrainingRow,
    stateTransitionCalibration,
    thresholdShift,
    globalThresholdShift,
  };
}

const PATCH_STYLE_TOOL_NAMES = new Set(["str_replace", "apply_patch", "edit", "str_replace_editor"]);
const WHOLE_WRITE_TOOL_NAMES = new Set(["write_file", "file_write", "write"]);
const READ_STYLE_TOOL_NAMES = new Set(["read", "read_file", "readfile", "file_read"]);
const PREMATURE_STOP_GOVERNOR_RULES = new Set([
  "completion_claim_requires_task_update",
  "verification_after_completion_claim",
  "verbal_intent_without_action",
]);

function normalizeTrajectoryToolName(name: string): string {
  return name.trim().toLowerCase();
}

export function classifyTrajectoryToolKind(name: string): TrajectoryToolKind {
  const n = name.toLowerCase();
  if (n.includes("search") || n.includes("inspect") || n.includes("classify")) return "discovery";
  if (n.includes("read") || n.includes("diff") || n.includes("status")) return "evidence";
  if (n.includes("patch") || n.includes("write") || n.includes("format") || n.includes("git_add") || n.includes("git_commit")) {
    return "mutation";
  }
  if (n.includes("run_test") || n.includes("run_build") || n.includes("run_lint")) return "verification";
  return "other";
}

export function inferTrajectoryBucket(
  sequence: string[],
  patchOps: number,
  wholeWriteOps: number,
): TrajectoryBucket {
  const edits = patchOps + wholeWriteOps;
  if (edits === 0) return "investigation";
  if (edits === 1 && sequence.length <= 5) return "micro";
  if (edits >= 4 || sequence.length >= 12) return "feature";
  return "repo";
}

export function countEditsFromToolSequence(sequence: string[]): { patchOps: number; wholeWriteOps: number } {
  let patchOps = 0;
  let wholeWriteOps = 0;
  for (const name of sequence) {
    const normalized = normalizeTrajectoryToolName(name);
    if (PATCH_STYLE_TOOL_NAMES.has(normalized)) patchOps += 1;
    if (WHOLE_WRITE_TOOL_NAMES.has(normalized)) wholeWriteOps += 1;
  }
  return { patchOps, wholeWriteOps };
}

export function countReadOpsFromToolSequence(sequence: string[]): number {
  let readOps = 0;
  for (const name of sequence) {
    if (READ_STYLE_TOOL_NAMES.has(normalizeTrajectoryToolName(name))) {
      readOps += 1;
    }
  }
  return readOps;
}

export function inferPrematureStopSignalsFromGovernor(matchedRules: readonly string[] | undefined): number {
  if (!Array.isArray(matchedRules) || matchedRules.length === 0) return 0;
  const seen = new Set<string>();
  let matched = 0;
  for (const rule of matchedRules) {
    const normalized = String(rule ?? "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    if (PREMATURE_STOP_GOVERNOR_RULES.has(normalized)) matched += 1;
  }
  return matched;
}

export function buildRequestTrajectoryMetrics(input: BuildRequestTrajectoryMetricsInput): RequestTrajectoryMetrics {
  const trajectory = input.trajectory;
  const snapshot = input.snapshot;
  const toolSequence = trajectory?.toolSequence ?? [];
  const inferredEdits = countEditsFromToolSequence(toolSequence);
  const patchOpsCount = trajectory?.patchOpsCount ?? inferredEdits.patchOps;
  const wholeWriteOpsCount = trajectory?.wholeWriteOpsCount ?? inferredEdits.wholeWriteOps;
  const filesWrittenCount = patchOpsCount + wholeWriteOpsCount;
  const inferredFilesReadCount = countReadOpsFromToolSequence(toolSequence);
  const filesReadCount = Math.max(0, trajectory?.filesReadCount ?? inferredFilesReadCount);
  const bytesReadTotal = Number.isFinite(Number(trajectory?.bytesReadTotal))
    ? Math.max(0, Number(trajectory?.bytesReadTotal))
    : undefined;
  const readEditRatio = filesWrittenCount > 0
    ? Number((filesReadCount / filesWrittenCount).toFixed(3))
    : undefined;
  const patchRatio = filesWrittenCount > 0
    ? Number((patchOpsCount / filesWrittenCount).toFixed(3))
    : undefined;
  const wholeWriteRatio = filesWrittenCount > 0
    ? Number((wholeWriteOpsCount / filesWrittenCount).toFixed(3))
    : undefined;
  const inferredPrematureStopSignals = inferPrematureStopSignalsFromGovernor(snapshot?.governor?.matchedRules);
  const prematureStopSignals = Math.max(0, trajectory?.prematureStopSignals ?? inferredPrematureStopSignals);
  const verificationSteps = trajectory?.verificationSteps ?? [];
  const countsByKind: TrajectoryToolKindCounts = { discovery: 0, evidence: 0, mutation: 0, verification: 0, other: 0 };
  for (const name of toolSequence) {
    countsByKind[classifyTrajectoryToolKind(name)] += 1;
  }
  const taskBucket = trajectory?.taskBucket ?? inferTrajectoryBucket(toolSequence, patchOpsCount, wholeWriteOpsCount);
  const firstPassVerifyOk =
    input.finishReason !== "error"
    && !snapshot?.verificationStalled
    && (snapshot?.verificationRound === undefined || snapshot.verificationRound <= 1);
  const structuredErrorsCount = trajectory?.diagnostics?.structuredErrorsCount ?? 0;
  const diagnosticLinesCount = trajectory?.diagnostics?.diagnosticLinesCount ?? 0;
  const structuredErrorCoverage = trajectory?.diagnostics?.structuredErrorCoverage
    ?? (diagnosticLinesCount > 0
      ? Number((structuredErrorsCount / diagnosticLinesCount).toFixed(3))
      : (structuredErrorsCount > 0 ? 1 : 0));
  const completionGateBlocked = trajectory?.completionGateBlocked ?? false;
  const criticBlocked = trajectory?.criticBlocked ?? false;
  const outcomeState = trajectory?.outcomeState
    ?? (input.finishReason === "error" ? "stalled" : snapshot?.verificationStalled ? "stalled" : (completionGateBlocked || criticBlocked) ? "partial" : "verified");
  const failureStage = trajectory?.failureStage
    ?? (input.finishReason === "error" ? "verification" : snapshot?.verificationStalled ? "verification" : completionGateBlocked ? "verification" : criticBlocked ? "policy" : null);

  return {
    toolSequence,
    patchOpsCount,
    wholeWriteOpsCount,
    filesWrittenCount,
    filesReadCount,
    bytesReadTotal,
    readEditRatio,
    patchRatio,
    wholeWriteRatio,
    prematureStopSignals,
    verificationSteps,
    countsByKind,
    taskBucket,
    firstPassVerifyOk,
    structuredErrorsCount,
    diagnosticLinesCount,
    structuredErrorCoverage,
    completionGateBlocked,
    criticBlocked,
    outcomeState,
    failureStage,
  };
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

export function buildHourlyTokenThrottleEvents(
  input: BuildHourlyTokenThrottleEventsInput,
): SessionEventInsert[] {
  const events: SessionEventInsert[] = [];
  const windowMinutes = Math.max(1, Math.ceil(input.windowMs / 60_000));

  if (
    input.snapshot.sessionTokensInWindow > input.sessionLimit
    && input.previousSessionWindowTokens <= input.sessionLimit
  ) {
    events.push({
      sessionKey: input.record.sessionKey,
      requestId: input.requestId,
      userId: input.record.userId,
      orgId: input.record.orgId,
      eventKind: "hourly_token_throttle_warn",
      component: "token-throttle",
      detail: `Session input tokens in rolling ${windowMinutes}m window exceeded ${input.sessionLimit.toLocaleString()} (used: ${input.snapshot.sessionTokensInWindow.toLocaleString()})`,
      metadataJson: {
        scope: "session",
        mode: "audit",
        window_ms: input.windowMs,
        limit_tokens: input.sessionLimit,
        observed_tokens: input.snapshot.sessionTokensInWindow,
      },
    });
  }

  if (
    input.snapshot.userTokensInWindow > input.userLimit
    && input.previousUserWindowTokens <= input.userLimit
  ) {
    events.push({
      sessionKey: input.record.sessionKey,
      requestId: input.requestId,
      userId: input.record.userId,
      orgId: input.record.orgId,
      eventKind: "hourly_token_throttle_warn",
      component: "token-throttle",
      detail: `User input tokens in rolling ${windowMinutes}m window exceeded ${input.userLimit.toLocaleString()} (used: ${input.snapshot.userTokensInWindow.toLocaleString()})`,
      metadataJson: {
        scope: "user",
        mode: "audit",
        window_ms: input.windowMs,
        limit_tokens: input.userLimit,
        observed_tokens: input.snapshot.userTokensInWindow,
      },
    });
  }

  return events;
}

export function runHourlyTokenThrottleUpdate(
  input: RunHourlyTokenThrottleUpdateInput,
): Promise<void> | null {
  if (!input.enabled || input.inputTokens <= 0) return null;
  const previousSessionWindowTokens = Number(input.record.metadata.hourly_tokens_session ?? 0) || 0;
  const previousUserWindowTokens = Number(input.record.metadata.hourly_tokens_user ?? 0) || 0;
  return input.counter.addInputTokensAndReadHourlyWindow(
    input.record.sessionKey,
    input.record.userId,
    input.inputTokens,
  ).then((snapshot) => {
    if (!snapshot) return;
    input.record.metadata.hourly_tokens_session = snapshot.sessionTokensInWindow;
    input.record.metadata.hourly_tokens_user = snapshot.userTokensInWindow;
    for (const event of buildHourlyTokenThrottleEvents({
      record: input.record,
      requestId: input.requestId,
      snapshot,
      previousSessionWindowTokens,
      previousUserWindowTokens,
      windowMs: input.windowMs,
      sessionLimit: input.sessionLimit,
      userLimit: input.userLimit,
    })) {
      input.recordEvent(event);
    }
    void input.saveSession();
  }).catch((err) => {
    if (input.warn) {
      input.warn(err);
      return;
    }
    console.warn("[throttle] token window update failed:", (err as Error).message ?? err);
  });
}

export function applyGovernorTelemetryMetadata(
  input: ApplyGovernorTelemetryMetadataInput,
): void {
  const governor = input.snapshot?.governor;
  if (!governor) return;
  input.record.metadata.last_governor_pause = governor.pause;
  input.record.metadata.last_governor_rules = governor.matchedRules;
  const previousPauseCount = Number(input.record.metadata.governor_pause_count ?? 0);
  input.record.metadata.governor_pause_count = previousPauseCount + (governor.pause ? 1 : 0);
}

export function applySessionUsagePersistenceMutation(
  state: SessionUsagePersistenceState,
  input: ApplySessionUsagePersistenceInput,
): SessionTraceLinks {
  const { record } = state;
  record.lastProvider = input.resolvedModelId;
  record.lastModel = input.traceModel;
  record.totalTokensIn += input.usage.inputTokens;
  record.totalTokensOut += input.usage.outputTokens;
  record.totalTokensCached += input.usage.cachedTokens;
  record.totalTokensSaved = (record.totalTokensSaved ?? 0) + input.tokensSavedByReduction;

  const prevEstimatedCost = Number(record.metadata.total_estimated_cost_usd ?? 0);
  const prevActualCost = Number(record.metadata.total_actual_cost_usd ?? 0);
  record.metadata.total_estimated_cost_usd = prevEstimatedCost + input.normalizedEstimatedCostUsd;
  record.metadata.total_actual_cost_usd = prevActualCost + input.normalizedActualCostUsd;
  record.requestCount += 1;
  record.lastActiveAt = Date.now();

  const previousTraceId = metadataString(record.metadata, "last_trace_id") || undefined;
  const rootTraceId = metadataString(record.metadata, "root_trace_id") || previousTraceId || input.requestId;
  record.metadata.root_trace_id = rootTraceId;
  record.metadata.last_trace_id = input.requestId;
  record.metadata.last_cache_hit_ratio = input.usage.inputTokens > 0
    ? Number((input.usage.cachedTokens / input.usage.inputTokens).toFixed(4))
    : 0;
  record.metadata.last_token_economics_warnings = input.tokenEconomicsWarnings;

  if (input.finishReason === "tool_calls" || input.finishReason === "tool_use") {
    state.consecutiveToolCalls += 1;
  } else {
    state.consecutiveToolCalls = 0;
    state.stagnantToolCycles = 0;
    state.lastToolSignalHash = "";
  }

  record.metadata.consecutive_tool_calls = state.consecutiveToolCalls;
  record.metadata.stagnant_tool_cycles = state.stagnantToolCycles;
  record.metadata.last_tool_signal_hash = state.lastToolSignalHash;
  record.metadata.awaiting_tool_loop_user_ack = state.awaitingToolLoopUserAck;
  record.metadata.tool_loop_ack_anchor_user_hash = state.toolLoopAckAnchorUserHash;
  record.metadata.tool_loop_no_user_ack_count = state.toolLoopNoUserAckCount;
  record.metadata.block_broad_verification_until_edit = state.blockBroadVerificationUntilEdit;
  record.metadata.block_failing_verification_until_edit = state.blockFailingVerificationUntilEdit;

  return {
    previousTraceId,
    parentTraceId: previousTraceId,
    rootTraceId,
  };
}

export function buildUsageEvent(input: BuildUsageEventInput): UsageEvent {
  return {
    sessionKey: input.record.sessionKey,
    requestId: input.requestId,
    userId: input.record.userId,
    orgId: input.record.orgId,
    provider: input.resolvedModelId,
    model: input.traceModel,
    tokensIn: input.usage.inputTokens,
    tokensOut: input.usage.outputTokens,
    tokensCached: input.usage.cachedTokens,
    tokensUncachedInput: input.costBreakdown.tokens_uncached_input,
    tokensCacheRead: input.costBreakdown.tokens_cache_read,
    tokensCacheWrite: input.costBreakdown.tokens_cache_write,
    inputCostUsd: input.costBreakdown.input_cost_usd,
    cacheReadCostUsd: input.costBreakdown.cache_read_cost_usd,
    cacheWriteCostUsd: input.costBreakdown.cache_write_cost_usd,
    outputCostUsd: input.costBreakdown.output_cost_usd,
    estimatedNoCacheCostUsd: input.costBreakdown.estimated_no_cache_cost_usd,
    cacheSavingsUsd: input.costBreakdown.cache_savings_usd,
    tokensSavedByReduction: input.tokensSavedByReduction,
    latencyMs: input.latencyMs,
    estimatedCostUsd: input.normalizedEstimatedCostUsd,
    actualCostUsd: input.normalizedActualCostUsd,
    pricingSource: input.pricingSource,
    authMethod: String(input.record.metadata.auth_method ?? ""),
    authKeyId: String(input.record.metadata.auth_key_id ?? ""),
    authKeyName: String(input.record.metadata.auth_key_name ?? ""),
    authKeyPrefix: String(input.record.metadata.auth_key_prefix ?? ""),
    escalated: input.escalated,
    toolCallsCount: input.toolCallsCount,
    finishReason: input.finishReason,
  };
}

export function buildTelemetryUsage(input: BuildTelemetryUsageInput): LlmUsage {
  return {
    prompt_tokens: input.usage.inputTokens,
    completion_tokens: input.usage.outputTokens,
    total_tokens: input.usage.inputTokens + input.usage.outputTokens,
    cached_prompt_tokens: input.usage.cachedTokens,
    cache_creation_tokens: input.usage.cacheCreationTokens,
    estimated_cost_usd: input.normalizedEstimatedCostUsd,
    actual_cost_usd: input.usage.costUsd > 0 ? input.usage.costUsd : 0,
  };
}

export function buildTokenEconomicsWarningEvent(
  input: BuildTokenEconomicsWarningEventInput,
): SessionEventInsert | null {
  if (input.warnings.length === 0 || input.usage.inputTokens + input.usage.outputTokens <= 0) {
    return null;
  }
  return {
    sessionKey: input.record.sessionKey,
    requestId: input.requestId,
    userId: input.record.userId,
    orgId: input.record.orgId,
    eventKind: "token_economics_warning_v1",
    component: "token-economics",
    detail: `${input.recommendation}: ${input.warnings.join(",")}`,
    metadataJson: input.metadataJson,
  };
}

export function runInitialSessionPersistenceWrites(
  input: RunInitialSessionPersistenceWritesInput,
): void {
  void input.saveSession();
  input.writer.enqueueSessionUpsert(input.record);

  const tokenEconomicsWarningEvent = buildTokenEconomicsWarningEvent({
    record: input.record,
    requestId: input.requestId,
    recommendation: input.tokenEconomicsRecommendation,
    warnings: input.tokenEconomicsWarnings,
    metadataJson: input.tokenEconomicsMetadata,
    usage: input.usage,
  });
  if (tokenEconomicsWarningEvent) {
    input.writer.enqueueSessionEvent(tokenEconomicsWarningEvent);
  }

  if (input.conversationMemoryEnabled && input.record.continuity) {
    input.writer.enqueueContinuityUpsert(
      input.record.userId,
      input.record.orgId,
      input.record.sessionKey,
      input.record.continuity,
    );
  }

  input.writer.enqueueUsageInsert(buildUsageEvent({
    record: input.record,
    requestId: input.requestId,
    resolvedModelId: input.resolvedModelId,
    traceModel: input.traceModel,
    usage: input.usage,
    costBreakdown: input.costBreakdown,
    tokensSavedByReduction: input.tokensSavedByReduction,
    latencyMs: input.latencyMs,
    normalizedEstimatedCostUsd: input.normalizedEstimatedCostUsd,
    normalizedActualCostUsd: input.normalizedActualCostUsd,
    pricingSource: input.pricingSource,
    escalated: input.escalated,
    toolCallsCount: input.toolCallsCount,
    finishReason: input.finishReason,
  }));
}

export function buildYarnTraceRecord(input: BuildYarnTraceRecordInput): YarnTraceRecord {
  const orig = (input.clientRequestedModel ?? "").trim();
  const hasOriginalModel = orig && orig.toLowerCase() !== "auto";
  const traceContext = input.snapshotTraceFields?.trace_context ?? {};
  return {
    service: "yarn",
    trace_id: input.requestId,
    request_id: input.requestId,
    conversation_id: input.record.sessionKey,
    parent_trace_id: input.parentTraceId,
    root_trace_id: input.rootTraceId,
    timestamp: Date.now() / 1000,
    user_id: input.record.userId,
    org_id: input.record.orgId,
    tenant_id: "",
    model: input.traceModel,
    query_snippet: (input.rootPromptSnippet || input.latestPromptSnippet).slice(0, 2000),
    tokens: input.telemetryUsage,
    cost: {
      estimated_usd: input.normalizedEstimatedCostUsd,
      actual_usd: input.telemetryUsage.actual_cost_usd,
      rates_snapshot: input.tierRates,
    },
    latency_ms: input.latencyMs,
    ...input.snapshotTraceFields,
    trace_context: {
      ...traceContext,
      turn_index: input.record.requestCount,
      root_user_prompt: input.rootPromptSnippet || undefined,
      latest_user_prompt: input.latestPromptSnippet || undefined,
      parent_trace_id: input.parentTraceId,
      root_trace_id: input.rootTraceId,
      ...(hasOriginalModel
        ? {
            client_requested_model: orig,
            resolved_backend_model: input.backendModel,
            registry_tier_id: input.resolvedModelId,
          }
        : {
            resolved_backend_model: input.backendModel,
            registry_tier_id: input.resolvedModelId,
          }),
      chat_state: input.chatStateSummary,
      file_state: input.fileStateSummary,
      objective_scope: input.objectiveScopeSummary,
      state_confidence: input.stateConfidenceSummary,
      state_transition: input.stateTransitionSummary,
      token_economics: input.tokenEconomics,
    },
    ...(input.optimizationLedger ? { optimization_ledger: input.optimizationLedger } : {}),
    has_error: input.finishReason === "error" || undefined,
  };
}

export function buildStateTransitionSummary(input: BuildStateTransitionSummaryInput): StateTransitionSummary {
  const { stateTransitionRecord } = input;
  return {
    changed_fields: stateTransitionRecord.delta.changed_fields,
    objective_epoch_advanced: stateTransitionRecord.delta.objective_epoch_advanced,
    objective_changed: stateTransitionRecord.delta.objective_changed,
    confidence_improved: stateTransitionRecord.delta.confidence_improved,
    stale_files_delta: stateTransitionRecord.delta.stale_files_delta,
    partial_files_delta: stateTransitionRecord.delta.partial_files_delta,
    evicted_files_delta: stateTransitionRecord.delta.evicted_files_delta,
    quality_label: stateTransitionRecord.quality.label,
    quality_score: stateTransitionRecord.quality.score,
    quality_reasons: stateTransitionRecord.quality.reasons,
    recommended_action: stateTransitionRecord.quality.recommended_action,
    quality_thresholds: input.activeQualityThresholds,
    quality_calibration_applied: input.stateTransitionCalibration.applied,
    quality_calibration_sample_count: input.stateTransitionCalibration.sample_count,
    quality_global_scope: input.globalThresholdResolutionAfter.selected_scope,
    quality_global_sample_count: input.globalSampleCountAfter,
    quality_global_weight: Number(input.globalWeightAfter.toFixed(3)),
  };
}

export function buildRequestTrajectoryEvent(input: BuildRequestTrajectoryEventInput): SessionEventInsert {
  const cacheHitRatio = input.usage.inputTokens > 0
    ? Number((input.usage.cachedTokens / input.usage.inputTokens).toFixed(4))
    : 0;
  const stateChannels = (
    input.chatStateSummary
    || input.fileStateSummary
    || input.objectiveScopeSummary
    || input.stateConfidenceSummary
    || input.stateTransitionSummary
  )
    ? {
        chat_state: input.chatStateSummary,
        file_state: input.fileStateSummary,
        objective_scope: input.objectiveScopeSummary,
        state_confidence: input.stateConfidenceSummary,
        state_transition: input.stateTransitionSummary,
      }
    : undefined;
  return {
    sessionKey: input.record.sessionKey,
    requestId: input.requestId,
    userId: input.record.userId,
    orgId: input.record.orgId,
    eventKind: "request_trajectory_v1",
    component: "yarn",
    detail: `trajectory ${input.outcomeState} bucket=${input.taskBucket} tools=${input.toolSequence.length}`,
    metadataJson: {
      schema_version: "request_trajectory_v1",
      request_id: input.requestId,
      session_key: input.record.sessionKey,
      task_bucket: input.taskBucket,
      identity: {
        client_kind: input.record.clientKind || "unknown",
        model: input.traceModel,
      },
      workflow: {
        decision_path: input.snapshot?.decisionPath,
        phase: input.snapshot?.phase ?? "unknown",
        escalated: input.escalated,
        policy_rules_matched: input.snapshot?.policyDecision ? String(input.snapshot.policyDecision).split(",").filter(Boolean) : [],
      },
      tools: {
        sequence: input.toolSequence,
        counts_by_kind: input.countsByKind,
        retry_count_total: input.retryCountTotal,
        blind_retry_count: input.blindRetryCount,
      },
      edits: {
        files_read_count: input.filesReadCount,
        bytes_read_total: input.bytesReadTotal,
        files_written_count: input.filesWrittenCount,
        read_edit_ratio: input.readEditRatio,
        patch_ops_count: input.patchOpsCount,
        whole_write_ops_count: input.wholeWriteOpsCount,
        patch_ratio: input.patchRatio,
        whole_write_ratio: input.wholeWriteRatio,
        patch_success_rate: input.patchRatio,
      },
      verification: {
        steps: input.verificationSteps,
        round: input.snapshot?.verificationRound,
        stalled: input.snapshot?.verificationStalled,
        findings: input.snapshot?.verificationFindings,
        first_pass_verify_ok: input.firstPassVerifyOk,
        structured_errors_count: input.structuredErrorsCount,
        diagnostic_lines_count: input.diagnosticLinesCount,
        structured_error_coverage: input.structuredErrorCoverage,
        completion_gate_blocked: input.completionGateBlocked,
        critic_blocked: input.criticBlocked,
      },
      cost: {
        tokens_in: input.usage.inputTokens,
        tokens_out: input.usage.outputTokens,
        tokens_cached: input.usage.cachedTokens,
        cache_creation_tokens: input.usage.cacheCreationTokens,
        cache_hit_ratio: cacheHitRatio,
        tokens_saved_by_reduction: input.tokensSavedByReduction,
        latency_ms: input.latencyMs,
        tool_latency_ms_total: undefined,
        token_economics: input.tokenEconomics,
      },
      outcome: {
        state: input.outcomeState,
        failure_stage: input.failureStage,
      },
      governor: input.snapshot?.governor ? {
        pause: input.snapshot.governor.pause,
        reason: input.snapshot.governor.reason,
        matched_rules: input.snapshot.governor.matchedRules,
        telemetry: input.snapshot.governor.telemetry,
      } : undefined,
      state_channels: stateChannels,
      training_signals: {
        governor_intervened: input.snapshot?.governor?.pause ?? false,
        governor_rules: input.snapshot?.governor?.matchedRules ?? [],
        no_edit_evidence: input.snapshot?.governor?.telemetry?.noEditEvidence ?? false,
        trailing_verification_stall: (input.snapshot?.governor?.telemetry?.trailingVerificationRunLength ?? 0) >= 3,
        false_green_detected: input.snapshot?.governor?.telemetry?.activeGuards?.includes("false_green_suspected") ?? false,
        evidence_delta: input.evidenceDelta,
        chat_phase: input.chatPhase,
        chat_completion_status: input.chatCompletionStatus,
        file_state_stale_count: input.fileStatusCounts?.stale ?? 0,
        file_state_partial_count: input.fileStatusCounts?.partial ?? 0,
        file_state_evicted_count: input.fileStatusCounts?.evicted ?? 0,
        objective_epoch_id: input.objectiveEpochId > 0 ? input.objectiveEpochId : undefined,
        objective_scope_boundary_index: input.objectiveScopeBoundaryIndex >= 0 ? input.objectiveScopeBoundaryIndex : undefined,
        objective_scope_retained_evidence: input.objectiveScopeRetainedEvidence > 0 ? input.objectiveScopeRetainedEvidence : undefined,
        objective_scope_dropped_pre_boundary: input.objectiveScopeDroppedPreBoundary > 0 ? input.objectiveScopeDroppedPreBoundary : undefined,
        state_confidence_overall: Number.isFinite(input.stateConfidenceOverall) ? input.stateConfidenceOverall : undefined,
        state_confidence_needs_reground: input.stateConfidenceNeedsReground || undefined,
        state_confidence_reasons: input.stateConfidenceReasons.length > 0 ? input.stateConfidenceReasons : undefined,
        objective_transition_changed: input.stateTransitionRecord.delta.objective_changed || undefined,
        objective_epoch_advanced: input.stateTransitionRecord.delta.objective_epoch_advanced || undefined,
        confidence_improved: input.stateTransitionRecord.delta.confidence_improved || undefined,
        stale_files_delta: input.stateTransitionRecord.delta.stale_files_delta,
        state_transition_quality_label: input.stateTransitionRecord.quality.label,
        state_transition_quality_score: input.stateTransitionRecord.quality.score,
        state_transition_quality_reasons: input.stateTransitionRecord.quality.reasons,
        state_transition_quality_forward_min: input.activeQualityThresholds.forward_progress_min,
        state_transition_quality_regressed_max: input.activeQualityThresholds.regressed_max,
        state_transition_quality_calibrated: input.stateTransitionCalibration.applied || undefined,
        state_transition_quality_calibration_samples: input.stateTransitionCalibration.sample_count,
        state_transition_quality_global_scope: input.globalThresholdResolutionAfter.selected_scope !== "none"
          ? input.globalThresholdResolutionAfter.selected_scope
          : undefined,
        state_transition_quality_global_samples: input.globalSampleCountAfter || undefined,
        premature_stop_signals: input.prematureStopSignals || undefined,
      },
    },
  };
}

export function buildPersistenceTelemetryEventBundle(
  input: BuildPersistenceTelemetryEventBundleInput,
): PersistenceTelemetryEventBundle {
  const {
    globalThresholdResolutionAfter,
    globalCalibrationObservation,
    globalSampleCountAfter,
    globalWeightAfter,
    activeQualityThresholds,
    stateTransitionRecord,
    stateTransitionTrainingRow,
    stateTransitionCalibration,
    thresholdShift,
    globalThresholdShift,
  } = input.stateTransitionCalibrationRun;
  const stateTransitionSummary = buildStateTransitionSummary({
    stateTransitionRecord,
    activeQualityThresholds,
    stateTransitionCalibration,
    globalThresholdResolutionAfter,
    globalSampleCountAfter,
    globalWeightAfter,
  });
  const trajectoryMetrics = input.trajectoryMetrics;
  const stateChannelSummary = input.stateChannelSummary;
  const requestTrajectoryEvent = buildRequestTrajectoryEvent({
    record: input.record,
    requestId: input.requestId,
    traceModel: input.traceModel,
    snapshot: input.snapshot,
    escalated: input.escalated,
    toolSequence: trajectoryMetrics.toolSequence,
    taskBucket: trajectoryMetrics.taskBucket,
    countsByKind: trajectoryMetrics.countsByKind,
    retryCountTotal: input.trajectory?.retryCountTotal ?? input.blindRetryCount,
    blindRetryCount: input.blindRetryCount,
    filesReadCount: trajectoryMetrics.filesReadCount,
    bytesReadTotal: trajectoryMetrics.bytesReadTotal,
    filesWrittenCount: trajectoryMetrics.filesWrittenCount,
    readEditRatio: trajectoryMetrics.readEditRatio,
    patchOpsCount: trajectoryMetrics.patchOpsCount,
    wholeWriteOpsCount: trajectoryMetrics.wholeWriteOpsCount,
    patchRatio: trajectoryMetrics.patchRatio,
    wholeWriteRatio: trajectoryMetrics.wholeWriteRatio,
    verificationSteps: trajectoryMetrics.verificationSteps,
    firstPassVerifyOk: trajectoryMetrics.firstPassVerifyOk,
    structuredErrorsCount: trajectoryMetrics.structuredErrorsCount,
    diagnosticLinesCount: trajectoryMetrics.diagnosticLinesCount,
    structuredErrorCoverage: trajectoryMetrics.structuredErrorCoverage,
    completionGateBlocked: trajectoryMetrics.completionGateBlocked,
    criticBlocked: trajectoryMetrics.criticBlocked,
    usage: input.usage,
    tokensSavedByReduction: input.tokensSavedByReduction,
    latencyMs: input.latencyMs,
    tokenEconomics: input.tokenEconomics,
    outcomeState: trajectoryMetrics.outcomeState,
    failureStage: trajectoryMetrics.failureStage,
    chatStateSummary: input.chatStateSummary,
    fileStateSummary: input.fileStateSummary,
    objectiveScopeSummary: input.objectiveScopeSummary,
    stateConfidenceSummary: input.stateConfidenceSummary,
    stateTransitionSummary,
    evidenceDelta: input.evidenceDelta,
    chatPhase: input.chatPhase,
    chatCompletionStatus: input.chatCompletionStatus,
    fileStatusCounts: input.fileStatusCounts,
    objectiveEpochId: stateChannelSummary.objectiveEpochId,
    objectiveScopeBoundaryIndex: stateChannelSummary.objectiveScopeBoundaryIndex,
    objectiveScopeRetainedEvidence: stateChannelSummary.objectiveScopeRetainedEvidence,
    objectiveScopeDroppedPreBoundary: stateChannelSummary.objectiveScopeDroppedPreBoundary,
    stateConfidenceOverall: stateChannelSummary.stateConfidenceOverall,
    stateConfidenceNeedsReground: stateChannelSummary.stateConfidenceNeedsReground,
    stateConfidenceReasons: stateChannelSummary.stateConfidenceReasons,
    stateTransitionRecord,
    activeQualityThresholds,
    stateTransitionCalibration,
    globalThresholdResolutionAfter,
    globalSampleCountAfter,
    prematureStopSignals: trajectoryMetrics.prematureStopSignals,
  });
  const stateTransitionEvents = buildStateTransitionEvents({
    record: input.record,
    requestId: input.requestId,
    stateTransitionRecord,
    stateTransitionTrainingRow,
    activeQualityThresholds,
    stateTransitionCalibration,
    globalThresholdResolutionAfter,
    globalCalibrationObservation,
    thresholdShift,
    globalThresholdShift,
    globalSampleCountAfter,
  });

  return {
    stateTransitionSummary,
    sessionEvents: [requestTrajectoryEvent, ...stateTransitionEvents],
  };
}

export function buildStateTransitionEvents(input: BuildStateTransitionEventsInput): SessionEventInsert[] {
  const events: SessionEventInsert[] = [{
    sessionKey: input.record.sessionKey,
    requestId: input.requestId,
    userId: input.record.userId,
    orgId: input.record.orgId,
    eventKind: "state_transition_v1",
    component: "state-ledger",
    detail: summarizeStateTransition(input.stateTransitionRecord),
    metadataJson: {
      ...input.stateTransitionRecord,
      training_row: input.stateTransitionTrainingRow,
      quality_thresholds: input.activeQualityThresholds,
      quality_calibration: input.stateTransitionCalibration,
      quality_global_resolution: input.globalThresholdResolutionAfter,
      quality_global_calibration: {
        org_model: input.globalCalibrationObservation.org_model_calibration,
        model: input.globalCalibrationObservation.model_calibration,
      },
    } as unknown as Record<string, unknown>,
  }];

  if (input.stateTransitionCalibration.applied && input.thresholdShift > 0.01) {
    events.push({
      sessionKey: input.record.sessionKey,
      requestId: input.requestId,
      userId: input.record.userId,
      orgId: input.record.orgId,
      eventKind: "state_transition_quality_calibration_v1",
      component: "state-ledger",
      detail: input.stateTransitionCalibration.summary,
      metadataJson: input.stateTransitionCalibration as unknown as Record<string, unknown>,
    });
  }

  if (
    (input.globalCalibrationObservation.org_model_calibration.applied || input.globalCalibrationObservation.model_calibration.applied)
    && input.globalThresholdShift > 0.01
  ) {
    events.push({
      sessionKey: input.record.sessionKey,
      requestId: input.requestId,
      userId: input.record.userId,
      orgId: input.record.orgId,
      eventKind: "state_transition_quality_global_calibration_v1",
      component: "state-ledger",
      detail: `global quality calibration scope=${input.globalThresholdResolutionAfter.selected_scope} samples=${input.globalSampleCountAfter}`,
      metadataJson: {
        resolution: input.globalThresholdResolutionAfter,
        org_model: input.globalCalibrationObservation.org_model_calibration,
        model: input.globalCalibrationObservation.model_calibration,
      } as unknown as Record<string, unknown>,
    });
  }

  return events;
}
