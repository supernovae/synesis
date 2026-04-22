/**
 * Historical Content Normalizer
 *
 * For messages OUTSIDE the recent keep window (already subject to pruning),
 * replaces volatile content that breaks upstream KV-cache prefix matching.
 *
 * This is explicitly lossy for old context but preserves exact content for
 * recent turns. The model has already processed these old messages — the only
 * consumer of the exact bytes is the upstream KV cache.
 *
 * Normalization passes:
 *  1. ISO timestamps → [TIMESTAMP]
 *  2. Home-dir absolute paths → ~ prefix
 *  3. Consecutive blank lines → single blank
 *  4. Tool-call ID stabilization (separate function, called from transcript pruning)
 */

interface MessageLike {
  role: string;
  tool_call_id?: string;
  content: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

export interface HistoricalNormalizerStats {
  messagesNormalized: number;
  timestampsReplaced: number;
  pathsNormalized: number;
  blankLinesCollapsed: number;
  toolIdsRewritten: number;
}

export interface HistoricalNormalizerResult {
  messages: MessageLike[];
  stats: HistoricalNormalizerStats;
}

// ISO-8601 timestamps: 2026-04-18T15:32:01Z, 2026-04-18T15:32:01.123Z, 2026-04-18 15:32:01
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

// Unix epoch millis in JSON (13-digit number as value)
const EPOCH_MILLIS_RE = /(?<="(?:timestamp|created_at|updated_at|time|date|ts)":\s*)\d{13}/g;

// Home directory paths
const HOME_PATH_RE = /\/(?:Users|home)\/[a-zA-Z0-9._-]+\//g;

// Consecutive blank lines (3+ newlines → 2)
const CONSECUTIVE_BLANKS_RE = /\n{3,}/g;

/**
 * Normalize volatile content in old messages for prefix cache stability.
 *
 * @param keepFromIndex Messages at or after this index are left untouched (recent window).
 * @param homeDir Optional home directory prefix for path normalization (e.g. "/Users/alice").
 */
export function normalizeHistoricalContent(
  messages: MessageLike[],
  keepFromIndex: number,
  homeDir?: string,
): HistoricalNormalizerResult {
  const stats: HistoricalNormalizerStats = {
    messagesNormalized: 0,
    timestampsReplaced: 0,
    pathsNormalized: 0,
    blankLinesCollapsed: 0,
    toolIdsRewritten: 0,
  };

  const result: MessageLike[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (i >= keepFromIndex || typeof m.content !== "string" || m.role === "system") {
      result.push(m);
      continue;
    }

    let content = m.content;
    let changed = false;

    // Timestamps
    const tsMatches = content.match(ISO_TIMESTAMP_RE);
    if (tsMatches && tsMatches.length > 0) {
      content = content.replace(ISO_TIMESTAMP_RE, "[TIMESTAMP]");
      stats.timestampsReplaced += tsMatches.length;
      changed = true;
    }

    const epochMatches = content.match(EPOCH_MILLIS_RE);
    if (epochMatches && epochMatches.length > 0) {
      content = content.replace(EPOCH_MILLIS_RE, "0");
      stats.timestampsReplaced += epochMatches.length;
      changed = true;
    }

    // Home directory paths
    if (homeDir) {
      const homePrefixRe = new RegExp(escapeRegex(homeDir) + "/", "g");
      const homeMatches = content.match(homePrefixRe);
      if (homeMatches && homeMatches.length > 0) {
        content = content.replace(homePrefixRe, "~/");
        stats.pathsNormalized += homeMatches.length;
        changed = true;
      }
    } else {
      const genericMatches = content.match(HOME_PATH_RE);
      if (genericMatches && genericMatches.length > 0) {
        content = content.replace(HOME_PATH_RE, "~/");
        stats.pathsNormalized += genericMatches.length;
        changed = true;
      }
    }

    // Consecutive blank lines
    if (CONSECUTIVE_BLANKS_RE.test(content)) {
      CONSECUTIVE_BLANKS_RE.lastIndex = 0;
      content = content.replace(CONSECUTIVE_BLANKS_RE, "\n\n");
      stats.blankLinesCollapsed += 1;
      changed = true;
    }

    if (changed) {
      stats.messagesNormalized += 1;
      result.push({ ...m, content });
    } else {
      result.push(m);
    }
  }

  return { messages: result, stats };
}

/**
 * Rewrite provider-generated tool-call IDs to deterministic values for messages
 * outside the recent keep window. Both assistant tool_calls[].id and the matching
 * tool message tool_call_id are rewritten together.
 *
 * Safe because tool-call IDs are only used for matching within the same
 * conversation — they have no external meaning.
 *
 * @param keepFromIndex Messages at or after this index are left untouched.
 */
export function stabilizeToolCallIds(
  messages: MessageLike[],
  keepFromIndex: number,
): { messages: MessageLike[]; rewriteCount: number } {
  // First pass: build the ID rewrite map from old assistant messages.
  const idMap = new Map<string, string>();
  let turnIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") turnIndex += 1;
    if (i >= keepFromIndex) break;
    if (m.role === "assistant" && m.tool_calls) {
      for (let j = 0; j < m.tool_calls.length; j++) {
        const tc = m.tool_calls[j];
        if (tc.id && !idMap.has(tc.id)) {
          idMap.set(tc.id, `tc_${turnIndex}_${j}`);
        }
      }
    }
  }

  if (idMap.size === 0) return { messages, rewriteCount: 0 };

  // Second pass: rewrite IDs.
  // Tool call IDs in assistant messages are only rewritten before keepFromIndex,
  // but tool_call_id references in tool-result messages are ALWAYS rewritten
  // to prevent orphaned tool calls across the keepFromIndex boundary.
  let rewriteCount = 0;
  const result: MessageLike[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    let changed = false;
    let newToolCalls = m.tool_calls;
    let newToolCallId = m.tool_call_id;

    if (i < keepFromIndex && m.role === "assistant" && m.tool_calls) {
      const rewritten = m.tool_calls.map((tc) => {
        const newId = tc.id ? idMap.get(tc.id) : undefined;
        if (newId && newId !== tc.id) {
          changed = true;
          rewriteCount += 1;
          return { ...tc, id: newId };
        }
        return tc;
      });
      if (changed) newToolCalls = rewritten;
    }

    if (m.tool_call_id) {
      const newId = idMap.get(m.tool_call_id);
      if (newId && newId !== m.tool_call_id) {
        newToolCallId = newId;
        changed = true;
        rewriteCount += 1;
      }
    }

    if (changed) {
      result.push({ ...m, tool_calls: newToolCalls, tool_call_id: newToolCallId });
    } else {
      result.push(m);
    }
  }

  return { messages: result, rewriteCount };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
