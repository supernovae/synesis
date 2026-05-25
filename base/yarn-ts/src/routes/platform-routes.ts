import type { FastifyInstance } from "fastify";
import type { Registry } from "prom-client";

import type { AuthResolver } from "../auth.js";
import {
  buildClaudeBootstrapTemplate,
  executeClaudeCompatCommand,
  resolveClaudeModelSelection,
} from "../claude-compat.js";
import { normalizeToolDescriptions } from "../compat/tool-description-normalizer.js";
import type { AppConfig } from "../config.js";
import {
  chatCompletionToResponseObject,
  OpenAIResponsesRequestSchema,
  responseObjectToSseEvents,
  responsesRequestToChatCompletion,
} from "../responses-compat.js";
import {
  normalizeUserRuntimePreferences,
  userRuntimePreferencesResponse,
  type UserRuntimePreferences,
} from "../runtime/user-preferences.js";
import {
  ClaudeBootstrapQuerySchema,
  ClaudeCommandExecuteRequestSchema,
  ClaudeModelResolutionQuerySchema,
  type ClaudeBootstrapQuery,
  type ClaudeCommandExecuteRequest,
  type ClaudeModelResolutionQuery,
} from "../schemas.js";
import type { SessionIdentity } from "../session/session-key.js";
import { summarizeCacheShapeDiagnostics } from "../telemetry/cache-shape-diagnostics.js";

type WritableRaw = NodeJS.WritableStream & { destroyed?: boolean };

type RequireInternalToken = (req: { headers: Record<string, unknown> }) => boolean;
type FgaCheck = (user: string, relation: string, objectType: string, objectId: string) => Promise<{ allowed: boolean }>;
type SafeWrite = (raw: WritableRaw, data: string) => boolean;
type SafeEnd = (raw: WritableRaw) => void;
type FormatValidationError = (error: { issues?: Array<{ path?: PropertyKey[]; message?: string }>; message: string }) => string;
type SelectedOpenAiCompatHeaders = (headers: Record<string, unknown>) => Record<string, string>;
type RecordSessionEvent = (
  sessionKey: string,
  userId: string,
  orgId: string,
  type: string,
  source: string,
  summary: string,
) => void;

interface StatsProvider {
  getStats(): unknown;
}

interface SessionStateForTelemetry {
  history: Array<{ content: string }>;
}

interface SessionStateForCommand {
  record: {
    sessionKey: string;
    userId: string;
    orgId: string;
  };
}

interface SessionStoreLike {
  ping(): Promise<boolean>;
  saveUserRuntimePreferences(userId: string, preferences: UserRuntimePreferences, ttlMs: number): Promise<void>;
}

interface UsageWriterLike {
  getStats(): unknown;
  getConversationMemoryStats(): unknown;
  getPoolStats(): unknown;
}

interface ToolResultReductionLike {
  getStats(): {
    reducedCount: number;
    fallbackToArtifactCount: number;
    artifactHandleCount: number;
    rawCharsTotal: number;
    reducedCharsTotal: number;
    jsonCompactionCount: number;
  };
  getRecallStats(): unknown;
  getVerificationStats(): unknown;
}

interface ContentDedupLike {
  getStats(): {
    totalReads: number;
    deduplicatedReads: number;
    charsSaved: number;
  };
}

interface DiagnosticRegistryLike {
  listRecent(): Promise<{ diagnostics: unknown[]; source: string }>;
  getByRequestId(requestId: string): Promise<unknown | null>;
  getRingStats(): { max: number; current: number };
}

interface UserRateLimiterLike {
  check(userId: string): Promise<{
    allowed: boolean;
    currentCount?: number;
    limit?: number;
    retryAfterSeconds?: number;
  }>;
  getStats(): unknown;
}

interface TierRegistryLike {
  getAvailableModels(): Array<{ id: string; [key: string]: unknown }>;
}

interface ArtifactStoreLike extends StatsProvider {
  get(id: string): unknown | null;
}

