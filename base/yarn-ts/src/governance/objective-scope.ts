import crypto from "crypto";

import type { ChatState } from "./chat-state.js";
import type { FileState } from "./file-state.js";

export interface ObjectiveEpochState {
  epochId: number;
  objectiveHash: string;
  objectiveText: string;
  anchorUserHash: string;
  objectiveSetRequest: number;
  objectiveChanged: boolean;
  similarityToPrevious: number;
}

export interface ResolveObjectiveEpochOptions {
  metadata: Record<string, unknown>;
  chatState: Pick<ChatState, "activeObjective" | "pendingUserDirective">;
  latestUserPromptText: string | null;
  requestOrdinal: number;
}

export interface ObjectiveScopeMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
}

export interface ApplyObjectiveScopeOptions<TMessage extends ObjectiveScopeMessage> {
  messages: TMessage[];
  epoch: ObjectiveEpochState;
  chatState: Pick<ChatState, "activeObjective" | "pendingUserDirective" | "blockers" | "currentFocusPaths" | "transcriptSummary" | "lastVerificationOutcome">;
  fileState: Pick<FileState, "filesByPath">;
  maxRelevantEvidence?: number;
  preBoundaryWindow?: number;
  minimumScore?: number;
}

export interface ObjectiveScopeResult<TMessage extends ObjectiveScopeMessage> {
  scopedMessages: TMessage[];
  relevantEvidenceBlock: string | null;
  boundaryIndex: number;
  preBoundaryCount: number;
  retainedEvidenceCount: number;
  droppedPreBoundaryCount: number;
  anchorMatched: boolean;
}

const OBJECTIVE_STOP_WORDS = new Set([
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
  "into",
  "across",
  "toward",
  "towards",
  "still",
  "continue",
]);

interface RelevancyCandidate {
  role: string;
  toolName: string | null;
  summary: string;
  score: number;
  index: number;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function safeSummary(value: string, maxChars = 180): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function hashSignal(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized.slice(0, 4000)).digest("hex");
}

function collectTokenSet(value: string): Set<string> {
  const tokens = normalizeText(value)
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !OBJECTIVE_STOP_WORDS.has(token));
  return new Set(tokens);
}

function objectiveSimilarity(previousObjective: string, currentObjective: string): number {
  const previous = collectTokenSet(previousObjective);
  const current = collectTokenSet(currentObjective);
  if (previous.size === 0 || current.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of previous) {
    if (current.has(token)) intersection += 1;
  }
  return intersection / Math.max(previous.size, current.size);
}

function objectivesEquivalent(previousObjective: string, currentObjective: string): boolean {
  const previous = normalizeText(previousObjective).toLowerCase();
  const current = normalizeText(currentObjective).toLowerCase();
  if (!previous || !current) return false;
  if (previous === current) return true;
  return objectiveSimilarity(previous, current) >= 0.65;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.text === "string" && row.text.trim()) out.push(row.text.trim());
      if (typeof row.content === "string" && row.content.trim()) out.push(row.content.trim());
      if (typeof row.output === "string" && row.output.trim()) out.push(row.output.trim());
    }
    return out.join("\n").trim();
  }
  if (content && typeof content === "object") {
    const row = content as Record<string, unknown>;
    if (typeof row.text === "string" && row.text.trim()) return row.text.trim();
    if (typeof row.content === "string" && row.content.trim()) return row.content.trim();
    if (typeof row.output === "string" && row.output.trim()) return row.output.trim();
  }
  return "";
}

function isToolResultOnlyUserContent(content: unknown): boolean {
  return Array.isArray(content)
    && content.length > 0
    && (content as Array<{ type?: string }>).every((block) => {
      if (!block || typeof block !== "object") return false;
      return String(block.type ?? "").trim().toLowerCase() === "tool_result";
    });
}

