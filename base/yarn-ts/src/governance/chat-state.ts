import { parseReadSnapshotEnvelope } from "../reduction/file-snapshot-registry.js";

export type ChatPhase =
  | "interpret"
  | "inspect"
  | "edit"
  | "verify"
  | "recover"
  | "finalize";

export type VerificationOutcome = "pass" | "fail" | "unknown";
export type CorrectionStatus = "open" | "resolved";
export type CompletionStatus = "in_progress" | "blocked" | "ready_to_finalize" | "complete_claimed";

export interface ChatCorrectionRecord {
  issue: string;
  sourceTurn: number;
  sourceRole: "user";
  status: CorrectionStatus;
  resolutionEvidenceSummary: string | null;
  reopened: boolean;
}

export interface ChatAttemptSummary {
  kind: "edit" | "verify" | "analysis";
  summary: string;
  evidenceTurn: number;
}

export interface ChatState {
  activeObjective: string | null;
  phase: ChatPhase;
  unresolvedCorrections: ChatCorrectionRecord[];
  resolvedCorrections: ChatCorrectionRecord[];
  lastAttemptSummary: ChatAttemptSummary | null;
  lastVerificationOutcome: VerificationOutcome;
  blockers: string[];
  currentFocusPaths: string[];
  transcriptSummary: string;
  narrationResidueSummary: string | null;
  pendingUserDirective: string | null;
  completionStatus: CompletionStatus;
}

/**
 * Compact, persisted chat-state payload for cross-turn continuity.
 * Stored in session metadata and fed back into derivation as a fallback.
 */
export interface ChatStateSnapshot {
  activeObjective: string | null;
  phase: ChatPhase;
  pendingUserDirective: string | null;
  completionStatus: CompletionStatus;
  lastVerificationOutcome: VerificationOutcome;
  unresolvedCorrectionCount: number;
  resolvedCorrectionCount: number;
  transcriptSummary: string;
  updatedAt: number;
}

interface MessageLike {
  role: string;
  content: unknown;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: unknown };
    name?: string;
    input?: unknown;
  }>;
}

export interface DeriveChatStateOptions {
  phaseHint?: ChatPhase | null;
  maxTranscriptSummaryEntries?: number;
  previousSnapshot?: Partial<ChatStateSnapshot> | null;
}

