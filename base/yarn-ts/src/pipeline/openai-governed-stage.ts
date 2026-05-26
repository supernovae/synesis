import type { AuthUser } from "../auth.js";
import type { SessionIdentity } from "../session/session-key.js";
import type { OpenAIChatCompletionsRouteDependencies } from "../server/route-dependencies.js";
import type { GovernorInputMessage } from "../governance/execution-governor.js";
import type { OpenAIChatCompletionRequest } from "../schemas.js";
import { shouldRunGovernorForMode } from "./modes.js";
import { prepareOpenAITurn } from "./openai-turn-preparation.js";
import { prepareOpenAIContext } from "./openai-context-preparation.js";
import { prepareOpenAIExecutionGovernor } from "./openai-execution-governor-preparation.js";
import { runOpenAIGovernancePrecheck } from "./openai-governance-precheck.js";
import { handleOpenAIGovernorResponse } from "./openai-governor-response.js";

type Deps = Pick<
  OpenAIChatCompletionsRouteDependencies,
  | "analyzeRecentCommandLoop"
  | "app"
  | "applyObjectiveScopeAndPersist"
  | "applySensemakingStats"
  | "assessStateConfidence"
  | "buildArtifactShadows"
  | "buildExecutionGovernorHardStopUserMessage"
  | "buildExecutionGovernorPauseEnvelope"
  | "buildGovernorPauseResumeBlockForUser"
  | "buildSensemakingGuidanceInjection"
  | "buildSensemakingPauseMessage"
  | "casSessionSave"
  | "chatPhaseFromWorkflowPhase"
  | "classifyIntentScope"
  | "classifyLatestReadRefresh"
  | "classifyLatestToolProgress"
  | "classifyToolResultAsEvidence"
  | "clearGovernorPauseContextMetadata"
  | "clientAdapterPacks"
  | "collectToolExecutionFailureObservations"
  | "config"
  | "countTurnsSinceLastUser"
  | "createDiffStats"
  | "deriveChatState"
  | "deriveEditContextMissGuardState"
  | "deriveFileState"
  | "detectLanguagesFromMessages"
  | "detectToolProgress"
  | "distributedCounters"
  | "evaluateYarnPromptIntakeSteer"
  | "extractCommandEvents"
  | "extractEditedFileHints"
  | "extractTextFromUnknownContent"
  | "formatStateConfidenceBlock"
  | "getBlockedDiscoveryCount"
  | "getChecklistSourceHash"
  | "getFileSnapshotRegistry"
  | "governanceClient"
  | "governorService"
  | "hashTextSignal"
  | "inferGovernorPhaseFromMessages"
  | "injectGovernorRecoveryMessage"
  | "isPlanRecoveryDiscoveryIntent"
  | "knowledgeResolveContext"
  | "knowledgeSearch"
  | "logAndPersistSafetyEvent"
  | "looksLikeFailureSignal"
  | "maybeBuildPlannerTodoPacketBlock"
  | "maybeCheckpoint"
  | "maybeUpdateTaskLedgerFromEvidence"
  | "mergeSessionPathHints"
  | "mergeSynesisClarificationFromRequestMetadata"
  | "normalizedToolOutputSignal"
  | "parseOrchestratorPhaseHeader"
  | "persistGovernorPauseContextMetadata"
  | "persistGovernorPauseSoftFail"
  | "persistPromptIntakeSnapshot"
  | "persistStateConfidence"
  | "phaseFromFrame"
  | "phaseOrchestrator"
  | "pinchCompactionBackendModelMetadata"
  | "policyEngine"
  | "processWorkspaceHandshakeRoute"
  | "projectInstructionFilePresent"
  | "readPersistedChatStateSnapshot"
  | "recordPromptIntakeEvent"
  | "recordSessionEvent"
  | "refreshRequirementChecklist"
  | "refreshTaskIntake"
  | "resetGovernorPauseRecoveryState"
  | "resetQwenInterventionOnUserTurn"
  | "resolveWorkingPhase"
  | "runEvidencePrefetch"
  | "runPatternPrefetch"
  | "runSensemaking"
  | "sensemakingStats"
  | "sessionPersistenceRunner"
  | "shouldStripGlobFromTools"
  | "sliceMessagesSinceLastUserPrompt"
  | "stripGlobFromTools"
  | "summarizeArtifactContext"
  | "summarizeEvidenceDelta"
  | "toSessionExecutionContextSystemBlock"
  | "toolResultReduction"
  | "updatePlanGraph"
  | "updateTracePromptMetadata"
  | "withSpan"
  | "withSpanAsync"
  | "workingFrameService"