function hasGenuineUserText(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return (content as Array<{ type?: string; text?: unknown; content?: unknown }>).some((block) => {
    if (!block || typeof block !== "object") return false;
    const type = String(block.type ?? "").trim().toLowerCase();
    if (type === "tool_result") return false;
    if (typeof block.text === "string" && block.text.trim().length > 0) return true;
    if (typeof block.content === "string" && block.content.trim().length > 0) return true;
    return false;
  });
}

function isGenuineUserPrompt(message: ObjectiveScopeMessage): boolean {
  if (message.role !== "user") return false;
  if (isToolResultOnlyUserContent(message.content)) return false;
  return hasGenuineUserText(message.content);
}

function findLastGenuineUserIndex(messages: ObjectiveScopeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isGenuineUserPrompt(messages[i])) return i;
  }
  return -1;
}

function findAnchorUserIndex(messages: ObjectiveScopeMessage[], anchorUserHash: string): number {
  if (!anchorUserHash) return -1;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!isGenuineUserPrompt(message)) continue;
    const hash = hashSignal(contentToText(message.content));
    if (hash && hash === anchorUserHash) return i;
  }
  return -1;
}

function countTokenOverlap(candidateText: string, objectiveTokens: Set<string>): number {
  if (objectiveTokens.size === 0) return 0;
  const candidateTokens = collectTokenSet(candidateText);
  let overlap = 0;
  for (const token of objectiveTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  return overlap;
}

function gatherFocusPaths(
  chatState: Pick<ChatState, "currentFocusPaths">,
  fileState: Pick<FileState, "filesByPath">,
): string[] {
  const out = new Set<string>();
  for (const path of chatState.currentFocusPaths ?? []) {
    const normalized = normalizeText(path);
    if (normalized) out.add(normalized);
  }
  for (const [path, entry] of Object.entries(fileState.filesByPath ?? {})) {
    if (entry.status === "stale" || entry.status === "partial" || entry.status === "evicted") {
      const normalized = normalizeText(path);
      if (normalized) out.add(normalized);
    }
  }
  return Array.from(out).slice(0, 16);
}

function scoreRelevancyCandidates(
  messages: ObjectiveScopeMessage[],
  objectiveTokens: Set<string>,
  focusPaths: string[],
  minimumScore: number,
): RelevancyCandidate[] {
  const candidates: RelevancyCandidate[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const text = contentToText(message.content);
    if (!text) continue;
    const normalized = normalizeText(text);
    const lower = normalized.toLowerCase();

    let score = 0;
    let matchedSemantic = false;

    if (message.role === "tool" || message.role === "tool_result") score += 1;

    let pathHits = 0;
    for (const path of focusPaths) {
      if (!path) continue;
      if (lower.includes(path.toLowerCase())) pathHits += 1;
      if (pathHits >= 3) break;
    }
    if (pathHits > 0) {
      score += 2 + Math.min(2, pathHits);
      matchedSemantic = true;
    }

    const overlap = countTokenOverlap(lower, objectiveTokens);
    if (overlap > 0) {
      score += Math.min(3, overlap);
      matchedSemantic = true;
    }

    const isFailureSignal = /\b(fail|failed|failure|error|panic|traceback|stale|evicted|blocked|denied)\b/.test(lower);
    if (isFailureSignal) {
      score += 1;
      if (message.role === "tool" || message.role === "tool_result") {
        matchedSemantic = true;
      }
    }
    if (i >= messages.length - 10) {
      score += 1;
    }

    if (score < minimumScore || !matchedSemantic) continue;
    candidates.push({
      role: message.role,
      toolName: typeof message.name === "string" && message.name.trim()
        ? message.name.trim()
        : null,
      summary: safeSummary(normalized, 190),
      score,
      index: i,
    });
  }
  return candidates;
}

export function resolveObjectiveEpoch(options: ResolveObjectiveEpochOptions): ObjectiveEpochState {
  const metadata = options.metadata ?? {};
  const previousEpochId = Number(metadata.objective_epoch_id ?? 0);
  const previousObjectiveHash = typeof metadata.objective_epoch_objective_hash === "string"
    ? metadata.objective_epoch_objective_hash
    : "";
  const previousObjectiveText = typeof metadata.objective_epoch_objective_text === "string"
    ? metadata.objective_epoch_objective_text
    : "";
  const previousAnchorUserHash = typeof metadata.objective_epoch_anchor_user_hash === "string"
    ? metadata.objective_epoch_anchor_user_hash
    : "";
  const previousSetRequest = Number(metadata.objective_epoch_set_request ?? 0);

  const currentObjectiveText = normalizeText(
    options.chatState.pendingUserDirective
      ?? options.chatState.activeObjective
      ?? "",
  );
  const currentObjectiveHash = hashSignal(currentObjectiveText);
  const latestUserPromptHash = hashSignal(options.latestUserPromptText ?? "");
  const similarityToPrevious = objectiveSimilarity(previousObjectiveText, currentObjectiveText);

  const hasCurrentObjective = Boolean(currentObjectiveHash);
  const equivalentToPrevious = objectivesEquivalent(previousObjectiveText, currentObjectiveText)
    || (Boolean(previousObjectiveHash) && currentObjectiveHash === previousObjectiveHash);
  const objectiveChanged = hasCurrentObjective
    ? (previousEpochId <= 0 || !equivalentToPrevious)
    : false;

  const epochId = hasCurrentObjective
    ? (objectiveChanged ? Math.max(1, previousEpochId + 1) : Math.max(1, previousEpochId || 1))
    : Math.max(1, previousEpochId || 1);
  const objectiveText = hasCurrentObjective
    ? currentObjectiveText
    : previousObjectiveText;
  const objectiveHash = hasCurrentObjective
    ? currentObjectiveHash
    : previousObjectiveHash;
  const anchorUserHash = objectiveChanged
    ? (latestUserPromptHash || previousAnchorUserHash || "")
    : (previousAnchorUserHash || latestUserPromptHash || "");
  const objectiveSetRequest = objectiveChanged
    ? options.requestOrdinal
    : (Number.isFinite(previousSetRequest) && previousSetRequest > 0 ? previousSetRequest : options.requestOrdinal);

  return {
    epochId,
    objectiveHash,
    objectiveText,
    anchorUserHash,
    objectiveSetRequest,
    objectiveChanged,
    similarityToPrevious: Number(similarityToPrevious.toFixed(3)),
  };
}

/**
 * Walk the boundary backward so that every assistant tool_call in the retained
 * window has its matching tool result included.  Without this, slicing at the
 * boundary can orphan tool calls whose results landed just before it, causing
 * AI_MissingToolResultsError downstream.
 */
function adjustBoundaryForToolPairIntegrity(
  messages: ObjectiveScopeMessage[],
  boundary: number,
): number {
  let adjusted = Math.max(0, boundary);
  const retained = messages.slice(adjusted);

  // --- Forward direction: pull boundary back for assistant tool_calls whose results are missing ---
  const neededToolCallIds = new Set<string>();
  for (const msg of retained) {
    if (msg.role !== "assistant") continue;
    const toolCalls = (msg as unknown as Record<string, unknown>).tool_calls as
      | Array<{ id?: string }>
      | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        if (tc.id) neededToolCallIds.add(tc.id);
      }
    }
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: string; id?: string }>) {
        if (block?.type === "tool_use" && block.id) neededToolCallIds.add(block.id);
      }
    }
  }

  for (const msg of retained) {
    if (msg.role === "tool" && msg.tool_call_id) {
      neededToolCallIds.delete(msg.tool_call_id);
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type?: string; tool_use_id?: string }>) {
        if (block?.type === "tool_result" && block.tool_use_id) {
          neededToolCallIds.delete(block.tool_use_id);
        }
      }
    }
  }

  if (neededToolCallIds.size > 0) {
    for (let i = adjusted - 1; i >= 0 && neededToolCallIds.size > 0; i--) {
      const msg = messages[i];
      let pulls = false;
      if (msg.role === "tool" && msg.tool_call_id && neededToolCallIds.has(msg.tool_call_id)) {
        neededToolCallIds.delete(msg.tool_call_id);
        pulls = true;
      }
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{ type?: string; tool_use_id?: string }>) {
          if (block?.type === "tool_result" && block.tool_use_id && neededToolCallIds.has(block.tool_use_id)) {
            neededToolCallIds.delete(block.tool_use_id);
            pulls = true;
          }
        }
      }
      if (pulls) adjusted = i;
    }
  }

  return adjusted;
}

