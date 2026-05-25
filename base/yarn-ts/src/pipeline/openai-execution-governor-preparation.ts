import type { AppConfig } from "../config.js";
import type { ExecutionGovernorDecision, GovernorInputMessage } from "../governance/execution-governor.js";
import {
  disabledExecutionGovernorDecision,
} from "../governance/governor-service.js";
import { deriveGovernorLoopObservability } from "../governance/governor-observability.js";

type ConfigSlice = Pick<
  AppConfig,
  | "SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED"
  | "SYNESIS_YARN_GOVERNANCE_DISABLED"
  | "SYNESIS_YARN_GOVERNANCE_PROFILE"
>;

type SessionLike = {
  lastGovernorCachedResult: ExecutionGovernorDecision | null;
  lastGovernorNoPauseAt: number;
  blockBroadVerificationUntilEdit?: boolean;
  consecutiveRecoveryFires: number;
  blockFailingVerificationUntilEdit?: boolean;
  consecutiveEditContextMisses: number;
  editMissForceReadPending?: boolean;
  lastEvidenceDelta: unknown;
  taskLedger?: { tasks: Array<{ status: string }> } | null;
};

type SpanLike = {
  setAttribute(name: string, value: unknown): void;
};

export interface OpenAIExecutionGovernorPreparationInput {
  config: ConfigSlice;
  session: SessionLike;
  sessionKey: string;
  identity: {
    userId: string;
    orgId: string;
    clientKind?: string;
    conversationId?: string;
  };
  requestId: string;
  headers: Record<string, unknown>;
  pipelineMode: string;
  taskCue: unknown;
  scopedMessages: unknown[];
  planGraph?: { activeStage?: unknown } | null;
  editMissGuard?: { active?: boolean } | null;
  latestToolProgress: { hasRecentEditContextMiss?: boolean };
  toolFailures: Array<{ reason?: string }>;
  artifactShadows: unknown;
  chatState: unknown;
  fileState: unknown;
  workingPhase?: string;
  editMissFailureCount: number;
  governorCooldownMs: number;
  stateConfidence: {
    chatConfidence: number;
    fileConfidence: number;
    overallConfidence: number;
    recommendedReadPath?: string | null;
  };
  needsStateReground: boolean;
  objectiveScope: {
    epochId: unknown;
    boundaryIndex: unknown;
    retainedEvidenceCount: unknown;
    droppedPreBoundaryCount: unknown;
  };
  artifactContext: unknown;
  pauseSummaries: {
    chat: unknown;
    file: unknown;
  };
  shouldRunGovernorForMode(mode: string): boolean;
  governorService: {
    beforeProviderCall(ctx: unknown, request: unknown): Promise<{ execution?: ExecutionGovernorDecision | null }>;
  };
  withSpanAsync<T>(name: string, attributes: Record<string, unknown>, fn: (span: SpanLike) => Promise<T>): Promise<T>;
  summarizeEvidenceDelta(delta: unknown): unknown;
  recordSessionEvent(
    sessionKey: string,
    userId: string,
    orgId: string,
    eventKind: string,
    component: string,
    detail: string,
    requestId?: string,
    metadataJson?: Record<string, unknown>,
  ): void;
  buildGovernorPauseResumeBlockForUser(session: unknown, latestUserPrompt: string): string | null;
}

export interface OpenAIExecutionGovernorPreparationResult {
  executionGovernor: ExecutionGovernorDecision;
  governorPauseResumeBlock: string | null;
}