interface PlatformRouteDependencies {
  app: FastifyInstance;
  config: AppConfig;
  authResolver: Pick<AuthResolver, "resolve" | "requireCoderScope" | "getPoolStats">;
  fgaCheck: FgaCheck;
  userRateLimiter: UserRateLimiterLike;
  requireInternalToken: RequireInternalToken;
  promRegistry: Registry;
  usagePersistenceEnabled: boolean;
  usageWriter: UsageWriterLike;
  sessionStore: SessionStoreLike;
  sessions: Iterable<[unknown, SessionStateForTelemetry]>;
  validationNormalization: StatsProvider;
  toolResultReduction: ToolResultReductionLike;
  transcriptPruning: StatsProvider;
  contentDedupBySession: ReadonlyMap<unknown, ContentDedupLike>;
  toolArgHardeningStats: Record<string, unknown>;
  toolSchemaPruningStats: Record<string, unknown>;
  toolBlobRedisEnabled: boolean;
  openClawProfileStats: Record<string, unknown>;
  contextAdmissionStats: Record<string, unknown> & { byPath?: Record<string, unknown> };
  workingFrameService: StatsProvider;
  projectManifestService: StatsProvider;
  policyEngine: StatsProvider;
  governanceClient: StatsProvider | null;
  phaseOrchestrator: StatsProvider;
  clientAdapterPacks: StatsProvider & { getCatalog(): unknown };
  stablePrefixService: StatsProvider;
  yarnToolPrefixCache: StatsProvider | null;
  artifactRetrieval: StatsProvider;
  knowledgeSearch: StatsProvider;
  getEvidencePrefetchStats(): unknown;
  getPatternPrefetchStats(): unknown;
  getPatternFeedbackStats(): unknown;
  artifactStore: ArtifactStoreLike;
  circuitBreakers: StatsProvider;
  distributedCounters: StatsProvider;
  streamAdmission: StatsProvider;
  attentionPositioning: StatsProvider;
  languagePacksConformance(): unknown;
  sessionContinuity: StatsProvider;
  enrichmentPool: StatsProvider;
  sensemakingStats: unknown;
  getEventLoopStats(): unknown;
  promptSnapshotRegistry: {
    service: string;
    profiles: Array<{ content_hash: string }>;
    assignments: unknown[];
    updated_at?: unknown;
  } | null;
  diagnosticRegistry: DiagnosticRegistryLike;
  resolveRequestId(headers: Record<string, unknown>): string;
  formatValidationError: FormatValidationError;
  selectedOpenAiCompatHeaders: SelectedOpenAiCompatHeaders;
  safeWrite: SafeWrite;
  safeEnd: SafeEnd;
  tierRegistry: TierRegistryLike;
  loadUserRuntimePreferences(userId: string): Promise<UserRuntimePreferences>;
  getSessionKey(identity: SessionIdentity): Promise<string>;
  getSessionState(sessionKey: string, identity: SessionIdentity): Promise<SessionStateForCommand>;
  forceCheckpoint(state: SessionStateForCommand): Promise<boolean>;
  casSessionSave(state: SessionStateForCommand): Promise<unknown>;
  recordSessionEvent: RecordSessionEvent;
}

