export function createEmptyVerificationStats() {
    return {
        loopsStarted: 0,
        loopsCompleted: 0,
        totalRounds: 0,
        totalFindingsDetected: 0,
        totalFindingsResolved: 0,
        selfRepairSuggestions: 0,
        stallCount: 0,
        budgetExhaustions: 0,
        byLanguage: {},
    };
}
