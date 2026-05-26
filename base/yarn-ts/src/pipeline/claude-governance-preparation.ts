import type { AppConfig } from "../config.js";
import type { ExecutionGovernorDecision, GovernorInputMessage } from "../governance/execution-governor.js";
import { disabledExecutionGovernorDecision } from "../governance/governor-service.js";
import { deriveGovernorLoopObservability } from "../governance/governor-observability.js";
import type { SensemakingDecision } from "../governance/sensemaking-governor.js";

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
  diffStats: {
    filesModified: number;
    filesDeleted: number;
    netLinesRemoved: number;
    totalLinesChanged: number;
  };
  scopeEnvelope: unknown;
};

type SpanLike = {
  setAttribute(name: string, value: unknown): void;
};

export interface ClaudeGovernancePreparationInput {
  config: Pick<
    AppConfig,
    | "SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED"
    | "SYNESIS_YARN_GOVERNANCE_DISABLED"
    | "SYNESIS_YARN_GOVERNANCE_PROFILE"
    | "SYNESIS_YARN_PROPORTIONALITY_ENABLED"
  >;
  session: SessionLike;
  sessionKey: string;
  identity: { userId: string; orgId: string };
  requestId: string;
  modelAdapterFamily?: string | null;
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
  governorCooldownMs: number;
  buildGovernorPauseResumeBlockForUser(session: unknown, latestUserPrompt: string): string | null;
  evaluateExecutionGovernor(messages: GovernorInputMessage[], options: unknown): ExecutionGovernorDecision;
  withSpan<T>(name: string, attributes: Record<string, unknown>, fn: (span: SpanLike) => T): T;
  extractCommandEvents(messages: GovernorInputMessage[]): unknown[];
  extractEditedFileHints(events: unknown[]): unknown[];
  isPlanRecoveryDiscoveryIntent(text: string): boolean;
  assessProportionality(diffStats: unknown, scopeEnvelope: unknown): {
    level: string;
    breaches: string[];
  } | null;
  proportionalityToSignal(level: string): unknown;
  evaluateSensemakingGovernor(
    executionGovernor: ExecutionGovernorDecision,
    events: unknown[],
    turnsSinceLastUser: number,
    changedFileCount: number,
    planRecoveryGrace: boolean,
    reserved: null,
    proportionalitySignal: unknown,
  ): SensemakingDecision;
  compareSensemakingWithLegacy(executionGovernor: ExecutionGovernorDecision, decision: SensemakingDecision): {
    frictionScore: unknown;
    productiveMomentum: unknown;
    agreement: unknown;
    [key: string]: unknown;
  };
  countTurnsSinceLastUser(messages: readonly { role: string }[]): number;
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
}

export async function prepareClaudeGovernance(
  input: ClaudeGovernancePreparationInput,
): Promise<{
  executionGovernor: ExecutionGovernorDecision;
  governorPauseResumeBlock: string | null;
  sensemakingDecision: SensemakingDecision | null;
}> {
  const governorPauseResumeBlock = input.buildGovernorPauseResumeBlockForUser(
    input.session,
    typeof input.taskCue === "string" ? input.taskCue : "",
  );
  const governorPauseSummaryRequested = Boolean(governorPauseResumeBlock);
  const governorCooldownActive =
    input.session.lastGovernorCachedResult
    && !input.session.lastGovernorCachedResult.pause
    && (Date.now() - input.session.lastGovernorNoPauseAt) < input.governorCooldownMs;
  let executionGovernor = input.config.SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED && !input.config.SYNESIS_YARN_GOVERNANCE_DISABLED
    ? (governorCooldownActive
      ? input.session.lastGovernorCachedResult!
      : input.withSpan("yarn.execution_governor.evaluate", {}, (govSpan) => {
        const decision = input.evaluateExecutionGovernor(
          input.scopedMessages as Array<GovernorInputMessage>,
          {
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
            modelAdapterFamily: input.modelAdapterFamily,
            orchestratorWorkflowPhase: input.workingPhase,
            taskLedgerOpenCount: input.session.taskLedger
              ? input.session.taskLedger.tasks.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "unknown").length
              : undefined,
          },
        );
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

  let sensemakingDecision: SensemakingDecision | null = null;
  if (input.config.SYNESIS_YARN_EXECUTION_GOVERNOR_ENABLED && !input.config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const govEvents = input.extractCommandEvents(
      (input.scopedMessages as GovernorInputMessage[]).slice(
        Math.max(0, (input.scopedMessages as GovernorInputMessage[]).length - 50),
      ),
    );
    const govChangedFiles = input.extractEditedFileHints(govEvents);
    const planRecoveryGrace = input.isPlanRecoveryDiscoveryIntent(
      typeof input.taskCue === "string" ? input.taskCue : "",
    ) && govChangedFiles.length === 0 && govEvents.length <= 30;
    const proportionality = input.config.SYNESIS_YARN_PROPORTIONALITY_ENABLED
      ? input.assessProportionality(input.session.diffStats, input.session.scopeEnvelope)
      : null;
    const proportionalitySignal = proportionality
      ? input.proportionalityToSignal(proportionality.level)
      : null;

    sensemakingDecision = input.evaluateSensemakingGovernor(
      executionGovernor,
      govEvents,
      input.countTurnsSinceLastUser(input.scopedMessages as readonly { role: string }[]),
      govChangedFiles.length,
      planRecoveryGrace,
      null,
      proportionalitySignal,
    );
    const comparison = input.compareSensemakingWithLegacy(executionGovernor, sensemakingDecision);
    input.recordSessionEvent(
      input.sessionKey,
      input.identity.userId,
      input.identity.orgId,
      "sensemaking_governor_evaluated",
      "sensemaking-governor",
      `domain=${sensemakingDecision.domain} response=${sensemakingDecision.responseLevel} friction=${comparison.frictionScore} momentum=${comparison.productiveMomentum} legacy_agreement=${comparison.agreement}`,
      input.requestId,
      {
        ...comparison,
        guidance: sensemakingDecision.guidance?.slice(0, 200),
        shouldPause: sensemakingDecision.shouldPause,
        shouldRestrictDiscovery: sensemakingDecision.shouldRestrictDiscovery,
        planRecoveryGrace,
      },
    );
    if (proportionality && proportionality.level !== "proportional") {
      input.recordSessionEvent(
        input.sessionKey,
        input.identity.userId,
        input.identity.orgId,
        "proportionality_check",
        "proportionality",
        `level=${proportionality.level} scope=${input.session.scopeEnvelope} files=${input.session.diffStats.filesModified} deleted=${input.session.diffStats.filesDeleted} net_removed=${input.session.diffStats.netLinesRemoved} breaches=${proportionality.breaches.join(";")}`,
        input.requestId,
        {
          level: proportionality.level,
          scopeEnvelope: input.session.scopeEnvelope,
          filesModified: input.session.diffStats.filesModified,
          filesDeleted: input.session.diffStats.filesDeleted,
          netLinesRemoved: input.session.diffStats.netLinesRemoved,
          totalLinesChanged: input.session.diffStats.totalLinesChanged,
          breaches: proportionality.breaches,
          signal: proportionalitySignal,
        },
      );
    }
  }

  return {
    executionGovernor,
    governorPauseResumeBlock,
    sensemakingDecision,
  };
}
