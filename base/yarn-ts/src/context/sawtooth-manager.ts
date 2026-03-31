import type { ContextMessage, ContextProtocol, ConsolidatedState, LanguageHeuristic } from "./context-protocol.js";
import { maskVerboseLog } from "./log-mask.js";
import { EXTENSION_HEURISTICS } from "./heuristics.js";

export type CompactFn = (system: string, userPrompt: string) => Promise<string>;

export interface CompactionStats {
  llmCompactions: number;
  heuristicFallbacks: number;
  compactionFailures: number;
  truncationFallbacks: number;
}

const COMPACTION_SYSTEM = `You are a context compaction engine for a coding assistant.
Summarize the conversation trajectory into a single <ARCHITECTURAL_STATE> block.
Preserve: file paths changed, key decisions made, error resolutions, current task state, pending work.
Omit: raw tool output, redundant retries, verbose logs, greetings.
Be concise but preserve enough detail that the assistant can continue seamlessly.`;

export class SawtoothContextManager implements ContextProtocol {
  private compactFn: CompactFn | null = null;
  private fallbackMaxChars: number;
  private readonly _stats: CompactionStats = {
    llmCompactions: 0,
    heuristicFallbacks: 0,
    compactionFailures: 0,
    truncationFallbacks: 0,
  };

  constructor(private readonly checkpointToolCalls = 12, fallbackMaxChars = 2000) {
    this.fallbackMaxChars = fallbackMaxChars;
  }

  setCompactFn(fn: CompactFn | null): void {
    this.compactFn = fn;
  }

  setFallbackMaxChars(maxChars: number): void {
    this.fallbackMaxChars = maxChars;
  }

  getStats(): CompactionStats {
    return { ...this._stats };
  }

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
    const masked = messages.map((m) => `${m.role}: ${maskVerboseLog(m.content)}`);

    if (this.compactFn) {
      try {
        const userPrompt = masked.join("\n\n");
        const summary = await this.compactFn(COMPACTION_SYSTEM, userPrompt);
        this._stats.llmCompactions += 1;
        return { summary, archivedMessageCount: Math.max(0, messages.length - 1) };
      } catch {
        this._stats.compactionFailures += 1;
      }
    }

    const joined = masked.join("\n\n");
    if (joined.length > this.fallbackMaxChars) {
      this._stats.truncationFallbacks += 1;
      const truncated = joined.slice(-this.fallbackMaxChars);
      const summary = [
        "<ARCHITECTURAL_STATE>",
        "Consolidated conversation state (truncated fallback -- compaction unavailable)",
        truncated,
        "</ARCHITECTURAL_STATE>",
      ].join("\n");
      return { summary, archivedMessageCount: Math.max(0, messages.length - 1) };
    }

    this._stats.heuristicFallbacks += 1;
    const recent = masked.slice(-20);
    const summary = [
      "<ARCHITECTURAL_STATE>",
      "Consolidated conversation state (heuristic -- no compaction model available)",
      ...recent,
      "</ARCHITECTURAL_STATE>"
    ].join("\n");
    return {
      summary,
      archivedMessageCount: Math.max(0, messages.length - 1)
    };
  }
}