const FILE_PATH_RE = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|yaml|yml|md|sql|sh|tf|hcl)\b/g;
const CORRECTION_TRIGGER_RE =
  /\b(correction|actually|instead|rather than|not that|don't|do not|wrong|stop doing|use .* instead)\b/i;
const RESOLUTION_RE =
  /\b(updated|fixed|implemented|applied|resolved|corrected|switched|done|completed|verified|incorporated)\b/i;
const VERIFICATION_PASS_RE =
  /\b(pass|passed|ok\b|success|all tests passed|0 failed|no failures?|verification passed)\b/i;
const VERIFICATION_FAIL_RE =
  /\bfail(ed|ure)?\b|\berror\b|\bpanic\b|\btraceback\b|exit\s+code\s+[1-9]\d*/i;
const COMPLETION_CLAIM_RE =
  /\b(i('| a)?ve?\s+(completed|finished|done|implemented)|already\s+(done|implemented|complete|finished)|task\s+(is\s+)?complete)\b/i;

const READ_AFFORDANCE_RE = /unchanged since last read|already read|already in memory|already in context|already loaded|cached/i;
const TOOL_RESULT_ONLY_USER_KEYS = new Set(["tool_result"]);

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "for",
  "of",
  "in",
  "on",
  "with",
  "that",
  "this",
  "is",
  "are",
  "be",
  "as",
  "it",
  "we",
  "you",
  "i",
  "please",
  "now",
  "then",
  "just",
  "from",
  "by",
]);

export function deriveChatState(
  messages: MessageLike[],
  options: DeriveChatStateOptions = {},
): ChatState {
  const previousSnapshot = options.previousSnapshot ?? null;
  const pendingUserDirective = findLatestUserDirective(messages)
    ?? previousSnapshot?.pendingUserDirective
    ?? null;
  const corrections = deriveCorrections(messages);
  const unresolvedCorrections = corrections.filter((c) => c.status === "open");
  const resolvedCorrections = corrections.filter((c) => c.status === "resolved");
  const inferredVerificationOutcome = inferVerificationOutcome(messages);
  const lastVerificationOutcome = inferredVerificationOutcome !== "unknown"
    ? inferredVerificationOutcome
    : (previousSnapshot?.lastVerificationOutcome ?? "unknown");
  const lastAttemptSummary = inferLastAttemptSummary(messages);
  const blockers = inferBlockers(messages);
  const currentFocusPaths = inferFocusPaths(
    messages,
    pendingUserDirective,
    unresolvedCorrections,
    lastAttemptSummary,
  );
  const transcriptSummaryRaw = summarizeTranscript(
    messages,
    options.maxTranscriptSummaryEntries ?? 6,
  );
  const transcriptSummary = transcriptSummaryRaw || previousSnapshot?.transcriptSummary || "";
  const narrationResidueSummary = summarizeNarrationResidue(messages);
  const inferredCompletionStatus = inferCompletionStatus(
    messages,
    unresolvedCorrections.length,
    lastVerificationOutcome,
  );
  const shouldCarryCompletionStatus =
    inferredCompletionStatus === "in_progress"
    && !pendingUserDirective
    && !lastAttemptSummary
    && unresolvedCorrections.length === 0
    && transcriptSummaryRaw.length === 0;
  const completionStatus = shouldCarryCompletionStatus
    ? (previousSnapshot?.completionStatus ?? inferredCompletionStatus)
    : inferredCompletionStatus;
  const phase = resolvePhase(
    messages,
    pendingUserDirective,
    lastVerificationOutcome,
    blockers,
    options.phaseHint,
    previousSnapshot?.phase,
  );
  const activeObjective = pendingUserDirective
    ?? unresolvedCorrections[unresolvedCorrections.length - 1]?.issue
    ?? lastAttemptSummary?.summary
    ?? previousSnapshot?.activeObjective
    ?? null;

  return {
    activeObjective,
    phase,
    unresolvedCorrections,
    resolvedCorrections,
    lastAttemptSummary,
    lastVerificationOutcome,
    blockers,
    currentFocusPaths,
    transcriptSummary,
    narrationResidueSummary,
    pendingUserDirective,
    completionStatus,
  };
}

export function formatChatStateBlock(chatState: ChatState): string | null {
  const hasSignal = Boolean(
    chatState.activeObjective
      || chatState.pendingUserDirective
      || chatState.transcriptSummary
      || chatState.unresolvedCorrections.length
      || chatState.resolvedCorrections.length,
  );
  if (!hasSignal) return null;

  const lines: string[] = ["<SYNESIS_CHAT_STATE version=\"1\">"];
  lines.push(`active_objective=${safeValue(chatState.activeObjective ?? "none")}`);
  lines.push(`phase=${chatState.phase}`);
  lines.push(`pending_user_directive=${safeValue(chatState.pendingUserDirective ?? "none")}`);
  lines.push("directive_execution_mode=apply_directive_silently_without_repeated_acknowledgment");
  lines.push(`last_verification_outcome=${chatState.lastVerificationOutcome}`);
  lines.push(`completion_status=${chatState.completionStatus}`);
  lines.push(`blockers=${safeValue(chatState.blockers.join(" | ") || "none")}`);
  lines.push(`focus_paths=${safeValue(chatState.currentFocusPaths.join(",") || "none")}`);
  lines.push(`unresolved_corrections=${chatState.unresolvedCorrections.length}`);
  lines.push(`resolved_corrections=${chatState.resolvedCorrections.length}`);

  for (const correction of chatState.unresolvedCorrections.slice(-3)) {
    lines.push(
      `open_correction=turn:${correction.sourceTurn};issue:${safeValue(correction.issue)};reopened:${correction.reopened ? "yes" : "no"}`,
    );
  }
  for (const correction of chatState.resolvedCorrections.slice(-3)) {
    lines.push(
      `resolved_correction=turn:${correction.sourceTurn};issue:${safeValue(correction.issue)};evidence:${safeValue(correction.resolutionEvidenceSummary ?? "none")}`,
    );
  }

  if (chatState.lastAttemptSummary) {
    lines.push(
      `last_attempt=kind:${chatState.lastAttemptSummary.kind};turn:${chatState.lastAttemptSummary.evidenceTurn};summary:${safeValue(chatState.lastAttemptSummary.summary)}`,
    );
  } else {
    lines.push("last_attempt=none");
  }

  lines.push(`transcript_summary=${safeValue(chatState.transcriptSummary || "none")}`);
  lines.push(
    `narration_residue_summary=${safeValue(chatState.narrationResidueSummary ?? "none")}`,
  );
  lines.push("</SYNESIS_CHAT_STATE>");
  return lines.join("\n");
}

export function toChatStateSnapshot(chatState: ChatState, updatedAt = Date.now()): ChatStateSnapshot {
  return {
    activeObjective: chatState.activeObjective ? summarizeValue(chatState.activeObjective, 240) : null,
    phase: chatState.phase,
    pendingUserDirective: chatState.pendingUserDirective ? summarizeValue(chatState.pendingUserDirective, 240) : null,
    completionStatus: chatState.completionStatus,
    lastVerificationOutcome: chatState.lastVerificationOutcome,
    unresolvedCorrectionCount: chatState.unresolvedCorrections.length,
    resolvedCorrectionCount: chatState.resolvedCorrections.length,
    transcriptSummary: summarizeValue(chatState.transcriptSummary || "", 320),
    updatedAt,
  };
}

function deriveCorrections(messages: MessageLike[]): ChatCorrectionRecord[] {
  const userTurns = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user")
    .filter(({ message }) => !isToolResultOnlyUserMessage(message))
    .map(({ message, index }) => ({
      index,
      text: normalizeText(contentToText(message.content)),
    }))
    .filter((row) => row.text.length > 0);

  const correctionTurns = userTurns
    .map((turn) => ({ ...turn, issue: extractCorrectionIssue(turn.text) }))
    .filter((turn): turn is { index: number; text: string; issue: string } => Boolean(turn.issue));

  const records: ChatCorrectionRecord[] = [];
  for (let i = 0; i < correctionTurns.length; i += 1) {
    const correction = correctionTurns[i];
    const issueKey = issueFingerprint(correction.issue);
    const searchEndExclusive = i + 1 < correctionTurns.length ? correctionTurns[i + 1].index : messages.length;
    const resolutionEvidence = findResolutionEvidence(
      messages,
      correction.index,
      searchEndExclusive,
      correction.issue,
    );
    const reopened = correctionTurns
      .slice(i + 1)
      .some((later) => issueFingerprint(later.issue) === issueKey);
    const resolved = Boolean(resolutionEvidence) && !reopened;

    records.push({
      issue: correction.issue,
      sourceTurn: correction.index,
      sourceRole: "user",
      status: resolved ? "resolved" : "open",
      resolutionEvidenceSummary: resolutionEvidence,
      reopened,
    });
  }

  return records;
}

function findResolutionEvidence(
  messages: MessageLike[],
  sourceIndex: number,
  endExclusive: number,
  issue: string,
): string | null {
  const issueTokens = tokenSet(issue);
  let sawEditLikeAction = false;

  for (let i = sourceIndex + 1; i < endExclusive; i += 1) {
    const message = messages[i];
    if (message.role === "assistant" && hasEditLikeToolCall(message)) {
      sawEditLikeAction = true;
    }

    const text = normalizeText(contentToText(message.content));
    if (!text) continue;
    if (isSyntheticToolSignal(message, text)) continue;

    if (message.role === "assistant" && RESOLUTION_RE.test(text)) {
      if (sharesIssueTokens(text, issueTokens) || /correction|updated|switched|instead/.test(text)) {
        return summarizeValue(text, 180);
      }
      if (sawEditLikeAction) {
        return summarizeValue(text, 180);
      }
    }

    if ((message.role === "tool" || message.role === "tool_result")
      && sawEditLikeAction
      && VERIFICATION_PASS_RE.test(text)
      && !VERIFICATION_FAIL_RE.test(text)) {
      return "Applied correction and verification succeeded.";
    }
  }

  return null;
}

function findLatestUserDirective(messages: MessageLike[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (isToolResultOnlyUserMessage(message)) continue;
    const text = normalizeText(contentToText(message.content));
    if (!text) continue;
    return summarizeValue(text, 220);
  }
  return null;
}

function inferVerificationOutcome(messages: MessageLike[]): VerificationOutcome {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    const text = normalizeText(contentToText(message.content));
    if (!text) continue;
    if (isSyntheticToolSignal(message, text)) continue;
    if (VERIFICATION_FAIL_RE.test(text)) return "fail";
    if (VERIFICATION_PASS_RE.test(text)) return "pass";
  }
  return "unknown";
}

