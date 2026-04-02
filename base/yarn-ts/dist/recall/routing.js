/**
 * Recall routing — decides between bypass, enrich, or passthrough
 * based on recall resolution confidence and configurable thresholds.
 */
import { resolveRecipes } from "./recipe-resolver.js";
import { formatEnrichmentBlock, formatSyntheticResponse } from "./formatter.js";
/**
 * Given enriched items from the reduction pipeline, decide the recall route.
 *
 * This is the core decision function that turns the Phase 6 language pack
 * metadata into runtime behavior.
 */
export function makeRecallDecision(items, bypassEligible, registry, config, validationFamily, stats) {
    if (!config.enabled || items.length === 0) {
        if (stats) {
            stats.passthroughCount++;
            stats.totalDecisions++;
        }
        return { routing: "passthrough", resolution: null, syntheticBlock: null, enrichmentBlock: null };
    }
    const resolution = resolveRecipes(items, registry, validationFamily);
    const lang = resolution.language ?? "unknown";
    if (stats) {
        stats.totalDecisions++;
        stats.totalConfidenceSum += resolution.confidence;
        const recipeHits = resolution.findings.filter((f) => f.recipe !== null).length;
        stats.recipeHitCount += recipeHits;
        stats.recipeMissCount += resolution.findings.length - recipeHits;
    }
    let routing;
    let syntheticBlock = null;
    let enrichmentBlock = null;
    if (bypassEligible && resolution.confidence >= config.bypassConfidenceThreshold) {
        routing = "bypass";
        syntheticBlock = formatSyntheticResponse(resolution);
        if (stats) {
            stats.bypassAttempts++;
            stats.bypassSuccesses++;
            const langStats = getOrCreateLangStats(stats, lang);
            langStats.bypasses++;
            stats.tokensSavedEstimate += estimateBypassTokenSavings(syntheticBlock);
        }
    }
    else if (resolution.confidence >= config.enrichConfidenceThreshold) {
        routing = "enrich";
        enrichmentBlock = formatEnrichmentBlock(resolution);
        if (stats) {
            stats.enrichAttempts++;
            if (enrichmentBlock.length > 0)
                stats.enrichSuccesses++;
            const langStats = getOrCreateLangStats(stats, lang);
            langStats.enrichments++;
        }
    }
    else {
        routing = "passthrough";
        if (stats) {
            stats.passthroughCount++;
            const langStats = getOrCreateLangStats(stats, lang);
            langStats.passthroughs++;
        }
    }
    return { routing, resolution, syntheticBlock, enrichmentBlock };
}
function getOrCreateLangStats(stats, lang) {
    if (!stats.byLanguage[lang]) {
        stats.byLanguage[lang] = { bypasses: 0, enrichments: 0, passthroughs: 0 };
    }
    return stats.byLanguage[lang];
}
function estimateBypassTokenSavings(syntheticBlock) {
    // Rough estimate: a typical LLM round-trip for a tool result is ~500-2000 tokens.
    // The synthetic block is much shorter. Estimate savings conservatively.
    const syntheticTokens = Math.ceil(syntheticBlock.length / 4);
    const estimatedLlmRoundTrip = 1200;
    return Math.max(0, estimatedLlmRoundTrip - syntheticTokens);
}