>;

type SessionState = Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["getSessionState"]>>;
type NormalizedOpenAI = { messages: unknown[] };

interface PrepareOpenAIGovernedStageInput {
  deps: Deps;
  authUser: AuthUser;
  req: { headers: Record<string, string | string[] | undefined> };
  session: SessionState;
  sessionKey: string;
  identity: SessionIdentity;
  requestId: string;
  request: OpenAIChatCompletionRequest;
  normalizedOpenAI: NormalizedOpenAI;
  bodyMetadata: Record<string, unknown> | null | undefined;
  latestUserText: { role: string; content: unknown } | undefined;
  taskCue: string;
  clientToolCapabilities: ReturnType<OpenAIChatCompletionsRouteDependencies["detectClientToolCapabilities"]>;
  pathContext: ReturnType<OpenAIChatCompletionsRouteDependencies["parseSessionExecutionContext"]>;
  adapterProfile: ReturnType<OpenAIChatCompletionsRouteDependencies["clientAdapterPacks"]["resolve"]>;
  adapterBlock: string | undefined;
  verificationAssessment: ReturnType<OpenAIChatCompletionsRouteDependencies["assessVerificationSignals"]>;
  preManifest: ReturnType<OpenAIChatCompletionsRouteDependencies["projectManifestService"]["build"]>;
  workspaceInspection: Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["applyWorkspaceBoundary"]>>;
  runtimePreferences: unknown;
  pipelineMode: string;
  governorCooldownMs: number;
  endContextStage: () => void;
  startGovernorStage: () => () => void;
}

export type OpenAIGovernedStageResult =
  | { kind: "workspaceHandshake"; toolCallId: string }
  | { kind: "softFail"; selectedModel: string; content: string; envelope?: unknown }
  | { kind: "reject"; decision: unknown }
  | {
      kind: "ok";
      requirementChecklist: ReturnType<OpenAIChatCompletionsRouteDependencies["refreshRequirementChecklist"]>;
      taskIntake: ReturnType<OpenAIChatCompletionsRouteDependencies["refreshTaskIntake"]>;
      planGraph: ReturnType<OpenAIChatCompletionsRouteDependencies["updatePlanGraph"]>;
      promptIntake: ReturnType<OpenAIChatCompletionsRouteDependencies["evaluateYarnPromptIntakeSteer"]>;
      plannerTodoPacketBlock: string | null;
      editMissGuard: unknown;
      latestToolProgress: unknown;
      latestReadRefresh: unknown;
      effectivePathContext: ReturnType<OpenAIChatCompletionsRouteDependencies["mergeSessionPathHints"]>;
      effectiveAdapterBlock: string | undefined;
      buildEffectiveAdapterBlock: (pathContext: ReturnType<OpenAIChatCompletionsRouteDependencies["mergeSessionPathHints"]>) => string | undefined;
      prefetchResult: unknown;
      patternResult: unknown;
      combinedEvidenceConfidence: number;
      orchestration: ReturnType<OpenAIChatCompletionsRouteDependencies["phaseOrchestrator"]["decide"]>;
      evidencePrefetched: boolean;
      sensemakingResult: unknown;
      sensemakingBlock: string | null;
      artifactShadows: unknown;
      artifactContext: unknown;
      fileState: unknown;
      chatState: unknown;
      objectiveScope: unknown;
      scopedMessages: unknown[];
      stateConfidence: unknown;
      stateConfidenceBlock: string | null;
      needsStateReground: boolean;
      pauseChatSummary: unknown;
      pauseFileSummary: unknown;
      chatStateBlock: string | null;
      fileStateBlock: string | null;
      executionGovernor: unknown;
      governorPauseResumeBlock: string | null;
      sensemakingDecision: unknown;
      policyPrecheck: unknown;
      clientToolInventory: unknown[];
      governorPhase: unknown;
      workingPhase: unknown;
      trajectoryWorkingFrameGoal: string | undefined;
      orchestratorPhaseOverride: unknown;
      commandLoop: unknown;
      toolProgress: unknown;
      hasActiveEditMissFailure: boolean;
    };

