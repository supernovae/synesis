import type { FastifyRequest } from "fastify";

import type { AuthUser } from "../auth.js";
import type { ClaudeMessagesRouteDependencies } from "../server/route-dependencies.js";
import type { ClaudeMessagesRequest } from "../schemas.js";
import { ClaudeMessagesRequestSchema } from "../schemas.js";
import { normalizeToolDescriptions } from "../compat/tool-description-normalizer.js";
import { applyToolSearchPolicy } from "../compat/tool-search-policy.js";
import { sortToolSchemas } from "../compat/sorted-tools.js";
import { mergeSynesisClarificationFromRequestMetadata } from "../validation/clarification-schema.js";
import {
  claudeMessagesToOpenAI,
  sanitizeToolCalls,
} from "../tool-mapping.js";
import { claudeSystemToMessage, resolveClaudeConversationId } from "../protocol/claude-messages-helpers.js";
import {
  applySessionTaskCapabilities,
  buildProtocolSessionIdentity,
  runProtocolSessionBootstrap,
} from "../session/protocol-session.js";
import { detectFreshImplicitSessionStart } from "../session/session-key.js";
import { applyWorkspaceBoundary, hasPersistedWorkspaceState } from "../state/workspace-session-boundary.js";
import { toSessionExecutionContextSystemBlock } from "../adapters/session-execution-context.js";
import {
  appendPathContextToAdapterBlock,
  parseSessionExecutionContext,
} from "../adapters/client-adapter-packs.js";
import { extractMetadataFromMessages } from "../providers/prefix-optimizer/index.js";
import { mergePathContextWithClientMetadata } from "./workspace-metadata-prebackfill.js";
import {
  detectClientToolCapabilities,
  isPlanImplementationApprovalTurn,
} from "../adapters/client-tool-capabilities.js";
import {
  deriveModelExecutionPolicy,
  resolveModelArchitectureProfile,
} from "../providers/model-architecture-profile.js";
import {
  normalizeHistoricalContent,
  stabilizeToolCallIds,
} from "../reduction/historical-normalizer.js";
import { normalizeReadSnapshotMessages } from "../reduction/read-snapshot-normalizer.js";
import { assessVerificationFromMessages as assessVerificationSignals } from "../verification/staff-completion.js";
import { detectClientTaskCapabilities } from "../task-ledger/index.js";

type ReduceMessagesOpts = import("../reduction/tool-result-reducer.js").ReduceMessagesOpts;
type RequestForensicsRecord = import("../telemetry/request-forensics.js").RequestForensicsRecord;
type SessionState = Awaited<ReturnType<ClaudeMessagesRouteDependencies["session"]["getSessionState"]>>;
type SessionIdentity = ReturnType<typeof buildProtocolSessionIdentity>;
type Deps = Pick<
  ClaudeMessagesRouteDependencies,
  | "runtime"
  | "protocol"
  | "session"
  | "workspace"
  | "reduction"
  | "governance"
  | "planning"
  | "adapter"
>;

interface ClaudeMessagesRoutePreparationInput {
  deps: Deps;
  request: FastifyRequest;
  authUser: AuthUser;
  requestId: string;
  anthropicVersion: string;
}

