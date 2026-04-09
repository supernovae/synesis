/**
 * Cache Marker Policy
 *
 * Computes explicit cache marker placements for providers that support them.
 * This is the only provider-specific component in the prefix optimizer.
 * The rest of the optimizer is provider-agnostic.
 *
 * Strategy for multi-turn coding sessions:
 *   Marker 1: core_instructions (stable forever, ~300 tokens)
 *   Marker 2: conversation boundary — last message before the latest user turn
 *             This is the BIG win. Each turn appends a few messages at the end.
 *             The entire prefix up to the previous turn's last message is
 *             identical, so caching here gives 80-90% hit rates.
 *   Marker 3 (tool-level): added by the interceptor on the last tool definition
 *
 * DashScope constraints:
 *   - Max 4 markers per request
 *   - Min 1024 tokens per cache block
 *   - Cache searches backward up to 20 content blocks from each marker
 *   - Cache valid for 5 minutes (resets on hit)
 *
 * The 20-block limit means the conversation boundary marker works as long as
 * each turn adds fewer than 20 messages. Typical tool-calling turns add 2-4
 * messages (assistant + tool_result pairs), so this is well within limits.
 */

import type { ChatMessage, MarkerBackend, ParsedSegment, PrefixDiagnostics, SegmentCategory } from "./types.js";

const DASHSCOPE_MAX_MARKERS = 4;
const DASHSCOPE_MIN_TOKENS = 1024;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function messageText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((b) => (typeof b.text === "string" ? b.text : "")).join("\n");
  }
  return String(msg.content ?? "");
}

/**
 * Find which rebuilt message index corresponds to a given segment category.
 */
function findMessageIndexForCategory(
  messages: ChatMessage[],
  segments: ParsedSegment[],
  category: SegmentCategory,
): number {
  const segment = segments.find((s) => s.category === category);
  if (!segment || !segment.content.trim()) return -1;

  let systemIdx = 0;
  const categoryOrder: SegmentCategory[] = [
    "core_instructions", "project_guidance", "task_frame", "live_context",
  ];

  for (const cat of categoryOrder) {
    if (cat === category) break;
    const seg = segments.find((s) => s.category === cat);
    if (seg && seg.content.trim()) systemIdx++;
  }

  if (systemIdx < messages.length && messages[systemIdx]?.role === "system") {
    return systemIdx;
  }
  return -1;
}

/**
 * Find the conversation boundary: the last message before latest_user_turn.
 *
 * In the rebuilt message array, the layout is:
 *   [system...] [conversation_history...] [tool_results...] [latest_user_turn]
 *
 * The boundary is the index of the last message that ISN'T the latest user turn.
 * Caching up to this point means the entire conversation prefix from prior turns
 * gets cached, which is the biggest win (~80-90% of tokens).
 */
function findConversationBoundary(
  messages: ChatMessage[],
  segments: ParsedSegment[],
): number {
  const userTurnSeg = segments.find((s) => s.category === "latest_user_turn");
  if (!userTurnSeg || userTurnSeg.sourceIndices.length === 0) return -1;
  if (messages.length < 3) return -1;

  // The latest_user_turn is always last in the rebuilt array.
  // The conversation boundary is the message right before it.
  const boundaryIdx = messages.length - 2;

  // Sanity: don't mark a system message as boundary (that's just the prefix)
  if (messages[boundaryIdx]?.role === "system") return -1;

  return boundaryIdx;
}

/**
 * Compute marker placements for DashScope explicit caching.
 */
function computeDashScopeMarkers(
  messages: ChatMessage[],
  segments: ParsedSegment[],
  _previousDiagnostics: PrefixDiagnostics | null,
  maxMarkers: number,
): number[] {
  const limit = Math.min(maxMarkers, DASHSCOPE_MAX_MARKERS);
  const markers: number[] = [];

  // Marker 1: core_instructions (stable forever)
  let cumulativeTokens = 0;
  const coreIdx = findMessageIndexForCategory(messages, segments, "core_instructions");
  if (coreIdx >= 0) {
    cumulativeTokens += estimateTokens(messageText(messages[coreIdx]));
    if (cumulativeTokens >= DASHSCOPE_MIN_TOKENS) {
      markers.push(coreIdx);
    }
  }

  if (markers.length >= limit) return markers;

  // Marker 2: conversation boundary (last message before latest user turn)
  // This is the high-value marker — caches the entire prior-turn prefix.
  const boundaryIdx = findConversationBoundary(messages, segments);
  if (boundaryIdx >= 0 && boundaryIdx > (markers[markers.length - 1] ?? -1)) {
    let boundaryTokens = 0;
    for (let i = 0; i <= boundaryIdx; i++) {
      boundaryTokens += estimateTokens(messageText(messages[i]));
    }
    if (boundaryTokens >= DASHSCOPE_MIN_TOKENS) {
      markers.push(boundaryIdx);
    }
  }

  return markers;
}

/**
 * Compute cache marker placements based on stability classification,
 * previous diagnostics, and provider backend.
 *
 * Returns message indices where markers should be placed.
 */
export function computeMarkerPlacements(
  messages: ChatMessage[],
  segments: ParsedSegment[],
  previousDiagnostics: PrefixDiagnostics | null,
  backend: MarkerBackend,
  maxMarkers = 3,
): number[] {
  switch (backend) {
    case "dashscope":
      return computeDashScopeMarkers(messages, segments, previousDiagnostics, maxMarkers);
    case "anthropic":
      return computeDashScopeMarkers(messages, segments, previousDiagnostics, maxMarkers);
    case "none":
      return [];
  }
}
