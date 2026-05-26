import type { ChatState } from "../governance/chat-state.js";
import {
  buildBudgetPolicy,
  evaluateContextBudget,
  type BudgetEvaluation,
  type CompactionMode,
  type ContextBudgetMessage,
} from "../governance/context-budget-manager.js";
import { buildRetentionContext } from "../governance/context-retention.js";
import type { FileState } from "../governance/file-state.js";
import type { TranscriptPruningService } from "../reduction/transcript-pruning.js";
import type { ArtifactStore } from "../state/artifact-store.js";
import type { UpperHarnessDecision, YarnUpperHarnessContext } from "../upper-harness/bridge.js";
import { evaluateUpperHarnessBudget } from "../upper-harness/bridge.js";
import type { ModelExecutionPolicy } from "../providers/model-architecture-profile.js";
import {
  evaluateContextAdmission,
  type ContextAdmissionMessage,
  type ContextAdmissionResult,
} from "./context-admission.js";

export type RouteContextAdmissionSurface = "openai" | "claude";

export interface RouteContextAdmissionStats {
  checked: number;
  warned: number;
  rejected: number;
  byPath: Record<RouteContextAdmissionSurface, number>;
}

export interface RouteContextAdmissionLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
}

export interface RunRouteContextAdmissionInput<TMessage extends ContextBudgetMessage> {
  surface: RouteContextAdmissionSurface;
  messages: TMessage[];
  tools: unknown[];
  sessionKey: string;
  logRequestId: string;
  metadata: Record<string, unknown>;
  chatState: ChatState;
  fileState: FileState;
  artifactStore: ArtifactStore;
  contextBudgetEnabled: boolean;
  modelContextCeilingTokens?: number | null;
  budgetCeilingTokens: number;
  outputReserveTokens: number;
  admissionMode: "advisory" | "hybrid" | "enforced";
  admissionWarnTokens: number;
  admissionHardTokens: number;
  compactionMode: CompactionMode;
  modelExecutionPolicy?: ModelExecutionPolicy | null;
  cachePolicyRecord: Record<string, unknown>;
  upperHarnessContext: YarnUpperHarnessContext;
  upperHarnessCeilingTokens?: number | null;
  stats: RouteContextAdmissionStats;
  backendModelHint?: string;
  transcriptPruning: Pick<TranscriptPruningService, "emergencyPrune">;
  logger: RouteContextAdmissionLogger;
  recordSessionEvent(
    eventKind: string,
    component: string,
    detail: string,
    metadataJson?: Record<string, unknown>,
  ): void;
  recordUpperHarnessDecision(
    label: string,
    decision: UpperHarnessDecision,
    options?: { recordAllow?: boolean },
  ): void;
  forceCheckpoint(): void | Promise<void>;
}

export interface RouteContextAdmissionResult<TMessage extends ContextBudgetMessage> {
  messages: TMessage[];
  budgetEvaluation: BudgetEvaluation | null;
  contextAdmission: ContextAdmissionResult;
  rejected: boolean;
}