export type ClaudeMessagesRoutePreparationResult =
  | {
      ok: false;
      statusCode: number;
      body: Record<string, unknown>;
    }
  | {
      ok: true;
      body: ClaudeMessagesRequest;
      taskCue: string;
      clientKind: string;
      conversationId: string;
      compactionOptions: ReduceMessagesOpts;
      phasePolicyEnabledByMatrix: boolean;
      forensicsCapabilityMatrix: RequestForensicsRecord["capabilityMatrix"];
      processedTools: Array<Record<string, unknown>> | undefined;
      normalizedFromClaude: { messages: unknown[] };
      toolResultCount: number;
      trajectoryDiagnostics: Record<string, unknown>;
      verificationAssessment: ReturnType<typeof assessVerificationSignals>;
      adapterProfile: ReturnType<ClaudeMessagesRouteDependencies["adapter"]["clientAdapterPacks"]["resolve"]>;
      openClawStrictGovernance: boolean;
      pathContext: ReturnType<typeof parseSessionExecutionContext>;
      adapterBlock: string | undefined;
      latestUser: { role: string; content: unknown } | undefined;
      manifest: ReturnType<ClaudeMessagesRouteDependencies["workspace"]["projectManifestService"]["build"]>;
      identity: SessionIdentity;
      sessionKey: string;
      session: SessionState;
      runtimePreferences: unknown;
      clientToolCapabilities: ReturnType<typeof detectClientToolCapabilities>;
      workspaceInspection: Awaited<ReturnType<typeof applyWorkspaceBoundary>>;
    };

