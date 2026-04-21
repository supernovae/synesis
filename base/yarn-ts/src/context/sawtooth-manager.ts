import type {
  CheckpointOptions,
  CompressTrajectoryOptions,
  ContextMessage,
  ContextProtocol,
  ConsolidatedState,
  LanguageHeuristic,
} from "./context-protocol.js";
import { compactionSystemPromptFor, type CompactionSensitivity } from "./compaction-sensitivity.js";
import { maskVerboseLog } from "./log-mask.js";
import { EXTENSION_HEURISTICS } from "./heuristics.js";

export type CompactFn = (system: string, userPrompt: string) => Promise<string>;

export interface CompactionStats {
  llmCompactions: number;
  heuristicFallbacks: number;
  compactionFailures: number;
  truncationFallbacks: number;
}

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

  shouldCheckpoint(
    history: ContextMessage[],
    toolCallsSinceCheckpoint: number,
    checkpointOpts?: CheckpointOptions,
  ): boolean {
    const toolTh = checkpointOpts?.toolCallsThreshold ?? this.checkpointToolCalls;
    const histTh = checkpointOpts?.historyLengthThreshold ?? 60;
    if (toolCallsSinceCheckpoint >= toolTh) {
      return true;
    }
    return history.length >= histTh;
  }

  getLanguageHeuristics(ext: string): LanguageHeuristic {
    return EXTENSION_HEURISTICS[ext] ?? { extension: ext, maxInlineLogLines: 60 };
  }

  async compressTrajectory(
    messages: ContextMessage[],
    compressOpts?: CompressTrajectoryOptions,
  ): Promise<ConsolidatedState> {
    const sensitivity: CompactionSensitivity = compressOpts?.sensitivity ?? "default";
    const systemPrompt = compactionSystemPromptFor(sensitivity);
    const masked = messages.map((m) => `${m.role}: ${maskVerboseLog(m.content)}`);

    if (this.compactFn) {
      try {
        const userPrompt = masked.join("\n\n");
        const summary = await this.compactFn(systemPrompt, userPrompt);
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