export function runRouteContextAdmission<TMessage extends ContextBudgetMessage>(
  input: RunRouteContextAdmissionInput<TMessage>,
): RouteContextAdmissionResult<TMessage> {
  let messages = input.messages;
  let budgetEvaluation: BudgetEvaluation | null = null;

  if (input.contextBudgetEnabled) {
    const configuredCeiling = input.modelContextCeilingTokens
      ?? (input.budgetCeilingTokens > 0
        ? input.budgetCeilingTokens
        : input.admissionHardTokens);
    const architectureCeiling = input.modelExecutionPolicy?.effectiveContextCeilingTokens;
    const budgetCeiling = architectureCeiling && architectureCeiling > 0
      ? Math.min(configuredCeiling, architectureCeiling)
      : configuredCeiling;
    const compactionMode = input.modelExecutionPolicy?.compactionMode === "aggressive"
      ? "aggressive"
      : input.compactionMode;
    if (budgetCeiling !== configuredCeiling || compactionMode !== input.compactionMode) {
      input.recordSessionEvent(
        "model_architecture_policy_applied",
        "model-architecture",
        `ceiling=${budgetCeiling}/${configuredCeiling} compaction=${compactionMode}`,
        {
          profile_id: input.modelExecutionPolicy?.profileId,
          policy_hash: input.modelExecutionPolicy?.policyHash,
          effective_context_ceiling_tokens: budgetCeiling,
          configured_context_ceiling_tokens: configuredCeiling,
          compaction_mode: compactionMode,
          configured_compaction_mode: input.compactionMode,
          reasons: input.modelExecutionPolicy?.reasons ?? [],
        },
      );
    }
    const budgetPolicy = buildBudgetPolicy(budgetCeiling, input.outputReserveTokens, compactionMode);
    const planPaths = input.metadata.plan_file_path
      ? [input.metadata.plan_file_path as string]
      : [];
    const retentionContext = buildRetentionContext(
      messages,
      input.chatState.currentFocusPaths,
      planPaths,
    );
    const budgetResult = evaluateContextBudget({
      messages,
      tools: input.tools,
      policy: budgetPolicy,
      retentionContext,
      heavyCompactionContext: {
        sessionKey: input.sessionKey,
        chatState: input.chatState,
        fileState: input.fileState,
        objectiveEpoch: {
          epochId: Number(input.metadata.objective_epoch_id ?? 0),
          objectiveHash: "",
          objectiveText: String(input.chatState.activeObjective ?? ""),
          anchorUserHash: "",
          objectiveSetRequest: 0,
          objectiveChanged: false,
          similarityToPrevious: 1,
          pruningCheckpoint: { frozenBoundaryIndex: 0, frozenAtRequest: 0, frozenMessageCount: 0 },
        },
      },
      enableCompaction: true,
      artifactStore: input.artifactStore,
      compactionMode,
    });
    budgetEvaluation = budgetResult.evaluation;
    if (budgetEvaluation.compactionApplied !== "none") {
      messages = budgetResult.messages as TMessage[];
    }
    input.recordSessionEvent(
      "context_budget_evaluated",
      "context-budget",
      `zone=${budgetEvaluation.zone} tokens=${budgetEvaluation.estimate.totalTokens} headroom=${budgetEvaluation.headroomTokens} compaction=${budgetEvaluation.compactionApplied} recovered=${budgetEvaluation.tokensRecovered}`,
      {
        zone: budgetEvaluation.zone,
        estimatedTokens: budgetEvaluation.estimate.totalTokens,
        headroomTokens: budgetEvaluation.headroomTokens,
        compactionApplied: budgetEvaluation.compactionApplied,
        tokensRecovered: budgetEvaluation.tokensRecovered,
        cachePolicy: input.cachePolicyRecord,
        modelExecutionPolicy: input.modelExecutionPolicy
          ? {
              profileId: input.modelExecutionPolicy.profileId,
              policyHash: input.modelExecutionPolicy.policyHash,
              attention: input.modelExecutionPolicy.attention,
              activation: input.modelExecutionPolicy.activation,
              decoding: input.modelExecutionPolicy.decoding,
              reasons: input.modelExecutionPolicy.reasons,
            }
          : undefined,
      },
    );
    if (budgetEvaluation.checkpoint) {
      input.recordSessionEvent(
        "context_checkpoint_created",
        "context-budget",
        `id=${budgetEvaluation.checkpoint.checkpointId} compacted=${budgetEvaluation.checkpoint.compactedMessageCount}`,
      );
    }
  }

  const contextAdmission = evaluateContextAdmission(
    messages as ContextAdmissionMessage[],
    input.tools,
    input.admissionMode,
    input.admissionWarnTokens,
    input.admissionHardTokens,
  );
  const upperBudgetDecision = evaluateUpperHarnessBudget({
    context: input.upperHarnessContext,
    estimatedInputTokens: contextAdmission.estimatedTokens,
    ceilingTokens: input.modelExecutionPolicy?.effectiveContextCeilingTokens
      ?? input.upperHarnessCeilingTokens
      ?? (input.budgetCeilingTokens > 0 ? input.budgetCeilingTokens : input.admissionHardTokens),
    outputReserveTokens: input.outputReserveTokens,
  });
  input.recordUpperHarnessDecision(
    `upper-harness:${input.surface}-budget`,
    upperBudgetDecision.decision,
    { recordAllow: true },
  );
  input.stats.checked += 1;
  input.stats.byPath[input.surface] += 1;

  if (contextAdmission.decision === "warn") {
    input.stats.warned += 1;
    input.logger.warn(
      {
        requestId: input.logRequestId,
        estimatedTokens: contextAdmission.estimatedTokens,
        estimatedChars: contextAdmission.estimatedChars,
        reason: contextAdmission.reason,
      },
      `context_admission_warn_${input.surface}`,
    );
    const budgetAlreadyCompacted = budgetEvaluation?.compactionApplied !== "none"
      && budgetEvaluation?.compactionApplied !== undefined;
    if (!budgetAlreadyCompacted) {
      const hardCharBudget = input.admissionHardTokens * 4;
      const emergencyResult = input.transcriptPruning.emergencyPrune(
        messages,
        hardCharBudget,
        input.backendModelHint,
        input.compactionMode,
      );
      if (emergencyResult.pruned) {
        messages = emergencyResult.messages as TMessage[];
        input.logger.info(
          {
            requestId: input.logRequestId,
            charsBefore: emergencyResult.charsBefore,
            charsAfter: emergencyResult.charsAfter,
            charsSaved: emergencyResult.charsBefore - emergencyResult.charsAfter,
          },
          `context_admission_emergency_prune_${input.surface}`,
        );
        input.recordSessionEvent(
          "emergency_context_prune",
          "context-admission",
          `Pruned ${emergencyResult.charsBefore - emergencyResult.charsAfter} chars (${emergencyResult.charsBefore} → ${emergencyResult.charsAfter}) to avoid hard limit (fallback — budget manager inactive)`,
        );
      }
    } else {
      input.logger.info(
        {
          requestId: input.logRequestId,
          budgetZone: budgetEvaluation?.zone,
          tokensRecovered: budgetEvaluation?.tokensRecovered,
        },
        `context_admission_warn_budget_manager_handled_${input.surface}`,
      );
    }
    void input.forceCheckpoint();
  }

  if (contextAdmission.decision === "reject") {
    input.stats.rejected += 1;
    input.logger.warn(
      {
        requestId: input.logRequestId,
        estimatedTokens: contextAdmission.estimatedTokens,
        estimatedChars: contextAdmission.estimatedChars,
        reason: contextAdmission.reason,
      },
      `context_admission_reject_${input.surface}`,
    );
  }

  return {
    messages,
    budgetEvaluation,
    contextAdmission,
    rejected: contextAdmission.decision === "reject",
  };
}
