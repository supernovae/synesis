export function createEmptyRecallStats() {
    return {
        bypassAttempts: 0,
        bypassSuccesses: 0,
        enrichAttempts: 0,
        enrichSuccesses: 0,
        passthroughCount: 0,
        totalConfidenceSum: 0,
        totalDecisions: 0,
        recipeHitCount: 0,
        recipeMissCount: 0,
        tokensSavedEstimate: 0,
        byLanguage: {},
    };
}