/**
 * Ensure every tool_call has a matching tool_result and vice versa.
 *
 * After boundary slicing + transcript pruning, two orphan directions exist:
 *   1. Tool results whose assistant tool_call was dropped → strip result
 *   2. Assistant tool_calls whose tool result was dropped → inject placeholder
 *
 * The Vercel AI SDK throws AI_MissingToolResultsError for either direction.
 */
function healToolCallResultPairs<T extends ObjectiveScopeMessage>(messages: T[]): T[] {
  // Collect all assistant tool_call IDs and all tool_result IDs
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const toolCalls = (msg as unknown as Record<string, unknown>).tool_calls as
        | Array<{ id?: string }>
        | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          if (tc.id) toolCallIds.add(tc.id);
        }
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{ type?: string; id?: string }>) {
          if (block?.type === "tool_use" && block.id) toolCallIds.add(block.id);
        }
      }
    }
    if (msg.role === "tool" && msg.tool_call_id) {
      toolResultIds.add(msg.tool_call_id);
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type?: string; tool_use_id?: string }>) {
        if (block?.type === "tool_result" && block.tool_use_id) {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  // Direction 1: tool results without matching tool_call → strip
  const orphanedResults = new Set<string>();
  for (const id of toolResultIds) {
    if (!toolCallIds.has(id)) orphanedResults.add(id);
  }

  // Direction 2: tool_calls without matching tool result → need placeholder
  const orphanedCalls = new Set<string>();
  for (const id of toolCallIds) {
    if (!toolResultIds.has(id)) orphanedCalls.add(id);
  }

  if (orphanedResults.size === 0 && orphanedCalls.size === 0) return messages;

  // Pass 1: strip orphaned tool results
  const result: T[] = [];
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id && orphanedResults.has(msg.tool_call_id)) {
      continue;
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const blocks = msg.content as Array<{ type?: string; tool_use_id?: string }>;
      const hasOrphans = blocks.some(
        (b) => b?.type === "tool_result" && b.tool_use_id && orphanedResults.has(b.tool_use_id),
      );
      if (hasOrphans) {
        const filtered = blocks.filter((b) => {
          if (b?.type !== "tool_result") return true;
          return !b.tool_use_id || !orphanedResults.has(b.tool_use_id);
        });
        if (filtered.length === 0) continue;
        if (filtered.length !== blocks.length) {
          result.push({ ...msg, content: filtered } as T);
          continue;
        }
      }
    }
    result.push(msg);
  }

  // Pass 2: inject placeholders for orphaned tool_calls right after their assistant message
  if (orphanedCalls.size > 0) {
    const injected: T[] = [];
    for (const msg of result) {
      injected.push(msg);
      if (msg.role === "assistant") {
        const toolCalls = (msg as unknown as Record<string, unknown>).tool_calls as
          | Array<{ id?: string; function?: { name?: string } }>
          | undefined;
        if (toolCalls) {
          for (const tc of toolCalls) {
            if (tc.id && orphanedCalls.has(tc.id)) {
              injected.push({
                role: "tool",
                content: "[Result no longer available — prior context was compacted]",
                tool_call_id: tc.id,
                name: tc.function?.name ?? "unknown",
              } as unknown as T);
              orphanedCalls.delete(tc.id);
            }
          }
        }
        if (Array.isArray(msg.content)) {
          for (const block of msg.content as Array<{ type?: string; id?: string; name?: string }>) {
            if (block?.type === "tool_use" && block.id && orphanedCalls.has(block.id)) {
              injected.push({
                role: "user",
                content: [{
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: "[Result no longer available — prior context was compacted]",
                }],
              } as unknown as T);
              orphanedCalls.delete(block.id);
            }
          }
        }
      }
    }
    return injected;
  }

  return result;
}

