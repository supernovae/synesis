/**
 * Prefix Optimizer Diagnostics
 *
 * Per-request logging with segment hashes, marker placement info,
 * token estimates, and cache miss reason analysis.
 */

import type { MarkerBackend, PrefixDiagnostics, ParsedSegment, SegmentCategory } from "./types.js";

export interface ProviderUsage {
  cached_tokens: number;
  cache_creation: number;
  prompt_tokens: number;
}

/**
 * Build diagnostics from parsed segments and marker placements.
 */
export function buildDiagnostics(
  segments: ParsedSegment[],
  markerIndices: number[],
  markerBackend: MarkerBackend,
  previousDiagnostics: PrefixDiagnostics | null,
): PrefixDiagnostics {
  const segmentSizes: Partial<Record<SegmentCategory, number>> = {};
  let totalTokenEstimate = 0;

  const hashByCategory: Partial<Record<SegmentCategory, string>> = {};

  for (const seg of segments) {
    segmentSizes[seg.category] = (segmentSizes[seg.category] ?? 0) + seg.tokenEstimate;
    totalTokenEstimate += seg.tokenEstimate;
    if (!hashByCategory[seg.category]) {
      hashByCategory[seg.category] = seg.hash;
    }
  }

  const diag: PrefixDiagnostics = {
    coreHash: hashByCategory.core_instructions ?? "",
    projectHash: hashByCategory.project_guidance ?? "",
    toolsetHash: hashByCategory.tool_definitions ?? "",
    frameHash: hashByCategory.task_frame ?? "",
    volatileHash: hashByCategory.live_context ?? "",
    userTurnHash: hashByCategory.latest_user_turn ?? "",
    markerBackend,
    markerCount: markerIndices.length,
    markerIndices,
    segmentSizes,
    cacheMissReason: diagnoseMissReason(hashByCategory, previousDiagnostics),
    totalTokenEstimate,
  };

  return diag;
}

/**
 * Compare current segment hashes against previous diagnostics to identify
 * which segment changed and would cause a cache miss.
 */
function diagnoseMissReason(
  currentHashes: Partial<Record<SegmentCategory, string>>,
  previous: PrefixDiagnostics | null,
): string | null {
  if (!previous) return "first_request";

  if (currentHashes.core_instructions && currentHashes.core_instructions !== previous.coreHash) {
    return "core_instructions_changed";
  }
  if (currentHashes.project_guidance && currentHashes.project_guidance !== previous.projectHash) {
    return "project_guidance_changed";
  }
  if (currentHashes.tool_definitions && currentHashes.tool_definitions !== previous.toolsetHash) {
    return "tools_changed";
  }
  if (currentHashes.task_frame && currentHashes.task_frame !== previous.frameHash) {
    return "frame_changed";
  }

  return null;
}

/**
 * Log prefix optimizer diagnostics to stdout in structured JSON format.
 */
export function logPrefixDiagnostics(
  current: PrefixDiagnostics,
  previous: PrefixDiagnostics | null,
  providerUsage: ProviderUsage | null,
): void {
  const entry: Record<string, unknown> = {
    level: 20,
    msg: "prefix_optimizer_diagnostics",
    backend: current.markerBackend,
    coreHash: current.coreHash,
    projectHash: current.projectHash,
    toolsetHash: current.toolsetHash,
    frameHash: current.frameHash,
    volatileHash: current.volatileHash,
    userTurnHash: current.userTurnHash,
    markerCount: current.markerCount,
    markerIndices: current.markerIndices,
    segmentSizes: current.segmentSizes,
    totalTokenEstimate: current.totalTokenEstimate,
    cacheMissReason: current.cacheMissReason,
  };

  if (previous) {
    entry.hashChanges = {
      core: current.coreHash !== previous.coreHash,
      project: current.projectHash !== previous.projectHash,
      tools: current.toolsetHash !== previous.toolsetHash,
      frame: current.frameHash !== previous.frameHash,
    };
  }

  if (providerUsage) {
    entry.providerCachedTokens = providerUsage.cached_tokens;
    entry.providerCacheCreation = providerUsage.cache_creation;
    entry.providerPromptTokens = providerUsage.prompt_tokens;
    if (providerUsage.prompt_tokens > 0) {
      entry.cacheHitRate = Number(
        ((providerUsage.cached_tokens / providerUsage.prompt_tokens) * 100).toFixed(1),
      );
    }
  }

  console.log(JSON.stringify(entry));
}

/**
 * Generate a human-readable debug report explaining cache miss causes.
 */
export function generateMissReport(
  current: PrefixDiagnostics,
  previous: PrefixDiagnostics | null,
): string {
  if (!previous) return "First request in session — cache creation expected.";

  const changes: string[] = [];

  if (current.coreHash !== previous.coreHash) {
    changes.push("Core instructions hash changed (system prompt base modified)");
  }
  if (current.projectHash !== previous.projectHash) {
    changes.push("Project guidance hash changed (CLAUDE.md/rules modified)");
  }
  if (current.toolsetHash !== previous.toolsetHash) {
    changes.push("Toolset hash changed (tool definitions added/removed/modified)");
  }
  if (current.frameHash !== previous.frameHash) {
    changes.push("Task frame hash changed (objective/phase/files shifted)");
  }

  if (changes.length === 0) {
    if (current.markerCount === 0) {
      return "No explicit markers placed — relying on implicit KV-cache from stable prefix layout.";
    }
    return "All stable segment hashes match previous request — cache hits expected.";
  }

  return `Cache miss likely because:\n${changes.map((c) => `  - ${c}`).join("\n")}`;
}
