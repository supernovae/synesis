import type { CollapsePlan, ParsedToolCall } from "../tool-collapse/types.js";

export type DedupeLogKind =
  | "exact_duplicate_tool_call"
  | "semantic_segment_dedupe"
  | "response_cached_stub"
  | "patch_duplicate_skipped";

export interface DedupeLogEvent {
  kind: DedupeLogKind;
  message: string;
  toolCallIds?: string[];
  detail?: string;
}

export interface DedupeLayerOptions {
  /** Max entries per LRU bucket */
  maxCacheEntries: number;
  /** Max search query length (regex / token DoS guard) */
  maxSearchQueryChars: number;
  log?: (e: DedupeLogEvent) => void;
}

export interface ExactDedupeResult {
  calls: ParsedToolCall[];
  /** duplicateId -> canonicalId (first kept call) */
  duplicateOf: Map<string, string>;
  droppedIds: string[];
}

export interface DedupePipelineResult {
  plan: CollapsePlan;
  exactDuplicateOf: Map<string, string>;
  droppedExactIds: string[];
  segmentDroppedReadIds: string[];
  segmentDroppedSearchIds: string[];
}
