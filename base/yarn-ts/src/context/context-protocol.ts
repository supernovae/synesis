export interface LanguageHeuristic {
  extension: string;
  maxInlineLogLines: number;
}

export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ConsolidatedState {
  summary: string;
  archivedMessageCount: number;
}

export interface ContextProtocol {
  shouldCheckpoint(history: ContextMessage[], toolCallsSinceCheckpoint: number): boolean;
  getLanguageHeuristics(ext: string): LanguageHeuristic;
  compressTrajectory(messages: ContextMessage[]): Promise<ConsolidatedState>;
}
