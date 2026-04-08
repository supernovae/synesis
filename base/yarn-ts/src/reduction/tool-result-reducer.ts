import type { AppConfig } from "../config.js";
import { ArtifactStore } from "../state/artifact-store.js";
import { ReducerRegistry, registeredFamilies } from "./registry.js";
import type { ReducerFamily } from "./types.js";
import { compactJsonArray } from "./json-compactor.js";
import { ContentDispatchService } from "./content-dispatch.js";
import { makeRecallDecision } from "../recall/routing.js";
import type { RecallDecision, RecallStats } from "../recall/types.js";
import { createEmptyRecallStats } from "../recall/types.js";
import { getLanguagePackRegistry } from "../language-packs/index.js";
import type { RecallRoutingConfig } from "../recall/routing.js";
import { VerificationLoopTracker } from "../verification/loop-tracker.js";
import { getVerificationToolNames } from "../verification/planner.js";
import type { VerificationStats } from "../verification/types.js";
import { createEmptyVerificationStats } from "../verification/types.js";
import { formatSelfRepairBlock } from "../recall/formatter.js";
import { formatTerminalVerificationHint, type TerminalSignals } from "../terminal/terminal-signals.js";
import type { EnrichmentPool } from "../workers/pool.js";

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
  shrunkCount: number;
  expandedCount: number;
  unchangedCount: number;
  netCharsSavedTotal: number;
  artifactHandleCount: number;
  tokensSavedEstimateTotal: number;
  fallbackToArtifactCount: number;
  jsonCompactionCount: number;
  contentDispatchCount: number;
  reducerFailures: number;
  compactionFailures: number;
  guidedTruncationCount: number;
  enrichedCount: number;
  bypassEligibleCount: number;
  byFamily: Record<string, number>;
  lifecycle: Record<string, { lifecycle: string; successes: number; failures: number; lastError?: string }>;
}

const GUIDED_TRIM_TOOL_NAMES = new Set<string>([
  "glob",
  "list_files",
  "list_dir",
  "read_dir",
  "read_directory",
  "search_code",
  "search_files",
  "codebase_search",
  "grep",
  "rg",
]);

export interface ToolResultReductionResult {
  messages: ToolResultLike[];
  reducedCount: number;
}

function toStringContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function buildByFamilyStats(): Record<string, number> {
  const stats: Record<string, number> = { generic: 0 };
  for (const f of registeredFamilies()) stats[f] = 0;
  return stats;
}

