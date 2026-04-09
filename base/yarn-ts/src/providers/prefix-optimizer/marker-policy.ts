/**
 * Cache Marker Policy
 *
 * Computes explicit cache marker placements for providers that support them.
 * This is the only provider-specific component in the prefix optimizer.
 * The rest of the optimizer is provider-agnostic.
 *
 * Strategy — FIXED-POSITION markers:
 *
 *   DashScope's cache_control annotation becomes part of the serialized
 *   message bytes. When a marker moves (e.g., from msg[120] to msg[125]),
 *   the old position loses its cache_control, changing the bytes at that
 *   position and preventing DashScope from matching the cached prefix.
 *
 *   Fix: place markers at FIXED positions that NEVER change across turns.
 *   The rebuilt message layout is:
 *     [system: core_instructions] [system: project_guidance] [system: task_frame]
 *     [prior-turn messages...] [system: live_context] [user: latest turn]
 *
 *   Marker 1 (fixed): end of stable system messages (last system msg
 *     before conversation history). This caches the system prompt prefix
 *     which is identical every turn → guaranteed cache hit.
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
 * Find the last stable system message index: the end of the system
 * prefix before conversation history begins.
 *
 * In the rebuilt layout:
 *   [system: core] [system: project] [system: frame] [conversation...] [system: live] [user]
 *
 * We want the index of the LAST leading system message (before the first
 * non-system message). This position never changes across turns because
 * the stable system categories are always emitted first.
 */
function findStableSystemEnd(messages: ChatMessage[]): number {
  let lastSystemIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "system") {
      lastSystemIdx = i;
    } else {
      break;
    }
  }
  return lastSystemIdx;
}

/**
 * Compute marker placements for DashScope explicit caching.
 *
 * Uses a single fixed-position marker at the end of the stable system
 * prefix. This position is byte-identical across turns, ensuring
 * DashScope always matches the cached prefix.
 */
function computeDashScopeMarkers(
  messages: ChatMessage[],
  _segments: ParsedSegment[],
  _previousDiagnostics: PrefixDiagnostics | null,
  maxMarkers: number,
): number[] {
  const limit = Math.min(maxMarkers, DASHSCOPE_MAX_MARKERS);
  if (limit <= 0) return [];

  const systemEnd = findStableSystemEnd(messages);
  if (systemEnd < 0) return [];

  let totalTokens = 0;
  for (let i = 0; i <= systemEnd; i++) {
    totalTokens += estimateTokens(messageText(messages[i]));
  }
  if (totalTokens < DASHSCOPE_MIN_TOKENS) return [];

  return [systemEnd];
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
