/**
 * Cache Marker Policy
 *
 * Computes explicit cache marker placements for providers that support them.
 * This is the only provider-specific component in the prefix optimizer.
 * The rest of the optimizer is provider-agnostic.
 *
 * Strategy — single conversation-boundary marker:
 *
 *   DashScope searches backward up to 20 content blocks from each marker.
 *   With 400+ messages, a marker at index 0 and another at ~406 are
 *   separated by far more than 20 blocks — the first marker's cache can
 *   never be found from the second marker.  Keeping TWO distant markers
 *   means DashScope re-creates 100% of tokens every turn.
 *
 *   Instead we use a SINGLE marker at the conversation boundary (last
 *   message before the latest user turn).  Each turn appends only a few
 *   messages, so the previous turn's boundary is always within 20 blocks
 *   of the new boundary.  DashScope finds the prior cache and creates
 *   only the increment, giving 80-95% cache hit rates.
 *
 *   The interceptor also marks the last tool definition (separate from
 *   message markers), as required by DashScope for tool-schema caching.
 *
 * DashScope constraints:
 *   - Max 4 markers per request (we use 1 message + 1 tool = 2)
 *   - Min 1024 tokens per cache block
 *   - Backward search limit: 20 content blocks from each marker
 *   - Cache valid for 5 minutes (resets on hit)
 */

import type { ChatMessage, MarkerBackend, ParsedSegment, PrefixDiagnostics } from "./types.js";

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
 * Find the conversation boundary: the last prior-turn message.
 *
 * In the rebuilt message array, the layout is:
 *   [stable-system...] [prior-turn messages...] [live_context(system)] [latest_user_turn]
 *
 * The boundary is the last non-system message before live_context and
 * the user turn. This is the end of the stable, append-only prefix.
 * Each turn appends a few messages here; the previous boundary is
 * always within DashScope's 20-block search window.
 */
function findConversationBoundary(
  messages: ChatMessage[],
  _segments: ParsedSegment[],
): number {
  if (messages.length < 3) return -1;

  // Walk backward from the end: skip user turn(s) and any trailing
  // system messages (live_context). The boundary is the first
  // non-system message we hit going backward.
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "user" || role === "system") continue;
    return i;
  }
  return -1;
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
  if (limit <= 0) return [];

  const boundaryIdx = findConversationBoundary(messages, segments);
  if (boundaryIdx < 0) return [];

  let totalTokens = 0;
  for (let i = 0; i <= boundaryIdx; i++) {
    totalTokens += estimateTokens(messageText(messages[i]));
  }
  if (totalTokens < DASHSCOPE_MIN_TOKENS) return [];

  return [boundaryIdx];
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
