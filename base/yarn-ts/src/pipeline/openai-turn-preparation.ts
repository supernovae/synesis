import type { SessionIdentity } from "../session/session-key.js";
import { isCoderClientKind } from "../session/session-key.js";
import type { SessionPathHints } from "../state/workspace-session-boundary.js";
import type { OpenAIChatCompletionsRouteDependencies } from "../server/route-dependencies.js";
import type { GovernorInputMessage } from "../governance/execution-governor.js";
import type { WorkflowPhase } from "../orchestration/phase-model-orchestrator.js";
import { extractMetadataFromMessages } from "../providers/prefix-optimizer/index.js";
import { shouldStartMissingPathWorkspaceHandshake } from "../session/workspace-handshake-route.js";
import { mergePathContextWithClientMetadata } from "./workspace-metadata-prebackfill.js";

type Deps = Pick<
  OpenAIChatCompletionsRouteDependencies,
  | "casSessionSave"
  | "classifyLatestReadRefresh"
  | "classifyLatestToolProgress"
  | "classifyToolResultAsEvidence"
  | "clientAdapterPacks"
  | "collectToolExecutionFailureObservations"
  | "config"
  | "deriveEditContextMissGuardState"
  | "evaluateYarnPromptIntakeSteer"
  | "getChecklistSourceHash"
  | "inferGovernorPhaseFromMessages"
  | "maybeBuildPlannerTodoPacketBlock"
  | "maybeUpdateTaskLedgerFromEvidence"
  | "mergeSessionPathHints"
  | "mergeSynesisClarificationFromRequestMetadata"
  | "parseOrchestratorPhaseHeader"
  | "persistPromptIntakeSnapshot"
  | "phaseFromFrame"
  | "processWorkspaceHandshakeRoute"
  | "recordPromptIntakeEvent"
  | "recordSessionEvent"
  | "refreshRequirementChecklist"
  | "refreshTaskIntake"
  | "resolveWorkingPhase"
  | "sliceMessagesSinceLastUserPrompt"
  | "toSessionExecutionContextSystemBlock"
  | "toolResultReduction"
  | "updatePlanGraph"
  | "updateTracePromptMetadata"
  | "workingFrameService"
>;

type SessionState = Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["getSessionState"]>>;
type RequestLike = {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  stream?: unknown;
  extra_body?: Record<string, unknown> | null;
};
type MessageWithToolState = {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
};

interface PrepareOpenAITurnInput {
  deps: Deps;
  session: SessionState;
  sessionKey: string;
  identity: SessionIdentity;
  requestId: string;
  request: RequestLike;
  normalizedMessages: MessageWithToolState[];
  bodyMetadata: Record<string, unknown> | null | undefined;
  latestUserText: { role: string; content: unknown } | undefined;
  latestUserPrompt: string;
  clientToolCapabilities: ReturnType<OpenAIChatCompletionsRouteDependencies["detectClientToolCapabilities"]>;
  pathContext: SessionPathHints;
  adapterProfile: ReturnType<OpenAIChatCompletionsRouteDependencies["clientAdapterPacks"]["resolve"]>;
  adapterBlock: string | undefined;
  failingVerificationSignals: ReturnType<OpenAIChatCompletionsRouteDependencies["assessVerificationSignals"]>["failingSignals"];
  headers: Record<string, unknown>;
}

