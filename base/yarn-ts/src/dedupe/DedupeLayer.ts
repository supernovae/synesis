import { collapseToolCallsLinear } from "../tool-collapse/tool-call-collapser.js";
import type { CollapseLogEntry } from "../tool-collapse/types.js";
import type { ParsedToolCall } from "../tool-collapse/types.js";
import { DedupeCache } from "./DedupeCache.js";
import type { DedupeLayerOptions, DedupePipelineResult } from "./types.js";
import { applySegmentReadSearchDedupe } from "./SemanticDedupe.js";
import { stripConsecutiveExactDuplicates } from "./ToolCallDedupe.js";
import { ResponseDedupe } from "./ResponseDedupe.js";

/**
 * Ordered pipeline (matches intended agent runtime flow):
 * 1. Exact consecutive duplicate tool calls (hash name + stable args)
 * 2. Segment-scoped interleaved read/search dedupe (shared with tool-collapse prepass)
 * 3. Linear collapse / batching ([`collapseToolCallsLinear`](../tool-collapse/tool-call-collapser.ts))
 *
 * Prefix cache: stable tool order + reduced call count improves implicit cache hits upstream.
 * Response shortening: use [`ResponseDedupe`] after execution with the same [`DedupeCache`] instance.
 */
export class DedupeLayer {
  readonly cache: DedupeCache;
  readonly responseDedupe: ResponseDedupe;
  private readonly opts: DedupeLayerOptions;

  constructor(opts: DedupeLayerOptions) {
    this.opts = opts;
    this.cache = new DedupeCache(opts.maxCacheEntries);
    this.responseDedupe = new ResponseDedupe(this.cache, { log: opts.log });
  }

  run(calls: ParsedToolCall[], originalIncomingCount = calls.length): DedupePipelineResult {
    const log: CollapseLogEntry[] = [];

    const exact = stripConsecutiveExactDuplicates(calls, log, this.opts.log);
    const seg = applySegmentReadSearchDedupe(exact.calls, log, this.opts.log);
    const plan = collapseToolCallsLinear(seg.calls, log, originalIncomingCount);

    return {
      plan,
      exactDuplicateOf: exact.duplicateOf,
      droppedExactIds: exact.droppedIds,
      segmentDroppedReadIds: seg.droppedReadIds,
      segmentDroppedSearchIds: seg.droppedSearchIds,
    };
  }
}