function inferLastAttemptSummary(messages: MessageLike[]): ChatAttemptSummary | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const text = normalizeText(contentToText(message.content));
    if (!text) continue;
    if (isSyntheticToolSignal(message, text)) continue;

    if (message.role === "tool" || message.role === "tool_result") {
      const kind = VERIFICATION_FAIL_RE.test(text) || VERIFICATION_PASS_RE.test(text)
        ? "verify"
        : "analysis";
      return { kind, summary: summarizeValue(text, 180), evidenceTurn: i };
    }

    if (message.role === "assistant") {
      const kind = hasEditLikeToolCall(message) || /\b(edit|updated|patched|refactored|implemented)\b/i.test(text)
        ? "edit"
        : "analysis";
      return { kind, summary: summarizeValue(text, 180), evidenceTurn: i };
    }
  }

  return null;
}

function inferBlockers(messages: MessageLike[]): string[] {
  const blockers: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (blockers.length >= 4) break;
    const message = messages[i];
    if (message.role !== "tool" && message.role !== "tool_result") continue;
    const text = normalizeText(contentToText(message.content));
    if (!text || isSyntheticToolSignal(message, text)) continue;
    if (!VERIFICATION_FAIL_RE.test(text)) continue;

    const blocker = summarizeValue(text, 160);
    if (!blockers.includes(blocker)) blockers.push(blocker);
  }
  blockers.reverse();
  return blockers;
}

