/**
 * Request Rebuilder
 *
 * Rebuilds the OpenAI messages array in cache-friendly canonical order:
 *   1. system — core_instructions (stable)
 *   2. system — project_guidance (stable)
 *   3. system — task_frame (semi-stable)
 *   4. system — live_context (volatile)
 *   5. prior-turn messages in ORIGINAL order (conversation_history + tool_results interleaved)
 *   6. user — latest user turn (volatile)
 *
 * CRITICAL for prefix caching: conversation_history and tool_results are
 * kept in their original interleaved order. If we separated them into
 * distinct groups, inserting new messages would shift the prefix —
 * DashScope (and any KV-cache) requires byte-identical prefixes to hit.
 */

import type { ChatMessage, ParsedSegment, SegmentCategory } from "./types.js";
import { canonicalizeMessage } from "./serializer.js";

const SYSTEM_CATEGORIES: SegmentCategory[] = [
  "core_instructions",
  "project_guidance",
  "task_frame",
  "live_context",
];

/**
 * Rebuild an optimized messages array from parsed segments
 * and the original messages.
 *
 * System message content is split into new system messages ordered by
 * stability. Conversation history and tool results are appended in
 * their ORIGINAL message order (preserving the prefix for caching).
 * Latest user turn is always last.
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

  // 1. Emit system messages in stability order
  for (const category of SYSTEM_CATEGORIES) {
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

  // 3. Latest user turn last
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
