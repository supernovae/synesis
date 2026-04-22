import type { ChatState } from "./chat-state.js";
import type { FileState, FileStateEntry, FileStateStatus } from "./file-state.js";

export interface StateConfidenceAssessment {
  chatConfidence: number;
  fileConfidence: number;
  overallConfidence: number;
  needsReground: boolean;
  reasons: string[];
  recommendedReadPath: string | null;
}

export interface AssessStateConfidenceOptions {
  chatState: Pick<
    ChatState,
    | "activeObjective"
    | "pendingUserDirective"
    | "phase"
    | "unresolvedCorrections"
    | "lastVerificationOutcome"
    | "completionStatus"
    | "blockers"
    | "currentFocusPaths"
    | "transcriptSummary"
    | "narrationResidueSummary"
  >;
  fileState: Pick<FileState, "filesByPath">;
  recentReadSatisfied?: boolean;
  lowConfidenceThreshold?: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/");
}

function round(value: number): number {
  return Number(clamp01(value).toFixed(3));
}

function candidatePathByStatus(
  entries: Array<{ path: string; entry: FileStateEntry }>,
  statuses: FileStateStatus[],
): string | null {
  const statusSet = new Set(statuses);
  for (const row of entries) {
    if (statusSet.has(row.entry.status)) return row.path;
  }
  return null;
}

function recommendedReadPath(
  focusPaths: string[],
  entries: Array<{ path: string; entry: FileStateEntry }>,
): string | null {
  const byPath = new Map<string, FileStateEntry>();
  for (const row of entries) byPath.set(row.path, row.entry);

  const normalizedFocus = focusPaths
    .map((path) => normalizePath(path))
    .filter(Boolean);
  const prioritizedStatuses: FileStateStatus[] = ["stale", "partial", "evicted", "missing"];

  for (const focusPath of normalizedFocus) {
    const direct = byPath.get(focusPath);
    if (direct && prioritizedStatuses.includes(direct.status)) return focusPath;
    for (const row of entries) {
      const path = row.path;
      if (path.endsWith(focusPath) || focusPath.endsWith(path)) {
        if (prioritizedStatuses.includes(row.entry.status)) return path;
      }
    }
  }

  return candidatePathByStatus(entries, ["stale", "partial", "evicted", "missing"])
    ?? normalizedFocus[0]
    ?? null;
}