export function applyObjectiveScope<TMessage extends ObjectiveScopeMessage>(
  options: ApplyObjectiveScopeOptions<TMessage>,
): ObjectiveScopeResult<TMessage> {
  const allMessages = options.messages ?? [];
  if (allMessages.length === 0) {
    return {
      scopedMessages: [],
      relevantEvidenceBlock: null,
      boundaryIndex: 0,
      preBoundaryCount: 0,
      retainedEvidenceCount: 0,
      droppedPreBoundaryCount: 0,
      anchorMatched: false,
    };
  }

  const preBoundaryWindow = Math.max(10, options.preBoundaryWindow ?? 80);
  const minimumScore = Math.max(1, options.minimumScore ?? 2);
  const maxRelevantEvidence = Math.max(1, options.maxRelevantEvidence ?? 10);

  const anchorUserIndex = findAnchorUserIndex(allMessages, options.epoch.anchorUserHash);
  const lastUserIndex = findLastGenuineUserIndex(allMessages);
  let boundaryIndex = anchorUserIndex >= 0
    ? anchorUserIndex
    : (lastUserIndex >= 0 ? lastUserIndex : 0);

  boundaryIndex = adjustBoundaryForToolPairIntegrity(allMessages, boundaryIndex);

  const scopedMessages = healToolCallResultPairs(allMessages.slice(Math.max(0, boundaryIndex)));
  const preStart = Math.max(0, boundaryIndex - preBoundaryWindow);
  const preBoundaryMessages = allMessages.slice(preStart, boundaryIndex);

  const objectiveText = [
    options.chatState.pendingUserDirective,
    options.chatState.activeObjective,
    options.chatState.transcriptSummary,
    ...(options.chatState.blockers ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
  const objectiveTokens = collectTokenSet(objectiveText);
  const focusPaths = gatherFocusPaths(options.chatState, options.fileState);

  const scored = scoreRelevancyCandidates(
    preBoundaryMessages,
    objectiveTokens,
    focusPaths,
    minimumScore,
  );
  const retained = scored
    .sort((a, b) => (b.score - a.score) || (b.index - a.index))
    .slice(0, maxRelevantEvidence)
    .sort((a, b) => a.index - b.index);

  const relevantEvidenceBlock = retained.length > 0
    ? [
        "<SYNESIS_RELEVANT_EVIDENCE version=\"1\" source=\"objective_scope_gate\">",
        `objective_epoch_id=${options.epoch.epochId}`,
        `objective_changed=${options.epoch.objectiveChanged ? "yes" : "no"}`,
        `tail_start_index=${boundaryIndex}`,
        `pre_boundary_candidates=${preBoundaryMessages.length}`,
        `retained_candidates=${retained.length}`,
        `dropped_candidates=${Math.max(0, preBoundaryMessages.length - retained.length)}`,
        ...retained.map((row) =>
          `evidence=role:${row.role};tool:${row.toolName ?? "none"};score:${row.score};summary:${row.summary.replace(/;/g, ",")}`),
        "</SYNESIS_RELEVANT_EVIDENCE>",
      ].join("\n")
    : null;

  return {
    scopedMessages,
    relevantEvidenceBlock,
    boundaryIndex,
    preBoundaryCount: preBoundaryMessages.length,
    retainedEvidenceCount: retained.length,
    droppedPreBoundaryCount: Math.max(0, preBoundaryMessages.length - retained.length),
    anchorMatched: anchorUserIndex >= 0,
  };
}