export async function prepareOpenAIExecutionGovernor(
  input: OpenAIExecutionGovernorPreparationInput,
): Promise<OpenAIExecutionGovernorPreparationResult> {
  const governorPauseResumeBlock = input.buildGovernorPauseResumeBlockForUser(
    input.session as never,
    typeof input.taskCue === "string" ? input.taskCue : "",
  );
  const governorPauseSummaryRequested = Boolean(governorPauseResumeBlock);
  const governorCooldownActive =
    input.session.lastGovernorCachedResult
    && !input.session.lastGovernorCachedResult.pause
    && (Date.now() - input.session.lastGovernorNoPauseAt) < input.governorCooldownMs;
  const pipelineContext = {
    requestId: input.requestId,
    mode: input.pipelineMode,
    userId: input.identity.userId,
    orgId: input.identity.orgId,
    clientKind: input.identity.clientKind,
    conversationId: input.identity.conversationId,
    sessionKey: input.sessionKey,
    startedAt: Date.now(),
    headers: input.headers,
  };
  let executionGovernor = input.config.SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED
    && !input.config.SYNESIS_YARN_GOVERNANCE_DISABLED
    && input.shouldRunGovernorForMode(input.pipelineMode)
    ? (governorCooldownActive
      ? input.session.lastGovernorCachedResult!
      : await input.withSpanAsync("yarn.execution_governor.evaluate", {}, async (govSpan) => {
        const governorDecision = await input.governorService.beforeProviderCall(
          pipelineContext,
          {
            messages: input.scopedMessages as Array<GovernorInputMessage>,
            options: {
              profile: input.config.SYNESIS_YARN_GOVERNANCE_PROFILE,
              activePlanStage: input.planGraph?.activeStage ?? null,
              editContextMissActive:
                input.editMissGuard?.active === true
                || input.latestToolProgress.hasRecentEditContextMiss
                || input.session.editMissForceReadPending
                || input.toolFailures.some((failure) => failure.reason === "edit_context_miss"),
              artifactShadows: input.artifactShadows,
              chatState: input.chatState,
              fileState: input.fileState,
              orchestratorWorkflowPhase: input.workingPhase,
              taskLedgerOpenCount: input.session.taskLedger
                ? input.session.taskLedger.tasks.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "unknown").length
                : undefined,
            },
          },
        );
        const decision = governorDecision.execution ?? disabledExecutionGovernorDecision();
        if (!decision.pause) {
          input.session.lastGovernorNoPauseAt = Date.now();
          input.session.lastGovernorCachedResult = decision;
        } else {
          input.session.lastGovernorCachedResult = null;
        }
        if (input.workingPhase) govSpan.setAttribute("governor.orchestrator_workflow_phase", input.workingPhase);
        govSpan.setAttribute("governor.pause", decision.pause);
        govSpan.setAttribute("governor.reason", decision.reason ?? "");
        govSpan.setAttribute("governor.matched_rules", decision.matchedRules.join(","));
        govSpan.setAttribute("governor.phase", decision.telemetry.phase);
        govSpan.setAttribute("governor.trailing_verification_run", decision.telemetry.trailingVerificationRunLength);
        govSpan.setAttribute("governor.no_edit_evidence", decision.telemetry.noEditEvidence);
        return decision;
      }))
    : disabledExecutionGovernorDecision();

  if (
    executionGovernor.matchedRules.includes("verification_green_repeat_block")
    || executionGovernor.matchedRules.includes("verification_already_green")
  ) {
    input.session.blockBroadVerificationUntilEdit = true;
  }
  if (
    input.session.consecutiveRecoveryFires >= 2
    && (
      executionGovernor.matchedRules.includes("verification_fail_repeat_block")
      || executionGovernor.matchedRules.includes("verification_same_failure_signature_replay")
      || executionGovernor.matchedRules.includes("verification_churn_no_edit")
    )
  ) {
    input.session.blockFailingVerificationUntilEdit = true;
  }
  if (
    (input.editMissFailureCount >= 2 || input.session.consecutiveEditContextMisses >= 2)
    && !executionGovernor.matchedRules.includes("edit_failure_replay")
  ) {
    executionGovernor = {
      ...executionGovernor,
      pause: true,
      reason: "edit_failure_replay",
      matchedRules: ["edit_failure_replay", ...new Set(executionGovernor.matchedRules)],
      suggestedNextStep:
        executionGovernor.suggestedNextStep
        ?? "Repeated edit anchor failures detected. Read the file once, choose an exact current anchor, and apply one focused edit. If the behavior is already present, verify and move on.",
    };
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "execution_governor_edit_miss_override",
      "execution-governor",
      `Forced edit_failure_replay (turn_misses=${input.editMissFailureCount}, consecutive_turn_misses=${input.session.consecutiveEditContextMisses})`,
      input.requestId,
      {
        edit_miss_failures: input.editMissFailureCount,
        consecutive_turn_edit_miss_failures: input.session.consecutiveEditContextMisses,
        matched_rules: executionGovernor.matchedRules,
      },
    );
  }
  if (governorPauseSummaryRequested && executionGovernor.pause) {
    const priorRules = executionGovernor.matchedRules;
    executionGovernor = {
      ...executionGovernor,
      pause: false,
      reason: "user_requested_governor_summary",
      matchedRules: ["user_requested_governor_summary"],
      suggestedNextStep: "Summarize current status without tool calls, edits, or command retries.",
    };
    input.session.lastGovernorCachedResult = null;
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "governor_pause_summary_resume",
      "execution-governor",
      `Allowed explicit summarize/status reply after pause (prior_rules=${priorRules.slice(0, 3).join(",") || "unknown"})`,
      input.requestId,
      {
        prior_matched_rules: priorRules,
        summary_resume: true,
      },
    );
  }
  const loopObs = deriveGovernorLoopObservability(
    input.scopedMessages as Array<{ role: string; tool_calls?: unknown }>,
  );
  input.recordSessionEvent(
    input.sessionKey,
    input.identity.userId,
    input.identity.orgId,
    "execution_governor_evaluated",
    "execution-governor",
    `phase=${executionGovernor.telemetry.phase} rules=${executionGovernor.matchedRules.join(",") || "allow"} pause=${executionGovernor.pause}`,
    input.requestId,
    {
      pause: executionGovernor.pause,
      reason: executionGovernor.reason,
      phase: executionGovernor.telemetry.phase,
      matched_rules: executionGovernor.matchedRules,
      suggested_next_step: executionGovernor.suggestedNextStep?.slice(0, 200),
      has_run_test: loopObs.hasRunTest,
      last_assistant_tool_calls: loopObs.lastAssistantToolCalls,
      assistant_tool_calls_since_latest_user: loopObs.assistantToolCallsSinceLatestUser,
      objective_epoch_id: input.objectiveScope.epochId,
      objective_scope_boundary_index: input.objectiveScope.boundaryIndex,
      objective_scope_retained_evidence: input.objectiveScope.retainedEvidenceCount,
      objective_scope_dropped_pre_boundary: input.objectiveScope.droppedPreBoundaryCount,
      state_confidence_chat: input.stateConfidence.chatConfidence,
      state_confidence_file: input.stateConfidence.fileConfidence,
      state_confidence_overall: input.stateConfidence.overallConfidence,
      state_confidence_needs_reground: input.needsStateReground,
      state_confidence_recommended_path: input.stateConfidence.recommendedReadPath,
      evidence_delta: input.summarizeEvidenceDelta(input.session.lastEvidenceDelta),
      artifact_context: input.artifactContext,
      chat_state_summary: input.pauseSummaries.chat,
      file_state_summary: input.pauseSummaries.file,
      telemetry: executionGovernor.telemetry,
    },
  );
  if (executionGovernor.matchedRules.includes("discovery_churn_nudge")) {
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "discovery_churn_guard_nudge",
      "execution-governor",
      `Nudge-only discovery churn detected (explore_trail=${executionGovernor.telemetry.trailingExplorationRunLength ?? 0}, repeated_reads=${executionGovernor.telemetry.repeatedReadSearchCalls})`,
      input.requestId,
      {
        phase: executionGovernor.telemetry.phase,
        matched_rules: executionGovernor.matchedRules,
        trailing_exploration_run_length: executionGovernor.telemetry.trailingExplorationRunLength ?? 0,
        repeated_read_search_calls: executionGovernor.telemetry.repeatedReadSearchCalls,
        repeated_broad_discovery_calls: executionGovernor.telemetry.repeatedBroadDiscoveryCalls,
        total_broad_discovery_calls: executionGovernor.telemetry.totalBroadDiscoveryCalls,
        suggested_next_step: executionGovernor.suggestedNextStep?.slice(0, 200),
      },
    );
  }

  return {
    executionGovernor,
    governorPauseResumeBlock,
  };
}