export async function prepareOpenAITurn(input: PrepareOpenAITurnInput) {
  const {
    deps,
    session,
    sessionKey,
    identity,
    requestId,
    request,
    normalizedMessages,
    bodyMetadata,
    latestUserText,
    latestUserPrompt,
    clientToolCapabilities,
    pathContext,
    adapterProfile,
    adapterBlock,
    failingVerificationSignals,
    headers,
  } = input;
  const {
    casSessionSave,
    classifyLatestReadRefresh,
    classifyLatestToolProgress,
    classifyToolResultAsEvidence,
    clientAdapterPacks,
    collectToolExecutionFailureObservations,
    config,
    deriveEditContextMissGuardState,
    evaluateYarnPromptIntakeSteer,
    getChecklistSourceHash,
    inferGovernorPhaseFromMessages,
    maybeBuildPlannerTodoPacketBlock,
    maybeUpdateTaskLedgerFromEvidence,
    mergeSessionPathHints,
    mergeSynesisClarificationFromRequestMetadata,
    parseOrchestratorPhaseHeader,
    persistPromptIntakeSnapshot,
    phaseFromFrame,
    processWorkspaceHandshakeRoute,
    recordPromptIntakeEvent,
    recordSessionEvent,
    refreshRequirementChecklist,
    refreshTaskIntake,
    resolveWorkingPhase,
    sliceMessagesSinceLastUserPrompt,
    toSessionExecutionContextSystemBlock,
    toolResultReduction,
    updatePlanGraph,
    updateTracePromptMetadata,
    workingFrameService,
  } = deps;

  mergeSynesisClarificationFromRequestMetadata(session.record.metadata, bodyMetadata ?? undefined);
  const priorChecklistHash = getChecklistSourceHash(session.record.metadata);
  if (latestUserText && typeof latestUserText.content === "string") {
    updateTracePromptMetadata(session, latestUserText.content);
  }
  const requirementChecklist = refreshRequirementChecklist(session);
  const taskIntake = refreshTaskIntake(session);
  const planGraph = updatePlanGraph(
    session,
    taskIntake,
    normalizedMessages as Array<{ role: string; content: unknown }>,
    failingVerificationSignals,
  );
  const promptIntake = evaluateYarnPromptIntakeSteer({
    enabled: config.SYNESIS_YARN_PROMPT_INTAKE_STEER_ENABLED && !config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    latestUserPrompt,
    metadata: bodyMetadata,
    extraBody: request.extra_body ?? null,
    clientToolCapabilities,
  });
  persistPromptIntakeSnapshot(session, promptIntake);
  recordPromptIntakeEvent(
    sessionKey,
    identity.userId,
    identity.orgId,
    requestId,
    "openai",
    promptIntake,
  );
  const plannerTodoPacketBlock = await maybeBuildPlannerTodoPacketBlock({
    session,
    sessionKey,
    identity,
    requestId,
    surface: "openai",
    latestUserPrompt,
    promptIntake,
    clientToolCapabilities,
  });
  if (requirementChecklist && requirementChecklist.sourceHash !== priorChecklistHash) {
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "requirements_checklist",
      "completion-gate",
      `Checklist initialized (must=${requirementChecklist.must.length}, should=${requirementChecklist.should.length})`,
      requestId,
    );
  }

  const turnMessages = sliceMessagesSinceLastUserPrompt(
    normalizedMessages,
  );
  const toolFailures = collectToolExecutionFailureObservations(
    turnMessages as Array<{ role: string; content: unknown; name?: string; tool_call_id?: string }>,
  );
  const editMissGuard = deriveEditContextMissGuardState(
    turnMessages,
  );
  const latestToolProgress = classifyLatestToolProgress(
    turnMessages,
  );
  if (latestToolProgress.toolName && latestToolProgress.snippet) {
    const evidenceSignals = classifyToolResultAsEvidence(
      latestToolProgress.toolName,
      latestToolProgress.snippet,
      session.record.requestCount,
    );
    maybeUpdateTaskLedgerFromEvidence(session, evidenceSignals);
  }
  const latestReadRefresh = classifyLatestReadRefresh(
    turnMessages,
  );
  const hadForceReadPending = session.editMissForceReadPending;
  if (hadForceReadPending && latestReadRefresh.hasRecentReadSuccess) {
    session.editMissForceReadPending = false;
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "edit_context_miss_forced_read_satisfied",
      "execution-governor",
      `Forced read recovery satisfied via ${latestReadRefresh.toolName || "read"} ${latestReadRefresh.filePath || "<unknown file>"}`,
      requestId,
      {
        toolName: latestReadRefresh.toolName || null,
        toolCallId: latestReadRefresh.toolCallId || null,
        filePath: latestReadRefresh.filePath || null,
        snippet: latestReadRefresh.snippet || null,
      },
    );
  }
  for (const failure of toolFailures) {
    const failureEventKind = failure.reason === "edit_already_applied"
      ? "client_tool_idempotent_observed"
      : "client_tool_error_observed";
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      failureEventKind,
      "tool-result-monitor",
      `tool=${failure.toolName} reason=${failure.reason} ${failure.snippet}`,
      requestId,
      {
        toolName: failure.toolName,
        toolCallId: failure.toolCallId || null,
        filePath: failure.filePath || null,
        reason: failure.reason,
        snippet: failure.snippet,
      },
    );
  }
  if (editMissGuard?.active) {
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "edit_context_miss_guard_active",
      "tool-result-monitor",
      `forcing_read_before_edit file=${editMissGuard.filePath} misses=${editMissGuard.missCount}`,
      requestId,
      {
        filePath: editMissGuard.filePath,
        missCount: editMissGuard.missCount,
      },
    );
  }
  const editMissFailureCount = toolFailures.filter((failure: { reason: string }) => failure.reason === "edit_context_miss").length;
  const anyWriteToolEditFailure = toolFailures.some(
    (f: { reason: string }) => f.reason === "edit_error"
      || f.reason === "edit_context_miss"
      || f.reason === "write_tool_error"
      || f.reason === "patch_apply_failed",
  );
  const hasActiveEditMissFailure =
    editMissFailureCount > 0
    || anyWriteToolEditFailure
    || latestToolProgress.hasRecentEditContextMiss
    || editMissGuard?.active === true
    || session.editMissForceReadPending;
  if (latestToolProgress.hasRecentWriteSuccess && !hasActiveEditMissFailure) {
    session.stagnantToolCycles = 0;
    session.lastToolSignalHash = "";
    session.consecutiveEditContextMisses = 0;
    session.editReplayHardStopGraceUsed = false;
    session.editMissForceReadPending = false;
  } else if (editMissFailureCount > 0) {
    session.consecutiveEditContextMisses += 1;
  } else if (latestToolProgress.hasRecentFailure) {
    session.consecutiveEditContextMisses = 0;
  }
  const shouldArmForceReadRecovery =
    latestToolProgress.hasRecentEditContextMiss
    && (editMissFailureCount >= 1 || session.consecutiveEditContextMisses >= 1);
  if (shouldArmForceReadRecovery) {
    if (!session.editMissForceReadPending) {
      recordSessionEvent(
        sessionKey,
        identity.userId,
        identity.orgId,
        "edit_context_miss_forced_read_armed",
        "execution-governor",
        `Armed forced read recovery after edit misses (turn=${editMissFailureCount}, consecutive=${session.consecutiveEditContextMisses})`,
        requestId,
        {
          edit_miss_failures: editMissFailureCount,
          consecutive_turn_edit_miss_failures: session.consecutiveEditContextMisses,
        },
      );
    }
    session.editMissForceReadPending = true;
  }
  if (latestToolProgress.hasRecentWriteSuccess && !hasActiveEditMissFailure && session.consecutiveRecoveryFires > 0) {
    session.consecutiveRecoveryFires = 0;
    session.governorPrePauseAttemptsByRule.clear();
    session.implementationSoftStallNudgeStrikes = 0;
    recordSessionEvent(
      sessionKey,
      identity.userId,
      identity.orgId,
      "execution_governor_recovery_reset",
      "execution-governor",
      `Recovery streak reset after successful ${latestToolProgress.toolName || "write"} tool result`,
      requestId,
      {
        toolName: latestToolProgress.toolName || null,
        toolCallId: latestToolProgress.toolCallId || null,
        snippet: latestToolProgress.snippet || null,
      },
    );
  }

  const messageMetadata = extractMetadataFromMessages(normalizedMessages as never);
  const pathContextWithMessageMetadata = mergePathContextWithClientMetadata(pathContext, messageMetadata);
  const workspaceHandshakeAction = await processWorkspaceHandshakeRoute({
    protocol: "openai",
    session,
    sessionKey,
    identity,
    requestId,
    pathContext: pathContextWithMessageMetadata,
    messages: request.messages,
    tools: request.tools,
    saveSession: casSessionSave,
    recordSessionEvent,
    shouldStart: (state: SessionState, ctx: SessionPathHints) =>
      isCoderClientKind(identity.clientKind) && shouldStartMissingPathWorkspaceHandshake(state, ctx),
  });
  const effectivePathContext = mergeSessionPathHints(pathContextWithMessageMetadata, session);
  const buildEffectiveAdapterBlock = (nextPathContext: SessionPathHints): string | undefined => {
    const ctxBlock = toSessionExecutionContextSystemBlock(nextPathContext);
    if (!ctxBlock) return adapterBlock;
    return `${clientAdapterPacks.toSystemBlock(adapterProfile)}\n\n${ctxBlock}`;
  };
  const effectiveAdapterBlock = buildEffectiveAdapterBlock(effectivePathContext);

  const recallDecision = toolResultReduction.getLastRecallDecision();
  const verificationState = toolResultReduction.getVerificationTracker().getState();

  const preFrame = config.SYNESIS_YARN_WORKING_FRAME_ENABLED
    ? workingFrameService.build(normalizedMessages as never)
    : undefined;
  const orchestratorPhaseOverride = parseOrchestratorPhaseHeader(
    String(headers["x-synesis-orchestrator-phase"] ?? ""),
  );
  const governorPreviewPhase = inferGovernorPhaseFromMessages(
    normalizedMessages as Array<GovernorInputMessage>,
  );
  const framePhase = preFrame ? phaseFromFrame(preFrame.currentPhase) : undefined;
  const workingPhase: WorkflowPhase | undefined = resolveWorkingPhase({
    orchestratorOverride: orchestratorPhaseOverride,
    framePhase,
    governorPreviewPhase,
  });
  const workingFrameGoal: string | undefined = preFrame?.goal;

  return {
    requirementChecklist,
    taskIntake,
    planGraph,
    promptIntake,
    plannerTodoPacketBlock,
    toolFailures,
    editMissGuard,
    latestToolProgress,
    latestReadRefresh,
    editMissFailureCount,
    hasActiveEditMissFailure,
    workspaceHandshakeAction,
    effectivePathContext,
    effectiveAdapterBlock,
    buildEffectiveAdapterBlock,
    recallDecision,
    verificationState,
    orchestratorPhaseOverride,
    workingPhase,
    workingFrameGoal,
  };
}