function inferFocusPaths(
  messages: MessageLike[],
  pendingUserDirective: string | null,
  unresolvedCorrections: ChatCorrectionRecord[],
  lastAttemptSummary: ChatAttemptSummary | null,
): string[] {
  const out = new Set<string>();

  if (pendingUserDirective) {
    for (const p of extractPaths(pendingUserDirective)) out.add(p);
  }
  for (const correction of unresolvedCorrections.slice(-4)) {
    for (const p of extractPaths(correction.issue)) out.add(p);
  }
  if (lastAttemptSummary) {
    for (const p of extractPaths(lastAttemptSummary.summary)) out.add(p);
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (out.size >= 8) break;
    const message = messages[i];
    const text = normalizeText(contentToText(message.content));
    if (!text) continue;
    const envelope = parseReadSnapshotEnvelope(text);
    if (envelope) {
      const path = typeof envelope.canonical_path === "string"
        ? envelope.canonical_path
        : (typeof envelope.path === "string" ? envelope.path : "");
      if (path) out.add(path);
      continue;
    }
    for (const p of extractPaths(text)) {
      out.add(p);
      if (out.size >= 8) break;
    }
  }

  return Array.from(out).sort();
}

function summarizeTranscript(messages: MessageLike[], maxEntries: number): string {
  const entries: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (entries.length >= maxEntries) break;
    const message = messages[i];
    if (message.role === "system") continue;
    const text = normalizeText(contentToText(message.content));
    if (!text) continue;
    if (isSyntheticToolSignal(message, text)) continue;
    entries.push(`${message.role}:${summarizeValue(text, 110)}`);
  }
  entries.reverse();
  return entries.join(" | ");
}

function summarizeNarrationResidue(messages: MessageLike[]): string | null {
  const ACK_OPENING_RE =
    /^(i understand|understood|got it|acknowledged|sounds good|will do|ok(?:ay)?\b|thanks,?\s+understood)\b/i;
  const openings = new Map<string, number>();
  let ackReplayCount = 0;
  let lastAckOpening: string | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const raw = contentToText(message.content).trim();
    if (!raw) continue;
    const firstParagraph = (raw.split(/\n\n+/)[0] ?? raw).toLowerCase().replace(/\s+/g, " ").trim();
    if (ACK_OPENING_RE.test(firstParagraph)) {
      if (lastAckOpening !== null) ackReplayCount += 1;
      lastAckOpening = firstParagraph.slice(0, 80);
    } else {
      lastAckOpening = null;
    }
    if (firstParagraph.length < 40) continue;
    const normalized = firstParagraph.slice(0, 220);
    openings.set(normalized, (openings.get(normalized) ?? 0) + 1);
  }

  if (ackReplayCount >= 2) {
    return `Repeated assistant acknowledgments (${ackReplayCount + 1}x): avoid re-stating compliance and execute the directive directly.`;
  }

  let maxEntry: { text: string; count: number } | null = null;
  for (const [text, count] of openings) {
    if (!maxEntry || count > maxEntry.count) maxEntry = { text, count };
  }
  if (!maxEntry || maxEntry.count < 2) return null;
  return `Repeated assistant intent narration (${maxEntry.count}x): ${summarizeValue(maxEntry.text, 140)}`;
}

function inferCompletionStatus(
  messages: MessageLike[],
  unresolvedCorrectionCount: number,
  lastVerificationOutcome: VerificationOutcome,
): CompletionStatus {
  if (unresolvedCorrectionCount > 0) return "blocked";

  const assistantText = messages
    .filter((m) => m.role === "assistant")
    .map((m) => normalizeText(contentToText(m.content)).toLowerCase())
    .filter(Boolean)
    .join("\n");
  const hasCompletionClaim = COMPLETION_CLAIM_RE.test(assistantText);
  if (!hasCompletionClaim) return "in_progress";
  if (lastVerificationOutcome === "pass") return "ready_to_finalize";
  return "complete_claimed";
}

