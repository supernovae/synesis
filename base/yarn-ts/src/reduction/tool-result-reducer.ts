import type { AppConfig } from "../config.js";
import { ArtifactStore } from "../state/artifact-store.js";
import { ReducerRegistry, registeredFamilies } from "./registry.js";
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
import {
  effectiveMaxRawChars,
  effectiveReducerProfile,
  inferCompactionSensitivity,
  looksLikeVerificationFailureOutput,
  shouldPreserveLastVerificationFailureIndex,
  type CompactionSensitivity,
  type ReducerProfileName,
} from "../context/compaction-sensitivity.js";

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
  guidedTrimArtifactsStored: number;
  taskPrunedCount: number;
  taskPrunedLinesKept: number;
  taskPrunedLinesDropped: number;
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

export interface ReduceMessagesOpts {
  /** Tier-resolved backend model id/name; used for Qwen3-Coder compaction sensitivity. */
  backendModelHint?: string;
  /** Optional per-request override for JSON compaction stage. */
  jsonCompactionEnabled?: boolean;
}

const VERIFY_LITERAL_PRESERVE_CAP = 120_000;

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
    guidedTrimArtifactsStored: 0,
    taskPrunedCount: 0,
    taskPrunedLinesKept: 0,
    taskPrunedLinesDropped: 0,
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

  /**
   * Scan assistant messages for tool_use blocks and build a map from
   * tool_call_id → command string.  This lets the reducer recover the
   * original Bash/shell command when the tool RESULT is just stdout text.
   */
  private buildToolCallCommandMap(messages: ToolResultLike[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      // OpenAI format: tool_calls array
      const toolCalls = (m as unknown as Record<string, unknown>).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const id = typeof tc?.id === "string" ? tc.id : "";
          const args = typeof tc?.function?.arguments === "string"
            ? tc.function.arguments
            : "";
          if (!id || !args) continue;
          try {
            const parsed = JSON.parse(args);
            const cmd = typeof parsed?.command === "string" ? parsed.command.trim() : "";
            if (cmd) map.set(id, cmd);
          } catch { /* ignore parse errors */ }
        }
        continue;
      }
      // Claude format: content array with tool_use blocks
      const content = (m as unknown as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        const id = typeof block.id === "string" ? block.id : "";
        const input = block.input;
        if (!id || !input || typeof input !== "object") continue;
        const cmd = typeof (input as Record<string, unknown>).command === "string"
          ? ((input as Record<string, unknown>).command as string).trim()
          : "";
        if (cmd) map.set(id, cmd);
      }
    }
    return map;
  }

  private isBashLikeToolName(name: string | undefined): boolean {
    const n = (name ?? "").toLowerCase();
    return n === "bash"
      || n.includes("run_terminal")
      || n.includes("run_command")
      || n === "run_terminal_cmd"
      || n === "execute_command"
      || n.includes("shell");
  }

  private findLastVerificationFailureIndex(messages: ToolResultLike[]): number {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role !== "tool") continue;
      const normalized = this.buildReductionInput(m.name, m.content);
      const raw = normalized.raw;
      if (raw.length > VERIFY_LITERAL_PRESERVE_CAP) continue;
      if (!looksLikeVerificationFailureOutput(raw)) continue;
      if (this.isVerificationOutput(m.name) || this.isBashLikeToolName(m.name)) {
        return i;
      }
    }
    return -1;
  }

  reduceMessages(
    messages: ToolResultLike[],
    taskCue?: string,
    pruningWatermark?: number,
    opts?: ReduceMessagesOpts,
  ): ToolResultReductionResult {
    const jsonCompactionEnabled = opts?.jsonCompactionEnabled ?? this.config.SYNESIS_YARN_JSON_COMPACTION_ENABLED;
    const sensitivity: CompactionSensitivity = inferCompactionSensitivity(opts?.backendModelHint ?? "");
    const effProfile = effectiveReducerProfile(this.config.SYNESIS_YARN_REDUCER_PROFILE as ReducerProfileName, sensitivity);
    const effMaxChars = effectiveMaxRawChars(this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS, sensitivity);
    const lastVerificationFailureIdx = shouldPreserveLastVerificationFailureIndex(sensitivity)
      ? this.findLastVerificationFailureIndex(messages)
      : -1;

    const recentExempt = Number(this.config.SYNESIS_YARN_TASK_PRUNING_RECENT_EXEMPT) || 0;
    const recentToolProtected = computeRecentToolProtectedSet(messages, recentExempt);
    const toolCallCmds = this.buildToolCallCommandMap(messages);

    let reducedCount = 0;
    const out = messages.map((m, msgIdx) => {
      if (m.role !== "tool") return m;
      const normalized = this.buildReductionInput(m.name, m.content);
      const raw = normalized.raw;
      if (msgIdx === lastVerificationFailureIdx) {
        return { ...m, content: raw };
      }
      const cacheStub = this.applyReadCacheStubRemediation(m.name, raw);
      if (cacheStub) {
        this.trackTransformation(raw.length, cacheStub.length);
        reducedCount += 1;
        return { ...m, content: cacheStub };
      }
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
      const resolvedHint = (m.tool_call_id && toolCallCmds.get(m.tool_call_id)) || normalized.commandHint;
      const aboveWatermark = pruningWatermark !== undefined && msgIdx > pruningWatermark;
      if (!recentToolProtected.has(msgIdx) && !aboveWatermark) {
        const taskPruned = this.applyTaskConditionedPruning(m.name, raw, taskCue, resolvedHint);
        if (taskPruned) {
          this.trackTransformation(raw.length, taskPruned.length);
          reducedCount += 1;
          return { ...m, content: taskPruned };
        }
      }

      let reduced: ReturnType<ReducerRegistry["reduce"]> = null;
      if (!this.isExemptFromRegistryReduction(m.name)) {
        try {
          reduced = this.registry.reduce({
            raw,
            context: {
              toolName: m.name,
              command: resolvedHint,
              profile: effProfile,
              maxChars: effMaxChars,
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
      const shouldReduce = Boolean(reduced) || (!this.isExemptFromSizeCompaction(m.name) && raw.length > effMaxChars);
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
        const jsonResult = jsonCompactionEnabled
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
    taskCue?: string,
    pruningWatermark?: number,
    opts?: ReduceMessagesOpts,
  ): Promise<ToolResultReductionResult> {
    const jsonCompactionEnabled = opts?.jsonCompactionEnabled ?? this.config.SYNESIS_YARN_JSON_COMPACTION_ENABLED;
    if (!pool.isAvailable()) {
      return this.reduceMessages(messages, taskCue, pruningWatermark, opts);
    }

    const sensitivity: CompactionSensitivity = inferCompactionSensitivity(opts?.backendModelHint ?? "");
    const effProfile = effectiveReducerProfile(this.config.SYNESIS_YARN_REDUCER_PROFILE as ReducerProfileName, sensitivity);
    const effMaxChars = effectiveMaxRawChars(this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS, sensitivity);
    const lastVerificationFailureIdx = shouldPreserveLastVerificationFailureIndex(sensitivity)
      ? this.findLastVerificationFailureIndex(messages)
      : -1;

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
    const recentExempt = Number(this.config.SYNESIS_YARN_TASK_PRUNING_RECENT_EXEMPT) || 0;
    const recentToolProtected = computeRecentToolProtectedSet(messages, recentExempt);
    const toolCallCmds = this.buildToolCallCommandMap(messages);

    let reducedCount = 0;
    const out = [...messages];

    for (let j = 0; j < toolIndices.length; j++) {
      const idx = toolIndices[j];
      const m = messages[idx];
      const normalized = toolInputs[j];
      const raw = normalized.raw;
      if (idx === lastVerificationFailureIdx) {
        out[idx] = { ...m, content: raw };
        continue;
      }
      const cacheStub = this.applyReadCacheStubRemediation(m.name, raw);
      if (cacheStub) {
        this.trackTransformation(raw.length, cacheStub.length);
        reducedCount += 1;
        out[idx] = { ...m, content: cacheStub };
        continue;
      }
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
      const resolvedHint = (m.tool_call_id && toolCallCmds.get(m.tool_call_id)) || normalized.commandHint;
      const asyncAboveWatermark = pruningWatermark !== undefined && idx > pruningWatermark;
      if (!recentToolProtected.has(idx) && !asyncAboveWatermark) {
        const taskPruned = this.applyTaskConditionedPruning(m.name, raw, taskCue, resolvedHint);
        if (taskPruned) {
          this.trackTransformation(raw.length, taskPruned.length);
          reducedCount += 1;
          out[idx] = { ...m, content: taskPruned };
          continue;
        }
      }
      const dispatch = dispatched[j];

      let reduced: ReturnType<ReducerRegistry["reduce"]> = null;
      if (!this.isExemptFromRegistryReduction(m.name)) {
        try {
          reduced = this.registry.reduce({
            raw,
            context: {
              toolName: m.name,
              command: resolvedHint,
              profile: effProfile,
              maxChars: effMaxChars,
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

      const shouldReduce = Boolean(reduced) || (!this.isExemptFromSizeCompaction(m.name) && raw.length > effMaxChars);
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
        const compactResult = jsonCompactionEnabled
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

  reduceStandaloneToolResult(content: unknown, toolName?: string, taskCue?: string, commandHintOverride?: string): string {
    const normalized = this.buildReductionInput(toolName, content);
    const raw = normalized.raw;
    const cacheStub = this.applyReadCacheStubRemediation(toolName, raw);
    if (cacheStub) {
      this.trackTransformation(raw.length, cacheStub.length);
      return cacheStub;
    }
    const emptyRemediation = this.applyEmptyResultRemediation(toolName, content, raw);
    if (emptyRemediation) {
      this.trackTransformation(raw.length, emptyRemediation.length);
      return emptyRemediation;
    }
    const resolvedHint = commandHintOverride || normalized.commandHint;
    const guidedTrim = this.applyGuidedOutputTrim(toolName, raw);
    if (guidedTrim) {
      this.stats.guidedTruncationCount += 1;
      this.trackTransformation(raw.length, guidedTrim.length);
      return guidedTrim;
    }
    const taskPruned = this.applyTaskConditionedPruning(toolName, raw, taskCue, resolvedHint);
    if (taskPruned) {
      this.trackTransformation(raw.length, taskPruned.length);
      return taskPruned;
    }
    let reduced: ReturnType<ReducerRegistry["reduce"]> = null;
    if (!this.isExemptFromRegistryReduction(toolName)) {
      try {
        reduced = this.registry.reduce({
          raw,
          context: {
            toolName,
            command: resolvedHint,
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
      return dispatched.transformed;
    }
    const shouldReduce = Boolean(reduced) || (!this.isExemptFromSizeCompaction(toolName) && raw.length > this.config.SYNESIS_YARN_VALIDATION_MAX_RAW_CHARS);
    if (!shouldReduce) return raw;
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
  private _taskPrunedCheckpoint = 0;

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

  /** Returns task-pruned count delta since last call. */
  getPerRequestTaskPrunedDelta(): number {
    const current = this.stats.taskPrunedCount;
    const delta = current - this._taskPrunedCheckpoint;
    this._taskPrunedCheckpoint = current;
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
    const commandHint = this.extractCommandHint(row) ?? (name || (toolName ?? ""));
    return { raw: fallback, commandHint, allowDispatch: true };
  }

  private extractCommandHint(row: Record<string, unknown>): string | null {
    if (typeof row.command === "string" && row.command.trim()) return row.command.trim();
    if (typeof row.cmd === "string" && row.cmd.trim()) return row.cmd.trim();
    if (Array.isArray(row.argv)) {
      const parts = row.argv.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
      if (parts.length > 0) return parts.join(" ");
    }
    return null;
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

  private isExemptFromRegistryReduction(toolName: string | undefined): boolean {
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

  private isExemptFromSizeCompaction(toolName: string | undefined): boolean {
    const name = (toolName ?? "").toLowerCase();
    return (
      name === "read" ||
      name === "read_file" ||
      name === "write" ||
      name === "edit" ||
      name === "update" ||
      name === "glob" ||
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
    let artifactLine = "";
    if (this.config.SYNESIS_YARN_TRANSCRIPT_PRUNE_ARTIFACT_RETENTION_ENABLED !== false) {
      try {
        const id = this.artifactStore.putToolResult(raw).id;
        this.stats.guidedTrimArtifactsStored += 1;
        artifactLine = `artifact_handle=${id} recovery=synesis_artifact_retrieve`;
      } catch {
        artifactLine = "";
      }
    }
    const linesOut = [
      `<SYNESIS_TOOL_GUARDRAIL status="truncated" code="tool_output_truncated_guided" version="1">`,
      `tool=${toolName ?? "unknown"}`,
      `lines_total=${lines.length}`,
      `chars_total=${raw.length}`,
      `lines_shown=${previewLines}`,
      `next_action=use_more_specific_path_or_pattern`,
      ...(artifactLine ? [artifactLine] : []),
      `[Truncated] Tool output exceeded guardrail thresholds. Showing a bounded preview; full bytes stored for retrieval when artifact_handle is present.`,
      preview,
      "</SYNESIS_TOOL_GUARDRAIL>",
    ];
    return linesOut.join("\n");
  }

  private applyTaskConditionedPruning(
    toolName: string | undefined,
    raw: string,
    taskCue?: string,
    commandHint?: string,
  ): string | null {
    if (!this.config.SYNESIS_YARN_TASK_PRUNING_ENABLED || (this.config as Record<string, unknown>).SYNESIS_YARN_GOVERNANCE_DISABLED) return null;
    if (!taskCue || taskCue.trim().length < 8) return null;
    const lowerName = (toolName ?? "").toLowerCase();
    if (lowerName === "read_file" || lowerName === "read") return null;
    const lines = raw.split("\n");
    const minLines = Math.max(10, this.config.SYNESIS_YARN_TASK_PRUNING_MIN_LINES);
    if (lines.length < minLines) return null;
    if (this.shouldBypassTaskPruningForLikelySource(lowerName, lines, commandHint)) return null;

    const tokens = this.extractTaskTokens(taskCue);
    if (tokens.length === 0) return null;
    const radius = Math.max(0, this.config.SYNESIS_YARN_TASK_PRUNING_CONTEXT_RADIUS);
    const keepCap = Math.max(10, this.config.SYNESIS_YARN_TASK_PRUNING_KEEP_MAX_LINES);
    const selected = new Set<number>();
    const signalRe = /\b(exception|panic|traceback|stderr|timeout|denied|unauthorized|forbidden)\b|error:/i;

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const lower = line.toLowerCase();
      const hasSignal = signalRe.test(lower);
      const hasTaskMatch = tokens.some((t) => lower.includes(t));
      if (!hasSignal && !hasTaskMatch) continue;
      const start = Math.max(0, idx - radius);
      const end = Math.min(lines.length - 1, idx + radius);
      for (let i = start; i <= end; i++) selected.add(i);
    }

    if (selected.size === 0) return null;
    const ordered = [...selected].sort((a, b) => a - b).slice(0, keepCap);
    const keptLines = ordered.map((idx) => lines[idx]);
    if (keptLines.length === 0 || keptLines.length >= lines.length) return null;

    const droppedLines = Math.max(0, lines.length - keptLines.length);
    const artifact = this.artifactStore.putToolResult(raw);
    this.stats.taskPrunedCount += 1;
    this.stats.taskPrunedLinesKept += keptLines.length;
    this.stats.taskPrunedLinesDropped += droppedLines;

    return [
      `<SYNESIS_TOOL_GUARDRAIL status="task_pruned" code="task_conditioned_pruning" version="1">`,
      `tool=${toolName ?? "unknown"}`,
      `task_tokens=${tokens.slice(0, 8).join(",")}`,
      `lines_total=${lines.length}`,
      `lines_kept=${keptLines.length}`,
      `lines_dropped=${droppedLines}`,
      `artifact_handle=${artifact.id}`,
      "next_action=request_artifact_handle_if_more_context_needed",
      "[Task-pruned] Showing high-signal lines aligned to current task cue.",
      ...keptLines,
      "</SYNESIS_TOOL_GUARDRAIL>",
    ].join("\n");
  }

  private shouldBypassTaskPruningForLikelySource(
    lowerName: string,
    lines: string[],
    commandHint?: string,
  ): boolean {
    const cmd = (commandHint ?? "").toLowerCase();
    const isCodeReadCommand = /\b(cat|sed|awk|head|tail|less|more|bat|nl)\b/.test(cmd);
    const isShellLikeTool = lowerName.includes("bash") || lowerName.includes("run_command") || lowerName.includes("shell");
    const isDirectReadTool =
      lowerName === "read" || lowerName === "read_file" || lowerName === "readfile"
      || lowerName.startsWith("read_file") || lowerName.startsWith("file_read");
    const isArtifactFetch =
      (lowerName === "webfetch" || lowerName === "web_fetch" || lowerName === "fetch")
      && cmd.includes("artifact://");
    if (!isCodeReadCommand && !isShellLikeTool && !isDirectReadTool && !isArtifactFetch) return false;
    if (isDirectReadTool || isArtifactFetch) return true;
    if (isCodeReadCommand && isShellLikeTool) return true;
    // Keep full go test / build / lint stderr when stderr-like signals exist — task pruning
    // would otherwise drop the tail of the failure the model needs to fix the root cause.
    if (isShellLikeTool && this.hasDiagnosticSignals(lines)) return true;
    if (this.hasDiagnosticSignals(lines)) return false;
    return this.looksLikeSourceCode(lines);
  }

  private hasDiagnosticSignals(lines: string[]): boolean {
    const signalRe = /\b(exception|panic|traceback|stderr|timeout|denied|unauthorized|forbidden)\b|error:/i;
    for (const line of lines.slice(0, 220)) {
      if (signalRe.test(line)) return true;
      if (/^\s*(FAIL|E\s{2,}|✗|×)\b/.test(line)) return true;
    }
    return false;
  }

  private looksLikeSourceCode(lines: string[]): boolean {
    const sample = lines.slice(0, 220);
    if (sample.length === 0) return false;
    const codeLineRe =
      /^\s*(#!\/.*(bash|sh|zsh)|package\s+[\w.]+|import\s+[\w"{].*|from\s+\w+|export\s+|class\s+\w+|interface\s+\w+|type\s+\w+|trait\s+\w+|impl\s+\w+|struct\s+\w+|enum\s+\w+|func\s+\w+|fn\s+\w+|def\s+\w+|const\s+\w+|let\s+\w+|var\s+\w+|public\s+\w+|private\s+\w+|protected\s+\w+|namespace\s+\w+|using\s+[\w.]+;|#include\s+[<"]|\/\/|\/\*|\*\/|if\s+__name__\s*==\s*["']__main__["'])/;
    let codeLike = 0;
    for (const line of sample) {
      if (codeLineRe.test(line)) {
        codeLike += 1;
        continue;
      }
      if ((line.includes("{") && line.includes("}")) || /;\s*$/.test(line) || /=>\s*\{?/.test(line)) {
        codeLike += 1;
      }
    }
    return codeLike >= 8 && codeLike / sample.length >= 0.12;
  }

  private extractTaskTokens(taskCue: string): string[] {
    const stop = new Set([
      "the", "and", "for", "with", "from", "that", "this", "have", "into", "then", "than",
      "tool", "tests", "test", "code", "file", "files", "should", "could", "would", "about",
      "please", "update", "build", "suite",
    ]);
    const parts = taskCue
      .toLowerCase()
      .split(/[^a-z0-9_./:-]+/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 3 && !stop.has(p));
    return [...new Set(parts)].slice(0, 20);
  }

  /**
   * Claude Code caches file reads and returns "Unchanged since last read"
   * instead of re-sending the content. This breaks when Yarn has pruned the
   * original read from the context — the model sees a stub but has no content.
   * Detect these stubs and replace with a recovery hint.
   */
  private applyReadCacheStubRemediation(
    toolName: string | undefined,
    raw: string,
  ): string | null {
    if (raw.includes('"kind":"synesis_file_read"') || raw.includes('"kind": "synesis_file_read"')) {
      return null;
    }
    const trimmed = raw.trim().toLowerCase();
    if (
      trimmed.includes("<file_unchanged") ||
      trimmed.includes("unchanged since last read") ||
      trimmed.includes("file unchanged")
    ) {
      const pathMatch = raw.match(/path="([^"]+)"/i);
      const extractedPath = pathMatch?.[1] ?? null;
      const catTarget = extractedPath ?? "<file_path>";
      return [
        `<SYNESIS_TOOL_GUARDRAIL status="guided" code="read_cache_stub" version="1">`,
        `tool=${toolName ?? "Read"}`,
        ...(extractedPath ? [`file_path=${extractedPath}`] : []),
        `reason=client_returned_cache_stub`,
        `next_action=use_bash_cat_to_read_file_content`,
        `[Cache stub] The client returned "Unchanged since last read" instead of file content.`,
        `The previous read was pruned from context so you do not have the content.`,
        `Use Bash(cat ${catTarget}) to retrieve the full file content.`,
        `</SYNESIS_TOOL_GUARDRAIL>`,
      ].join("\n");
    }
    return null;
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

/**
 * Build a set of message indices for the most recent N tool results.
 * These are exempt from task-conditioned pruning to prevent the agent
 * from seeing stubs of content it just read and re-reading in a loop.
 */
function computeRecentToolProtectedSet(
  messages: ToolResultLike[],
  recentCount: number,
): Set<number> {
  if (recentCount <= 0) return new Set();
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolIndices.push(i);
  }
  const startFrom = Math.max(0, toolIndices.length - recentCount);
  return new Set(toolIndices.slice(startFrom));
}
