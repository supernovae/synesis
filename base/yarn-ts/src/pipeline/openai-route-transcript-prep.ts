import { inferModelFamily } from "../prompt/infer-model-family.js";
import type { CapabilityKey, CapabilityMatrixDocument } from "../policy/capability-matrix.js";
import { resolveCapabilityMatrix, type CapabilityMatrixResolution } from "../policy/capability-matrix.js";
import type { ReduceMessagesOpts, ToolResultReductionResult, ToolResultReductionService } from "../reduction/tool-result-reducer.js";
import type { TranscriptPruningService } from "../reduction/transcript-pruning.js";
import type { ValidationNormalizationService } from "../validation/service.js";
import type { EnrichmentPool } from "../workers/pool.js";
import type { OpenAIChatCompletionRequest } from "../schemas.js";
import { withSpan, withSpanAsync } from "../telemetry/otel.js";
import type { OptimizationLedger } from "../telemetry/optimization-ledger.js";

interface OpenAIRouteTranscriptPrepLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
}

type MessageWithContent = { role: string; name?: string; tool_call_id?: string; content: unknown };

export interface OpenAIRouteTranscriptPrepConfig {
  SYNESIS_YARN_GOVERNANCE_DISABLED: boolean;
  SYNESIS_YARN_REDUCERS_ENABLED: boolean;
  SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED: boolean;
  SYNESIS_YARN_DEDUPE_ENABLED: boolean;
  SYNESIS_YARN_RESPONSE_DEDUPE_ENABLED: boolean;
}

export interface OpenAIRouteTranscriptPrepInput {
  request: OpenAIChatCompletionRequest;
  requestId: string;
  taskCue: string;
  backendModelHint?: string;
  pruningWatermark?: number;
  config: OpenAIRouteTranscriptPrepConfig;
  capabilityMatrix: CapabilityMatrixDocument | null | undefined;
  enrichmentPool: EnrichmentPool;
  toolResultReduction: ToolResultReductionService;
  validationNormalization: ValidationNormalizationService;
  transcriptPruning: TranscriptPruningService;
  validationTierCFallback?: Parameters<ValidationNormalizationService["normalizeMessagesAsync"]>[1];
  optimizationLedger: OptimizationLedger;
  endNormalizationStage?: () => void;
  startPruningStage?: () => () => void;
  logger: OpenAIRouteTranscriptPrepLogger;
}

export interface OpenAIRouteTranscriptPrepResult {
  compactionOpts: ReduceMessagesOpts;
  matrixModelPath: string;
  matrixModelId: string;
  matrixFamily: string;
  capabilityResolution: CapabilityMatrixResolution;
  reducersEnabled: boolean;
  transcriptPruneEnabled: boolean;
  phasePolicyEnabledByMatrix: boolean;
  contentDedupeEnabled: boolean;
  responseDedupeEnabled: boolean;
  historicalNormalizeEnabled: boolean;
  reducedOpenAI: ToolResultReductionResult;
  normalizedOpenAI: Awaited<ReturnType<ValidationNormalizationService["normalizeMessagesAsync"]>>;
  toolResultCount: number;
  endPruningStage?: () => void;
}

function isMatrixCapabilityEnabled(
  governanceDisabled: boolean,
  mode: "enforced" | "shadow",
  resolvedCapabilities: Record<string, boolean>,
  key: CapabilityKey,
): boolean {
  if (governanceDisabled) return true;
  if (mode !== "enforced") return true;
  return resolvedCapabilities[key] === true;
}

