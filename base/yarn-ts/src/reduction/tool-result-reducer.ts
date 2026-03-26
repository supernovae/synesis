import type { AppConfig } from "../config.js";
import { ArtifactStore } from "../state/artifact-store.js";

export interface ToolResultLike {
  role: string;
  name?: string;
  tool_call_id?: string;
  content: unknown;
}

export interface ToolResultReductionStats {
  rawCharsTotal: number;
  reducedCharsTotal: number;
  reducedCount: number;
  artifactHandleCount: number;
  tokensSavedEstimateTotal: number;
}

export interface ToolResultReductionResult {
  messages: ToolResultLike[];
  reducedCount: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function toStringContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export class ToolResultReductionService {
  private readonly stats: ToolResultReductionStats = {
    rawCharsTotal: 0,
    reducedCharsTotal: 0,
    reducedCount: 0,
    artifactHandleCount: 0,
    tokensSavedEstimateTotal: 0
  };

  constructor(
    private readonly config: AppConfig,
    private readonly artifactStore: ArtifactStore
  ) {}

  reduceMessages(messages: ToolResultLike[]): ToolResultReductionResult {
    let reducedCount = 0;
    const out = messages.map((m) => {
      if (m.role !== "tool") return m;
      const raw = toStringContent(m.content);
      const shouldReduce = raw.length > this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS;
      if (!shouldReduce) return { ...m, content: raw };

      const artifact = this.artifactStore.putToolResult(raw);
      const summary = [
        `<TOOL_RESULT_SUMMARY tool="${m.name ?? "unknown"}" chars="${raw.length}" truncated="true">`,
        `artifact_handle=${artifact.id}`,
        `preview=${artifact.preview}`,
        "</TOOL_RESULT_SUMMARY>"
      ].join("\n");

      this.stats.rawCharsTotal += raw.length;
      this.stats.reducedCharsTotal += summary.length;
      this.stats.reducedCount += 1;
      this.stats.artifactHandleCount += 1;
      this.stats.tokensSavedEstimateTotal += Math.max(0, estimateTokens(raw) - estimateTokens(summary));
      reducedCount += 1;

      return {
        ...m,
        content: summary
      };
    });
    return { messages: out, reducedCount };
  }

  reduceStandaloneToolResult(content: unknown, toolName?: string): string {
    const raw = toStringContent(content);
    if (raw.length <= this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS) return raw;
    const artifact = this.artifactStore.putToolResult(raw);
    const summary = [
      `<TOOL_RESULT_SUMMARY tool="${toolName ?? "unknown"}" chars="${raw.length}" truncated="true">`,
      `artifact_handle=${artifact.id}`,
      `preview=${artifact.preview}`,
      "</TOOL_RESULT_SUMMARY>"
    ].join("\n");
    this.stats.rawCharsTotal += raw.length;
    this.stats.reducedCharsTotal += summary.length;
    this.stats.reducedCount += 1;
    this.stats.artifactHandleCount += 1;
    this.stats.tokensSavedEstimateTotal += Math.max(0, estimateTokens(raw) - estimateTokens(summary));
    return summary;
  }

  getStats(): ToolResultReductionStats {
    return { ...this.stats };
  }
}
