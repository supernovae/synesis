/**
 * Cache Marker Policy
 *
 * Computes explicit cache marker placements for providers that support them.
 * This is the only provider-specific component in the prefix optimizer.
 * The rest of the optimizer is provider-agnostic.
 *
 * DashScope: up to 4 markers, min 1024 tokens before each marker
 * Anthropic: providerOptions.anthropic.cacheControl (future)
 * None: empty array (implicit KV-cache from stable-first layout)
 */

import type { ChatMessage, MarkerBackend, ParsedSegment, PrefixDiagnostics, SegmentCategory } from "./types.js";

const DASHSCOPE_MAX_MARKERS = 4;
const DASHSCOPE_MIN_TOKENS = 1024;

const CACHEABLE_CATEGORIES: Set<SegmentCategory> = new Set([
  "core_instructions",
  "project_guidance",
  "task_frame",
]);

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
 * The request-rebuilder creates system messages in order:
 * core_instructions, project_guidance, task_frame, live_context.
 * This finds the message index for a given category by scanning the rebuilt array.
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
 * Compute marker placements for DashScope explicit caching.
 */
function computeDashScopeMarkers(
  messages: ChatMessage[],
  segments: ParsedSegment[],
  previousDiagnostics: PrefixDiagnostics | null,
  maxMarkers: number,
): number[] {
  const limit = Math.min(maxMarkers, DASHSCOPE_MAX_MARKERS);
  const markers: number[] = [];

  let cumulativeTokens = 0;

  const coreIdx = findMessageIndexForCategory(messages, segments, "core_instructions");
  if (coreIdx >= 0) {
    cumulativeTokens += estimateTokens(messageText(messages[coreIdx]));
    if (cumulativeTokens >= DASHSCOPE_MIN_TOKENS) {
      markers.push(coreIdx);
    }
  }

  if (markers.length >= limit) return markers;

  const projectIdx = findMessageIndexForCategory(messages, segments, "project_guidance");
  if (projectIdx >= 0) {
    cumulativeTokens += estimateTokens(messageText(messages[projectIdx]));
    if (cumulativeTokens >= DASHSCOPE_MIN_TOKENS) {
      markers.push(projectIdx);
    }
  }

  if (markers.length >= limit) return markers;

  const frameSeg = segments.find((s) => s.category === "task_frame");
  if (frameSeg && frameSeg.content.trim()) {
    const frameIdx = findMessageIndexForCategory(messages, segments, "task_frame");
    if (frameIdx >= 0) {
      const frameUnchanged = previousDiagnostics !== null &&
        previousDiagnostics.frameHash === frameSeg.hash;
      if (frameUnchanged) {
        cumulativeTokens += estimateTokens(messageText(messages[frameIdx]));
        if (cumulativeTokens >= DASHSCOPE_MIN_TOKENS) {
          markers.push(frameIdx);
        }
      }
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
      // Future: Anthropic uses providerOptions, not content-block markers.
      // For now, same logic as DashScope but the interceptor would use
      // a different injection mechanism.
      return computeDashScopeMarkers(messages, segments, previousDiagnostics, maxMarkers);
    case "none":
      return [];
  }
}