export async function prepareClaudeMessagesRoute(
  input: ClaudeMessagesRoutePreparationInput,
): Promise<ClaudeMessagesRoutePreparationResult> {
  const {
    runtime: {
      app,
      config,
      crypto,
      readdir,
      withSpan,
      withSpanAsync,
    },
    protocol: {
      debugProtocolLog,
      extractLatestUserPromptFromMessages,
      formatValidationError,
    },
    session: {
      applyAuthKeyAttribution,
      getSessionKey,
      getSessionState,
      distributedCounters,
      loadUserRuntimePreferences,
      recordSessionEvent,
      sessions,
      updateTracePromptMetadata,
    },
    workspace: {
      projectManifestService,
      resetWorkspaceScopedSessionState,
      workspaceStatePresence,
    },
    reduction: {
      annotatePlanFileReads,
      annotateVerificationGaps,
      applyIngressCapToToolMessages,
      enrichmentPool,
      extractPlanContentShadow,
      findLastUserPromptIdx,
      getContentDedup,
      getFileSnapshotRegistry,
      getMemoryGovernor,
      remediatePlanFileStubs,
      resolveCompactionBackendModelHintFromRequestModel,
      runValidationTierCFallback,
      serializeShadow,
      toolResultReduction,
      transcriptPruning,
      validationNormalization,
      yarnDedupeLayer,
    },
    governance: {
      governanceClient,
      inferModelFamily,
      isGenuineUserPromptMessage: isGenuineUserPromptFromDeps,
      isMatrixCapabilityEnabled,
      isOpenClawProfile,
      openClawProfileStats,
      resolveCapabilityMatrix,
    },
    planning: {
      inferTrajectoryDiagnosticsFromMessages,
      injectPlanModeRecoveryHint,
    },
    adapter: {
      clientAdapterPacks,
    },
  } = input.deps;

  const normalizedIngress = normalizeToolDescriptions(input.request.body, "claude", "/v1/messages");
  for (const truncation of normalizedIngress.truncations) {
    app.log.warn({ reqId: input.requestId, ...truncation }, "tool_description_truncated");
  }
  const parsed = ClaudeMessagesRequestSchema.safeParse(normalizedIngress.body);
  if (!parsed.success) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        type: "error",
        error: { type: "invalid_request_error", message: formatValidationError(parsed.error) },
      },
    };
  }
  const body: ClaudeMessagesRequest = parsed.data;
  const taskCue = extractLatestUserPromptFromMessages(body.messages as Array<{ role: string; content: unknown }>);

  const clientKind = String((input.request.headers["x-synesis-client"] as string | undefined) ?? "claude-code");
  const conversationId = resolveClaudeConversationId(
    body.metadata,
    input.request.headers as Record<string, unknown>,
    {
      debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
      debugLog: (record, message) => app.log.debug(record, message),
    },
  );
  const peekWatermark = (() => {
    const existingKey = `${input.authUser.userId}:${conversationId}:${clientKind}`;
    for (const [k, v] of sessions) {
      if (k.includes(existingKey) || (conversationId && k.includes(conversationId))) return v.pruningWatermark;
    }
    return undefined;
  })();
  const compactionOptions: ReduceMessagesOpts = {
    backendModelHint: resolveCompactionBackendModelHintFromRequestModel(body.model),
  };
  const matrixModelPath = String(compactionOptions.backendModelHint ?? body.model ?? "");
  const matrixModelId = String(body.model ?? compactionOptions.backendModelHint ?? "");
  const matrixFamily = inferModelFamily(matrixModelPath || matrixModelId);
  const capabilityResolution = resolveCapabilityMatrix(
    governanceClient?.getCapabilityMatrix() ?? null,
    {
      model_id: matrixModelId,
      model_path: matrixModelPath,
      family: matrixFamily,
    },
  );
  const reducersEnabled = config.SYNESIS_YARN_REDUCERS_ENABLED && isMatrixCapabilityEnabled(
    config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.reducers_enabled",
  );
  const transcriptPruneEnabled = isMatrixCapabilityEnabled(
    config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.transcript_prune_enabled",
  );
  const phasePolicyEnabledByMatrix = isMatrixCapabilityEnabled(
    config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.phase_execution_policy_enabled",
  );
  const jsonCompactionEnabled = isMatrixCapabilityEnabled(
    config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.json_compaction_enabled",
  );
  const contentDedupeEnabled = config.SYNESIS_YARN_DEDUPE_ENABLED && isMatrixCapabilityEnabled(
    config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.content_dedupe_enabled",
  );
  const responseDedupeEnabled = config.SYNESIS_YARN_RESPONSE_DEDUPE_ENABLED && isMatrixCapabilityEnabled(
    config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.response_dedupe_enabled",
  );
  const historicalNormalizeEnabled = config.SYNESIS_YARN_HISTORICAL_NORMALIZE_ENABLED && isMatrixCapabilityEnabled(
    config.SYNESIS_YARN_GOVERNANCE_DISABLED,
    capabilityResolution.mode,
    capabilityResolution.resolved_capabilities,
    "yarn.historical_normalize_enabled",
  );
  compactionOptions.jsonCompactionEnabled = jsonCompactionEnabled;

  const systemMsg = claudeSystemToMessage(body.system);
  const rawOpenAIMessages = withSpan("yarn.enrichment", { "yarn.path": "claude" }, () =>
    claudeMessagesToOpenAI(body.messages as never),
  );
  const sanitizedOpenAIMessages = sanitizeToolCalls(rawOpenAIMessages as never);
  let openAIMessages = systemMsg ? [systemMsg, ...sanitizedOpenAIMessages] : sanitizedOpenAIMessages;
  if (config.SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES > 0 && !config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const ingress = applyIngressCapToToolMessages(
      openAIMessages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>,
      config.SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES,
    );
    if (ingress.cappedToolResults > 0) {
      openAIMessages = ingress.messages as typeof openAIMessages;
      if (config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED) {
        app.log.info(
          {
            reqId: input.requestId,
            capped_tool_results: ingress.cappedToolResults,
            bytes_reclaimed: ingress.bytesReclaimed,
            max_bytes: config.SYNESIS_YARN_INGRESS_MAX_TOOL_MESSAGE_BYTES,
          },
          "yarn_harness_ingress_cap",
        );
      }
    }
  }

  const toolSearchResult = applyToolSearchPolicy(
    body.tools as Array<Record<string, unknown>> | undefined,
    config.SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE,
  );
  const processedTools = config.SYNESIS_YARN_SORTED_TOOLS_ENABLED
    ? sortToolSchemas(toolSearchResult.tools)
    : toolSearchResult.tools;

  const reducedClaude = config.SYNESIS_YARN_GOVERNANCE_DISABLED || !reducersEnabled
    ? { messages: openAIMessages as never, reducedCount: 0 }
    : enrichmentPool.isAvailable()
      ? await withSpanAsync("yarn.enrichment", { "yarn.path": "claude" }, () =>
          toolResultReduction.reduceMessagesAsync(openAIMessages as never, enrichmentPool, taskCue, peekWatermark, compactionOptions),
        )
      : withSpan("yarn.enrichment", { "yarn.path": "claude" }, () =>
          toolResultReduction.reduceMessages(openAIMessages as never, taskCue, peekWatermark, compactionOptions),
        );
  const toolResultCount = (openAIMessages as Array<{ role: string }>).filter((m) => m.role === "tool").length;
  if (config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED && reducedClaude.reducedCount > 0) {
    app.log.info(
      { reqId: input.requestId, tool_result_reduced: reducedClaude.reducedCount },
      "yarn_harness_tool_result_reduction",
    );
  }
  const normalizedFromClaude = await validationNormalization.normalizeMessagesAsync(
    reducedClaude.messages as never,
    runValidationTierCFallback,
  );
  if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED && transcriptPruneEnabled) {
    const prunedClaude = transcriptPruning.prune(
      normalizedFromClaude.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>,
      undefined,
      compactionOptions.backendModelHint,
    );
    if (prunedClaude.pruned) {
      normalizedFromClaude.messages = prunedClaude.messages as never;
    }
    if (config.SYNESIS_YARN_HARNESS_TELEMETRY_ENABLED) {
      const cd = prunedClaude.invocationDelta;
      if (
        prunedClaude.pruned
        || cd.commandsDeduped > 0
        || cd.fileDeduped > 0
        || cd.toolResultsEvicted > 0
        || cd.assistantCondensed > 0
        || cd.nearDuplicatesCollapsed > 0
        || cd.artifactsStored > 0
      ) {
        app.log.info(
          { reqId: input.requestId, pruned: prunedClaude.pruned, transcript_prune: cd },
          "yarn_harness_transcript_prune",
        );
      }
    }
  }
  const trajectoryDiagnostics = inferTrajectoryDiagnosticsFromMessages(
    openAIMessages as Array<{ role: string; content: unknown }>,
  );
  const verificationAssessment = assessVerificationSignals(
    openAIMessages as Array<{ role: string; content: unknown; name?: string }>,
  );

  debugProtocolLog(app.log as never, input.requestId, "/v1/messages", {
    model: body.model,
    anthropicVersion: input.anthropicVersion,
    anthropicBeta: input.request.headers["anthropic-beta"] ?? null,
    messageCount: body.messages.length,
    hasSystem: !!body.system,
    hasTools: !!(body.tools as unknown[])?.length,
    hasThinking: !!body.thinking,
    stream: body.stream,
    toolSearchMode: config.SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE,
    toolSearchStripped: toolSearchResult.strippedDeferredCount,
  });

  const adapterProfile = clientAdapterPacks.resolve(
    clientKind,
    String((input.request.headers["x-synesis-mode"] as string | undefined) ?? ""),
  );
  const openClawStrictGovernance =
    config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED
    && config.SYNESIS_YARN_OPENCLAW_STRICT_GOVERNANCE_ENABLED
    && isOpenClawProfile(adapterProfile);
  if (isOpenClawProfile(adapterProfile)) {
    openClawProfileStats.requestsObserved += 1;
  }
  const headerPathContext = parseSessionExecutionContext(
    input.request.headers as Record<string, string | string[] | undefined>,
    body.metadata ?? null,
  );
  const messageMetadata = extractMetadataFromMessages(normalizedFromClaude.messages as never);
  const pathContext = mergePathContextWithClientMetadata(headerPathContext, messageMetadata);
  const baseAdapterBlock = clientAdapterPacks.toSystemBlock(adapterProfile);
  const sessionContextBlock = toSessionExecutionContextSystemBlock(pathContext);
  const adapterBlock = sessionContextBlock
    ? `${baseAdapterBlock}\n\n${sessionContextBlock}`
    : appendPathContextToAdapterBlock(
        baseAdapterBlock,
        input.request.headers as Record<string, string | string[] | undefined>,
        body.metadata ?? null,
        clientKind,
        { gitPolicyMode: config.SYNESIS_YARN_GIT_POLICY_MODE },
      );
  const latestUser = [...(normalizedFromClaude.messages as Array<{ role: string; content: unknown }>)]
    .reverse()
    .find((m) => m.role === "user");
  const manifest = projectManifestService.build(normalizedFromClaude.messages as never);
  const freshImplicitStart = detectFreshImplicitSessionStart({
    clientKind,
    conversationId,
    messages: body.messages as Array<{ role?: unknown; content?: unknown; tool_calls?: unknown }>,
  });
  const identity = buildProtocolSessionIdentity({
    authUser: input.authUser,
    conversationId,
    clientKind,
    forceFreshImplicitSession: freshImplicitStart.fresh,
    freshImplicitSessionReason: freshImplicitStart.fresh ? freshImplicitStart.reason : undefined,
    freshImplicitMessageCount: freshImplicitStart.fresh ? body.messages.length : undefined,
    sessionRequestId: input.requestId,
  });
  const bootstrap = await runProtocolSessionBootstrap({
    identity,
    authUser: input.authUser,
    getSessionKey,
    getSessionState,
    applyAuthKeyAttribution,
    loadRuntimePreferences: loadUserRuntimePreferences,
    debugEnabled: config.SYNESIS_YARN_DEBUG_PROTOCOL,
    debugConversationSource: "metadata",
    debugFallbackSource: "fallback",
    debugLog: (record) => app.log.debug(record, "session_resolution"),
  });
  const sessionKey = bootstrap.sessionKey;
  const session = bootstrap.session;
  const runtimePreferences = bootstrap.runtimePreferences;
  const rawClientToolCapabilities = detectClientToolCapabilities(
    processedTools as Array<{ name?: string; function?: { name?: string } }> | undefined,
    clientKind,
    taskCue,
  );
  const planImplementationApproved = isPlanImplementationApprovalTurn(
    normalizedFromClaude.messages as Array<{ role?: string; content?: unknown; name?: string }>,
  );
  const clientToolCapabilities =
    rawClientToolCapabilities.isClaudeCode
    && rawClientToolCapabilities.planModeRequested
    && planImplementationApproved
      ? { ...rawClientToolCapabilities, planModeRequested: false }
      : rawClientToolCapabilities;
  const detectedTaskCapabilities = detectClientTaskCapabilities(
    processedTools as Array<{ name?: string; function?: { name?: string } }> | undefined,
    clientKind,
  );
  applySessionTaskCapabilities(session, detectedTaskCapabilities);
  const capabilityHash = crypto
    .createHash("sha256")
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
    input.requestId,
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
  const msgCount = (body.messages as unknown[]).length;
  const recentExempt = Number(config.SYNESIS_YARN_TASK_PRUNING_RECENT_EXEMPT) || 0;
  session.pruningWatermark = Math.max(session.pruningWatermark, msgCount - recentExempt);
  const lastMsg = Array.isArray(body.messages) && body.messages.length > 0
    ? (body.messages as Array<{ role?: string; content?: unknown }>)[body.messages.length - 1]
    : undefined;
  const isNewUserPrompt = isGenuineUserPromptFromDeps(lastMsg);
  if (isNewUserPrompt) {
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
    requestId: input.requestId,
    pathHints: pathContext,
    readDir: async (root) => readdir(root, { withFileTypes: true }),
    hasPersistedState: hasPersistedWorkspaceState(session, workspaceStatePresence(sessionKey)),
    resetWorkspaceState: resetWorkspaceScopedSessionState,
    recordSessionEvent,
  });
  {
    const readSnapshotRegistry = getFileSnapshotRegistry(sessionKey);
    const readSnapshotNormalization = await normalizeReadSnapshotMessages(
      normalizedFromClaude.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown; tool_calls?: unknown }>,
      readSnapshotRegistry,
      {
        projectRoot: pathContext.projectRoot ?? pathContext.shellCwd ?? null,
        anchorDir: pathContext.shellCwd ?? pathContext.projectRoot ?? null,
        lastUserPromptIdx: findLastUserPromptIdx(normalizedFromClaude.messages as Array<{ role?: string; content?: unknown }>),
      },
    );
    if (readSnapshotNormalization.normalizedCount > 0) {
      normalizedFromClaude.messages = readSnapshotNormalization.messages as never;
      if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
        app.log.debug({
          reqId: input.requestId,
          normalized: readSnapshotNormalization.normalizedCount,
          replayed: readSnapshotNormalization.replayedCount,
          fallback: readSnapshotNormalization.fallbackCount,
        }, "read_snapshot_normalization_applied");
      }
    }
  }
  if (!config.SYNESIS_YARN_GOVERNANCE_DISABLED) {
    const dedup = getContentDedup(sessionKey);
    if (contentDedupeEnabled && session.lastIncomingMessageCount > 0 && msgCount < session.lastIncomingMessageCount * 0.6) {
      dedup.reset();
      getFileSnapshotRegistry(sessionKey).markCompaction("SUMMARY_ONLY");
      recordSessionEvent(sessionKey, identity.userId, identity.orgId, "external_compaction_detected", "dedup_reset", `msgs ${session.lastIncomingMessageCount} -> ${msgCount}`);
    }
    session.lastIncomingMessageCount = msgCount;
    if (contentDedupeEnabled) {
      const dedupResult = dedup.processMessages(
        normalizedFromClaude.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown }>,
      );
      if (dedupResult.dedupCount > 0) {
        normalizedFromClaude.messages = dedupResult.messages as never;
        const memoryTracker = getMemoryGovernor(sessionKey);
        for (const p of dedupResult.dedupPaths) {
          memoryTracker.trackFileRead(p);
          if (dedup.getStructuralIndex()?.getFileSummary(p)) {
            memoryTracker.trackSummaryGenerated(p);
          }
        }
        if (dedupResult.dedupPaths.length > 0 && config.SYNESIS_YARN_DEBUG_PROTOCOL) {
          app.log.debug({ reqId: input.requestId, dedupCount: dedupResult.dedupCount, paths: dedupResult.dedupPaths }, "content_dedup_applied");
        }
      }
    }
    if (responseDedupeEnabled && yarnDedupeLayer) {
      const msgs = normalizedFromClaude.messages as Array<{ role: string; name?: string; tool_call_id?: string; content: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }>;
      let responseDedupHits = 0;
      for (let mi = 0; mi < msgs.length; mi++) {
        const m = msgs[mi];
        if (m.role !== "tool" || typeof m.content !== "string") continue;
        const toolName = m.name ?? "";
        let toolInput: unknown;
        if (m.tool_call_id) {
          for (let ai = mi - 1; ai >= 0; ai--) {
            const am = msgs[ai];
            if (am.role === "assistant" && am.tool_calls) {
              const match = am.tool_calls.find((tc) => tc.id === m.tool_call_id);
              if (match?.function?.arguments) {
                try { toolInput = JSON.parse(match.function.arguments); } catch { toolInput = match.function.arguments; }
                break;
              }
            }
          }
        }
        try {
          const wrapped = yarnDedupeLayer.responseDedupe.wrapToolResult(toolName, toolInput, m.content);
          if (wrapped !== m.content) {
            msgs[mi] = { ...m, content: wrapped };
            responseDedupHits += 1;
          }
        } catch (e) {
          app.log.warn({ reqId: input.requestId, err: (e as Error).message }, "response_dedupe_bypass");
        }
      }
      if (responseDedupHits > 0) {
        normalizedFromClaude.messages = msgs as never;
        if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
          app.log.debug({ reqId: input.requestId, hits: responseDedupHits }, "response_dedupe_applied");
        }
      }
    }
    if (historicalNormalizeEnabled) {
      const histMsgs = normalizedFromClaude.messages as Array<{ role: string; tool_call_id?: string; content: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }>;
      const keepFromIdx = transcriptPruning.computeKeepFromIndex?.(histMsgs as never, compactionOptions.backendModelHint) ?? histMsgs.length;
      const histResult = normalizeHistoricalContent(histMsgs as never, keepFromIdx);
      if (histResult.stats.messagesNormalized > 0) {
        normalizedFromClaude.messages = histResult.messages as never;
      }
      if (!session.skipToolIdStabilization) {
        const idResult = stabilizeToolCallIds(normalizedFromClaude.messages as never, keepFromIdx);
        if (idResult.rewriteCount > 0) {
          normalizedFromClaude.messages = idResult.messages as never;
          if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
            app.log.debug({ reqId: input.requestId, rewrites: idResult.rewriteCount }, "tool_id_stabilization_applied");
          }
        }
      } else {
        app.log.warn({ reqId: input.requestId }, "tool_id_stabilization_skipped_after_missing_tool_results");
        session.skipToolIdStabilization = false;
      }
    }
    const planRemediation = remediatePlanFileStubs(normalizedFromClaude.messages as Array<{ role: string; content: unknown }>);
    if (planRemediation.remediatedCount > 0) {
      normalizedFromClaude.messages = planRemediation.messages as never;
      app.log.warn({ reqId: input.requestId, count: planRemediation.remediatedCount }, "plan_file_dedup_remediated");
    }
    const planAnnotation = annotatePlanFileReads(normalizedFromClaude.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>);
    if (planAnnotation.annotatedCount > 0) {
      normalizedFromClaude.messages = planAnnotation.messages as never;
      if (config.SYNESIS_YARN_DEBUG_PROTOCOL) {
        app.log.debug({ reqId: input.requestId, count: planAnnotation.annotatedCount }, "plan_file_read_annotated");
      }
    }
    if (planAnnotation.planFilePaths.length > 0) {
      session.record.metadata.plan_file_path = planAnnotation.planFilePaths[planAnnotation.planFilePaths.length - 1];
      const freshShadow = extractPlanContentShadow(
        normalizedFromClaude.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>,
        planAnnotation.planFilePaths,
      );
      if (freshShadow) {
        session.record.metadata.plan_content_shadow = serializeShadow(freshShadow) as unknown as Record<string, unknown>;
      }
    }
    const verifGaps = annotateVerificationGaps(normalizedFromClaude.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>);
    if (verifGaps.annotatedCount > 0) {
      normalizedFromClaude.messages = verifGaps.messages as never;
    }
    if (injectPlanModeRecoveryHint(normalizedFromClaude.messages as Array<{ role: string; content: unknown }>)) {
      app.log.info({ reqId: input.requestId }, "plan_mode_recovery_hint_injected");
    }
  }
  mergeSynesisClarificationFromRequestMetadata(session.record.metadata, body.metadata ?? undefined);
  if (latestUser && typeof latestUser.content === "string") {
    updateTracePromptMetadata(session, latestUser.content);
  }

  return {
    ok: true,
    body,
    taskCue,
    clientKind,
    conversationId,
    compactionOptions,
    phasePolicyEnabledByMatrix,
    forensicsCapabilityMatrix,
    processedTools,
    normalizedFromClaude,
    toolResultCount,
    trajectoryDiagnostics,
    verificationAssessment,
    adapterProfile,
    openClawStrictGovernance,
    pathContext,
    adapterBlock,
    latestUser,
    manifest,
    identity,
    sessionKey,
    session,
    runtimePreferences,
    clientToolCapabilities,
    workspaceInspection,
  };
}
