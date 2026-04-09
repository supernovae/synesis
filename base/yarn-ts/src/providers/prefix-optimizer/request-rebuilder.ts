/**
 * Request Rebuilder
 *
 * Rebuilds the OpenAI messages array in cache-friendly canonical order:
 *   1. system — core_instructions (stable)
 *   2. system — project_guidance (stable)
 *   3. system — task_frame (semi-stable)
 *   4. system — live_context (volatile)
 *   5. conversation history — prior turns (volatile, reduced)
 *   6. user — latest user turn (volatile)
 *
 * Messages 1-2 are stable across turns and accumulate KV-cache.
 * Message 3 is semi-stable (cacheable when frame unchanged).
 * Messages 4+ are volatile and never explicitly cached.
 */

import type { ChatMessage, ParsedSegment, SegmentCategory } from "./types.js";
import { canonicalizeMessage } from "./serializer.js";

/**
 * Canonical ordering of segment categories.
 * This is the heart of the prefix optimizer: stable content first, volatile last.
 */
const CATEGORY_ORDER: SegmentCategory[] = [
  "core_instructions",
  "project_guidance",
  "task_frame",
  "live_context",
  "conversation_history",
  "tool_results",
  "latest_user_turn",
];

/**
 * Rebuild an optimized messages array from parsed segments
 * and the original messages.
 *
 * The key insight: system message content is split across multiple
 * new system messages ordered by stability. Conversation history
 * and tool results retain their original structure (role, tool_call_id, etc.)
 * but are placed after the stable prefix.
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

  for (const category of CATEGORY_ORDER) {
    const segment = segmentMap.get(category);
    if (!segment || !segment.content.trim()) continue;

    switch (category) {
      case "core_instructions":
      case "project_guidance":
      case "task_frame":
      case "live_context":
        rebuilt.push(canonicalizeMessage({ role: "system", content: segment.content }));
        break;

      case "conversation_history":
      case "tool_results":
        appendOriginalMessages(rebuilt, segment.sourceIndices, originalMessages);
        break;

      case "latest_user_turn":
        appendOriginalMessages(rebuilt, segment.sourceIndices, originalMessages);
        break;
    }
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
