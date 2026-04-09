/**
 * Request Rebuilder
 *
 * Rebuilds the OpenAI messages array in cache-friendly canonical order:
 *   1. system — core_instructions (stable)
 *   2. system — project_guidance (stable)
 *   3. system — task_frame (semi-stable)
 *   4. prior-turn messages in ORIGINAL order (conversation_history + tool_results interleaved)
 *   5. system — live_context (volatile) ← AFTER conversation, before user turn
 *   6. user — latest user turn (volatile)
 *
 * CRITICAL for prefix caching: live_context (timestamps, open files, cwd)
 * changes every turn. Placing it AFTER the stable conversation history
 * means the prefix from [0] through the last prior-turn message is
 * byte-identical across turns — the only thing DashScope's prefix cache
 * needs to match.
 *
 * conversation_history and tool_results are kept in their original
 * interleaved order (append-only across turns).
 */

import type { ChatMessage, ParsedSegment, SegmentCategory } from "./types.js";
import { canonicalizeMessage } from "./serializer.js";

const STABLE_SYSTEM_CATEGORIES: SegmentCategory[] = [
  "core_instructions",
  "project_guidance",
  "task_frame",
];

/**
 * Rebuild an optimized messages array from parsed segments
 * and the original messages.
 *
 * Stable system content leads. Conversation history preserves
 * original order. Volatile content (live_context + user turn) is last.
 */
export function rebuildRequest(
  segments: ParsedSegment[],
  originalMessages: ChatMessage[],
): ChatMessage[] {
  const segmentMap = new Map<SegmentCategory, ParsedSegment>();
  for (const seg of segments) {
    if (!segmentMap.has(seg.category)) {
      segmentMap.set(seg.category, seg);
    }
  }

  const rebuilt: ChatMessage[] = [];

  // 1. Stable system messages first (these never change between turns)
  for (const category of STABLE_SYSTEM_CATEGORIES) {
    const segment = segmentMap.get(category);
    if (segment && segment.content.trim()) {
      rebuilt.push(canonicalizeMessage({ role: "system", content: segment.content }));
    }
  }

  // 2. Merge conversation_history + tool_results source indices and sort
  //    by original position. This preserves the interleaved order from
  //    the client (assistant → tool_call → tool_result → assistant → ...),
  //    ensuring the prefix is append-only across turns.
  const priorTurnIndices = new Set<number>();
  for (const cat of ["conversation_history", "tool_results"] as SegmentCategory[]) {
    const seg = segmentMap.get(cat);
    if (seg) {
      for (const idx of seg.sourceIndices) priorTurnIndices.add(idx);
    }
  }
  const sortedPriorIndices = [...priorTurnIndices].sort((a, b) => a - b);
  appendOriginalMessages(rebuilt, sortedPriorIndices, originalMessages);

  // 3. live_context AFTER conversation history — it changes every turn
  //    so it must not be part of the cacheable prefix
  const liveSeg = segmentMap.get("live_context");
  if (liveSeg && liveSeg.content.trim()) {
    rebuilt.push(canonicalizeMessage({ role: "system", content: liveSeg.content }));
  }

  // 4. Latest user turn last
  const userTurnSeg = segmentMap.get("latest_user_turn");
  if (userTurnSeg && userTurnSeg.sourceIndices.length > 0) {
    appendOriginalMessages(rebuilt, userTurnSeg.sourceIndices, originalMessages);
  }

  return rebuilt;
}

/**
 * Append original messages by their source indices, preserving
 * their full structure (role, tool_call_id, tool_calls, etc.).
 * Messages are canonicalized for deterministic serialization.
 */
function appendOriginalMessages(
  target: ChatMessage[],
  indices: number[],
  originalMessages: ChatMessage[],
): void {
  for (const idx of indices) {
    if (idx >= 0 && idx < originalMessages.length) {
      target.push(canonicalizeMessage(originalMessages[idx]));
    }
  }
}

/**
 * Count system messages in the rebuilt array.
 * Useful for understanding the stable prefix boundary.
 */
export function countSystemPrefix(messages: ChatMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role === "system") count++;
    else break;
  }
  return count;
}