function resolvePhase(
  messages: MessageLike[],
  pendingUserDirective: string | null,
  lastVerificationOutcome: VerificationOutcome,
  blockers: string[],
  phaseHint?: ChatPhase | null,
  previousPhase?: ChatPhase | null,
): ChatPhase {
  if (phaseHint) return phaseHint;
  if (lastVerificationOutcome === "fail") return "recover";
  if (lastVerificationOutcome === "pass") return "verify";
  if (blockers.length > 0) return "recover";

  if (hasRecentEditIntent(messages)) return "edit";

  const directive = (pendingUserDirective ?? "").toLowerCase();
  if (/\b(plan|design|approach|strategy)\b/.test(directive)) return "interpret";
  if (/\b(inspect|investigate|review|scan|audit|understand|analyze)\b/.test(directive)) return "inspect";
  if (/\b(verify|test|validate|check)\b/.test(directive)) return "verify";
  if (/\b(done|finalize|finish|wrap up)\b/.test(directive)) return "finalize";
  if (directive) return "edit";
  return previousPhase ?? "inspect";
}

function hasRecentEditIntent(messages: MessageLike[]): boolean {
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 12); i -= 1) {
    const message = messages[i];
    if (message.role === "assistant" && hasEditLikeToolCall(message)) return true;
    const text = normalizeText(contentToText(message.content)).toLowerCase();
    if (!text) continue;
    if (/\b(edit|write|patch|modify|implement|refactor)\b/.test(text)) return true;
  }
  return false;
}

function hasEditLikeToolCall(message: MessageLike): boolean {
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return false;
  return message.tool_calls.some((call) => {
    const name = normalizeText(
      typeof call.function?.name === "string" ? call.function.name : (call.name ?? ""),
    ).toLowerCase();
    if (!name) return false;
    return name.includes("edit")
      || name.includes("write")
      || name.includes("applypatch")
      || name.includes("str_replace")
      || name.includes("update");
  });
}

function isSyntheticToolSignal(message: MessageLike, text: string): boolean {
  if (message.role !== "tool" && message.role !== "tool_result") return false;
  if (READ_AFFORDANCE_RE.test(text)) return true;

  const envelope = parseReadSnapshotEnvelope(text);
  if (!envelope) return false;

  const hasContent = typeof envelope.content === "string" && envelope.content.trim().length > 0;
  if (!hasContent) return true;
  return envelope.status === "ok/replayed_snapshot";
}

function extractCorrectionIssue(text: string): string | null {
  if (!CORRECTION_TRIGGER_RE.test(text)) return null;
  const trimmed = text
    .replace(/^correction\s*:\s*/i, "")
    .replace(/^actually\s*,?\s*/i, "")
    .trim();
  if (!trimmed) return null;
  return summarizeValue(trimmed, 220);
}

function contentToText(content: unknown): string {
  const chunks: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const text = value.trim();
      if (text) chunks.push(text);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (text) chunks.push(text);
    for (const key of ["message", "error", "output", "content"]) {
      if (typeof row[key] === "string") {
        const nested = String(row[key]).trim();
        if (nested) chunks.push(nested);
      }
    }
    if ("content" in row) visit(row.content);
  };
  visit(content);
  return chunks.join("\n");
}

function isToolResultOnlyUserMessage(message: MessageLike): boolean {
  if (message.role !== "user" || !Array.isArray(message.content) || message.content.length === 0) {
    return false;
  }
  return message.content.every((part) => {
    if (!part || typeof part !== "object") return false;
    const row = part as Record<string, unknown>;
    const typeValue = typeof row.type === "string" ? row.type.trim().toLowerCase() : "";
    return TOOL_RESULT_ONLY_USER_KEYS.has(typeValue);
  });
}

function extractPaths(text: string): string[] {
  return Array.from(new Set(text.match(FILE_PATH_RE) ?? []));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function summarizeValue(value: string, maxChars: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function issueFingerprint(issue: string): string {
  return Array.from(tokenSet(issue)).sort().slice(0, 8).join("|");
}

function tokenSet(text: string): Set<string> {
  const tokens = normalizeText(text)
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !STOP_WORDS.has(token));
  return new Set(tokens);
}

function sharesIssueTokens(candidate: string, issueTokens: Set<string>): boolean {
  if (issueTokens.size === 0) return false;
  const candidateTokens = tokenSet(candidate);
  for (const token of issueTokens) {
    if (candidateTokens.has(token)) return true;
  }
  return false;
}

function safeValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
