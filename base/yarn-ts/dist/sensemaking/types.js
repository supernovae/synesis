/**
 * Sensemaking and Exploration Engine types.
 *
 * Implements the Known / Unknown / KnowBetter framework from M11 theory,
 * structured exploration plans with future-backward reasoning, and
 * telemetry counters for the sensemaking subsystem.
 */
export function createEmptySensemakingStats() {
    return {
        triggeredCount: 0,
        skippedCount: 0,
        byReason: {},
        totalGapsClassified: 0,
        knownCount: 0,
        unknownCount: 0,
        knowBetterCount: 0,
        plansGenerated: 0,
        actionsGenerated: 0,
    };
}
