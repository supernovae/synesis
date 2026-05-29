import { createHash } from "node:crypto";
import type { AuthUser } from "../auth.js";
import {
  detectFreshImplicitSessionStart,
  type SessionIdentity,
} from "../session/session-key.js";
import type { RequestForensicsRecord } from "../telemetry/request-forensics.js";
import type { SessionPathHints } from "../state/workspace-session-boundary.js";
import type { OpenAIChatCompletionsRouteDependencies } from "../server/route-dependencies.js";
import {
  deriveModelExecutionPolicy,
  resolveModelArchitectureProfile,
} from "../providers/model-architecture-profile.js";
import { stabilizeOpenAITranscript } from "./openai-route-transcript-stabilization.js";

type Deps = Pick<
  OpenAIChatCompletionsRouteDependencies,
  | "app"
  | "annotatePlanFileReads"
  | "annotateVerificationGaps"
  | "applyAuthKeyAttribution"
  | "applySessionTaskCapabilities"
  | "applyWorkspaceBoundary"
  | "buildFreshImplicitSessionNotice"
  | "config"
  | "detectClientTaskCapabilities"
  | "detectClientToolCapabilities"
  | "distributedCounters"
  | "extractPlanContentShadow"
  | "getContentDedup"
  | "getFileSnapshotRegistry"
  | "getMemoryGovernor"
  | "getSessionKey"
  | "getSessionState"
  | "hasPersistedWorkspaceState"
  | "injectPlanModeRecoveryHint"
  | "isGenuineUserPromptMessage"
  | "loadUserRuntimePreferences"
  | "recordSessionEvent"
  | "readdir"
  | "remediatePlanFileStubs"
  | "resetWorkspaceScopedSessionState"
  | "runProtocolSessionBootstrap"
  | "serializeShadow"
  | "shouldResetImplicitSessionForFreshTranscript"
  | "transcriptPruning"
  | "workspaceStatePresence"
  | "yarnDedupeLayer"
>;

type SessionState = Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["getSessionState"]>>;
type NormalizedOpenAI = { messages: unknown[] };

interface CapabilityResolutionLike {
  mode: "enforced" | "shadow";
  global_optimizations_enabled: boolean;
  matched_override_ids: string[];
  matched_selectors: unknown;
  resolved_capabilities: Record<string, unknown>;
}

interface PrepareOpenAISessionWorkspaceInput {
  deps: Deps;
  authUser: AuthUser;
  identity: SessionIdentity;
  request: {
    model: string;
    messages: unknown[];
    tools?: unknown[];
  };
  normalizedOpenAI: NormalizedOpenAI;
  requestId: string;
  clientKind: string;
  conversationId: string;
  taskCue: string;
  pathContext: SessionPathHints;
  capabilityResolution: CapabilityResolutionLike;
  matrixModelId: string;
  matrixModelPath: string;
  matrixFamily: string;
  compactionBackendModelHint?: string;
  contentDedupeEnabled: boolean;
  responseDedupeEnabled: boolean;
  historicalNormalizeEnabled: boolean;
  optimizationLedger: {
    recordAfterPruning(messages: Array<{ content?: unknown }>): void;
  };
}

