import type { ContextMessage, ContextProtocol, ConsolidatedState, LanguageHeuristic } from "./context-protocol.js";
import { maskVerboseLog } from "./log-mask.js";
import { EXTENSION_HEURISTICS } from "./heuristics.js";

export type CompactFn = (system: string, userPrompt: string) => Promise<string>;

const COMPACTION_SYSTEM = `You are a context compaction engine for a coding assistant.
Summarize the conversation trajectory into a single <ARCHITECTURAL_STATE> block.
Preserve: file paths changed, key decisions made, error resolutions, current task state, pending work.
Omit: raw tool output, redundant retries, verbose logs, greetings.
Be concise but preserve enough detail that the assistant can continue seamlessly.`;

export class SawtoothContextManager implements ContextProtocol {
  private compactFn: CompactFn | null = null;

  constructor(private readonly checkpointToolCalls = 12) {}

  setCompactFn(fn: CompactFn | null): void {
    this.compactFn = fn;
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
        return { summary, archivedMessageCount: Math.max(0, messages.length - 1) };
      } catch {
        // Fall through to heuristic compaction on LLM failure.
      }
    }

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