export class ToolResultReductionService {
  private readonly stats: ToolResultReductionStats = {
    rawCharsTotal: 0,
    reducedCharsTotal: 0,
    reducedCount: 0,
    shrunkCount: 0,
    expandedCount: 0,
    unchangedCount: 0,
    netCharsSavedTotal: 0,
    artifactHandleCount: 0,
    tokensSavedEstimateTotal: 0,
    fallbackToArtifactCount: 0,
    jsonCompactionCount: 0,
    contentDispatchCount: 0,
    reducerFailures: 0,
    compactionFailures: 0,
    guidedTruncationCount: 0,
    enrichedCount: 0,
    bypassEligibleCount: 0,
    byFamily: buildByFamilyStats(),
    lifecycle: {}
  };
  private readonly registry: ReducerRegistry;
  private readonly contentDispatch: ContentDispatchService | null;
  private readonly recallStats: RecallStats = createEmptyRecallStats();
  private readonly recallConfig: RecallRoutingConfig;
  private _lastRecallDecision: RecallDecision | null = null;
  private readonly verificationTracker = new VerificationLoopTracker();
  private readonly verificationStats: VerificationStats = createEmptyVerificationStats();
  private _verificationToolNames: Set<string> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly artifactStore: ArtifactStore
  ) {
    const disabledFamilies = new Set<string>(
      config.SYNESIS_YARN_REDUCER_DISABLED_FAMILIES.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    this.contentDispatch = config.SYNESIS_YARN_CONTENT_DISPATCH_ENABLED
      ? new ContentDispatchService()
      : null;
    this.registry = new ReducerRegistry({
      enabled: config.SYNESIS_YARN_REDUCERS_ENABLED,
      disabledFamilies,
      minConfidence: config.SYNESIS_YARN_REDUCER_MIN_CONFIDENCE
    });
    this.recallConfig = {
      enabled: config.SYNESIS_YARN_RECALL_BYPASS_ENABLED,
      bypassConfidenceThreshold: config.SYNESIS_YARN_RECALL_BYPASS_CONFIDENCE_THRESHOLD,
      enrichConfidenceThreshold: config.SYNESIS_YARN_RECALL_ENRICH_THRESHOLD,
    };
  }

  reduceMessages(messages: ToolResultLike[]): ToolResultReductionResult {
    let reducedCount = 0;
    const out = messages.map((m) => {
      if (m.role !== "tool") return m;
      const normalized = this.buildReductionInput(m.name, m.content);
      const raw = normalized.raw;
      const emptyRemediation = this.applyEmptyResultRemediation(m.name, m.content, raw);
      if (emptyRemediation) {
        this.trackTransformation(raw.length, emptyRemediation.length);
        reducedCount += 1;
        return { ...m, content: emptyRemediation };
      }
      const guidedTrim = this.applyGuidedOutputTrim(m.name, raw);
      if (guidedTrim) {
        this.stats.guidedTruncationCount += 1;
        this.trackTransformation(raw.length, guidedTrim.length);
        reducedCount += 1;
        return { ...m, content: guidedTrim };
      }

      let reduced: ReturnType<ReducerRegistry["reduce"]> = null;
      if (!this.isExemptFromFileReduction(m.name)) {
        try {
          reduced = this.registry.reduce({
            raw,
            context: {
              toolName: m.name,
              command: normalized.commandHint,
              profile: this.config.SYNESIS_YARN_REDUCER_PROFILE,
              maxChars: this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS,
              minConfidence: this.config.SYNESIS_YARN_REDUCER_MIN_CONFIDENCE
            }
          });
        } catch {
          this.stats.compactionFailures += 1;
          reduced = null;
        }
      }
      const dispatched = reduced || !normalized.allowDispatch ? null : this.contentDispatch?.dispatch(raw);
      if (!reduced && dispatched?.transformed) {
        this.stats.contentDispatchCount += 1;
        this.trackTransformation(raw.length, dispatched.transformed.length);
        reducedCount += 1;
        return { ...m, content: dispatched.transformed };
      }
      const shouldReduce = Boolean(reduced) || (!this.isExemptFromFileReduction(m.name) && raw.length > this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS);
      if (!shouldReduce) return { ...m, content: raw };

      let summary: string;
      if (reduced) {
        summary = reduced.summary;
        this.stats.byFamily[reduced.family] += 1;
        if (reduced.enrichedItems && reduced.enrichedItems.length > 0) this.stats.enrichedCount += 1;
        if (reduced.bypassEligible) this.stats.bypassEligibleCount += 1;

        if (reduced.enrichedItems && reduced.enrichedItems.length > 0) {
          const registry = getLanguagePackRegistry();
          const decision = makeRecallDecision(
            reduced.enrichedItems,
            reduced.bypassEligible ?? false,
            registry,
            this.recallConfig,
            reduced.family,
            this.recallStats,
          );
          this._lastRecallDecision = decision;

          const isVerify = this.isVerificationOutput(m.name);
          if (isVerify) {
            const loopState = this.verificationTracker.recordRound(
              m.name ?? "unknown",
              reduced.enrichedItems,
              reduced.bypassEligible ?? false,
              this.verificationStats,
              decision.resolution?.language,
            );

            if (decision.routing !== "passthrough" && decision.resolution) {
              const selfRepair = formatSelfRepairBlock(decision.resolution, loopState);
              if (selfRepair) {
                this.verificationStats.selfRepairSuggestions++;
                summary = summary + "\n" + selfRepair;
              }
            }

            const progress = this.verificationTracker.formatProgressAnnotation();
            if (progress) {
              summary = summary + "\n" + progress;
            }
          } else {
            if (decision.routing === "bypass" && decision.syntheticBlock) {
              summary = decision.syntheticBlock;
            } else if (decision.routing === "enrich" && decision.enrichmentBlock) {
              summary = summary + "\n" + decision.enrichmentBlock;
            }
          }
        }
      } else {
        const jsonResult = this.config.SYNESIS_YARN_JSON_COMPACTION_ENABLED
          ? compactJsonArray(raw, { artifactHandle: this.artifactStore.putToolResult(raw).id })
          : null;
        if (jsonResult && jsonResult.compressionRatio > 0.2) {
          summary = jsonResult.compacted;
          this.stats.jsonCompactionCount += 1;
        } else {
          summary = this.artifactSummary(raw, m.name);
          this.stats.fallbackToArtifactCount += 1;
          this.stats.reducerFailures += 1;
        }
      }

      this.trackTransformation(raw.length, summary.length);
      if (summary.includes("artifact_handle=")) this.stats.artifactHandleCount += 1;
      reducedCount += 1;

      summary = this.appendTerminalVerificationHintForTool(m.name, m.content, summary);

      return {
        ...m,
        content: summary
      };
    });
    return { messages: out, reducedCount };
  }

  /**
   * Async variant of reduceMessages that fans out stateless content dispatch
   * and JSON compaction to worker threads for parallel processing.
   * Falls back to sync reduceMessages when pool is unavailable.
   */
  async reduceMessagesAsync(
    messages: ToolResultLike[],
    pool: EnrichmentPool,
  ): Promise<ToolResultReductionResult> {
    if (!pool.isAvailable()) {
      return this.reduceMessages(messages);
    }

    const toolIndices: number[] = [];
    const toolInputs: Array<{ raw: string; commandHint: string; allowDispatch: boolean }> = [];
    const dispatchPromises: Promise<{ contentType: string; transformed: string | null }>[] = [];

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") {
        const normalized = this.buildReductionInput(messages[i].name, messages[i].content);
        toolIndices.push(i);
        toolInputs.push(normalized);
        dispatchPromises.push(
          this.contentDispatch && normalized.allowDispatch
            ? pool.dispatchContentAsync(normalized.raw)
            : Promise.resolve({ contentType: "unknown", transformed: null }),
        );
      }
    }

    const dispatched = await Promise.all(dispatchPromises);

    let reducedCount = 0;
    const out = [...messages];

    for (let j = 0; j < toolIndices.length; j++) {
      const idx = toolIndices[j];
      const m = messages[idx];
      const normalized = toolInputs[j];
      const raw = normalized.raw;
      const emptyRemediation = this.applyEmptyResultRemediation(m.name, m.content, raw);
      if (emptyRemediation) {
        this.trackTransformation(raw.length, emptyRemediation.length);
        reducedCount += 1;
        out[idx] = { ...m, content: emptyRemediation };
        continue;
      }
      const guidedTrim = this.applyGuidedOutputTrim(m.name, raw);
      if (guidedTrim) {
        this.stats.guidedTruncationCount += 1;
        this.trackTransformation(raw.length, guidedTrim.length);
        reducedCount += 1;
        out[idx] = { ...m, content: guidedTrim };
        continue;
      }
      const dispatch = dispatched[j];

      let reduced: ReturnType<ReducerRegistry["reduce"]> = null;
      if (!this.isExemptFromFileReduction(m.name)) {
        try {
          reduced = this.registry.reduce({
            raw,
            context: {
              toolName: m.name,
              command: normalized.commandHint,
              profile: this.config.SYNESIS_YARN_REDUCER_PROFILE,
              maxChars: this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS,
              minConfidence: this.config.SYNESIS_YARN_REDUCER_MIN_CONFIDENCE,
            },
          });
        } catch {
          this.stats.compactionFailures += 1;
          reduced = null;
        }
      }
      if (!reduced && normalized.allowDispatch && dispatch.transformed) {
        this.stats.contentDispatchCount += 1;
        this.trackTransformation(raw.length, dispatch.transformed.length);
        reducedCount += 1;
        out[idx] = { ...m, content: dispatch.transformed };
        continue;
      }

      const shouldReduce = Boolean(reduced) || (!this.isExemptFromFileReduction(m.name) && raw.length > this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS);
      if (!shouldReduce) {
        out[idx] = { ...m, content: raw };
        continue;
      }

      let summary: string;
      if (reduced) {
        summary = reduced.summary;
        this.stats.byFamily[reduced.family] += 1;
        if (reduced.enrichedItems && reduced.enrichedItems.length > 0) this.stats.enrichedCount += 1;
        if (reduced.bypassEligible) this.stats.bypassEligibleCount += 1;

        if (reduced.enrichedItems && reduced.enrichedItems.length > 0) {
          const registry = getLanguagePackRegistry();
          const decision = makeRecallDecision(
            reduced.enrichedItems,
            reduced.bypassEligible ?? false,
            registry,
            this.recallConfig,
            reduced.family,
            this.recallStats,
          );
          this._lastRecallDecision = decision;

          const isVerify = this.isVerificationOutput(m.name);
          if (isVerify) {
            const loopState = this.verificationTracker.recordRound(
              m.name ?? "unknown",
              reduced.enrichedItems,
              reduced.bypassEligible ?? false,
              this.verificationStats,
              decision.resolution?.language,
            );
            if (decision.routing !== "passthrough" && decision.resolution) {
              const selfRepair = formatSelfRepairBlock(decision.resolution, loopState);
              if (selfRepair) {
                this.verificationStats.selfRepairSuggestions++;
                summary = summary + "\n" + selfRepair;
              }
            }
            const progress = this.verificationTracker.formatProgressAnnotation();
            if (progress) {
              summary = summary + "\n" + progress;
            }
          } else {
            if (decision.routing === "bypass" && decision.syntheticBlock) {
              summary = decision.syntheticBlock;
            } else if (decision.routing === "enrich" && decision.enrichmentBlock) {
              summary = summary + "\n" + decision.enrichmentBlock;
            }
          }
        }
      } else {
        const compactResult = this.config.SYNESIS_YARN_JSON_COMPACTION_ENABLED
          ? await pool.compactJsonAsync(raw)
          : null;
        if (compactResult && compactResult.compressionRatio > 0.2) {
          summary = compactResult.compacted;
          this.stats.jsonCompactionCount += 1;
        } else {
          summary = this.artifactSummary(raw, m.name);
          this.stats.fallbackToArtifactCount += 1;
          this.stats.reducerFailures += 1;
        }
      }

      this.trackTransformation(raw.length, summary.length);
      if (summary.includes("artifact_handle=")) this.stats.artifactHandleCount += 1;
      reducedCount += 1;
      summary = this.appendTerminalVerificationHintForTool(m.name, m.content, summary);
      out[idx] = { ...m, content: summary };
    }

    return { messages: out, reducedCount };
  }

  reduceStandaloneToolResult(content: unknown, toolName?: string): string {
    const normalized = this.buildReductionInput(toolName, content);
    const raw = normalized.raw;
    const emptyRemediation = this.applyEmptyResultRemediation(toolName, content, raw);
    if (emptyRemediation) {
      this.trackTransformation(raw.length, emptyRemediation.length);
      return emptyRemediation;
    }
    const guidedTrim = this.applyGuidedOutputTrim(toolName, raw);
    if (guidedTrim) {
      this.stats.guidedTruncationCount += 1;
      this.trackTransformation(raw.length, guidedTrim.length);
      return guidedTrim;
    }
    let reduced: ReturnType<ReducerRegistry["reduce"]> = null;
    if (!this.isExemptFromFileReduction(toolName)) {
      try {
        reduced = this.registry.reduce({
          raw,
          context: {
            toolName,
            command: normalized.commandHint,
            profile: this.config.SYNESIS_YARN_REDUCER_PROFILE,
            maxChars: this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS,
            minConfidence: this.config.SYNESIS_YARN_REDUCER_MIN_CONFIDENCE
          }
        });
      } catch {
        this.stats.compactionFailures += 1;
        reduced = null;
      }
    }
    if (!reduced && (this.isExemptFromFileReduction(toolName) || raw.length <= this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS)) {
      const jsonResult = this.config.SYNESIS_YARN_JSON_COMPACTION_ENABLED
        ? compactJsonArray(raw)
        : null;
      if (jsonResult && jsonResult.compressionRatio > 0.2) {
        this.stats.jsonCompactionCount += 1;
        this.trackTransformation(raw.length, jsonResult.compacted.length);
        return jsonResult.compacted;
      }
      return raw;
    }
    let summary: string;
    if (reduced) {
      summary = reduced.summary;
      this.stats.byFamily[reduced.family] += 1;
      if (reduced.enrichedItems && reduced.enrichedItems.length > 0) this.stats.enrichedCount += 1;
      if (reduced.bypassEligible) this.stats.bypassEligibleCount += 1;

      if (reduced.enrichedItems && reduced.enrichedItems.length > 0) {
        const registry = getLanguagePackRegistry();
        const decision = makeRecallDecision(
          reduced.enrichedItems,
          reduced.bypassEligible ?? false,
          registry,
          this.recallConfig,
          reduced.family,
          this.recallStats,
        );
        this._lastRecallDecision = decision;

        const isVerify = this.isVerificationOutput(toolName);
        if (isVerify) {
          const loopState = this.verificationTracker.recordRound(
            toolName ?? "unknown",
            reduced.enrichedItems,
            reduced.bypassEligible ?? false,
            this.verificationStats,
            decision.resolution?.language,
          );

          if (decision.routing !== "passthrough" && decision.resolution) {
            const selfRepair = formatSelfRepairBlock(decision.resolution, loopState);
            if (selfRepair) {
              this.verificationStats.selfRepairSuggestions++;
              summary = summary + "\n" + selfRepair;
            }
          }

          const progress = this.verificationTracker.formatProgressAnnotation();
          if (progress) {
            summary = summary + "\n" + progress;
          }
        } else {
          if (decision.routing === "bypass" && decision.syntheticBlock) {
            summary = decision.syntheticBlock;
          } else if (decision.routing === "enrich" && decision.enrichmentBlock) {
            summary = summary + "\n" + decision.enrichmentBlock;
          }
        }
      }
    } else {
      const jsonResult = this.config.SYNESIS_YARN_JSON_COMPACTION_ENABLED
        ? compactJsonArray(raw, { artifactHandle: this.artifactStore.putToolResult(raw).id })
        : null;
      if (jsonResult && jsonResult.compressionRatio > 0.2) {
        summary = jsonResult.compacted;
        this.stats.jsonCompactionCount += 1;
      } else {
        summary = this.artifactSummary(raw, toolName);
        this.stats.fallbackToArtifactCount += 1;
        this.stats.reducerFailures += 1;
      }
    }
    this.trackTransformation(raw.length, summary.length);
    if (summary.includes("artifact_handle=")) this.stats.artifactHandleCount += 1;
    return this.appendTerminalVerificationHintForTool(toolName, content, summary);
  }

  private _savedCheckpoint = 0;
  private _guidedTruncationCheckpoint = 0;

  /** Returns estimated tokens saved since the last call (per-request delta). */
  getPerRequestDelta(): number {
    const current = this.stats.tokensSavedEstimateTotal;
    const delta = current - this._savedCheckpoint;
    this._savedCheckpoint = current;
    return Math.max(0, delta);
  }

  /** Returns guided truncation count delta since last call. */
  getPerRequestGuidedTruncationDelta(): number {
    const current = this.stats.guidedTruncationCount;
    const delta = current - this._guidedTruncationCheckpoint;
    this._guidedTruncationCheckpoint = current;
    return Math.max(0, delta);
  }

  getStats(): ToolResultReductionStats & { contentDispatch: ReturnType<ContentDispatchService["getStats"]>; recall: RecallStats } {
    this.stats.lifecycle = this.registry.lifecycleStates();
    const dispatchStats = this.contentDispatch?.getStats() ?? { dispatched: 0, byType: { "json-array": 0, "json-object": 0, "log-stream": 0, text: 0 } };
    return { ...this.stats, contentDispatch: dispatchStats, recall: this.recallStats };
  }

  getRecallStats(): RecallStats {
    return this.recallStats;
  }

  getLastRecallDecision(): RecallDecision | null {
    return this._lastRecallDecision;
  }

  getVerificationStats(): VerificationStats {
    return this.verificationStats;
  }

  getVerificationTracker(): VerificationLoopTracker {
    return this.verificationTracker;
  }

  private pickTerminalSignalsFromToolContent(content: unknown): TerminalSignals | null {
    if (content && typeof content === "object" && !Array.isArray(content)) {
      const row = content as Record<string, unknown>;
      const ts = row.terminalSignals ?? row.terminal_signals;
      if (ts && typeof ts === "object") return ts as TerminalSignals;
      return null;
    }
    if (typeof content === "string") {
      try {
        const row = JSON.parse(content) as Record<string, unknown>;
        const ts = row.terminalSignals ?? row.terminal_signals;
        if (ts && typeof ts === "object") return ts as TerminalSignals;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * When verification MCP tools emit terminalSignals, append a bounded hint so the model
   * does not repeat the same hung/interactive command blindly.
   */
  private appendTerminalVerificationHintForTool(
    toolName: string | undefined,
    content: unknown,
    summary: string,
  ): string {
    if (!this.isVerificationOutput(toolName)) return summary;
    if (summary.includes("<synesis_terminal_signals")) return summary;
    const ts = this.pickTerminalSignalsFromToolContent(content);
    if (!ts) return summary;
    const hint = formatTerminalVerificationHint(ts);
    if (!hint) return summary;
    return `${summary}\n${hint}`;
  }

  private isVerificationOutput(toolName: string | undefined): boolean {
    if (!toolName) return false;
    if (!this._verificationToolNames) {
      this._verificationToolNames = getVerificationToolNames(getLanguagePackRegistry());
    }
    const lower = toolName.toLowerCase();
    if (lower.includes("run_test") || lower.includes("run_build") || lower.includes("run_lint")) {
      return true;
    }
    for (const vt of this._verificationToolNames) {
      if (lower.includes(vt)) return true;
    }
    return false;
  }

  private trackTransformation(rawChars: number, outChars: number): void {
    this.stats.rawCharsTotal += rawChars;
    this.stats.reducedCharsTotal += outChars;
    this.stats.reducedCount += 1;
    this.stats.netCharsSavedTotal += rawChars - outChars;
    this.stats.tokensSavedEstimateTotal += Math.max(0, Math.ceil(rawChars / 4) - Math.ceil(outChars / 4));
    if (outChars < rawChars) this.stats.shrunkCount += 1;
    else if (outChars > rawChars) this.stats.expandedCount += 1;
    else this.stats.unchangedCount += 1;
  }

  private buildReductionInput(
    toolName: string | undefined,
    content: unknown,
  ): { raw: string; commandHint: string; allowDispatch: boolean } {
    const name = (toolName ?? "").toLowerCase();
    const fallback = toStringContent(content);
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      return { raw: fallback, commandHint: name || (toolName ?? ""), allowDispatch: true };
    }
    const row = content as Record<string, unknown>;
    if (name.startsWith("git_")) {
      return {
        raw: this.extractGitReductionRaw(row, fallback),
        commandHint: this.gitCommandHintFromToolName(name),
        allowDispatch: false,
      };
    }
    if (name.startsWith("run_") || name === "format_code") {
      return {
        raw: this.extractRunnerReductionRaw(row, fallback),
        commandHint: name,
        allowDispatch: false,
      };
    }
    return { raw: fallback, commandHint: name || (toolName ?? ""), allowDispatch: true };
  }

  private gitCommandHintFromToolName(toolName: string): string {
    if (toolName === "git_status") return "git status";
    if (toolName === "git_diff") return "git diff";
    if (toolName === "git_log") return "git log";
    if (toolName === "git_rev_parse") return "git rev-parse";
    if (toolName === "git_branch_info") return "git branch";
    if (toolName === "git_file_state") return "git status --porcelain";
    if (toolName === "git_add_guarded") return "git add";
    if (toolName === "git_commit_guarded") return "git commit";
    return toolName;
  }

  private extractGitReductionRaw(row: Record<string, unknown>, fallback: string): string {
    const chunks: string[] = [];
    if (typeof row.stdout === "string" && row.stdout.trim()) chunks.push(row.stdout.trim());
    if (typeof row.stderr === "string" && row.stderr.trim()) chunks.push(row.stderr.trim());
    if (typeof row.summary === "string" && row.summary.trim()) chunks.push(row.summary.trim());
    if (typeof row.branch === "string" && row.branch.trim()) chunks.push(`branch=${row.branch.trim()}`);
    if (typeof row.statusCode === "string" && row.statusCode.trim()) chunks.push(`status=${row.statusCode.trim()}`);
    if (typeof row.ahead === "number" || typeof row.behind === "number") {
      chunks.push(`ahead_behind=${String(row.ahead ?? 0)}/${String(row.behind ?? 0)}`);
    }
    if (typeof row.dirty === "boolean") chunks.push(`dirty=${row.dirty}`);
    if (typeof row.hasUntracked === "boolean") chunks.push(`has_untracked=${row.hasUntracked}`);
    return chunks.length > 0 ? chunks.join("\n") : fallback;
  }

  private extractRunnerReductionRaw(row: Record<string, unknown>, fallback: string): string {
    const chunks: string[] = [];
    if (typeof row.summary === "string" && row.summary.trim()) chunks.push(row.summary.trim());
    if (row.terminalSignals && typeof row.terminalSignals === "object" && row.terminalSignals !== null) {
      try {
        chunks.push(`terminalSignals=${JSON.stringify(row.terminalSignals)}`);
      } catch {
        /* ignore */
      }
    }
    if (row.terminal_signals && typeof row.terminal_signals === "object" && row.terminal_signals !== null) {
      try {
        chunks.push(`terminal_signals=${JSON.stringify(row.terminal_signals)}`);
      } catch {
        /* ignore */
      }
    }
    if (Array.isArray(row.errorLines)) {
      const lines = row.errorLines
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .slice(0, 64);
      if (lines.length > 0) chunks.push(lines.join("\n"));
    }
    if (typeof row.stderr === "string" && row.stderr.trim()) chunks.push(row.stderr.trim());
    if (typeof row.stdout === "string" && row.stdout.trim()) chunks.push(row.stdout.trim());
    return chunks.length > 0 ? chunks.join("\n") : fallback;
  }

  private isExemptFromFileReduction(toolName: string | undefined): boolean {
    const name = (toolName ?? "").toLowerCase();
    return (
      name === "read" ||
      name === "write" ||
      name === "edit" ||
      name === "update" ||
      name === "glob" ||
      name === "read_file" ||
      name === "search_files" ||
      name === "synesis_code_search" ||
      name === "synesis_docs_search" ||
      name === "synesis_config_search" ||
      name === "synesis_knowledge_search" ||
      name === "synesis_web_search" ||
      name === "synesis_artifact_retrieve" ||
      name === "agent" ||
      name === "explore" ||
      name === "taskcreate" ||
      name === "taskupdate"
    );
  }

  private applyGuidedOutputTrim(toolName: string | undefined, raw: string): string | null {
    if (!this.config.SYNESIS_YARN_TOOL_OUTPUT_TRIM_GUIDED_ENABLED) return null;
    const lowerName = (toolName ?? "").toLowerCase();
    if (!GUIDED_TRIM_TOOL_NAMES.has(lowerName)) return null;
    const lines = raw.split("\n");
    const maxLines = Math.max(1, this.config.SYNESIS_YARN_TOOL_OUTPUT_TRIM_MAX_LINES);
    const oversizedByLines = lines.length > maxLines;
    const oversizedByChars = raw.length > this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS;
    if (!oversizedByLines && !oversizedByChars) return null;
    const previewLines = Math.min(Math.max(1, this.config.SYNESIS_YARN_TOOL_OUTPUT_TRIM_PREVIEW_LINES), lines.length);
    const preview = oversizedByLines
      ? lines.slice(0, previewLines).join("\n")
      : raw.slice(0, Math.min(raw.length, 2400));
    return [
      `<SYNESIS_TOOL_GUARDRAIL status="truncated" code="tool_output_truncated_guided" version="1">`,
      `tool=${toolName ?? "unknown"}`,
      `lines_total=${lines.length}`,
      `chars_total=${raw.length}`,
      `lines_shown=${previewLines}`,
      `next_action=use_more_specific_path_or_pattern`,
      `[Truncated] Tool output exceeded guardrail thresholds. Showing a bounded preview.`,
      preview,
      "</SYNESIS_TOOL_GUARDRAIL>",
    ].join("\n");
  }

  private applyEmptyResultRemediation(
    toolName: string | undefined,
    content: unknown,
    raw: string,
  ): string | null {
    const lower = (toolName ?? "").toLowerCase();
    const isSearchLike = lower.includes("search") || lower.includes("grep") || lower.includes("rg");
    const isListLike = lower.includes("list_dir") || lower.includes("read_dir") || lower.includes("glob");
    if (!isSearchLike && !isListLike) return null;
    let parsed: Record<string, unknown> | null = null;
    if (content && typeof content === "object" && !Array.isArray(content)) {
      parsed = content as Record<string, unknown>;
    } else if (typeof content === "string" && content.trim().startsWith("{")) {
      try {
        const row = JSON.parse(content) as unknown;
        if (row && typeof row === "object" && !Array.isArray(row)) parsed = row as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    const matches = Array.isArray(parsed?.matches) ? parsed?.matches : null;
    const entries = Array.isArray(parsed?.entries) ? parsed?.entries : null;
    const isEmpty = (matches !== null && matches.length === 0) || (entries !== null && entries.length === 0);
    if (!isEmpty) return null;
    return [
      `<SYNESIS_TOOL_GUARDRAIL status="guided" code="empty_result_remediation" version="1">`,
      `tool=${toolName ?? "unknown"}`,
      "reason=empty_result",
      "next_action=broaden_or_correct_query_then_retry_once",
      "[No results] Try a partial symbol match, broaden dir scope by one level, or list_dir first to validate path assumptions.",
      `preview=${raw.slice(0, 240).replace(/\n/g, " ")}`,
      "</SYNESIS_TOOL_GUARDRAIL>",
    ].join("\n");
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
