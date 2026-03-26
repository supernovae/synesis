import { maskVerboseLog } from "./log-mask.js";
import { EXTENSION_HEURISTICS } from "./heuristics.js";
export class SawtoothContextManager {
    checkpointToolCalls;
    constructor(checkpointToolCalls = 12) {
        this.checkpointToolCalls = checkpointToolCalls;
    }
    shouldCheckpoint(history, toolCallsSinceCheckpoint) {
        if (toolCallsSinceCheckpoint >= this.checkpointToolCalls) {
            return true;
        }
        return history.length >= 60;
    }
    getLanguageHeuristics(ext) {
        return EXTENSION_HEURISTICS[ext] ?? { extension: ext, maxInlineLogLines: 60 };
    }
    async compressTrajectory(messages) {
        const recent = messages.slice(-20).map((m) => `${m.role}: ${maskVerboseLog(m.content)}`);
        const summary = [
            "<ARCHITECTURAL_STATE>",
            "Consolidated conversation state",
            ...recent,
            "</ARCHITECTURAL_STATE>"
        ].join("\n");
        return {
            summary,
            archivedMessageCount: Math.max(0, messages.length - 1)
        };
    }
}
