import { dedupeReadsAndSearchesWithinSegments } from "../tool-collapse/tool-call-collapser.js";
import { z } from "zod";
/**
 * Normalize search query for safety (length) and light canonicalization.
 * We do **not** merge "foo" vs "function foo" (different semantics) — only validate + trim.
 */
export function normalizeSearchQueryForSafety(raw, maxChars) {
    const t = raw.trim().replace(/\s+/g, " ");
    const capped = t.length > maxChars ? t.slice(0, maxChars) : t;
    z.string().max(maxChars).parse(capped);
    return capped;
}
/**
 * Interleaved duplicate reads/searches within safe segments (same as tool-collapse prepass).
 * Invoked from DedupeLayer so collapseToolCallsLinear does not repeat this step.
 */
export function applySegmentReadSearchDedupe(calls, log, emit) {
    const r = dedupeReadsAndSearchesWithinSegments(calls);
    const n = r.droppedReadIds.length + r.droppedSearchIds.length;
    if (n > 0) {
        emit?.({
            kind: "semantic_segment_dedupe",
            message: "dedupe: semantic segment dedupe (interleaved read/search)",
            toolCallIds: [...r.droppedReadIds, ...r.droppedSearchIds],
        });
        log.push({
            phase: "collapse",
            detail: `dedupe_segment: dropped ${r.droppedReadIds.length} read(s), ${r.droppedSearchIds.length} search(es)`,
            atMs: Date.now(),
            originalIds: [...r.droppedReadIds, ...r.droppedSearchIds],
        });
    }
    return {
        calls: r.calls,
        droppedReadIds: r.droppedReadIds,
        droppedSearchIds: r.droppedSearchIds,
    };
}
