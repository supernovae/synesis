import type { AppConfig } from "../config.js";
import { ArtifactStore } from "../state/artifact-store.js";
import { ReducerRegistry } from "./registry.js";
import type { ReducerFamily } from "./types.js";

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
  fallbackToArtifactCount: number;
  reducerFailures: number;
  byFamily: Record<ReducerFamily, number>;
  lifecycle: Record<string, { lifecycle: string; successes: number; failures: number; lastError?: string }>;
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
    tokensSavedEstimateTotal: 0,
    fallbackToArtifactCount: 0,
    reducerFailures: 0,
    byFamily: {
      pytest: 0, tsc: 0, lint: 0, git: 0, search: 0,
      "npm-install": 0, "docker-build": 0, cargo: 0, make: 0, "stack-trace": 0,
      jest: 0, "go-build": 0, "pip-install": 0, "ls-tree": 0, "curl-http": 0,
      kubectl: 0, terraform: 0, "sql-result": 0, mypy: 0, "java-build": 0,
      ansible: 0, helm: 0, "network-diag": 0, "strace-perf": 0, "log-stream": 0,
      generic: 0
    },
    lifecycle: {}
  };
  private readonly registry: ReducerRegistry;

  constructor(
    private readonly config: AppConfig,
    private readonly artifactStore: ArtifactStore
  ) {
    const enabledFamilies = new Set<ReducerFamily>(
      config.SYNESIS_YARN_REDUCER_FAMILIES.split(",")
        .map((s) => s.trim())
        .filter(Boolean) as ReducerFamily[]
    );
    this.registry = new ReducerRegistry({
      enabled: config.SYNESIS_YARN_REDUCERS_ENABLED,
      enabledFamilies,
      minConfidence: config.SYNESIS_YARN_REDUCER_MIN_CONFIDENCE
    });
  }

  reduceMessages(messages: ToolResultLike[]): ToolResultReductionResult {
    let reducedCount = 0;
    const out = messages.map((m) => {
      if (m.role !== "tool") return m;
      const raw = toStringContent(m.content);
      const reduced = this.registry.reduce({
        raw,
        context: {
          toolName: m.name,
          command: m.name,
          profile: this.config.SYNESIS_YARN_REDUCER_PROFILE,
          maxChars: this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS,
          minConfidence: this.config.SYNESIS_YARN_REDUCER_MIN_CONFIDENCE
        }
      });
      const shouldReduce = Boolean(reduced) || raw.length > this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS;
      if (!shouldReduce) return { ...m, content: raw };

      const summary = reduced
        ? reduced.summary
        : this.artifactSummary(raw, m.name);
      if (!reduced) {
        this.stats.fallbackToArtifactCount += 1;
        this.stats.reducerFailures += 1;
      } else {
        this.stats.byFamily[reduced.family] += 1;
      }

      this.stats.rawCharsTotal += raw.length;
      this.stats.reducedCharsTotal += summary.length;
      this.stats.reducedCount += 1;
      if (summary.includes("artifact_handle=")) this.stats.artifactHandleCount += 1;
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
    const reduced = this.registry.reduce({
      raw,
      context: {
        toolName,
        command: toolName,
        profile: this.config.SYNESIS_YARN_REDUCER_PROFILE,
        maxChars: this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS,
        minConfidence: this.config.SYNESIS_YARN_REDUCER_MIN_CONFIDENCE
      }
    });
    if (!reduced && raw.length <= this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS) return raw;
    const summary = reduced ? reduced.summary : this.artifactSummary(raw, toolName);
    if (reduced) {
      this.stats.byFamily[reduced.family] += 1;
    } else {
      this.stats.fallbackToArtifactCount += 1;
      this.stats.reducerFailures += 1;
    }
    this.stats.rawCharsTotal += raw.length;
    this.stats.reducedCharsTotal += summary.length;
    this.stats.reducedCount += 1;
    if (summary.includes("artifact_handle=")) this.stats.artifactHandleCount += 1;
    this.stats.tokensSavedEstimateTotal += Math.max(0, estimateTokens(raw) - estimateTokens(summary));
    return summary;
  }

  getStats(): ToolResultReductionStats {
    this.stats.lifecycle = this.registry.lifecycleStates();
    return { ...this.stats };
  }

  private artifactSummary(raw: string, toolName?: string): string {
    const artifact = this.artifactStore.putToolResult(raw);
    return [
      `<TOOL_RESULT_SUMMARY tool="${toolName ?? "unknown"}" chars="${raw.length}" truncated="true">`,
      `artifact_handle=${artifact.id}`,
      `preview=${artifact.preview}`,
      "</TOOL_RESULT_SUMMARY>"
    ].join("\n");
  }
}