function computeEfficiencyIndex(toolResultReduction: ToolResultReductionLike): {
  score: number;
  reducerHitRate: number;
  artifactOffloadRate: number;
  tokenSavingsRate: number;
  jsonCompactionRate: number;
} {
  const stats = toolResultReduction.getStats();
  const total = stats.reducedCount + stats.fallbackToArtifactCount;
  const reducerHitRate = total > 0 ? (total - stats.fallbackToArtifactCount) / total : 0;
  const artifactOffloadRate = total > 0 ? stats.artifactHandleCount / total : 0;
  const tokenSavingsRate = stats.rawCharsTotal > 0
    ? (stats.rawCharsTotal - stats.reducedCharsTotal) / stats.rawCharsTotal
    : 0;
  const jsonCompactionRate = total > 0 ? stats.jsonCompactionCount / total : 0;
  const score = reducerHitRate * 0.3 + artifactOffloadRate * 0.15 + tokenSavingsRate * 0.45 + jsonCompactionRate * 0.1;
  return {
    score: Math.round(score * 1000) / 1000,
    reducerHitRate: Math.round(reducerHitRate * 1000) / 1000,
    artifactOffloadRate: Math.round(artifactOffloadRate * 1000) / 1000,
    tokenSavingsRate: Math.round(tokenSavingsRate * 1000) / 1000,
    jsonCompactionRate: Math.round(jsonCompactionRate * 1000) / 1000,
  };
}

async function authorizeClaudeCompatRequest(
  deps: Pick<PlatformRouteDependencies, "authResolver" | "fgaCheck" | "userRateLimiter">,
  authorization: string | undefined,
): Promise<
  | { ok: true; authUser: Awaited<ReturnType<AuthResolver["resolve"]>> }
  | { ok: false; statusCode: number; retryAfter?: number; body: Record<string, unknown> }
