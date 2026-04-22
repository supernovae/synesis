/**
 * Request Rebuilder
 *
 * Rebuilds the OpenAI messages array in cache-friendly canonical order:
 *   1. system — core_instructions (stable)
 *   2. system — project_guidance (stable)
 *   3. prior-turn messages in ORIGINAL order (conversation_history + tool_results interleaved)
 *   4. user — latest user turn (volatile)
 *   5. system — task_frame (semi-stable, changes per turn due to compactor)
 *   6. system — live_context (volatile)
 *
 * CRITICAL: task_frame is NOT in the stable prefix. The frame compactor
 * derives objective/nextAction/filesInPlay from conversation content which
 * changes every turn. Placing it in the stable prefix would make the
 * cache_control annotation position's content different each turn,
 * preventing DashScope from matching any cached prefix.
 *
 * The stable prefix (core + project_guidance) is small but guaranteed to
 * be byte-identical across turns. DashScope's explicit cache marker is
 * placed at the end of this prefix for reliable cache hits.
 *
 * conversation_history and tool_results are kept in their original
 * interleaved order (append-only across turns). The latest user turn
 * is intentionally placed before task_frame/live_context so a turn's
 * user request remains in the reusable prefix on the next append.
 */

import type { ChatMessage, ParsedSegment, SegmentCategory } from "./types.js";
import { canonicalizeMessage } from "./serializer.js";

const STABLE_SYSTEM_CATEGORIES: SegmentCategory[] = [
  "core_instructions",
  "project_guidance",
];

/**
 * Rebuild an optimized messages array from parsed segments
 * and the original messages.
 *
 * Stable system content leads. Conversation history preserves
 * original order. Volatile system content (task_frame + live_context)
 * trails the latest user turn.
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

  // 3. Latest user turn before frame/live_context. This keeps the
  //    prior turn's user request in the reusable prefix when the next
  //    assistant+user pair is appended.
  const userTurnSeg = segmentMap.get("latest_user_turn");
  if (userTurnSeg && userTurnSeg.sourceIndices.length > 0) {
    appendOriginalMessages(rebuilt, userTurnSeg.sourceIndices, originalMessages);
  }

  // 4. task_frame AFTER conversation and latest user — it changes every turn due to
  //    the frame compactor (objective, nextAction, filesInPlay derive
  //    from conversation content), so it must NOT be in the stable prefix.
  const frameSeg = segmentMap.get("task_frame");
  if (frameSeg && frameSeg.content.trim()) {
    rebuilt.push(canonicalizeMessage({ role: "system", content: frameSeg.content }));
  }

  // 5. live_context AFTER task_frame — it changes every turn
  const liveSeg = segmentMap.get("live_context");
  if (liveSeg && liveSeg.content.trim()) {
    rebuilt.push(canonicalizeMessage({ role: "system", content: liveSeg.content }));
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
