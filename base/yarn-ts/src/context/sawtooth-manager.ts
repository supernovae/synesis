import type { ContextMessage, ContextProtocol, ConsolidatedState, LanguageHeuristic } from "./context-protocol.js";
import { maskVerboseLog } from "./log-mask.js";
import { EXTENSION_HEURISTICS } from "./heuristics.js";

export class SawtoothContextManager implements ContextProtocol {
  constructor(private readonly checkpointToolCalls = 12) {}

  shouldCheckpoint(history: ContextMessage[], toolCallsSinceCheckpoint: number): boolean {
    if (toolCallsSinceCheckpoint >= this.checkpointToolCalls) {
      return true;
    }
    return history.length >= 60;
  }

  getLanguageHeuristics(ext: string): LanguageHeuristic {
    return EXTENSION_HEURISTICS[ext] ?? { extension: ext, maxInlineLogLines: 60 };
  }

  async compressTrajectory(messages: ContextMessage[]): Promise<ConsolidatedState> {
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
