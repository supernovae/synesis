/**
 * Context Retention — Tiered Memory Classification + Retention Scoring
 *
 * Classifies each message into one of four memory tiers and computes a
 * retention score (0.0–1.0) that drives compaction decisions.
 *
 * Tiers (in order of protection):
 *   immutable       — system prompts, tool schemas, session identity
 *   working         — current objective, active failures, plan, governor guidance
 *   artifact_shadow — file snapshots still referenced, recent tool results
 *   historical      — old narration, superseded outputs, resolved verifications
 *
 * Constraints:
 *   - Messages tagged "unresolved_failure" never score below 0.6
 *   - Immutable tier messages are never compacted
 *   - Working tier messages are only compacted via heavy checkpoint
 */

import { estimateMessageTokens } from "./context-token-estimator.js";
import { looksLikeVerificationFailureOutput } from "../context/compaction-sensitivity.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type MemoryTier = "immutable" | "working" | "artifact_shadow" | "historical";

export interface ClassifiedMessage {
  index: number;
  tier: MemoryTier;
  retentionScore: number;
  estimatedTokens: number;
  tags: string[];
}

export interface RetentionContext {
  totalMessageCount: number;
  activeFilePaths: Set<string>;
  planFilePaths: Set<string>;
  lastUserMessageIndex: number;
  recentWindowStart: number;
}

export interface RetentionMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const VERIFICATION_FAIL_RE = /\bfail(ed|ure)?\b|\berror\b|\bpanic\b|\btraceback\b|exit\s+code\s+[1-9]\d*/i;
const VERIFICATION_PASS_RE = /\b(pass|passed|ok\b|success|all tests passed|0 failed|no failures?|verification passed)\b/i;
const PLAN_FILE_RE = /\.claude\/plans\//;
const GOVERNOR_RECOVERY_RE = /SYNESIS_|governor_recovery|execution_governor|sensemaking/i;
const ENRICHMENT_RE = /SYNESIS_CHAT_STATE|SYNESIS_RELEVANT_EVIDENCE|SYNESIS_FILE_STATE|SYNESIS_STRUCTURAL_INDEX|CONTEXT_CHECKPOINT/i;

const FILE_OP_TOOLS = new Set(["read_file", "readfile", "read", "file_read", "cat", "view"]);
const EDIT_TOOLS = new Set(["edit", "write", "applypatch", "str_replace", "update", "write_file", "editfile", "create_file"]);

function contentString(content: unknown): string {
  if (typeof content === "string") return content;
  try { return JSON.stringify(content ?? ""); } catch { return String(content); }
}

function extractFilePaths(content: string): string[] {
  const re = /\b(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|json|yaml|yml|md|sql|sh|tf|hcl)\b/g;
  return Array.from(new Set(content.match(re) ?? []));
}

function getToolName(msg: RetentionMessage): string {
  return (msg.name ?? "").toLowerCase();
}

function hasEditToolCalls(msg: RetentionMessage): boolean {
  if (!Array.isArray(msg.tool_calls)) return false;
  return msg.tool_calls.some((tc) => {
    const name = (tc.function?.name ?? tc.id ?? "").toLowerCase();
    return EDIT_TOOLS.has(name) || /edit|write|patch|replace|create/i.test(name);
  });
}

function hasToolCalls(msg: RetentionMessage): boolean {
  return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

// ── Classification ─────────────────────────────────────────────────────────

export function buildRetentionContext(
  messages: RetentionMessage[],
  activeFilePaths?: string[],
  planFilePaths?: string[],
): RetentionContext {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { lastUserIdx = i; break; }
  }

  const recentToolCount = 6;
  let toolsSeen = 0;
  let recentStart = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool" || messages[i].role === "tool_result") {
      toolsSeen++;
      if (toolsSeen >= recentToolCount) { recentStart = i; break; }
    }
  }

  return {
    totalMessageCount: messages.length,
    activeFilePaths: new Set(activeFilePaths ?? []),
    planFilePaths: new Set(planFilePaths ?? []),
    lastUserMessageIndex: lastUserIdx,
    recentWindowStart: Math.min(recentStart, lastUserIdx >= 0 ? lastUserIdx : messages.length),
  };
}