> {
  let authUser: Awaited<ReturnType<AuthResolver["resolve"]>>;
  try {
    authUser = await deps.authResolver.resolve(authorization);
  } catch {
    return { ok: false, statusCode: 401, body: { error: { type: "auth_error", message: "Authentication required" } } };
  }
  try {
    deps.authResolver.requireCoderScope(authUser);
  } catch {
    return { ok: false, statusCode: 403, body: { error: { type: "authz_error", message: "Insufficient scope for coder access" } } };
  }
  const fgaResult = await deps.fgaCheck(`user:${authUser.userId}`, "can_invoke", "yarn_endpoint", "messages");
  if (!fgaResult.allowed) {
    return { ok: false, statusCode: 403, body: { error: { type: "authz_error", message: "Authorization denied by policy" } } };
  }
  const rateResult = await deps.userRateLimiter.check(authUser.userId);
  if (!rateResult.allowed) {
    const retryAfterSeconds = rateResult.retryAfterSeconds ?? 0;
    return {
      ok: false,
      statusCode: 429,
      retryAfter: retryAfterSeconds,
      body: {
        error: {
          type: "rate_limit_error",
          message: `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
        },
      },
    };
  }
  return { ok: true, authUser };
}

export function registerPlatformRoutes(deps: PlatformRouteDependencies): void {
  const {
    app,
    config,
    authResolver,
    userRateLimiter,
    requireInternalToken,
    promRegistry,
    usagePersistenceEnabled,
    usageWriter,
    sessionStore,
    sessions,
    validationNormalization,
    toolResultReduction,
    transcriptPruning,
    contentDedupBySession,
    toolArgHardeningStats,
    toolSchemaPruningStats,
    toolBlobRedisEnabled,
    openClawProfileStats,
    contextAdmissionStats,
    workingFrameService,
    projectManifestService,
    policyEngine,
    governanceClient,
    phaseOrchestrator,
    clientAdapterPacks,
    stablePrefixService,
    yarnToolPrefixCache,
    artifactRetrieval,
    knowledgeSearch,
    getEvidencePrefetchStats,
    getPatternPrefetchStats,
    getPatternFeedbackStats,
    artifactStore,
    circuitBreakers,
    distributedCounters,
    streamAdmission,
    attentionPositioning,
    languagePacksConformance,
    sessionContinuity,
    enrichmentPool,
    sensemakingStats,
    getEventLoopStats,
    promptSnapshotRegistry,
    diagnosticRegistry,
    resolveRequestId,
    formatValidationError,
    selectedOpenAiCompatHeaders,
    safeWrite,
    safeEnd,
    tierRegistry,
    loadUserRuntimePreferences,
    getSessionKey,
    getSessionState,
    forceCheckpoint,
    casSessionSave,
    recordSessionEvent,
  } = deps;

  app.get("/health", async () => ({
    status: "ok",
    usage_persistence_enabled: usagePersistenceEnabled,
    usage_write_queue: usageWriter.getStats(),
  }));

  app.get("/health/readiness", async (_req, reply) => {
    const redisOk = await sessionStore.ping();
    if (!redisOk) {
      return reply.code(503).send({ status: "not_ready", reason: "redis_unreachable" });
    }
    return { status: "ready" };
  });

  app.get("/health/telemetry", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
    }
    let activeSessionCount = 0;
    let totalHistoryEntries = 0;
    let checkpointedSessions = 0;
    for (const [, state] of sessions) {
      activeSessionCount++;
      totalHistoryEntries += state.history.length;
      if (state.history.some((m) => m.content.includes("<ARCHITECTURAL_STATE>"))) {
        checkpointedSessions++;
      }
    }
    return {
      timestamp: Date.now(),
      writeQueue: usageWriter.getStats(),
      validationNormalization: validationNormalization.getStats(),
      toolResultReduction: toolResultReduction.getStats(),
      transcriptPruning: transcriptPruning.getStats(),
      contentAddressedDedup: {
        activeSessions: contentDedupBySession.size,
        aggregate: Array.from(contentDedupBySession.values()).reduce(
          (acc, d) => {
            const s = d.getStats();
            return {
              totalReads: acc.totalReads + s.totalReads,
              deduplicatedReads: acc.deduplicatedReads + s.deduplicatedReads,
              charsSaved: acc.charsSaved + s.charsSaved,
            };
          },
          { totalReads: 0, deduplicatedReads: 0, charsSaved: 0 },
        ),
      },
      toolArgHardening: { ...toolArgHardeningStats },
      toolSchemaPruning: { ...toolSchemaPruningStats },
      openClawProfile: { ...openClawProfileStats },
      contextAdmission: { ...contextAdmissionStats, byPath: { ...(contextAdmissionStats.byPath ?? {}) } },
      workingFrame: workingFrameService.getStats(),
      projectManifest: projectManifestService.getStats(),
      deterministicPolicy: policyEngine.getStats(),
      governance: governanceClient ? governanceClient.getStats() : { enabled: false },
      phaseOrchestrator: phaseOrchestrator.getStats(),
      clientAdapterPacks: clientAdapterPacks.getStats(),
      sawtoothContext: {
        activeSessionCount,
        totalHistoryEntries,
        checkpointedSessions,
        checkpointThreshold: config.SYNESIS_YARN_SAWTOOTH_CHECKPOINT_TOOL_CALLS,
      },
      stablePrefix: stablePrefixService.getStats(),
      toolPrefixCache: yarnToolPrefixCache ? yarnToolPrefixCache.getStats() : { enabled: false },
      artifactRetrieval: artifactRetrieval.getStats(),
      knowledgeSearch: knowledgeSearch.getStats(),
      evidencePrefetch: getEvidencePrefetchStats(),
      patternPrefetch: getPatternPrefetchStats(),
      patternFeedback: getPatternFeedbackStats(),
      artifactStore: artifactStore.getStats(),
      circuitBreakers: circuitBreakers.getStats(),
      userRateLimiter: userRateLimiter.getStats(),
      distributedCounters: distributedCounters.getStats(),
      streamAdmission: streamAdmission.getStats(),
      attentionPositioning: attentionPositioning.getStats(),
      compressionEfficiencyIndex: computeEfficiencyIndex(toolResultReduction),
      recall: toolResultReduction.getRecallStats(),
      verification: toolResultReduction.getVerificationStats(),
      languagePacks: languagePacksConformance(),
      sessionContinuity: sessionContinuity.getStats(),
      conversationMemory: usageWriter.getConversationMemoryStats(),
      workerPool: enrichmentPool.getStats(),
      sensemaking: sensemakingStats,
      eventLoopLag: getEventLoopStats(),
      promptLibrary: {
        loaded: Boolean(promptSnapshotRegistry),
        service: promptSnapshotRegistry?.service ?? "yarn",
        profiles: promptSnapshotRegistry?.profiles.length ?? 0,
        assignments: promptSnapshotRegistry?.assignments.length ?? 0,
        profileHashes: (promptSnapshotRegistry?.profiles ?? []).map((p) => p.content_hash).slice(0, 12),
        updatedAt: promptSnapshotRegistry?.updated_at ?? null,
      },
      connectionPools: {
        auth: authResolver.getPoolStats(),
        usageWriter: usageWriter.getPoolStats(),
      },
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      diagnosticRingMax: diagnosticRegistry.getRingStats().max,
      diagnosticRingCurrent: diagnosticRegistry.getRingStats().current,
      featureFlags: {
        toolBlobRedis: toolBlobRedisEnabled,
        artifactRedisReplica: config.SYNESIS_YARN_ARTIFACT_REDIS_REPLICA_ENABLED,
        sensemakingPromptBlocks: config.SYNESIS_YARN_SENSEMAKING_PROMPT_BLOCK_ENABLED,
        stablePrefix: config.SYNESIS_YARN_STABLE_PREFIX_ENABLED,
        jsonCompaction: config.SYNESIS_YARN_JSON_COMPACTION_ENABLED,
        attentionPositioning: config.SYNESIS_YARN_ATTENTION_POSITIONING_ENABLED,
        artifactRetrieval: config.SYNESIS_YARN_ARTIFACT_RETRIEVAL_ENABLED,
        knowledgeSearch: config.SYNESIS_YARN_KNOWLEDGE_SEARCH_ENABLED,
        evidencePrefetch: config.SYNESIS_YARN_EVIDENCE_PREFETCH_ENABLED,
        governance: config.SYNESIS_YARN_GOVERNANCE_ENABLED,
        governanceBypass: config.SYNESIS_YARN_GOVERNANCE_DISABLED,
        sessionContinuity: config.SYNESIS_YARN_SESSION_CONTINUITY_ENABLED,
        conversationMemory: config.SYNESIS_YARN_CONVERSATION_MEMORY_ENABLED,
        crossConversationRecall: config.SYNESIS_YARN_CROSS_CONVERSATION_RECALL_ENABLED,
        workerPool: config.SYNESIS_YARN_WORKER_POOL_ENABLED,
        contentDispatch: config.SYNESIS_YARN_CONTENT_DISPATCH_ENABLED,
        transcriptPruning: config.SYNESIS_YARN_TRANSCRIPT_PRUNE_ENABLED,
        promptIntakeSteer: config.SYNESIS_YARN_PROMPT_INTAKE_STEER_ENABLED,
        patternRecall: config.SYNESIS_YARN_PATTERN_RECALL_ENABLED,
        recallBypass: config.SYNESIS_YARN_RECALL_BYPASS_ENABLED,
        verificationPlan: config.SYNESIS_YARN_VERIFICATION_PLAN_ENABLED,
        completionGate: config.SYNESIS_YARN_COMPLETION_GATE_ENABLED,
        completionGateHardFail: config.SYNESIS_YARN_COMPLETION_GATE_HARD_FAIL,
        completionGateSkipClarification: config.SYNESIS_YARN_COMPLETION_GATE_SKIP_CLARIFICATION,
        planningUseHorizon: config.SYNESIS_YARN_PLANNING_USE_HORIZON,
        plannerTodoPacket: config.SYNESIS_YARN_PLANNER_TODO_PACKET_ENABLED,
        plannerTodoRequireNativeTool: config.SYNESIS_YARN_PLANNER_TODO_REQUIRE_NATIVE_TOOL,
        decisionMatrix: config.SYNESIS_YARN_DECISION_MATRIX_ENABLED,
        sensemaking: config.SYNESIS_YARN_SENSEMAKING_ENABLED,
        diagnosticPersistence: config.SYNESIS_YARN_DIAGNOSTIC_PERSISTENCE_ENABLED,
        claudeToolSearchMode: config.SYNESIS_YARN_CLAUDE_TOOL_SEARCH_MODE,
        jitterBuffer: config.SYNESIS_YARN_JITTER_BUFFER_ENABLED,
        sortedTools: config.SYNESIS_YARN_SORTED_TOOLS_ENABLED,
        debugProtocol: config.SYNESIS_YARN_DEBUG_PROTOCOL,
        otelEnabled: config.SYNESIS_YARN_OTEL_ENABLED,
      },
      safetyLimits: {
        hardRejectAfter: config.SYNESIS_YARN_POLICY_HARD_REJECT_AFTER,
        sessionSoftMaxInputTokens: config.SYNESIS_YARN_SESSION_SOFT_MAX_INPUT_TOKENS,
        sessionMaxInputTokens: config.SYNESIS_YARN_SESSION_MAX_INPUT_TOKENS,
        sessionBudgetMode: config.SYNESIS_YARN_SESSION_BUDGET_MODE,
        contextAdmissionMode: config.SYNESIS_YARN_CONTEXT_ADMISSION_MODE,
        contextAdmissionWarnTokens: config.SYNESIS_YARN_CONTEXT_ADMISSION_WARN_TOKENS,
        contextAdmissionHardTokens: config.SYNESIS_YARN_CONTEXT_ADMISSION_HARD_TOKENS,
        hourlyTokenThrottleEnabled: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_ENABLED,
        hourlyTokenThrottleWindowMs: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_WINDOW_MS,
        hourlyTokenThrottleSessionLimit: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_SESSION_LIMIT,
        hourlyTokenThrottleUserLimit: config.SYNESIS_YARN_HOURLY_TOKEN_THROTTLE_USER_LIMIT,
        maxOutputTokensSafetyCeiling: config.SYNESIS_YARN_MAX_OUTPUT_TOKENS_SAFETY_CEILING,
        consecutiveToolCallsLimit: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_LIMIT,
        consecutiveToolCallsPivot: config.SYNESIS_YARN_CONSECUTIVE_TOOL_CALLS_PIVOT,
        stagnantToolCyclesLimit: config.SYNESIS_YARN_STAGNANT_TOOL_CYCLES_LIMIT,
        toolLoopNoUserAckLimit: config.SYNESIS_YARN_TOOL_LOOP_NO_USER_ACK_LIMIT,
        toolLoopSoftFailEnabled: config.SYNESIS_YARN_TOOL_LOOP_SOFT_FAIL_ENABLED,
        maxConcurrentStreams: config.SYNESIS_YARN_MAX_CONCURRENT_STREAMS,
        streamQueueMaxDepth: config.SYNESIS_YARN_STREAM_QUEUE_MAX_DEPTH,
        streamQueueWaitTimeoutMs: config.SYNESIS_YARN_STREAM_QUEUE_WAIT_TIMEOUT_MS,
      },
    };
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", promRegistry.contentType);
    return promRegistry.metrics();
  });

  app.get("/v1/diagnostics/recent", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
    }
    const recent = await diagnosticRegistry.listRecent();
    return { diagnostics: recent.diagnostics, count: recent.diagnostics.length, source: recent.source };
  });

  app.get("/v1/diagnostics/cache-shapes/recent", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
    }
    const recent = await diagnosticRegistry.listRecent();
    const summaries = summarizeCacheShapeDiagnostics(
      recent.diagnostics as Array<Record<string, unknown>>,
      diagnosticRegistry.getRingStats().max,
    );
    return {
      summaries,
      count: summaries.length,
      diagnosticCount: recent.diagnostics.length,
      source: recent.source,
    };
  });

  app.get("/v1/diagnostics/:requestId", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Unauthorized" } });
    }
    const { requestId } = req.params as { requestId: string };
    const diagnostic = await diagnosticRegistry.getByRequestId(requestId);
    if (diagnostic) return diagnostic;
    return reply.code(404).send({ error: { type: "not_found", message: "Diagnostic not found" } });
  });

  app.get("/v1", async () => ({
    status: "ok",
    service: "synesis-yarn-ts",
    version: "0.2.0",
    endpoints: ["/v1/models", "/v1/models/{model}", "/v1/chat/completions", "/v1/responses", "/v1/messages"],
  }));

  app.get("/v1/models", async () => ({
    object: "list",
    data: tierRegistry.getAvailableModels(),
  }));

  app.get("/v1/models/:model", async (req, reply) => {
    const { model } = req.params as { model: string };
    const found = tierRegistry.getAvailableModels().find((entry) => entry.id === model);
    if (!found) {
      return reply.code(404).send({
        error: { type: "invalid_request_error", message: `Model '${model}' was not found.` },
      });
    }
    return found;
  });

  app.post("/v1/responses", async (req, reply) => {
    const responseReqId = resolveRequestId(req.headers as Record<string, unknown>);
    const normalizedIngress = normalizeToolDescriptions(req.body, "responses", "/v1/responses");
    for (const truncation of normalizedIngress.truncations) {
      app.log.warn({ reqId: responseReqId, ...truncation }, "tool_description_truncated");
    }
    const parsed = OpenAIResponsesRequestSchema.safeParse(normalizedIngress.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { type: "invalid_request_error", message: formatValidationError(parsed.error) },
      });
    }
    const responseRequest = parsed.data;
    const chatRequest = responsesRequestToChatCompletion(responseRequest);
    const injected = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: selectedOpenAiCompatHeaders(req.headers as Record<string, unknown>),
      payload: JSON.stringify({ ...chatRequest, stream: false }),
    });

    let chatPayload: Record<string, unknown>;
    try {
      chatPayload = JSON.parse(injected.body) as Record<string, unknown>;
    } catch {
      chatPayload = {
        error: {
          type: "api_error",
          message: injected.body || "Unable to parse upstream chat completion response.",
        },
      };
    }
    if (injected.statusCode >= 400) {
      return reply.code(injected.statusCode).send(chatPayload);
    }

    const response = chatCompletionToResponseObject(chatPayload, responseRequest);
    if (!responseRequest.stream) {
      return reply.send(response);
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    for (const evt of responseObjectToSseEvents(response)) {
      if (!safeWrite(reply.raw, `event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`)) break;
    }
    safeWrite(reply.raw, "data: [DONE]\n\n");
    safeEnd(reply.raw);
    return reply;
  });

  app.get("/v1/claude/bootstrap", async (req, reply) => {
    const auth = await authorizeClaudeCompatRequest(deps, req.headers.authorization);
    if (!auth.ok) {
      if (auth.retryAfter != null) reply.header("Retry-After", String(auth.retryAfter));
      return reply.code(auth.statusCode).send(auth.body);
    }

    const parsedQuery = ClaudeBootstrapQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: parsedQuery.error.message } });
    }
    const query: ClaudeBootstrapQuery = parsedQuery.data;
    const template = buildClaudeBootstrapTemplate(query.preset);
    return {
      object: "claude_bootstrap",
      template,
    };
  });

  app.get("/v1/claude/model-resolution", async (req, reply) => {
    const auth = await authorizeClaudeCompatRequest(deps, req.headers.authorization);
    if (!auth.ok) {
      if (auth.retryAfter != null) reply.header("Retry-After", String(auth.retryAfter));
      return reply.code(auth.statusCode).send(auth.body);
    }

    const parsedQuery = ClaudeModelResolutionQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: parsedQuery.error.message } });
    }
    const query: ClaudeModelResolutionQuery = parsedQuery.data;
    try {
      return {
        object: "claude_model_resolution",
        resolution: resolveClaudeModelSelection(query.model, config.SYNESIS_YARN_CLAUDE_TIER_MAP),
        available_models: tierRegistry.getAvailableModels().map((m) => m.id),
      };
    } catch (err) {
      app.log.error({ err, path: "/v1/claude/model-resolution" }, "claude model-resolution handler failed");
      return reply.code(500).send({
        error: {
          type: "internal_error",
          message: err instanceof Error ? err.message : "Model resolution failed",
        },
      });
    }
  });

  app.post("/v1/claude/commands/execute", async (req, reply) => {
    const auth = await authorizeClaudeCompatRequest(deps, req.headers.authorization);
    if (!auth.ok) {
      if (auth.retryAfter != null) reply.header("Retry-After", String(auth.retryAfter));
      return reply.code(auth.statusCode).send(auth.body);
    }

    const parsedBody = ClaudeCommandExecuteRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: parsedBody.error.message } });
    }
    const body: ClaudeCommandExecuteRequest = parsedBody.data;

    const clientKind = String((req.headers["x-synesis-client"] as string | undefined) ?? "claude-code");
    const conversationId = (body.conversation_id ?? body.session_id ?? "").trim();
    const identity: SessionIdentity = {
      userId: auth.authUser.userId,
      orgId: auth.authUser.orgId,
      conversationId,
      clientKind,
      displayName: auth.authUser.displayName,
    };
    const sessionKey = await getSessionKey(identity);

    try {
      if (body.command.trim().toLowerCase() === "compact") {
        const state = await getSessionState(sessionKey, identity);
        const compacted = await forceCheckpoint(state);
        await casSessionSave(state);
        recordSessionEvent(
          state.record.sessionKey,
          state.record.userId,
          state.record.orgId,
          "compat_command_compact",
          "claude-command-api",
          compacted
            ? "Manual compaction requested via /v1/claude/commands/execute (compacting)"
            : "Manual compaction requested via /v1/claude/commands/execute (no-op)",
        );
      }

      const result = executeClaudeCompatCommand({
        tierMap: config.SYNESIS_YARN_CLAUDE_TIER_MAP,
        availableModels: tierRegistry.getAvailableModels().map((m) => m.id),
        command: body.command,
        model: body.model,
        conversationId,
        sessionKey,
      });
      return {
        object: "claude_command_result",
        ...result,
      };
    } catch (err) {
      app.log.error({ err, path: "/v1/claude/commands/execute" }, "claude command execute failed");
      return reply.code(500).send({
        error: {
          type: "internal_error",
          message: err instanceof Error ? err.message : "Claude command failed",
        },
      });
    }
  });

  app.get("/v1/adapter-packs", async () => ({
    catalog: clientAdapterPacks.getCatalog(),
  }));

  app.get("/v1/user-runtime-preferences/:userId", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Internal service token required" } });
    }
    const { userId } = req.params as { userId: string };
    const preferences = await loadUserRuntimePreferences(userId);
    return userRuntimePreferencesResponse(preferences);
  });

  app.put("/v1/user-runtime-preferences/:userId", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({ error: { type: "auth_error", message: "Internal service token required" } });
    }
    const { userId } = req.params as { userId: string };
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const preferences = normalizeUserRuntimePreferences({ ...body, updatedAt: Date.now() });
    await sessionStore.saveUserRuntimePreferences(
      userId,
      preferences,
      config.SYNESIS_YARN_USER_RUNTIME_PREFERENCES_TTL_MS,
    );
    return userRuntimePreferencesResponse(preferences);
  });

  app.get("/v1/artifacts/:id", async (req, reply) => {
    if (!requireInternalToken(req as never)) {
      return reply.code(401).send({
        error: { type: "auth_error", message: "Internal service token required" },
      });
    }
    const id = (req.params as { id: string }).id;
    const artifact = artifactStore.get(id);
    if (!artifact) {
      return reply.code(404).send({ error: { type: "not_found", message: "Artifact not found" } });
    }
    return artifact;
  });
}
