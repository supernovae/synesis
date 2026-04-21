export interface LanguageHeuristic {
  extension: string;
  maxInlineLogLines: number;
}

export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

import type { CompactionSensitivity } from "./compaction-sensitivity.js";

export interface ConsolidatedState {
  summary: string;
  archivedMessageCount: number;
}

export interface CheckpointOptions {
  toolCallsThreshold?: number;
  historyLengthThreshold?: number;
}

export interface CompressTrajectoryOptions {
  sensitivity?: CompactionSensitivity;
}

export interface ContextProtocol {
  shouldCheckpoint(
    history: ContextMessage[],
    toolCallsSinceCheckpoint: number,
    checkpointOpts?: CheckpointOptions,
  ): boolean;
  getLanguageHeuristics(ext: string): LanguageHeuristic;
  compressTrajectory(
    messages: ContextMessage[],
    compressOpts?: CompressTrajectoryOptions,
  ): Promise<ConsolidatedState>;
}