export async function prepareOpenAIGovernedStage(
  input: PrepareOpenAIGovernedStageInput,
): Promise<OpenAIGovernedStageResult> {
  const { deps } = input;
  const turn = await prepareOpenAITurn({
    deps: {
      casSessionSave: deps.casSessionSave,
      classifyLatestReadRefresh: deps.classifyLatestReadRefresh,
      classifyLatestToolProgress: deps.classifyLatestToolProgress,
      classifyToolResultAsEvidence: deps.classifyToolResultAsEvidence,
      clientAdapterPacks: deps.clientAdapterPacks,
      collectToolExecutionFailureObservations: deps.collectToolExecutionFailureObservations,
      config: deps.config,
      deriveEditContextMissGuardState: deps.deriveEditContextMissGuardState,
      evaluateYarnPromptIntakeSteer: deps.evaluateYarnPromptIntakeSteer,
      getChecklistSourceHash: deps.getChecklistSourceHash,
      inferGovernorPhaseFromMessages: deps.inferGovernorPhaseFromMessages,
      maybeBuildPlannerTodoPacketBlock: deps.maybeBuildPlannerTodoPacketBlock,
      maybeUpdateTaskLedgerFromEvidence: deps.maybeUpdateTaskLedgerFromEvidence,
      mergeSessionPathHints: deps.mergeSessionPathHints,
      mergeSynesisClarificationFromRequestMetadata: deps.mergeSynesisClarificationFromRequestMetadata,
      parseOrchestratorPhaseHeader: deps.parseOrchestratorPhaseHeader,
      persistPromptIntakeSnapshot: deps.persistPromptIntakeSnapshot,
      phaseFromFrame: deps.phaseFromFrame,
      processWorkspaceHandshakeRoute: deps.processWorkspaceHandshakeRoute,
      recordPromptIntakeEvent: deps.recordPromptIntakeEvent,
      recordSessionEvent: deps.recordSessionEvent,
      refreshRequirementChecklist: deps.refreshRequirementChecklist,
      refreshTaskIntake: deps.refreshTaskIntake,
      resolveWorkingPhase: deps.resolveWorkingPhase,
      sliceMessagesSinceLastUserPrompt: deps.sliceMessagesSinceLastUserPrompt,
      toSessionExecutionContextSystemBlock: deps.toSessionExecutionContextSystemBlock,
      toolResultReduction: deps.toolResultReduction,
      updatePlanGraph: deps.updatePlanGraph,
      updateTracePromptMetadata: deps.updateTracePromptMetadata,
      workingFrameService: deps.workingFrameService,
    },
    session: input.session,
    sessionKey: input.sessionKey,
    identity: input.identity,
    requestId: input.requestId,
    request: input.request as {
      model: string;
      messages: unknown[];
      tools?: unknown[];
      stream?: unknown;
      extra_body?: Record<string, unknown> | null;
    },
    normalizedMessages: input.normalizedOpenAI.messages as Array<{
      role: string;
      content: unknown;
      name?: string;
      tool_call_id?: string;
      tool_calls?: unknown;
    }>,
    bodyMetadata: input.bodyMetadata,
    latestUserText: input.latestUserText,
    latestUserPrompt: input.taskCue,
    clientToolCapabilities: input.clientToolCapabilities,
    pathContext: input.pathContext,
    adapterProfile: input.adapterProfile,
    adapterBlock: input.adapterBlock,
    failingVerificationSignals: input.verificationAssessment.failingSignals,
    headers: input.req.headers as Record<string, unknown>,
  });
  if (turn.workspaceHandshakeAction.kind === "send") {
    return { kind: "workspaceHandshake", toolCallId: turn.workspaceHandshakeAction.toolCallId };
  }

  const context = await prepareOpenAIContext({
    deps: {
      app: deps.app,
      analyzeRecentCommandLoop: deps.analyzeRecentCommandLoop,
      applyObjectiveScopeAndPersist: deps.applyObjectiveScopeAndPersist,
      applySensemakingStats: deps.applySensemakingStats,
      assessStateConfidence: deps.assessStateConfidence,
      buildArtifactShadows: deps.buildArtifactShadows,
      chatPhaseFromWorkflowPhase: deps.chatPhaseFromWorkflowPhase,
      classifyIntentScope: deps.classifyIntentScope,
      config: deps.config,
      createDiffStats: deps.createDiffStats,
      deriveChatState: deps.deriveChatState,
      deriveFileState: deps.deriveFileState,
      detectLanguagesFromMessages: deps.detectLanguagesFromMessages,
      detectToolProgress: deps.detectToolProgress,
      extractTextFromUnknownContent: deps.extractTextFromUnknownContent,
      formatStateConfidenceBlock: deps.formatStateConfidenceBlock,
      getFileSnapshotRegistry: deps.getFileSnapshotRegistry,
      hashTextSignal: deps.hashTextSignal,
      knowledgeResolveContext: deps.knowledgeResolveContext,
      knowledgeSearch: deps.knowledgeSearch,
      looksLikeFailureSignal: deps.looksLikeFailureSignal,
      normalizedToolOutputSignal: deps.normalizedToolOutputSignal,
      phaseOrchestrator: deps.phaseOrchestrator,
      pinchCompactionBackendModelMetadata: deps.pinchCompactionBackendModelMetadata,
      persistStateConfidence: deps.persistStateConfidence,
      projectInstructionFilePresent: deps.projectInstructionFilePresent,
      readPersistedChatStateSnapshot: deps.readPersistedChatStateSnapshot,
      recordSessionEvent: deps.recordSessionEvent,
      resetQwenInterventionOnUserTurn: deps.resetQwenInterventionOnUserTurn,
      runEvidencePrefetch: deps.runEvidencePrefetch,
      runPatternPrefetch: deps.runPatternPrefetch,
      runSensemaking: deps.runSensemaking,
      sensemakingStats: deps.sensemakingStats,
      summarizeArtifactContext: deps.summarizeArtifactContext,
    },
    authUser: input.authUser,
    req: { headers: { authorization: input.req.headers.authorization as string | undefined } },
    session: input.session,
    sessionKey: input.sessionKey,
    identity: input.identity,
    requestId: input.requestId,
    request: input.request,
    normalizedMessages: input.normalizedOpenAI.messages as Array<{
      role: string;
      content: unknown;
      name?: string;
      tool_call_id?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown }; name?: string; input?: unknown }>;
    }>,
    latestUserText: input.latestUserText,
    preManifest: input.preManifest,
    recallDecision: turn.recallDecision,
    verificationState: turn.verificationState,
    workingPhase: turn.workingPhase,
    workingFrameGoal: turn.workingFrameGoal,
    workspaceInspection: input.workspaceInspection,
    latestReadRefresh: turn.latestReadRefresh,
    editMissGuard: turn.editMissGuard,
  });
  input.endContextStage();
  const endGovernorStage = input.startGovernorStage();

  const executionGovernorPreparation = await prepareOpenAIExecutionGovernor({
    config: deps.config,
    session: input.session,
    sessionKey: input.sessionKey,
    identity: input.identity,
    requestId: input.requestId,
    headers: input.req.headers as Record<string, unknown>,
    pipelineMode: input.pipelineMode as never,
    taskCue: input.taskCue,
    scopedMessages: context.scopedMessages,
    planGraph: turn.planGraph,
    editMissGuard: turn.editMissGuard,
    latestToolProgress: turn.latestToolProgress,
    toolFailures: turn.toolFailures,
    artifactShadows: context.artifactShadows,
    chatState: context.chatState,
    fileState: context.fileState,
    workingPhase: turn.workingPhase,
    editMissFailureCount: turn.editMissFailureCount,
    governorCooldownMs: input.governorCooldownMs,
    stateConfidence: context.stateConfidence,
    needsStateReground: context.needsStateReground,
    objectiveScope: context.objectiveScope,
    artifactContext: context.artifactContext,
    pauseSummaries: {
      chat: context.pauseChatSummary,
      file: context.pauseFileSummary,
    },
    shouldRunGovernorForMode,
    governorService: deps.governorService,
    withSpanAsync: deps.withSpanAsync,
    summarizeEvidenceDelta: deps.summarizeEvidenceDelta,
    recordSessionEvent: deps.recordSessionEvent,
    buildGovernorPauseResumeBlockForUser: deps.buildGovernorPauseResumeBlockForUser,
  });
  const executionGovernor = executionGovernorPreparation.executionGovernor;

  const governancePrecheck = await runOpenAIGovernancePrecheck({
    config: deps.config,
    session: input.session,
    sessionKey: input.sessionKey,
    identity: input.identity,
    requestId: input.requestId,
    request: input.request,
    scopedMessages: context.scopedMessages,
    taskCue: input.taskCue,
    executionGovernor,
    pipelineMode: input.pipelineMode as never,
    shouldRunGovernorForMode,
    commandLoop: context.commandLoop,
    lastToolId: context.lastToolId,
    latestUserHash: context.latestUserHash,
    latestToolProgress: turn.latestToolProgress,
    toolProgress: context.toolProgress,
    runtimePreferences: input.runtimePreferences,
    orchestration: context.orchestration,
    workingPhase: turn.workingPhase,
    orchestratorPhaseOverride: turn.orchestratorPhaseOverride,
    normalizedMessages: input.normalizedOpenAI.messages as GovernorInputMessage[],
    distributedCounters: deps.distributedCounters,
    policyEngine: deps.policyEngine,
    governanceClient: deps.governanceClient,
    withSpan: deps.withSpan,
    extractCommandEvents: deps.extractCommandEvents,
    extractEditedFileHints: deps.extractEditedFileHints,
    isPlanRecoveryDiscoveryIntent: deps.isPlanRecoveryDiscoveryIntent,
    countTurnsSinceLastUser: deps.countTurnsSinceLastUser,
    shouldStripGlobFromTools: deps.shouldStripGlobFromTools,
    stripGlobFromTools: deps.stripGlobFromTools,
    getBlockedDiscoveryCount: deps.getBlockedDiscoveryCount,
    logWarn: (record, message) => deps.app.log.warn(record, message),
    logAndPersistSafetyEvent: deps.logAndPersistSafetyEvent,
    persistSessionAndUsage: deps.sessionPersistenceRunner.persistSessionAndUsage,
    maybeCheckpoint: deps.maybeCheckpoint,
    recordSessionEvent: deps.recordSessionEvent,
  });
  const policyAction = governancePrecheck.policyAction;
  if (policyAction.kind === "softFail") {
    return { kind: "softFail", selectedModel: context.orchestration.selectedModel, content: policyAction.content };
  }
  if (policyAction.kind === "reject") {
    return { kind: "reject", decision: policyAction.decision };
  }

  const sensemakingPrimaryEnabled =
    deps.config.SYNESIS_YARN_SENSEMAKING_ENABLED
    && !deps.config.SYNESIS_YARN_SENSEMAKING_HARD_STOP_ONLY;
  const governorResponse = handleOpenAIGovernorResponse({
    deps: {
      buildExecutionGovernorHardStopUserMessage: deps.buildExecutionGovernorHardStopUserMessage,
      buildExecutionGovernorPauseEnvelope: deps.buildExecutionGovernorPauseEnvelope,
      buildSensemakingGuidanceInjection: deps.buildSensemakingGuidanceInjection,
      buildSensemakingPauseMessage: deps.buildSensemakingPauseMessage,
      clearGovernorPauseContextMetadata: deps.clearGovernorPauseContextMetadata,
      config: deps.config,
      injectGovernorRecoveryMessage: deps.injectGovernorRecoveryMessage,
      maybeCheckpoint: deps.maybeCheckpoint,
      persistGovernorPauseContextMetadata: deps.persistGovernorPauseContextMetadata,
      persistGovernorPauseSoftFail: deps.persistGovernorPauseSoftFail,
      recordSessionEvent: deps.recordSessionEvent,
      resetGovernorPauseRecoveryState: deps.resetGovernorPauseRecoveryState,
      sessionPersistenceRunner: deps.sessionPersistenceRunner,
      summarizeEvidenceDelta: deps.summarizeEvidenceDelta,
    },
    session: input.session,
    sessionKey: input.sessionKey,
    identity: input.identity,
    requestId: input.requestId,
    selectedModel: context.orchestration.selectedModel,
    originalModel: input.request.model,
    messages: input.normalizedOpenAI.messages as Array<{ role: string; content: unknown }>,
    executionGovernor,
    sensemakingDecision: governancePrecheck.sensemakingDecision,
    sensemakingPrimaryEnabled,
    hasActiveEditMissFailure: turn.hasActiveEditMissFailure,
    clientToolCapabilities: input.clientToolCapabilities,
    pauseContext: {
      artifactContext: context.artifactContext,
      chatStateSummary: context.pauseChatSummary,
      fileStateSummary: context.pauseFileSummary,
      taskContext: context.pauseTaskContext,
    },
  });
  if (governorResponse.kind === "softFail") {
    return {
      kind: "softFail",
      selectedModel: context.orchestration.selectedModel,
      content: governorResponse.content,
      envelope: governorResponse.envelope,
    };
  }
  endGovernorStage();

  return {
    kind: "ok",
    requirementChecklist: turn.requirementChecklist,
    taskIntake: turn.taskIntake,
    planGraph: turn.planGraph,
    promptIntake: turn.promptIntake,
    plannerTodoPacketBlock: turn.plannerTodoPacketBlock,
    editMissGuard: turn.editMissGuard,
    latestToolProgress: turn.latestToolProgress,
    latestReadRefresh: turn.latestReadRefresh,
    effectivePathContext: turn.effectivePathContext,
    effectiveAdapterBlock: turn.effectiveAdapterBlock,
    buildEffectiveAdapterBlock: turn.buildEffectiveAdapterBlock,
    prefetchResult: context.prefetchResult,
    patternResult: context.patternResult,
    combinedEvidenceConfidence: context.combinedEvidenceConfidence,
    orchestration: context.orchestration,
    evidencePrefetched: context.evidencePrefetched,
    sensemakingResult: context.sensemakingResult,
    sensemakingBlock: context.sensemakingBlock,
    artifactShadows: context.artifactShadows,
    artifactContext: context.artifactContext,
    fileState: context.fileState,
    chatState: context.chatState,
    objectiveScope: context.objectiveScope,
    scopedMessages: context.scopedMessages,
    stateConfidence: context.stateConfidence,
    stateConfidenceBlock: context.stateConfidenceBlock,
    needsStateReground: context.needsStateReground,
    pauseChatSummary: context.pauseChatSummary,
    pauseFileSummary: context.pauseFileSummary,
    chatStateBlock: context.chatStateBlock,
    fileStateBlock: context.fileStateBlock,
    executionGovernor,
    governorPauseResumeBlock: executionGovernorPreparation.governorPauseResumeBlock,
    sensemakingDecision: governancePrecheck.sensemakingDecision,
    policyPrecheck: governancePrecheck.policyPrecheck,
    clientToolInventory: governancePrecheck.clientToolInventory,
    governorPhase: governancePrecheck.governorPhase,
    workingPhase: turn.workingPhase,
    trajectoryWorkingFrameGoal: turn.workingFrameGoal,
    orchestratorPhaseOverride: turn.orchestratorPhaseOverride,
    commandLoop: context.commandLoop,
    toolProgress: context.toolProgress,
    hasActiveEditMissFailure: turn.hasActiveEditMissFailure,
  };
}
