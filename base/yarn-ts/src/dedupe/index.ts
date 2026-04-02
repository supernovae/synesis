export type { DedupeLayerOptions, DedupePipelineResult, DedupeLogEvent, ExactDedupeResult } from "./types.js";
export { DedupeCache } from "./DedupeCache.js";
export { DedupeLayer } from "./DedupeLayer.js";
export { stripConsecutiveExactDuplicates, hashToolCall, patchCallsAreByteIdentical } from "./ToolCallDedupe.js";
export { applySegmentReadSearchDedupe, normalizeSearchQueryForSafety } from "./SemanticDedupe.js";
export { ResponseDedupe } from "./ResponseDedupe.js";