export function classifyMessages(
  messages: RetentionMessage[],
  ctx: RetentionContext,
): ClassifiedMessage[] {
  const result: ClassifiedMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const raw = contentString(msg.content);
    const tokens = estimateMessageTokens(msg as { role: string; content: unknown });
    const tags: string[] = [];
    let tier: MemoryTier;
    let score: number;

    // Tier classification
    if (msg.role === "system") {
      if (ENRICHMENT_RE.test(raw) && !raw.startsWith("<CONTEXT_CHECKPOINT")) {
        tier = "immutable";
      } else if (raw.startsWith("<CONTEXT_CHECKPOINT")) {
        tier = "historical";
      } else {
        tier = "immutable";
      }
    } else if (i >= ctx.recentWindowStart || i === ctx.lastUserMessageIndex) {
      tier = "working";
    } else if (msg.role === "tool" || msg.role === "tool_result") {
      const toolName = getToolName(msg);
      const isFile = FILE_OP_TOOLS.has(toolName);
      const paths = extractFilePaths(raw);
      const referencesActiveFile = paths.some((p) => ctx.activeFilePaths.has(p));
      const referencesPlan = paths.some((p) => ctx.planFilePaths.has(p)) || PLAN_FILE_RE.test(raw);

      if (referencesActiveFile || referencesPlan) {
        tier = "artifact_shadow";
        if (referencesActiveFile) tags.push("active_file");
        if (referencesPlan) tags.push("plan_content");
      } else if (isFile) {
        tier = "artifact_shadow";
        tags.push("stale_read");
      } else {
        tier = "historical";
      }
    } else if (msg.role === "assistant") {
      if (GOVERNOR_RECOVERY_RE.test(raw)) {
        tier = "working";
        tags.push("governor_guidance");
      } else if (hasEditToolCalls(msg)) {
        tier = "working";
        tags.push("state_change");
      } else if (hasToolCalls(msg)) {
        tier = "artifact_shadow";
      } else {
        tier = "historical";
        tags.push("narration");
      }
    } else if (msg.role === "user") {
      tier = "historical";
    } else {
      tier = "historical";
    }

    // Failure detection
    if ((msg.role === "tool" || msg.role === "tool_result") && looksLikeVerificationFailureOutput(raw)) {
      if (!VERIFICATION_PASS_RE.test(raw) || VERIFICATION_FAIL_RE.test(raw)) {
        tags.push("unresolved_failure");
        if (tier === "historical") tier = "working";
      }
    }

    // Retention scoring
    score = computeRetentionScore(i, msg, raw, tags, tier, ctx);

    result.push({ index: i, tier, retentionScore: score, estimatedTokens: tokens, tags });
  }

  return result;
}

function computeRetentionScore(
  index: number,
  msg: RetentionMessage,
  raw: string,
  tags: string[],
  tier: MemoryTier,
  ctx: RetentionContext,
): number {
  if (tier === "immutable") return 1.0;

  let score = 0.0;

  // Recency: exponential decay
  const distance = ctx.totalMessageCount - index;
  const recency = Math.exp(-distance / (ctx.totalMessageCount * 0.4));
  score += recency * 0.3;

  // Failure signal
  if (tags.includes("unresolved_failure")) score += 0.4;

  // Active file reference
  if (tags.includes("active_file")) score += 0.3;

  // Plan content
  if (tags.includes("plan_content")) score += 0.3;

  // Governor guidance
  if (tags.includes("governor_guidance")) score += 0.2;

  // State change (edit tool calls)
  if (tags.includes("state_change")) score += 0.2;

  // Narration penalty
  if (tags.includes("narration") && !hasToolCalls(msg) && raw.length > 200) {
    score -= 0.3;
  }

  // Working tier bonus
  if (tier === "working") score += 0.2;

  // Clamp
  score = Math.max(0, Math.min(1.0, score));

  // Floor for unresolved failures
  if (tags.includes("unresolved_failure") && score < 0.6) score = 0.6;

  return Number(score.toFixed(3));
}