export async function prepareOpenAIRouteTranscript(
  input: OpenAIRouteTranscriptPrepInput,
): Promise<OpenAIRouteTranscriptPrepResult> {
  const compactionOpts: ReduceMessagesOpts = {
    backendModelHint: input.backendModelHint,
  };
  const matrixModelPath = String(compactionOpts.backendModelHint ?? input.request.model ?? "");
  const matrixModelId = String(input.request.model ?? compactionOpts.backendModelHint ?? "");
  const matrixFamily = inferModelFamily(matrixModelPath || matrixModelId);
  const capabilityResolution = resolveCapabilityMatrix(
    input.capabilityMatrix,
    {
      model_id: matrixModelId,
      model_path: matrixModelPath,
      family: matrixFamily,
    },
  );
  const reducersEnabled = input.config.SYNESIS_YARN_REDUCERS_ENABLED && isMatrixCapabilityEnabled(
    input.config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.reducers_enabled",
  );
  const transcriptPruneEnabled = isMatrixCapabilityEnabled(
    input.config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.transcript_prune_enabled",
  );
  const phasePolicyEnabledByMatrix = isMatrixCapabilityEnabled(
    input.config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.phase_execution_policy_enabled",
  );
  const jsonCompactionEnabled = isMatrixCapabilityEnabled(
    input.config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.json_compaction_enabled",
  );
  const contentDedupeEnabled = input.config.SYNESIS_YARN_DEDUPE_ENABLED && isMatrixCapabilityEnabled(
    input.config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.content_dedupe_enabled",
  );
  const responseDedupeEnabled = input.config.SYNESIS_YARN_RESPONSE_DEDUPE_ENABLED && isMatrixCapabilityEnabled(
    input.config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.response_dedupe_enabled",
  );
  const historicalNormalizeEnabled = isMatrixCapabilityEnabled(
    input.config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.historical_normalize_enabled",
  );
  compactionOpts.jsonCompactionEnabled = jsonCompactionEnabled;

  const reducedOpenAI = input.config.SYNESIS_YARN_GOVERNANCE_DISABLED || !reducersEnabled
    ? { messages: input.request.messages as never, reducedCount: 0 }
    : input.enrichmentPool.isAvailable()
      ? await withSpanAsync("yarn.enrichment", { "yarn.path": "openai" }, () =>
          input.toolResultReduction.reduceMessagesAsync(
            input.request.messages as never,
            input.enrichmentPool,
            input.taskCue,
            input.pruningWatermark,
            compactionOpts,
          ),
        )
      : withSpan("yarn.enrichment", { "yarn.path": "openai" }, () =>
          input.toolResultReduction.reduceMessages(
            input.request.messages as never,
            input.taskCue,
            input.pruningWatermark,
            compactionOpts,
          ),
        );

  const toolResultCount = (input.request.messages as Array<{ role: string }>).filter((m) => m.role === "tool").length;
  if (input.config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED && reducedOpenAI.reducedCount > 0) {
    input.logger.info(
      { reqId: input.requestId, tool_result_reduced: reducedOpenAI.reducedCount },
      "yarn_harness_tool_result_reduction",
    );
  }

  const normalizedOpenAI = await input.validationNormalization.normalizeMessagesAsync(
    reducedOpenAI.messages as never,
    input.validationTierCFallback,
  );
  input.optimizationLedger.recordAfterNormalization(normalizedOpenAI.messages as Array<{ content?: unknown }>);
  input.endNormalizationStage?.();

  const endPruningStage = input.startPruningStage?.();
  if (!input.config.SYNESIS_YARN_GOVERNANCE_DISABLED && transcriptPruneEnabled) {
    const prunedOpenAI = input.transcriptPruning.prune(
      normalizedOpenAI.messages as MessageWithContent[],
      undefined,
      compactionOpts.backendModelHint,
    );
    if (prunedOpenAI.pruned) {
      normalizedOpenAI.messages = prunedOpenAI.messages as never;
    }
    if (input.config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED) {
      const d = prunedOpenAI.invocationDelta;
      if (
        prunedOpenAI.pruned
        || d.commandsDeduped > 0
        || d.fileDeduped > 0
        || d.toolResultsEvicted > 0
        || d.assistantCondensed > 0
        || d.nearDuplicatesCollapsed > 0
        || d.artifactsStored > 0
      ) {
        input.logger.info(
          { reqId: input.requestId, pruned: prunedOpenAI.pruned, transcript_prune: d },
          "yarn_harness_transcript_prune",
        );
      }
    }
  }

  return {
    compactionOpts,
    matrixModelPath,
    matrixModelId,
    matrixFamily,
    capabilityResolution,
    reducersEnabled,
    transcriptPruneEnabled,
    phasePolicyEnabledByMatrix,
    contentDedupeEnabled,
    responseDedupeEnabled,
    historicalNormalizeEnabled,
    reducedOpenAI,
    normalizedOpenAI,
    toolResultCount,
    endPruningStage,
  };
}