export async function prepareOpenAISessionWorkspace(
  input: PrepareOpenAISessionWorkspaceInput,
): Promise<{
  sessionKey: string;
  session: SessionState;
  runtimePreferences: unknown;
  clientToolCapabilities: ReturnType<OpenAIChatCompletionsRouteDependencies["detectClientToolCapabilities"]>;
  forensicsCapabilityMatrix: RequestForensicsRecord["capabilityMatrix"];
  workspaceInspection: Awaited<ReturnType<OpenAIChatCompletionsRouteDependencies["applyWorkspaceBoundary"]>>;
  freshImplicitSessionNotice: string | null;
}> {
  const {
    deps,
    authUser,
    identity,
    request,
    normalizedOpenAI,
    requestId,
    clientKind,
    conversationId,
    taskCue,
    pathContext,
    capabilityResolution,
    matrixModelId,
    matrixModelPath,
    matrixFamily,
    compactionBackendModelHint,
    contentDedupeEnabled,
    responseDedupeEnabled,
    historicalNormalizeEnabled,
    optimizationLedger,
  } = input;
  const {
    app,
    annotatePlanFileReads,
    annotateVerificationGaps,
    applyAuthKeyAttribution,
    applySessionTaskCapabilities,
    applyWorkspaceBoundary,
    buildFreshImplicitSessionNotice,
    config,
    detectClientTaskCapabilities,
    detectClientToolCapabilities,
    distributedCounters,
    extractPlanContentShadow,
    getContentDedup,
    getFileSnapshotRegistry,
    getMemoryGovernor,
    getSessionKey,
    getSessionState,
    hasPersistedWorkspaceState,
    injectPlanModeRecoveryHint,
    isGenuineUserPromptMessage,
    loadUserRuntimePreferences,
    recordSessionEvent,
    readdir,
    remediatePlanFileStubs,
    resetWorkspaceScopedSessionState,
    runProtocolSessionBootstrap,
    serializeShadow,
    shouldResetImplicitSessionForFreshTranscript,
    transcriptPruning,
    workspaceStatePresence,
    yarnDedupeLayer,
  } = deps;

  const freshImplicitStart = detectFreshImplicitSessionStart({
    clientKind,
    conversationId,
    messages: request.messages as Array<{ role?: unknown; content?: unknown; tool_calls?: unknown }>,
  });
  let freshImplicitSessionNotice: string | null = freshImplicitStart.fresh
    ? buildFreshImplicitSessionNotice(clientKind, request.messages.length)
    : null;
  const sessionIdentity: SessionIdentity = freshImplicitStart.fresh
    ? {
        ...identity,
        forceFreshImplicitSession: true,
        freshImplicitSessionReason: freshImplicitStart.reason,
        freshImplicitMessageCount: request.messages.length,
        sessionRequestId: requestId,
      }
    : identity;
  const bootstrap = await runProtocolSessionBootstrap({
    identity: sessionIdentity,
    authUser,
    getSessionKey,
    getSessionState,
    applyAuthKeyAttribution,
    loadRuntimePreferences: loadUserRuntimePreferences,
    debugEnabled: config.SYNESIS_YARN_DEBUG_PROTOCOL,
    debugConversationSource: "conversation_resolved",
    debugFallbackSource: "conversation_fallback",
    debugLog: (record: Record<string, unknown>) => app.log.debug(record, "session_resolution"),
    afterSessionLoaded: ({ sessionKey: loadedSessionKey, session: loadedSession }: {
      sessionKey: string;
      session: SessionState;
    }) => {
      if (shouldResetImplicitSessionForFreshTranscript({
        clientKind,
        conversationId,
        messages: request.messages as Array<{ role?: unknown }>,
        hasPersistedState: hasPersistedWorkspaceState(loadedSession, workspaceStatePresence(loadedSessionKey)),
      })) {
        resetWorkspaceScopedSessionState(loadedSessionKey, loadedSession);
        freshImplicitSessionNotice = buildFreshImplicitSessionNotice(
          clientKind,
          request.messages.length,
        );
        recordSessionEvent(
          loadedSessionKey,
          identity.userId,
          identity.orgId,
          "implicit_session_fresh_transcript_reset",
          "session-boundary",
          `client=${clientKind} messages=${request.messages.length}`,
          requestId,
          {
            client_kind: clientKind,
            conversation_id_present: false,
            message_count: request.messages.length,
          },
        );
      }
    },
  });
  const sessionKey = bootstrap.sessionKey;
  const session = bootstrap.session;
  const runtimePreferences = bootstrap.runtimePreferences;
  const toolDefs = request.tools as Array<{ name?: string; function?: { name?: string } }> | undefined;
  const clientToolCapabilities = detectClientToolCapabilities(toolDefs, clientKind, taskCue);
  const detectedTaskCapabilities = detectClientTaskCapabilities(toolDefs, clientKind);
  applySessionTaskCapabilities(session, detectedTaskCapabilities);

  const capabilityHash = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(capabilityResolution.resolved_capabilities)
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest("hex")
    .slice(0, 16);
  const forensicsCapabilityMatrix: RequestForensicsRecord["capabilityMatrix"] = {
    mode: capabilityResolution.mode,
    globalOptimizationsEnabled: capabilityResolution.global_optimizations_enabled,
    modelId: matrixModelId,
    modelPath: matrixModelPath,
    family: matrixFamily,
    matchedOverrideIds: capabilityResolution.matched_override_ids,
    capabilityHash,
  };
  const architectureProfile = resolveModelArchitectureProfile({
    modelId: matrixModelPath || matrixModelId,
    family: matrixFamily,
  });
  const architecturePolicy = deriveModelExecutionPolicy(architectureProfile);
  forensicsCapabilityMatrix.architecturePolicy = {
    profileId: architecturePolicy.profileId,
    policyHash: architecturePolicy.policyHash,
    attention: architecturePolicy.attention,
    activation: architecturePolicy.activation,
    decoding: architecturePolicy.decoding,
    effectiveContextCeilingTokens: architecturePolicy.effectiveContextCeilingTokens,
    reasons: architecturePolicy.reasons,
  };
  recordSessionEvent(
    sessionKey,
    identity.userId,
    identity.orgId,
    "capability_matrix_resolution_v1",
    "capability-matrix",
    `mode=${capabilityResolution.mode} global=${capabilityResolution.global_optimizations_enabled ? "on" : "off"} matched=${capabilityResolution.matched_override_ids.join(",") || "none"}`,
    requestId,
    {
      mode: capabilityResolution.mode,
      global_optimizations_enabled: capabilityResolution.global_optimizations_enabled,
      model_id: matrixModelId,
      model_path: matrixModelPath,
      family: matrixFamily,
      matched_override_ids: capabilityResolution.matched_override_ids,
      matched_selectors: capabilityResolution.matched_selectors,
      capability_hash: capabilityHash,
      resolved_capabilities: capabilityResolution.resolved_capabilities,
      architecture_policy: forensicsCapabilityMatrix.architecturePolicy,
    },
  );

  const msgCount = request.messages.length;
  const recentExempt = Number(config.SYNESIS_YARN_TASK_PRUNING_RECENT_EXEMPT) || 0;
  session.pruningWatermark = Math.max(session.pruningWatermark, msgCount - recentExempt);
  const lastIncomingMessage = request.messages.length > 0
    ? (request.messages[request.messages.length - 1] as { role?: string; content?: unknown })
    : undefined;
  if (isGenuineUserPromptMessage(lastIncomingMessage)) {
    session.consecutiveToolCalls = 0;
    session.stagnantToolCycles = 0;
    session.lastToolSignalHash = "";
    session.awaitingToolLoopUserAck = false;
    session.toolLoopAckAnchorUserHash = "";
    session.toolLoopNoUserAckCount = 0;
    session.consecutiveRecoveryFires = 0;
    session.consecutiveEditContextMisses = 0;
    session.editReplayHardStopGraceUsed = false;
    session.editMissForceReadPending = false;
    session.lastGovernorCachedResult = null;
    session.lastGovernorNoPauseAt = 0;
    session.blockBroadVerificationUntilEdit = false;
    session.blockFailingVerificationUntilEdit = false;
    session.governorPrePauseAttemptsByRule.clear();
    session.implementationSoftStallNudgeStrikes = 0;
    void distributedCounters.setConsecutiveToolCalls(sessionKey, 0).catch((err: unknown) => {
      console.warn("[session] counter reset failed:", (err as Error).message ?? err);
    });
  }

  const workspaceInspection = await applyWorkspaceBoundary({
    state: session,
    sessionKey,
    identity,
    requestId,
    pathHints: pathContext,
    readDir: async (root: string) => readdir(root, { withFileTypes: true }),
    hasPersistedState: hasPersistedWorkspaceState(session, workspaceStatePresence(sessionKey)),
    resetWorkspaceState: resetWorkspaceScopedSessionState,
    recordSessionEvent,
  });
  const stabilizedTranscript = await stabilizeOpenAITranscript({
    messages: normalizedOpenAI.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }>,
    originalMessageCount: msgCount,
    sessionKey,
    identity,
    requestId,
    pathContext,
    governanceDisabled: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
    contentDedupeEnabled,
    responseDedupeEnabled,
    historicalNormalizeEnabled,
    compactionBackendModelHint,
    yarnDedupeLayer,
    transcriptPruning,
    optimizationLedger: optimizationLedger as never,
    logger: app.log,
    getFileSnapshotRegistry,
    getContentDedup,
    getMemoryGovernor,
    session,
    recordSessionEvent,
  });
  normalizedOpenAI.messages = stabilizedTranscript.messages as never;
  if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const planRemediation = remediatePlanFileStubs(normalizedOpenAI.messages as Array<{ role: string; content: unknown }>);
    if (planRemediation.remediatedCount > 0) {
      normalizedOpenAI.messages = planRemediation.messages as never;
      app.log.warn({ reqId: requestId, count: planRemediation.remediatedCount }, "plan_file_dedup_remediated");
    }
    const planAnnotation = annotatePlanFileReads(normalizedOpenAI.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>);
    if (planAnnotation.annotatedCount > 0) {
      normalizedOpenAI.messages = planAnnotation.messages as never;
      if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
        app.log.debug({ reqId: requestId, count: planAnnotation.annotatedCount }, "plan_file_read_annotated");
      }
    }
    if (planAnnotation.planFilePaths.length > 0) {
      session.record.metadata.plan_file_path = planAnnotation.planFilePaths[planAnnotation.planFilePaths.length - 1];
      const freshShadow = extractPlanContentShadow(
        normalizedOpenAI.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>,
        planAnnotation.planFilePaths,
      );
      if (freshShadow) {
        session.record.metadata.plan_content_shadow = serializeShadow(freshShadow) as unknown as Record<string, unknown>;
      }
    }
    const verifGaps = annotateVerificationGaps(normalizedOpenAI.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>);
    if (verifGaps.annotatedCount > 0) {
      normalizedOpenAI.messages = verifGaps.messages as never;
    }
    if (injectPlanModeRecoveryHint(normalizedOpenAI.messages as Array<{ role: string; content: unknown }>)) {
      app.log.info({ reqId: requestId }, "plan_mode_recovery_hint_injected");
    }
  }
  optimizationLedger.recordAfterPruning(normalizedOpenAI.messages as Array<{ content?: unknown }>);

  return {
    sessionKey,
    session,
    runtimePreferences,
    clientToolCapabilities,
    forensicsCapabilityMatrix,
    workspaceInspection,
    freshImplicitSessionNotice,
  };
}