export function assessStateConfidence(options: AssessStateConfidenceOptions): StateConfidenceAssessment {
  const { chatState, fileState } = options;
  const reasons = new Set<string>();
  let chatConfidence = 0.2;

  if (chatState.activeObjective) chatConfidence += 0.26;
  else reasons.add("missing_active_objective");

  if (chatState.pendingUserDirective) chatConfidence += 0.18;
  else reasons.add("missing_pending_directive");

  if (chatState.currentFocusPaths.length > 0) chatConfidence += 0.14;
  else reasons.add("missing_focus_paths");

  if (chatState.transcriptSummary) chatConfidence += 0.08;
  if (chatState.blockers.length > 0) chatConfidence += 0.04;

  if (chatState.unresolvedCorrections.length > 0) {
    chatConfidence -= 0.08;
    reasons.add("unresolved_corrections_present");
  }

  if (chatState.narrationResidueSummary && !chatState.pendingUserDirective) {
    chatConfidence -= 0.16;
    reasons.add("narration_residue_without_directive");
  }

  if (
    chatState.completionStatus === "complete_claimed"
    && chatState.lastVerificationOutcome !== "pass"
  ) {
    chatConfidence -= 0.16;
    reasons.add("completion_claim_without_verification_pass");
  }

  if (chatState.phase === "recover" && chatState.lastVerificationOutcome === "fail") {
    chatConfidence -= 0.04;
  }

  chatConfidence = clamp01(chatConfidence);

  const entries = Object.entries(fileState.filesByPath ?? {})
    .map(([path, entry]) => ({ path: normalizePath(path), entry }));
  const total = entries.length;
  let fileConfidence = 0.35;

  let availableLike = 0;
  let stale = 0;
  let partial = 0;
  let evicted = 0;
  let missing = 0;
  let contentReady = 0;

  for (const row of entries) {
    const status = row.entry.status;
    if (status === "available" || status === "unchanged") availableLike += 1;
    if (status === "stale" || row.entry.staleSinceEdit) stale += 1;
    if (status === "partial") partial += 1;
    if (status === "evicted") evicted += 1;
    if (status === "missing") missing += 1;
    if (row.entry.fullContentAvailable || typeof row.entry.lastContent === "string") contentReady += 1;
  }

  if (total > 0) {
    fileConfidence = 0.18;
    fileConfidence += 0.46 * (availableLike / total);
    fileConfidence += 0.14 * (contentReady / total);
    fileConfidence -= 0.30 * (stale / total);
    fileConfidence -= 0.20 * (partial / total);
    fileConfidence -= 0.36 * (evicted / total);
    fileConfidence -= 0.20 * (missing / total);
  } else {
    reasons.add("file_state_empty");
  }

  const focusPaths = chatState.currentFocusPaths.map((path) => normalizePath(path)).filter(Boolean);
  if (focusPaths.length > 0) {
    const focusGrounded = focusPaths.some((focusPath) => entries.some(({ path, entry }) =>
      (path.endsWith(focusPath) || focusPath.endsWith(path))
      && (entry.status === "available" || entry.status === "unchanged"),
    ));
    if (!focusGrounded) {
      fileConfidence -= 0.14;
      reasons.add("focus_paths_not_grounded");
    }
  }

  if (stale > 0) reasons.add("stale_file_snapshot_present");
  if (partial > 0) reasons.add("partial_file_snapshot_present");
  if (evicted > 0) reasons.add("evicted_file_snapshot_present");

  if (options.recentReadSatisfied) {
    fileConfidence += 0.1;
  }
  fileConfidence = clamp01(fileConfidence);

  const overallConfidence = clamp01((chatConfidence * 0.55) + (fileConfidence * 0.45));
  const threshold = Number.isFinite(options.lowConfidenceThreshold ?? NaN)
    ? clamp01(Number(options.lowConfidenceThreshold))
    : 0.58;
  const inActionPhase = chatState.phase === "edit"
    || chatState.phase === "verify"
    || chatState.phase === "recover"
    || chatState.phase === "finalize";
  const recPath = recommendedReadPath(focusPaths, entries);
  const needsReground = Boolean(
    inActionPhase
    && !options.recentReadSatisfied
    && recPath
    && (
      overallConfidence < threshold
      || chatConfidence < 0.48
      || fileConfidence < 0.48
    ),
  );

  return {
    chatConfidence: round(chatConfidence),
    fileConfidence: round(fileConfidence),
    overallConfidence: round(overallConfidence),
    needsReground,
    reasons: Array.from(reasons).sort(),
    recommendedReadPath: needsReground ? recPath : null,
  };
}

export function formatStateConfidenceBlock(assessment: StateConfidenceAssessment): string | null {
  if (!assessment.needsReground || !assessment.recommendedReadPath) return null;
  const reasons = assessment.reasons.join(",") || "low_confidence";
  return [
    "<SYNESIS_STATE_CONFIDENCE version=\"1\">",
    `chat_confidence=${assessment.chatConfidence.toFixed(3)}`,
    `file_confidence=${assessment.fileConfidence.toFixed(3)}`,
    `overall_confidence=${assessment.overallConfidence.toFixed(3)}`,
    "needs_reground=yes",
    `recommended_read_path=${assessment.recommendedReadPath}`,
    `reasons=${reasons}`,
    "action=Before continuing autonomous implementation, issue exactly one targeted Read for the recommended path.",
    "</SYNESIS_STATE_CONFIDENCE>",
  ].join("\n");
}
