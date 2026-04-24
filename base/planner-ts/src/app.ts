import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { Registry } from "prom-client";
import {
  ZERO_USAGE,
  PricingRegistry,
  createServiceMetrics,
  recordUsageMetrics,
  emitTrace,
  emitPlannerUsageMetering,
  type LlmUsage,
  type TraceRecord,
  type TraceSensemaking,
  type TraceCriticResult,
  type TraceClassification,
} from "@synesis/telemetry";
import { ChatCompletionRequestSchema } from "./api-schemas.js";
import { authorizeChatCompletionsWithPolicy } from "./auth/authorizer.js";
import {
  createAuthorizationPolicyEngine,
  type PolicyDecision
} from "./auth/policy-engine.js";
import { resolveAuthContext } from "./auth/resolver.js";
import { initFgaClient } from "./auth/openfga-client.js";
import { resolvePatFromDb } from "./auth/pat-resolver.js";
import { assertCapabilityLock } from "./capability-lock.js";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { SessionManager } from "./context/session-manager.js";
import { createSessionStore } from "./context/session-store.js";
import { invokeGraph, streamGraph } from "./graph.js";
import { getLlmResilienceStats, setPricingContext } from "./llm/client.js";
import { setRetrievalClient, directStreamPipeline, isRetrievalClientRegistered } from "./pipeline.js";
import { UnifiedRetrievalClient } from "./retrieval/client.js";
import { retrieveContext } from "./retrieval/rag-client.js";
import { searchAndProcess, setWebSearchObserver } from "./retrieval/web-search.js";
import { persistWebSearchLog } from "./retrieval/web-search-log.js";
import { buildMetadataFilter, extractTagMetadata } from "./retrieval/metadata-filter.js";
import { evaluateCritic } from "./nodes/critic-evaluator.js";
import { buildDomainProfile } from "./nodes/domain-profile.js";
import { listModelIds, resolveTierSettings } from "./model-tiers.js";
import { optimizeContext } from "./optimization/context-optimizer.js";
import { UserRateLimiter } from "./middleware/user-rate-limit.js";
import { StreamAdmissionController } from "./middleware/stream-admission.js";
import {
  endSse,
  initSse,
  isSseWritable,
  writeAssistantRoleDelta,
  writeContentDelta,
  writeReasoningDelta,
  writeFinalChunk,
  writeStatusEvent,
} from "./streaming/sse.js";
import { describePhase } from "./streaming/phases.js";
import type { GraphState } from "./state/types.js";
import { shouldApplyUserInjectionMitigation } from "@synesis/context-trust";
import { scanUserInput, scanModelOutput, redactPatterns } from "./security/scanner.js";
import { FailureStore } from "./diagnostics/failure-store.js";
import { DependencyHealthMonitor } from "./diagnostics/health-monitor.js";
import { getTracer } from "./telemetry/otel.js";
import { PromptRegistry } from "./prompt-registry.js";
import { setPlannerPromptSnapshot } from "./prompt-composer.js";
import { isLikelyClarificationAnswer } from "./clarification/clarification-answer-heuristic.js";
import type { WebSearchAttribution, WebSearchRequest, WebSearchResponse } from "./retrieval/types.js";
import { CapabilityMatrixClient } from "./capability-matrix/client.js";
import { resolveCapabilityMatrix } from "./capability-matrix/resolver.js";

type ErrorWithMeta = Error & {
  statusCode?: number;
  retryAfterSeconds?: number;
  policyDecision?: { matchedRules?: string[] };
};

/** When the graph finishes with no assistant text (and no structured error), surface this instead of an empty message. */
const EMPTY_ASSISTANT_FALLBACK =
  "I wasn't able to complete a response for this request. Please try again or rephrase your question.";
const SYSTEM_FINGERPRINT = "synesis-planner-ts-compat-v1";

const SAFE_ERROR_PATTERNS = [
  /^Missing Bearer token$/,
  /^Invalid token$/,
  /^Untrusted forwarded identity/,
  /^Token missing required scope:/,
  /^Authorization denied/,
  /^Unsupported policy target:/,
  /is not configured yet/,
  /^Rate limit exceeded/,
  /^Request too large/,
  /^Too many requests/,
  /^Circuit breaker open/,
  /^LLM is not enabled$/,
];

function sanitizeErrorMessage(raw: string): string {
  for (const pat of SAFE_ERROR_PATTERNS) {
    if (pat.test(raw)) return raw;
  }
  if (raw.startsWith("LLM HTTP ")) return "Upstream model service error";
  if (raw.includes("ZodError") || raw.includes("Expected")) return "Request validation failed";
  return "Internal server error";
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s.length > 0 ? s : undefined;
}

function inferPlannerModelFamily(modelId: string): string {
  const normalized = String(modelId ?? "").trim().toLowerCase();
  if (!normalized) return "generic";
  if (normalized.includes("/")) return normalized.split("/")[0] || "generic";
  const dash = normalized.split("-")[0];
  return dash || "generic";
}

function normalizeSourceSurface(value: unknown): WebSearchAttribution["source_surface"] {
  const raw = String(value ?? "").trim();
  switch (raw) {
    case "yarn_chat":
    case "yarn_mcp_http":
    case "openwebui_planner":
    case "planner_internal":
    case "external_api":
      return raw;
    default:
      return "planner_internal";
  }
}

async function isSearchRouteAuthorized(
  authorizationHeader: string | undefined,
  internalServiceToken: string,
  patPepper: string,
): Promise<boolean> {
  const raw = String(authorizationHeader ?? "");
  if (!raw.toLowerCase().startsWith("bearer ")) return false;
  const bearer = raw.slice(7).trim();
  if (!bearer) return false;
  if (internalServiceToken && bearer === internalServiceToken) return true;
  if (!bearer.startsWith("syn-")) return false;
  try {
    const pat = await resolvePatFromDb(bearer, patPepper);
    return Boolean(pat);
  } catch {
    return false;
  }
}

type ParsedChatRequest = ReturnType<typeof ChatCompletionRequestSchema.parse>;

export function resolvePlannerSessionKey(
  requestBody: ParsedChatRequest,
  requestId: string,
): { sessionKey: string; source: "conversation_id" | "ephemeral_request" } {
  const conversationId = (requestBody.conversation_id ?? "").trim();
  if (conversationId.length > 0) {
    return { sessionKey: `conversation:${conversationId}`, source: "conversation_id" };
  }
  return { sessionKey: `ephemeral:${requestId}`, source: "ephemeral_request" };
}

function resolveIncomingConversationId(
  rawBody: unknown,
  headers: Record<string, unknown>,
  parsedConversationId?: string | null,
): { id: string; source: string } {
  const parsed = (parsedConversationId ?? "").trim();
  if (parsed) return { id: parsed, source: "body.conversation_id" };

  const body = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody))
    ? (rawBody as Record<string, unknown>)
    : {};

  for (const key of ["conversation_id", "session_id", "chat_id"]) {
    const val = body[key];
    if (typeof val === "string" && val.trim()) {
      return { id: val.trim(), source: `body.${key}` };
    }
  }

  const metadata = body.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const meta = metadata as Record<string, unknown>;
    for (const key of ["conversation_id", "synesis_conversation_id", "session_id", "chat_id"]) {
      const val = meta[key];
      if (typeof val === "string" && val.trim()) {
        return { id: val.trim(), source: `body.metadata.${key}` };
      }
    }
  }

  for (const key of [
    "x-synesis-conversation-id",
    "x-openwebui-conversation-id",
    "x-openwebui-chat-id",
    "x-chat-id",
    "x-session-id",
  ]) {
    const val = headers[key];
    if (typeof val === "string" && val.trim()) {
      return { id: val.trim(), source: `header.${key}` };
    }
  }

  return { id: "", source: "none" };
}

function isLikelyQuizOptionAnswer(answer: string): boolean {
  const trimmed = answer.trim();
  return /^([a-d]|[1-4])[\)\.\:]?$/i.test(trimmed);
}

function hasMultipleChoiceOptions(text: string): boolean {
  const optionMatches = text.match(/\b([A-D]|[1-4])[\)\.\:]\s*/gi) ?? [];
  const unique = new Set(optionMatches.map((m) => m.trim().charAt(0).toUpperCase()));
  return unique.size >= 2;
}

function findLatestUserTurnWithPreviousAssistant(
  messages: Array<{ role: string; content?: string | null }>,
): { latestUserContent?: string; previousAssistantContent?: string } {
  let latestUserIndex = -1;
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    if (message.role === "user" && typeof message.content === "string") {
      latestUserIndex = idx;
      break;
    }
  }
  if (latestUserIndex < 0) return {};

  for (let idx = latestUserIndex - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    if (message.role === "assistant" && typeof message.content === "string") {
      return {
        latestUserContent: messages[latestUserIndex]?.content ?? "",
        previousAssistantContent: message.content,
      };
    }
  }

  return {
    latestUserContent: messages[latestUserIndex]?.content ?? "",
  };
}

function buildQuizFollowupTask(
  answer: string,
  previousAssistantTurn: string,
): string {
  return [
    "Quiz context:",
    previousAssistantTurn.trim(),
    "",
    "Learner answer:",
    answer.trim(),
    "",
    "Instruction:",
    "Grade the answer against the quiz options, state whether it is correct, and give a short explanation.",
  ].join("\n");
}

export function buildApp(config: AppConfig): FastifyInstance {
  initFgaClient(config);

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    forceCloseConnections: "idle"
  });
  void app.register(fastifyRateLimit, { global: false });
  // Keep origin-side throttling in addition to Cloudflare edge controls so
  // internal/private paths remain consistently rate-limited.

  const promRegistry = new Registry();
  const metrics = createServiceMetrics("planner", promRegistry);

  const pricingRegistry = new PricingRegistry({
    adminUrl: config.SYNESIS_ADMIN_URL,
    adminToken: config.SYNESIS_ADMIN_INTERNAL_TOKEN,
    cachedMultiplier: config.SYNESIS_CACHED_INPUT_PRICE_MULTIPLIER,
  });

  void pricingRegistry.start().then(() => {
    const defaultRates = pricingRegistry.getRates("router");
    setPricingContext(defaultRates, pricingRegistry.getCachedMultiplier());
  }).catch((err) => {
    app.log.warn({ err }, "pricing registry startup failed (non-fatal)");
  });

  const embedderConfigured = Boolean(config.SYNESIS_EMBEDDER_URL?.trim());
  const webSearchConfigured =
    config.SYNESIS_WEB_SEARCH_ENABLED && Boolean(config.SYNESIS_WEB_SEARCH_URL?.trim());
  if (embedderConfigured || webSearchConfigured) {
    setRetrievalClient(new UnifiedRetrievalClient(config));
    if (!embedderConfigured && webSearchConfigured) {
      app.log.warn(
        { webSearchUrl: "configured", embedder: "not_set" },
        "retrieval: unified client active for web-only path (RAG will return empty until embedder is set)",
      );
    }
  }

  setWebSearchObserver(async (payload) => {
    await persistWebSearchLog(
      {
        adminDbUrl: config.SYNESIS_PLANNER_TS_ADMIN_DB_URL,
        logger: app.log,
      },
      {
        query: payload.query,
        profile: payload.profile,
        results: payload.results,
        latencyMs: payload.latencyMs,
        outcome: payload.results.length > 0 ? "success" : "empty",
        policyAction: "allow",
        attribution: payload.attribution ?? {
          source_surface: "planner_internal",
          tool_name: "planner_internal",
        },
      },
    );
  });

  const knowledgeSearchRagConfig: import("./retrieval/rag-client.js").RagClientConfig = {
    milvusHost: config.SYNESIS_MILVUS_HOST,
    milvusPort: config.SYNESIS_MILVUS_PORT,
    embedderUrl: config.SYNESIS_EMBEDDER_URL,
    embedderModel: config.SYNESIS_EMBEDDER_MODEL,
    bgeRerankerUrl: config.SYNESIS_BGE_RERANKER_URL,
    retrievalStrategy: config.SYNESIS_RAG_RETRIEVAL_STRATEGY,
    rrfK: config.SYNESIS_RAG_RRF_K,
    scoreThreshold: config.SYNESIS_RAG_SCORE_THRESHOLD,
    rerankScoreMin: config.SYNESIS_RAG_RERANK_SCORE_MIN,
  };

  const retrieveContextFn = retrieveContext;
  const buildMetadataFilterFn = buildMetadataFilter;
  const extractTagMetadataFn = extractTagMetadata;

  const traceEmitterConfig = {
    adminUrl: config.SYNESIS_ADMIN_URL,
    adminToken: config.SYNESIS_ADMIN_INTERNAL_TOKEN,
  };

  const optimizationCounters = {
    reducedCount: 0,
    reducedCharsTotal: 0,
    rawCharsTotal: 0
  };

  const sessionStore = createSessionStore({
    redisUrl: config.SYNESIS_PLANNER_TS_REDIS_URL,
    redisKeyPrefix: config.SYNESIS_PLANNER_TS_REDIS_KEY_PREFIX,
    memoryMaxSessions: config.SYNESIS_PLANNER_TS_SESSION_MAX_SESSIONS,
    redisCasMaxRetries: config.SYNESIS_PLANNER_TS_REDIS_CAS_MAX_RETRIES,
  });
  const sessionManager = new SessionManager({
    enabled: config.SYNESIS_PLANNER_TS_SESSION_ENABLED,
    maxHistory: config.SYNESIS_PLANNER_TS_SESSION_MAX_HISTORY,
    checkpointEveryMessages: config.SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_MESSAGES,
    ttlMs: config.SYNESIS_PLANNER_TS_SESSION_TTL_MS,
    store: sessionStore
  });
  const authzPolicyEngine = createAuthorizationPolicyEngine(config);
  const promptRegistry = new PromptRegistry({
    adminUrl: config.SYNESIS_ADMIN_URL,
    adminToken: config.SYNESIS_ADMIN_INTERNAL_TOKEN,
    refreshMs: config.SYNESIS_PLANNER_TS_PROMPT_REFRESH_MS,
    logger: app.log,
  });
  promptRegistry.start();
  const capabilityMatrixClient = new CapabilityMatrixClient({
    adminUrl: config.SYNESIS_ADMIN_URL,
    adminToken: config.SYNESIS_ADMIN_INTERNAL_TOKEN,
    refreshMs: config.SYNESIS_PLANNER_TS_PROMPT_REFRESH_MS,
    logger: app.log,
  });
  capabilityMatrixClient.start();
  const failureStore = new FailureStore();
  const dependencyHealthMonitor = new DependencyHealthMonitor(config, sessionStore);
  const userRateLimiter = new UserRateLimiter({
    windowMs: config.SYNESIS_PLANNER_TS_RATE_LIMIT_WINDOW_MS,
    maxRequests: config.SYNESIS_PLANNER_TS_RATE_LIMIT_MAX_REQUESTS,
  });
  const streamAdmission = new StreamAdmissionController({
    maxConcurrentStreams: config.SYNESIS_PLANNER_TS_STREAM_MAX_CONCURRENT,
    maxQueueDepth: config.SYNESIS_PLANNER_TS_STREAM_QUEUE_MAX,
    queueWaitTimeoutMs: config.SYNESIS_PLANNER_TS_STREAM_QUEUE_WAIT_MS,
  });

  app.addHook("onClose", async () => {
    userRateLimiter.close();
    streamAdmission.close();
    dependencyHealthMonitor.stop();
    promptRegistry.stop();
    capabilityMatrixClient.stop();
  });
  dependencyHealthMonitor.start();

  function spawnBackgroundCritic(state: GraphState, requestLog: FastifyInstance["log"]): void {
    const executionPolicy = state.execution_policy ?? {};
    if (!Boolean((executionPolicy as Record<string, unknown>).critic_background)) return;
    if (!(state.generated_code ?? "").trim()) return;
    const criticStartTime = Date.now() / 1000;
    void evaluateCritic({ ...state, next_node: "critic" })
      .then((result) => {
        const criticEndTime = Date.now() / 1000;
        const criticLatencyMs = Math.round((criticEndTime - criticStartTime) * 1000);
        requestLog.info(
          {
            authzTraceId: state.authz_trace_id,
            approved: result.approved,
            needMoreEvidence: result.need_more_evidence,
          },
          "background critic completed",
        );
        const model = state.response_model ?? state.requested_model ?? "unknown";
        const criticRates = state.pricing_rates_by_role?.critic ?? pricingRegistry.getRates("critic");
        const bgCriticData: Record<string, unknown> = {
          approved: result.approved,
          need_more_evidence: result.need_more_evidence,
          scores: result.scores,
          blocking_issues: result.blocking_issues ?? [],
          nonblocking: result.nonblocking ?? [],
          latency_ms: criticLatencyMs,
          is_background: true,
        };
        const syntheticSpan: import("@synesis/telemetry").TraceSpanRecord = {
          node_name: "background_critic",
          intent: "Background Critic (async)",
          start_time: criticStartTime,
          end_time: criticEndTime,
          latency_ms: criticLatencyMs,
          tokens_used: result.usage?.total_tokens ?? 0,
          confidence: typeof result.scores === "object"
            ? Object.values(result.scores as Record<string, number>).reduce((a, b) => a + b, 0) /
              Math.max(Object.keys(result.scores as Record<string, number>).length, 1)
            : 0,
          outcome: result.approved ? "approved" : "rejected",
          llm_calls: result.usage?.total_tokens
            ? [{
                model,
                node: "background_critic",
                role: "critic",
                prompt_tokens: result.usage.prompt_tokens,
                completion_tokens: result.usage.completion_tokens,
                total_tokens: result.usage.total_tokens,
                cached_prompt_tokens: result.usage.cached_prompt_tokens || undefined,
                latency_ms: criticLatencyMs,
                timestamp: criticEndTime,
                actual_cost: result.usage.actual_cost_usd || undefined,
                estimated_cost: result.usage.estimated_cost_usd || undefined,
              }]
            : [],
          metadata: { async: true, ...bgCriticData },
        };
        const criticTrace: TraceRecord = {
          service: "planner",
          trace_id: state.authz_trace_id ?? crypto.randomUUID(),
          request_id: state.authz_trace_id ?? crypto.randomUUID(),
          authz_trace_id: state.authz_trace_id,
          conversation_id: state.conversation_id,
          timestamp: criticEndTime,
          user_id: state.user_id ?? "",
          org_id: state.org_id ?? "",
          tenant_id: state.tenant_ids?.[0] ?? "",
          model,
          tokens: result.usage,
          cost: {
            estimated_usd: result.usage.estimated_cost_usd,
            actual_usd: result.usage.actual_cost_usd,
            rates_snapshot: criticRates,
          },
          latency_ms: criticLatencyMs,
          background_critic: bgCriticData,
          spans: [syntheticSpan],
        };
        emitTrace(criticTrace, traceEmitterConfig, app.log);
      })
      .catch((error: unknown) => {
        requestLog.warn(
          {
            authzTraceId: state.authz_trace_id,
            error: error instanceof Error ? error.message : String(error),
          },
          "background critic failed",
        );
      });
  }

  async function toState(
    requestBody: ParsedChatRequest,
    auth: Awaited<ReturnType<typeof resolveAuthContext>>,
    authzTraceId: string,
    policyDecision: PolicyDecision,
    sessionKey: string,
    traceparent?: string,
  ): Promise<GraphState> {
    const promptSnapshot = promptRegistry.getSnapshot();
    if (promptSnapshot) {
      setPlannerPromptSnapshot(promptSnapshot);
    }
    const incomingWithSession = await sessionManager.enrichIncomingMessages(
      sessionKey,
      requestBody.messages.map((m) => ({ role: m.role, content: m.content ?? "" }))
    );
    const tierSettings = resolveTierSettings(requestBody.model);
    const requestedEffortMode = tierSettings.tier;
    const plannerMatrixModelId = String(tierSettings.responseModel || tierSettings.requestedModel || requestBody.model || "");
    const plannerMatrixModelPath = plannerMatrixModelId;
    const plannerMatrixFamily = inferPlannerModelFamily(plannerMatrixModelId);
    const plannerCapabilityResolution = resolveCapabilityMatrix(capabilityMatrixClient.getMatrix(), {
      model_id: plannerMatrixModelId,
      model_path: plannerMatrixModelPath,
      family: plannerMatrixFamily,
    });
    const plannerContextOptimizerEnabled =
      plannerCapabilityResolution.mode !== "enforced"
      || plannerCapabilityResolution.resolved_capabilities["planner.context_optimizer_enabled"] === true;
    const rawCharsTotal = incomingWithSession.reduce((sum, message) => sum + (message.content ?? "").length, 0);
    const optimized = plannerContextOptimizerEnabled
      ? optimizeContext(incomingWithSession, {
          maxCharsPerMessage: config.SYNESIS_PLANNER_TS_CONTEXT_MAX_CHARS,
          recentMessageLimit: config.SYNESIS_PLANNER_TS_CONTEXT_RECENT_MESSAGE_LIMIT
        })
      : {
          messages: incomingWithSession,
          stats: {
            reducedCount: 0,
            reducedCharsTotal: rawCharsTotal,
            rawCharsTotal,
          },
        };
    optimizationCounters.reducedCount += optimized.stats.reducedCount;
    optimizationCounters.reducedCharsTotal += optimized.stats.reducedCharsTotal;
    optimizationCounters.rawCharsTotal += optimized.stats.rawCharsTotal;
    const plannerCapabilityHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(plannerCapabilityResolution.resolved_capabilities)
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
      .digest("hex")
      .slice(0, 16);
    app.log.info(
      {
        authzTraceId,
        modelId: plannerMatrixModelId,
        family: plannerMatrixFamily,
        modelPath: plannerMatrixModelPath,
        mode: plannerCapabilityResolution.mode,
        globalOptimizationsEnabled: plannerCapabilityResolution.global_optimizations_enabled,
        matchedOverrideIds: plannerCapabilityResolution.matched_override_ids,
        resolvedCapabilities: plannerCapabilityResolution.resolved_capabilities,
        capabilityHash: plannerCapabilityHash,
      },
      "capability_matrix_resolution_v1",
    );

    const userMessage = [...requestBody.messages].reverse().find((m) => m.role === "user");
    let taskText = userMessage?.content ?? "";

    let injectionDetected = false;
    let injectionScanResult: { detected: boolean; patterns_found: string[]; source: string } = {
      detected: false, patterns_found: [], source: ""
    };
    if (config.SYNESIS_INJECTION_SCAN_ENABLED) {
      const history = requestBody.messages
        .filter((m) => m.role === "user")
        .slice(0, -1)
        .map((m) => m.content ?? "");
      const [detected, details] = scanUserInput(taskText, history);
      injectionDetected = detected;
      injectionScanResult = details;

      const applyMitigation = shouldApplyUserInjectionMitigation(
        injectionScanResult.patterns_found,
        config.SYNESIS_INJECTION_ACTION,
        config.SYNESIS_INJECTION_REQUIRE_DUAL_SIGNAL,
      );
      if (detected && config.SYNESIS_INJECTION_ACTION === "block" && applyMitigation) {
        const err = new Error("Suspicious content detected. If this was unintentional, rephrase your message and try again.");
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (detected && config.SYNESIS_INJECTION_ACTION === "reduce" && applyMitigation && taskText) {
        taskText = redactPatterns(taskText);
      }
    }

    const pendingClarification = await sessionManager.getPendingClarification(sessionKey);
    let mergedTaskText = taskText;
    const { latestUserContent, previousAssistantContent } = findLatestUserTurnWithPreviousAssistant(requestBody.messages);
    const applyQuizFollowupMerge = Boolean(
      latestUserContent
      && isLikelyQuizOptionAnswer(latestUserContent)
      && previousAssistantContent
      && hasMultipleChoiceOptions(previousAssistantContent),
    );
    const applyPendingClarification = Boolean(
      pendingClarification && isLikelyClarificationAnswer(taskText, pendingClarification),
    );
    if (applyQuizFollowupMerge && previousAssistantContent) {
      mergedTaskText = buildQuizFollowupTask(taskText, previousAssistantContent);
    } else if (applyPendingClarification && pendingClarification?.originalTaskDescription) {
      const originalTask = pendingClarification.originalTaskDescription.trim();
      const answer = taskText.trim();
      mergedTaskText = [
        "Original request:",
        originalTask,
        "",
        "Clarification response:",
        answer || "(no answer provided)",
        "",
        "Re-plan instruction:",
        "Use the original request and the clarification response together. The clarification constrains the original request; it does not replace it.",
      ].join("\n");
    }
    const domainProfile = buildDomainProfile(mergedTaskText);

    const baseState: GraphState = {
      messages: optimized.messages.map((m) => ({ role: m.role, content: m.content ?? "" })),
      user_id: auth.userEmail || auth.userId,
      org_id: auth.orgId,
      tenant_ids: auth.tenantIds,
      token_scopes: auth.tokenScopes,
      auth_method: auth.authMethod,
      conversation_id: requestBody.conversation_id ?? undefined,
      authz_trace_id: authzTraceId,
      authz_engine: authzPolicyEngine.engineName,
      authz_rules: policyDecision.matchedRules,
      requested_model: tierSettings.requestedModel || requestBody.model,
      response_model: tierSettings.responseModel,
      model_tier: tierSettings.tier,
      pricing_rates_by_role: {
        router: pricingRegistry.getRates("router"),
        general: pricingRegistry.getRates("general"),
        critic: pricingRegistry.getRates("critic"),
      },
      requested_effort_mode: requestedEffortMode,
      task_description: mergedTaskText,
      evidence_packets: [],
      decision_ledger: [],
      critique_register: {},
      draft_fingerprints: [],
      patch_ops: [],
      writer_max_tokens: tierSettings.writerMaxTokens,
      critic_max_tokens: tierSettings.criticMaxTokens,
      execution_policy: {
        critique_passes: tierSettings.critiquePasses,
        critic_background: config.SYNESIS_PLANNER_TS_CRITIC_BACKGROUND,
        capability_matrix: {
          mode: plannerCapabilityResolution.mode,
          global_optimizations_enabled: plannerCapabilityResolution.global_optimizations_enabled,
          model_id: plannerMatrixModelId,
          family: plannerMatrixFamily,
          model_path: plannerMatrixModelPath,
          matched_override_ids: plannerCapabilityResolution.matched_override_ids,
          capability_hash: plannerCapabilityHash,
          resolved_capabilities: plannerCapabilityResolution.resolved_capabilities,
          effective_context_optimizer_enabled: plannerContextOptimizerEnabled,
        },
      },
      run_id: requestBody.conversation_id?.trim() || crypto.randomUUID(),
      traceparent,
      requested_response_format: requestBody.response_format,
      stream_include_usage: requestBody.stream_options?.include_usage,
      domain_profile: domainProfile,
      injection_detected: injectionDetected,
      injection_scan_result: injectionScanResult,
    };

    if (applyPendingClarification && pendingClarification) {
      baseState.user_answer_to_clarification = taskText;
      baseState.assumptions = pendingClarification.assumptions;
      // The original request was complex enough to trigger clarification.
      // The follow-up answer is typically short ("on prem, 50 users") so the
      // entry classifier would downgrade it to trivial. Force the full
      // pipeline so the planner runs with conversation context + answer.
      baseState.plan_required = true;
      baseState.difficulty = Math.max(baseState.difficulty ?? 0, 0.6);
    }
    if (applyQuizFollowupMerge) {
      // Short quiz answers are context-dependent; avoid downgrading to trivial.
      baseState.plan_required = true;
      baseState.difficulty = Math.max(baseState.difficulty ?? 0, 0.45);
    }

    if (applyPendingClarification && pendingClarification) {
      await sessionManager.clearPendingClarification(sessionKey);
    }

    return baseState;
  }

  async function readinessSnapshot(): Promise<{
    ready: boolean;
    checks: {
      llm: { configured: boolean; ok: boolean; detail?: string };
      redis: { configured: boolean; ok: boolean; detail?: string };
    };
  }> {
    const llmConfigured = Boolean(config.SYNESIS_PLANNER_TS_LLM_ENABLED && config.SYNESIS_PLANNER_TS_LLM_BASE_URL);
    let llmOk = true;
    let llmDetail = "disabled_or_not_configured";
    if (llmConfigured) {
      try {
        const origin = new URL(config.SYNESIS_PLANNER_TS_LLM_BASE_URL).origin;
        const resp = await fetch(`${origin}/health/liveliness`, {
          method: "GET",
          signal: AbortSignal.timeout(2_000),
          headers: config.SYNESIS_PLANNER_TS_LLM_API_KEY
            ? { Authorization: `Bearer ${config.SYNESIS_PLANNER_TS_LLM_API_KEY}` }
            : undefined,
        });
        llmOk = resp.ok;
        llmDetail = `status_${resp.status}`;
      } catch (error) {
        llmOk = false;
        llmDetail = error instanceof Error ? error.message : String(error);
      }
    }

    const redisConfigured = Boolean(config.SYNESIS_PLANNER_TS_REDIS_URL);
    let redisOk = true;
    let redisDetail = "disabled_or_not_configured";
    if (redisConfigured) {
      redisOk = await sessionStore.ping();
      redisDetail = redisOk ? "pong" : "ping_failed";
    }

    return {
      ready: llmOk && redisOk,
      checks: {
        llm: { configured: llmConfigured, ok: llmOk, detail: llmDetail },
        redis: { configured: redisConfigured, ok: redisOk, detail: redisDetail },
      },
    };
  }

  app.get("/health", async () => ({
    status: "ok",
    service: "planner-ts",
    contextOptimization: optimizationCounters,
    session: await sessionManager.telemetry(),
    llm: {
      enabled: config.SYNESIS_PLANNER_TS_LLM_ENABLED,
      baseUrlConfigured: Boolean(config.SYNESIS_PLANNER_TS_LLM_BASE_URL),
      prefixCacheMode: config.SYNESIS_PLANNER_TS_PREFIX_CACHE_MODE
    },
    redis: {
      configured: Boolean(config.SYNESIS_PLANNER_TS_REDIS_URL)
    },
    llmResilience: getLlmResilienceStats(),
    promptLibrary: promptRegistry.getStats(),
    capabilityMatrix: capabilityMatrixClient.getStats(),
    admissionControl: {
      userRateLimit: userRateLimiter.getStats(),
      streamAdmission: streamAdmission.getStats(),
    },
    failures: failureStore.stats(),
    deps: dependencyHealthMonitor.snapshot(),
    auth: {
      engine: authzPolicyEngine.engineName,
      policyStats: authzPolicyEngine.getStats(),
      openfga: {
        apiUrlConfigured: Boolean(config.SYNESIS_OPENFGA_API_URL),
        storeConfigured: Boolean(config.SYNESIS_OPENFGA_STORE_ID),
        modelConfigured: Boolean(config.SYNESIS_OPENFGA_MODEL_ID),
        authTokenConfigured: Boolean(config.SYNESIS_OPENFGA_AUTH_TOKEN)
      },
      requireBearerAuth: config.SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH,
      trustForwardedIdentityHeaders: config.SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS,
      strictForwardedIdentityMode: config.SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE
    }
  }));

  app.get("/health/readiness", async (_request, reply) => {
    const readiness = await readinessSnapshot();
    if (!readiness.ready) {
      return reply.code(503).send({
        status: "degraded",
        service: "planner-ts",
        ...readiness,
      });
    }
    return {
      status: "ready",
      service: "planner-ts",
      ...readiness,
    };
  });

  app.get("/health/deps", async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!token || request.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const snapshot = dependencyHealthMonitor.snapshot();
    const code = snapshot.status === "ok" ? 200 : 503;
    return reply.code(code).send({
      service: "planner-ts",
      ...snapshot,
    });
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", promRegistry.contentType);
    return promRegistry.metrics();
  });

  app.get("/health/authz-events", async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!token || request.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return {
      status: "ok",
      service: "planner-ts",
      auth: {
        engine: authzPolicyEngine.engineName,
        recentEvents: authzPolicyEngine.getStats().recentEvents
      }
    };
  });

  app.get("/health/failures", async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!token || request.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return {
      status: "ok",
      service: "planner-ts",
      failures: failureStore.top(50),
    };
  });

  app.get("/debug/retrieval-config", async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!token || request.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return {
      embedder_url: config.SYNESIS_EMBEDDER_URL ? "configured" : "not_set",
      milvus_host: config.SYNESIS_MILVUS_HOST ? "configured" : "not_set",
      web_search_enabled: config.SYNESIS_WEB_SEARCH_ENABLED,
      web_search_url: config.SYNESIS_WEB_SEARCH_URL ? "configured" : "not_set",
      unified_retrieval_client_registered: isRetrievalClientRegistered(),
      cohesion_lock_enabled: config.SYNESIS_COHESION_LOCK_ENABLED,
      gliner_service_url: config.SYNESIS_GLINER_SERVICE_URL ? "configured" : "not_set",
      rag_strategy: config.SYNESIS_RAG_RETRIEVAL_STRATEGY,
      bge_reranker: config.SYNESIS_BGE_RERANKER_URL ? "configured" : "not_set",
    };
  });

  app.get("/debug/session-stats", async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!token || request.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return {
      session_enabled: config.SYNESIS_PLANNER_TS_SESSION_ENABLED,
      session_backend: config.SYNESIS_PLANNER_TS_REDIS_URL ? "redis" : "memory",
      session_ttl_s: config.SYNESIS_PLANNER_TS_REDIS_SESSION_TTL_S,
    };
  });

  // -----------------------------------------------------------------------
  // Knowledge search — structured RAG retrieval for MCP and Yarn
  // -----------------------------------------------------------------------
  app.post(
    "/v1/knowledge/search",
    {
      config: { rateLimit: { max: 180, timeWindow: "1 minute" as const } },
      preHandler: app.rateLimit({ max: 180, timeWindow: "1 minute" }),
    },
    async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!await isSearchRouteAuthorized(
      request.headers.authorization,
      token,
      config.SYNESIS_PAT_PEPPER,
    )) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const body = request.body as Record<string, unknown> | null;
    const query = String(body?.query ?? "").trim();
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }

    const topK = Math.min(Math.max(Number(body?.top_k) || 5, 1), 50);

    const metaParams: import("./retrieval/metadata-filter.js").MetadataFilterParams = {
      language: body?.language ? String(body.language) : undefined,
      artifact_kind: body?.artifact_kind ? String(body.artifact_kind) : undefined,
      domain: body?.domain ? String(body.domain) : undefined,
      corpus_class: body?.corpus_class ? String(body.corpus_class) : undefined,
      constraint_kind: body?.constraint_kind ? String(body.constraint_kind) : undefined,
      content_profile: body?.content_profile ? String(body.content_profile) : undefined,
      constraint_source: body?.constraint_source ? String(body.constraint_source) : undefined,
      golden_path_id: body?.golden_path_id ? String(body.golden_path_id) : undefined,
      scope_tags: Array.isArray(body?.scope_tags) ? (body.scope_tags as string[]) : undefined,
      tags: body?.tags ? String(body.tags) : undefined,
      content_format: body?.content_format ? String(body.content_format) : undefined,
      repo_path: body?.repo_path ? String(body.repo_path) : undefined,
    };

    const scopeOpts = {
      callerOrgId: body?.caller_org_id ? String(body.caller_org_id) : undefined,
      callerTenantIds: Array.isArray(body?.caller_tenant_ids) ? (body.caller_tenant_ids as string[]) : undefined,
      callerAclGroups: Array.isArray(body?.caller_acl_groups) ? (body.caller_acl_groups as string[]) : undefined,
      callerUserId: body?.caller_user_id ? String(body.caller_user_id) : undefined,
    };

    const metaFilter = buildMetadataFilterFn(metaParams);

    const t0 = performance.now();
    try {
      const results = await retrieveContextFn(query, knowledgeSearchRagConfig, {
        topK,
        scopeFilter: scopeOpts,
        extraFilter: metaFilter || undefined,
      });
      const totalMs = performance.now() - t0;

      const mapped: import("./retrieval/types.js").KnowledgeResult[] = results.map((r) => {
        const tagMeta = extractTagMetadataFn(r.tags ?? "");
        const scopeTagsStr = r.scope_tags ?? "";
        const scopeFromCol = scopeTagsStr ? scopeTagsStr.split(",").map((s) => s.trim()).filter(Boolean) : [];
        return {
          text: r.text,
          source_url: r.source_url,
          document_name: r.document_name,
          authority: r.authority,
          origin_type: r.origin_type,
          domain: r.domain,
          language: r.language ?? "",
          artifact_kind: r.artifact_kind ?? "",
          tags: r.tags ?? "",
          context_prefix: r.context_prefix,
          chunk_summary: r.chunk_summary,
          heading_path: r.heading_path,
          score: r.rerank_score > 0 ? r.rerank_score : r.rrf_score,
          constraint_kind: r.constraint_kind || tagMeta.constraint_kind,
          corpus_class: r.corpus_class || tagMeta.corpus_class,
          scope_tags: scopeFromCol.length > 0 ? scopeFromCol : tagMeta.scope_tags,
          content_profile: r.content_profile || tagMeta.content_profile,
          constraint_source: r.constraint_source ?? "",
          constraint_confidence: r.constraint_confidence ?? -1,
          golden_path_id: r.golden_path_id ?? "",
          novel_pattern: r.novel_pattern ?? false,
        };
      });

      request.log.info({
        knowledge_search: true,
        query_len: query.length,
        results_count: mapped.length,
        filter_applied: metaFilter || null,
        total_ms: Math.round(totalMs * 10) / 10,
      }, "knowledge_search_complete");

      return {
        results: mapped,
        query,
        total: mapped.length,
        timings: {
          embed_ms: 0,
          search_ms: Math.round(totalMs * 10) / 10,
          rerank_ms: 0,
          total_ms: Math.round(totalMs * 10) / 10,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      request.log.error({ err: msg }, "knowledge_search_failed");
      return reply.code(500).send({ error: "Knowledge search failed", detail: msg });
    }
    },
  );

  // -----------------------------------------------------------------------
  // Web search — planner-owned route for MCP/Yarn/OpenWebUI attribution
  // -----------------------------------------------------------------------
  app.post(
    "/v1/web/search",
    {
      config: { rateLimit: { max: 180, timeWindow: "1 minute" as const } },
      preHandler: app.rateLimit({ max: 180, timeWindow: "1 minute" }),
    },
    async (request, reply) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (!await isSearchRouteAuthorized(
      request.headers.authorization,
      token,
      config.SYNESIS_PAT_PEPPER,
    )) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!config.SYNESIS_WEB_SEARCH_ENABLED || !config.SYNESIS_WEB_SEARCH_URL) {
      const attribution: WebSearchAttribution = {
        source_surface: "planner_internal",
        tool_name: "synesis_web_search",
      };
      await persistWebSearchLog(
        { adminDbUrl: config.SYNESIS_PLANNER_TS_ADMIN_DB_URL, logger: app.log },
        {
          query: "",
          profile: "web",
          results: [],
          latencyMs: 0,
          outcome: "error",
          policyAction: "deny",
          blockedReason: "web_search_disabled",
          attribution,
          errorMessage: "web search disabled",
        },
      );
      return reply.code(503).send({
        error: "web_search_disabled",
        policy: { action: "deny", reason: "web_search_disabled" },
      });
    }

    const body = (request.body ?? {}) as Partial<WebSearchRequest>;
    const query = String(body.query ?? "").trim();
    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }

    const topK = Math.min(Math.max(Number(body.top_k ?? 8) || 8, 1), 20);
    const profile = body.profile === "code" ? "code" : "web";
    const attribution: WebSearchAttribution = {
      source_surface: normalizeSourceSurface(body.source_surface),
      tool_name: optionalString(body.tool_name) ?? "synesis_web_search",
      request_id: optionalString(body.request_id),
      session_key: optionalString(body.session_key),
      conversation_id: optionalString(body.conversation_id),
      trace_id: optionalString(body.trace_id),
      caller_org_id: optionalString(body.caller_org_id),
      caller_user_id: optionalString(body.caller_user_id),
      caller_tenant_ids: Array.isArray(body.caller_tenant_ids) ? body.caller_tenant_ids.map(String) : undefined,
    };

    const started = performance.now();
    try {
      const results = await searchAndProcess(query, {
        url: config.SYNESIS_WEB_SEARCH_URL,
        enabled: config.SYNESIS_WEB_SEARCH_ENABLED,
        timeoutMs: config.SYNESIS_WEB_SEARCH_TIMEOUT_MS,
        maxResults: topK,
        engineAuthorityMap: (() => {
          try {
            return JSON.parse(config.SYNESIS_ENGINE_AUTHORITY_MAP || "{}");
          } catch {
            return {};
          }
        })(),
      }, {
        profile,
        fetchPages: body.fetch_pages ?? true,
        maxFetchPages: Number(body.max_fetch_pages ?? 2) || 2,
        minRelevance: Number(body.min_relevance ?? 0.5) || 0.5,
        attribution,
      });

      const totalMs = Math.round((performance.now() - started) * 10) / 10;
      const response: WebSearchResponse = {
        query,
        total: results.length,
        results: results.slice(0, topK),
        timings: { total_ms: totalMs },
        attribution_echo: attribution,
        policy: {
          action: "allow",
        },
      };
      request.log.info(
        {
          web_search: true,
          query_len: query.length,
          total: response.total,
          latency_ms: totalMs,
          source_surface: attribution.source_surface,
          tool_name: attribution.tool_name,
          request_id: attribution.request_id,
          trace_id: attribution.trace_id,
        },
        "web_search_complete",
      );
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const totalMs = Math.round((performance.now() - started) * 10) / 10;
      await persistWebSearchLog(
        { adminDbUrl: config.SYNESIS_PLANNER_TS_ADMIN_DB_URL, logger: app.log },
        {
          query,
          profile,
          results: [],
          latencyMs: totalMs,
          outcome: "error",
          policyAction: "degraded",
          blockedReason: "planner_web_search_error",
          attribution,
          errorMessage: message,
        },
      );
      request.log.error({ err: message }, "web_search_failed");
      return reply.code(500).send({
        error: "Web search failed",
        detail: message,
        attribution_echo: attribution,
        policy: { action: "degraded", reason: "planner_web_search_error" },
      });
    }
    },
  );

  app.get("/v1/models", async () => ({
    object: "list",
    data: listModelIds(config).map((id) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "synesis"
    }))
  }));

  app.delete(
    "/v1/memory/:conversationId",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" as const } },
      preHandler: app.rateLimit({ max: 60, timeWindow: "1 minute" }),
    },
    async (request, reply) => {
    const authzTraceId = crypto.randomUUID();
    reply.header("x-synesis-authz-trace-id", authzTraceId);
    reply.header("x-synesis-authz-engine", authzPolicyEngine.engineName);
    try {
      const preAuthSubject = `preauth:${(request.ip || "unknown").trim() || "unknown"}:memory-purge`;
      const preAuthRateLimit = userRateLimiter.check(preAuthSubject);
      if (!preAuthRateLimit.allowed) {
        const err = new Error("Too many requests for this user in the current window") as ErrorWithMeta;
        err.statusCode = 429;
        err.retryAfterSeconds = preAuthRateLimit.retryAfterSeconds ?? 1;
        throw err;
      }
      const auth = await resolveAuthContext(request, config);
      const rateSubject = (auth.userId || auth.userEmail || "anonymous").trim() || "anonymous";
      const rateLimit = userRateLimiter.check(rateSubject);
      if (!rateLimit.allowed) {
        const err = new Error("Too many requests for this user in the current window") as ErrorWithMeta;
        err.statusCode = 429;
        err.retryAfterSeconds = rateLimit.retryAfterSeconds ?? 1;
        throw err;
      }
      const policyDecision = await authorizeChatCompletionsWithPolicy(authzPolicyEngine, auth, {
        traceId: authzTraceId
      });
      reply.header("x-synesis-authz-rules", policyDecision.matchedRules.join(","));
      const { conversationId } = request.params as { conversationId: string };
      if (!conversationId?.trim()) {
        return reply.code(400).send({
          error: { message: "conversation_id is required", type: "invalid_request_error", code: "400" }
        });
      }
      const normalizedConversationId = conversationId.trim();
      // Fix-forward keying: current sessions are conversation-scoped with prefix,
      // but we also attempt a legacy raw key purge for existing in-memory sessions.
      const deletedConversationScoped = await sessionManager.purge(`conversation:${normalizedConversationId}`);
      const deletedLegacy = await sessionManager.purge(normalizedConversationId);
      const deleted = deletedConversationScoped || deletedLegacy;
      request.log.info(
        {
          authzTraceId,
          conversationId: normalizedConversationId,
          userId: auth.userId,
          deleted
        },
        "memory purge"
      );
      return { deleted, conversation_id: normalizedConversationId, authz_trace_id: authzTraceId };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "Unknown server error";
      const err = error as ErrorWithMeta;
      if (err.policyDecision?.matchedRules?.length) {
        reply.header("x-synesis-authz-rules", err.policyDecision.matchedRules.join(","));
      }
      request.log.warn({ authzTraceId, errorMessage: rawMessage }, "memory purge rejected");
      const statusCode = err.statusCode ?? (rawMessage === "Missing Bearer token" ? 401 : 400);
      const clientMessage = sanitizeErrorMessage(rawMessage);
      return reply.code(statusCode).send({
        error: {
          message: clientMessage,
          type: statusCode === 401
            ? "authentication_error"
            : statusCode === 403
              ? "permission_error"
              : "invalid_request_error",
          code: String(statusCode)
        }
      });
    }
    },
  );

  function countAssumptionTags(text: string): TraceSensemaking["assumption_tags_applied"] {
    return {
      assumption: (text.match(/\[Assumption[:\]]/g) ?? []).length,
      estimate: (text.match(/\[Estimate[:\]]/g) ?? []).length,
      clarified: (text.match(/\[Clarified[\]]/g) ?? []).length,
    };
  }

  function buildSensemakingTrace(state: GraphState): TraceSensemaking {
    return {
      domain_profile: state.domain_profile,
      planner_confidence: state.planner_confidence ?? 0,
      clarification_triggered: Boolean(state.clarification_question),
      clarification_question: state.clarification_question,
      clarification_options: state.clarification_options,
      assumptions: state.assumptions ?? [],
      frame_coherence: state.domain_profile?.frameCoherence ?? "unknown",
      assumption_tags_applied: countAssumptionTags(state.generated_code ?? ""),
    };
  }

  function buildClassificationTrace(state: GraphState): TraceClassification {
    const taxonomy = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;
    return {
      difficulty: state.difficulty ?? 0,
      task_size: state.task_size ?? "unknown",
      risk_score: state.risk_score ?? 0,
      effort_mode: state.selected_effort_mode ?? state.recommended_effort_mode ?? "auto",
      model_tier: state.model_tier ?? "auto",
      rag_mode: state.rag_mode ?? "disabled",
      plan_required: state.plan_required ?? false,
      show_assumptions: state.show_assumptions ?? false,
      taxonomy_key: String(taxonomy.taxonomy_key ?? "unknown"),
      cynefin_domain: state.cynefin_domain,
      active_vertical: String(taxonomy.active_vertical ?? "generic"),
    };
  }

  function buildInlineCriticTrace(state: GraphState): TraceCriticResult | undefined {
    if (!state.critic_scores) return undefined;
    return {
      approved: state.critic_approved ?? false,
      need_more_evidence: state.need_more_evidence ?? false,
      scores: state.critic_scores ?? {},
      blocking_issues: state.blocking_issues ?? [],
      nonblocking: state.critic_nonblocking ?? [],
      is_background: false,
    };
  }

  function buildEvidenceSummary(state: GraphState): Record<string, unknown> {
    const packets = state.evidence_packets ?? [];
    if (packets.length === 0) return {};
    const sourceUris = packets.flatMap((p) => p.sources.map((s) => s.uri)).filter(Boolean);
    const avgConfidence = packets.reduce((sum, p) => sum + p.confidence, 0) / packets.length;
    return {
      packets_count: packets.length,
      avg_confidence: Math.round(avgConfidence * 100) / 100,
      source_urls: [...new Set(sourceUris)].slice(0, 10),
    };
  }

  function buildTaxonomy(state: GraphState): Record<string, unknown> {
    const classification = buildClassificationTrace(state);
    const taxonomy = (state.taxonomy_metadata ?? {}) as Record<string, unknown>;

    // Discovery: how the taxonomy key was resolved
    const discovery: Record<string, unknown> = {
      taxonomy_key: String(taxonomy.taxonomy_key ?? "unknown"),
      active_vertical: String(taxonomy.active_vertical ?? "generic"),
      active_domains: taxonomy.active_domains,
      domain_ref_counts: taxonomy.domain_ref_counts,
    };
    if (taxonomy.taxonomy_semantic) {
      discovery.semantic_validation = taxonomy.taxonomy_semantic;
    }

    // Prompt steering: which taxonomy/vertical blocks were injected
    const steeringApplied: string[] = [];
    const difficulty = state.difficulty ?? 0;
    const complexity = Number(taxonomy.complexity_score ?? 0);
    if (complexity > 0.55 && String(taxonomy.depth_instructions ?? "").trim()) steeringApplied.push("depth_instructions");
    if (String(taxonomy.output_style_guidance ?? "").trim()) steeringApplied.push("output_style_guidance");
    if (difficulty >= 0.5 && String(taxonomy.epistemic_guidance ?? "").trim()) steeringApplied.push("epistemic_guidance");
    if (difficulty >= 0.4 && String(taxonomy.discovery_prompt ?? "").trim()) steeringApplied.push("discovery_prompt");
    if (difficulty >= 0.5 && Array.isArray(taxonomy.required_elements) && taxonomy.required_elements.length > 0) steeringApplied.push("required_elements");
    if (String(taxonomy.writer_regulated_block ?? "").trim()) steeringApplied.push("writer_regulated_block");
    if (String(taxonomy.critic_regulated_block ?? "").trim()) steeringApplied.push("critic_regulated_block");

    const activeVertical = String(taxonomy.active_vertical ?? "generic");
    if (activeVertical !== "generic") {
      steeringApplied.push(`vertical:${activeVertical}`);
      // critic_mode from vertical
      const criticMode = taxonomy._critic_mode ?? undefined;
      if (criticMode) {
        discovery.critic_mode = criticMode;
      }
    }

    return {
      difficulty: classification.difficulty,
      task_size: classification.task_size,
      risk_score: classification.risk_score,
      effort_mode: classification.effort_mode,
      model_tier: classification.model_tier,
      rag_mode: classification.rag_mode,
      plan_required: classification.plan_required,
      taxonomy_key: String(taxonomy.taxonomy_key ?? classification.taxonomy_key),
      active_vertical: String(taxonomy.active_vertical ?? "generic"),
      discovery,
      steering_applied: steeringApplied,
    };
  }

  function countHallucinatedUrls(state: GraphState): number {
    const draft = state.generated_code ?? "";
    if (!draft) return 0;
    const packets = state.evidence_packets ?? [];
    const validUris = new Set<string>();
    for (const packet of packets) {
      for (const source of packet.sources) {
        if (source.uri) validUris.add(source.uri.trim().toLowerCase());
      }
    }
    if (validUris.size === 0) return 0;
    const cited = new Set<string>();
    const citedBalancedUrl = /\[Source:\s*[\s\S]*?-\s*\[(https?:\/\/[^\]]+)\]\]/g;
    const citedLegacy = /\[Source:\s*[^\]]*?-\s*(https?:\/\/[^\]\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = citedBalancedUrl.exec(draft)) !== null) {
      cited.add(m[1].toLowerCase());
    }
    while ((m = citedLegacy.exec(draft)) !== null) {
      cited.add(m[1].toLowerCase());
    }
    if (cited.size === 0) return 0;
    let count = 0;
    for (const url of cited) {
      if (!validUris.has(url)) count++;
    }
    return count;
  }

  function buildContextCuration(state: GraphState): Record<string, unknown> | undefined {
    const packets = state.evidence_packets ?? [];
    const effective = state.writer_max_tokens ?? 0;
    const target = state.writer_budget_target ?? effective;
    if (packets.length === 0 && !effective && !target) return undefined;
    const cfg = loadConfig();
    const totalSnippets = packets.reduce((s, p) => s + (p.snippets?.length ?? 0), 0);
    const totalChars = packets.reduce((s, p) =>
      s + (p.snippets ?? []).reduce((c, sn) => c + (sn.text?.length ?? 0), 0), 0);
    const completionTokens = state.llm_usage?.completion_tokens ?? 0;
    const utilizationVsEffective = effective > 0 ? completionTokens / effective : 0;
    const utilizationVsTarget = target > 0 ? completionTokens / target : 0;
    const lowUtilization = effective > 0 && utilizationVsEffective < 0.15;
    const budgetAlert =
      effective > 0 && utilizationVsEffective > 0.95
        ? `Writer used ${Math.round(utilizationVsEffective * 100)}% of ${effective} effective token cap — potential truncation`
        : undefined;
    const budgetNote =
      cfg.SYNESIS_PLANNER_TS_WRITER_BUDGET_MODE === "audit" &&
      target > 0 &&
      effective > target &&
      utilizationVsTarget > 0.95 &&
      utilizationVsEffective <= 0.95
        ? `Policy target ${target} tokens fully used; audit floor (${effective}) prevented output truncation`
        : undefined;
    return {
      packets_in: packets.length,
      packets_kept: packets.length,
      excluded_count: 0,
      budget_mode: cfg.SYNESIS_PLANNER_TS_WRITER_BUDGET_MODE,
      token_budget_target: target,
      token_budget_effective: effective,
      token_budget: effective,
      tokens_used: completionTokens,
      utilization: Number(utilizationVsEffective.toFixed(4)),
      utilization_vs_target: target > 0 ? Number(utilizationVsTarget.toFixed(4)) : undefined,
      utilization_vs_effective: effective > 0 ? Number(utilizationVsEffective.toFixed(4)) : undefined,
      chars_used: totalChars,
      snippets_total: totalSnippets,
      low_utilization: lowUtilization,
      ...(budgetAlert ? { budget_alert: budgetAlert } : {}),
      ...(budgetNote ? { budget_note: budgetNote } : {}),
    };
  }

  function buildTraceContext(state: GraphState): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};
    if (state.writer_max_tokens) ctx.token_budget_total = state.writer_max_tokens;
    if (state.writer_budget_target !== undefined) ctx.token_budget_target = state.writer_budget_target;
    if (state.iteration_count !== undefined) ctx.iteration_count = state.iteration_count;
    if (state.max_iterations !== undefined) ctx.max_iterations = state.max_iterations;
    if (state.error) {
      ctx.failure_stage = state.next_node ?? "unknown";
      ctx.failure_reason = state.error;
    }
    const capabilityMatrix = (state.execution_policy as Record<string, unknown> | undefined)?.capability_matrix;
    if (capabilityMatrix && typeof capabilityMatrix === "object" && !Array.isArray(capabilityMatrix)) {
      const matrix = capabilityMatrix as Record<string, unknown>;
      ctx.capability_matrix_mode = matrix.mode;
      ctx.capability_matrix_global_optimizations_enabled = matrix.global_optimizations_enabled;
      ctx.capability_matrix_hash = matrix.capability_hash;
      ctx.capability_matrix_model_id = matrix.model_id;
      ctx.capability_matrix_family = matrix.family;
      ctx.capability_matrix_matched_override_ids = matrix.matched_override_ids;
    }
    return ctx;
  }

  function emitPlannerTrace(
    state: GraphState,
    usage: LlmUsage,
    latencyMs: number,
    auth: Awaited<ReturnType<typeof resolveAuthContext>>,
    streamingCtx?: { mode: "streaming" | "non-streaming"; timeToFirstTokenMs?: number },
  ): void {
    const model = state.response_model ?? state.requested_model ?? "unknown";
    const rates = state.pricing_rates_by_role?.general ?? pricingRegistry.getRates("general");
    const collector = state._span_collector;
    const spans = collector?.getSpans() ?? [];
    const phaseTimings = collector?.getPhaseTimings() ?? {};

    const classification = buildClassificationTrace(state);
    const domainProfile = state.domain_profile;
    const domainTags = domainProfile?.domains?.map((d) => d.key) ?? [];
    const taxonomyKey = classification.taxonomy_key ?? "";
    const isCode = taxonomyKey.startsWith("code") || taxonomyKey.includes("programming");

    const inlineCritic = buildInlineCriticTrace(state);
    const hallucinatedUrlsCount = countHallucinatedUrls(state);
    const criticScores: Record<string, unknown> = inlineCritic
      ? { ...inlineCritic.scores, approved: inlineCritic.approved, hallucinated_urls_count: hallucinatedUrlsCount }
      : (hallucinatedUrlsCount > 0 ? { hallucinated_urls_count: hallucinatedUrlsCount } : {});

    const contextCuration = buildContextCuration(state);
    const trace: TraceRecord = {
      service: "planner",
      trace_id: state.authz_trace_id ?? crypto.randomUUID(),
      request_id: state.authz_trace_id ?? crypto.randomUUID(),
      authz_trace_id: state.authz_trace_id,
      conversation_id: state.conversation_id,
      timestamp: Date.now() / 1000,
      user_id: auth.userEmail || auth.userId,
      org_id: auth.orgId,
      tenant_id: auth.tenantIds?.[0] ?? "",
      model,
      query_snippet: state.task_description?.slice(0, 200) ?? "",
      tokens: usage,
      cost: {
        estimated_usd: usage.estimated_cost_usd,
        actual_usd: usage.actual_cost_usd,
        rates_snapshot: rates,
      },
      latency_ms: latencyMs,
      spans,
      phase_timings: phaseTimings,
      decision_ledger: state.decision_ledger,
      sensemaking: buildSensemakingTrace(state),
      classification,
      critic_result: inlineCritic,
      critic_scores: Object.keys(criticScores).length > 0 ? criticScores : undefined,
      evidence_summary: buildEvidenceSummary(state),
      taxonomy: buildTaxonomy(state),
      trace_context: buildTraceContext(state),
      difficulty: classification.difficulty,
      task_type: taxonomyKey || undefined,
      domain_tags: domainTags.length > 0 ? domainTags : undefined,
      is_code_task: isCode,
      has_error: Boolean(state.error),
      iteration_count: state.iteration_count,
      max_iterations: state.max_iterations,
      streaming: streamingCtx
        ? { mode: streamingCtx.mode, time_to_first_token_ms: streamingCtx.timeToFirstTokenMs }
        : undefined,
      ...(contextCuration ? { context_curation: contextCuration } : {}),
    };
    emitTrace(trace, traceEmitterConfig, app.log);
  }

  function emitPlannerUsageMeteringRow(
    state: GraphState,
    usage: LlmUsage,
    latencyMs: number,
    auth: Awaited<ReturnType<typeof resolveAuthContext>>,
  ): void {
    const model = state.response_model ?? state.requested_model ?? "unknown";
    const requestId = state.authz_trace_id ?? "";
    if (!requestId) return;
    emitPlannerUsageMetering(
      {
        request_id: requestId,
        user_id: auth.userEmail || auth.userId,
        org_id: auth.orgId,
        tenant_id: auth.tenantIds?.[0] ?? "",
        conversation_id: state.conversation_id,
        model,
        tokens: usage,
        estimated_cost_usd: usage.estimated_cost_usd,
        actual_cost_usd: usage.actual_cost_usd,
        pricing_source: "registry",
        latency_ms: latencyMs,
        has_error: Boolean(state.error),
      },
      traceEmitterConfig,
      app.log,
    );
  }

  app.post(
    "/v1/chat/completions",
    {
      config: { rateLimit: { max: 300, timeWindow: "1 minute" as const } },
      preHandler: app.rateLimit({ max: 300, timeWindow: "1 minute" }),
    },
    async (request, reply) => {
    const authzTraceId = crypto.randomUUID();
    const inboundTraceparentHeader = request.headers["traceparent"];
    const inboundTraceparent = typeof inboundTraceparentHeader === "string" && inboundTraceparentHeader.trim().length > 0
      ? inboundTraceparentHeader.trim()
      : undefined;
    const requestSpan = getTracer().startSpan("planner.chat.completions", {
      "http.method": request.method,
      "http.route": "/v1/chat/completions",
    });
    requestSpan.setAttribute("planner.authz_trace_id", authzTraceId);
    if (inboundTraceparent) {
      requestSpan.setAttribute("planner.inbound_traceparent", inboundTraceparent);
    }
    const outboundTraceparent = inboundTraceparent ?? requestSpan.traceparent();
    reply.header("x-synesis-authz-trace-id", authzTraceId);
    reply.header("x-synesis-authz-engine", authzPolicyEngine.engineName);
    let streamRelease: (() => void) | undefined;
    try {
      const preAuthSubject = `preauth:${(request.ip || "unknown").trim() || "unknown"}:chat-completions`;
      const preAuthRateLimit = userRateLimiter.check(preAuthSubject);
      if (!preAuthRateLimit.allowed) {
        const err = new Error("Too many requests for this user in the current window") as ErrorWithMeta;
        err.statusCode = 429;
        err.retryAfterSeconds = preAuthRateLimit.retryAfterSeconds ?? 1;
        throw err;
      }
      assertCapabilityLock();
      const auth = await resolveAuthContext(request, config);
      const rateSubject = (auth.userId || auth.userEmail || "anonymous").trim() || "anonymous";
      const rateLimit = userRateLimiter.check(rateSubject);
      if (!rateLimit.allowed) {
        const err = new Error("Too many requests for this user in the current window") as ErrorWithMeta;
        err.statusCode = 429;
        err.retryAfterSeconds = rateLimit.retryAfterSeconds ?? 1;
        throw err;
      }
      const policyDecision = await authorizeChatCompletionsWithPolicy(authzPolicyEngine, auth, {
        traceId: authzTraceId
      });
      reply.header("x-synesis-authz-rules", policyDecision.matchedRules.join(","));
      request.log.info(
        {
          authzTraceId,
          authzEngine: authzPolicyEngine.engineName,
          authzRules: policyDecision.matchedRules,
          userId: auth.userId
        },
        "authz allow"
      );
      const rawBody = request.body;
      const body = ChatCompletionRequestSchema.parse(rawBody);
      const resolvedConversation = resolveIncomingConversationId(
        rawBody,
        request.headers as Record<string, unknown>,
        body.conversation_id,
      );
      const effectiveBody: ParsedChatRequest = resolvedConversation.id
        ? { ...body, conversation_id: resolvedConversation.id }
        : body;
      if (resolvedConversation.id && !body.conversation_id) {
        request.log.info(
          { authzTraceId, userId: auth.userId, conversationSource: resolvedConversation.source },
          "resolved conversation_id from fallback source",
        );
      }
      requestSpan.setAttribute("planner.request.stream", Boolean(body.stream));
      requestSpan.setAttribute("planner.request.model", body.model);
      const resolvedSession = resolvePlannerSessionKey(effectiveBody, authzTraceId);
      if (resolvedSession.source === "ephemeral_request") {
        request.log.warn(
          {
            authzTraceId,
            userId: auth.userId,
            model: body.model,
          },
          "conversation_id missing; using ephemeral planner session key (cross-turn memory/clarification continuity disabled)",
        );
      }
      const created = Math.floor(Date.now() / 1000);
      const completionId = `chatcmpl-${crypto.randomUUID()}`;
      if (body.stream) {
        const admission = await streamAdmission.acquire();
        if (!admission.admitted || !admission.release) {
          const err = new Error(`Stream admission denied: ${admission.reason ?? "capacity"}`) as ErrorWithMeta;
          err.statusCode = 503;
          err.retryAfterSeconds = admission.retryAfterSeconds ?? 5;
          throw err;
        }
        streamRelease = admission.release;
      }

      const initialState = await toState(
        effectiveBody,
        auth,
        authzTraceId,
        policyDecision,
        resolvedSession.sessionKey,
        outboundTraceparent,
      );
      const responseModel = initialState.response_model ?? body.model;

      const sessionKey = resolvedSession.sessionKey;

      if (!body.stream) {
        const reqStart = Date.now();
        const state = await invokeGraph(initialState);
        let content = state.generated_code ?? "";
        if (!content.trim()) {
          content = state.error?.trim()
            ? `Something went wrong: ${state.error}`
            : EMPTY_ASSISTANT_FALLBACK;
        }

        if (config.SYNESIS_INJECTION_SCAN_ENABLED && content) {
          const outputScan = scanModelOutput(content);
          if (outputScan.detected) {
            request.log.warn(
              { authzTraceId, patterns: outputScan.patterns_found.slice(0, 5) },
              "output guardrail: possible injection compliance detected in model response"
            );
          }
        }

        const latestUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        await sessionManager.recordTurn(sessionKey, latestUser ?? "", content);

        if (state.clarification_question) {
          await sessionManager.setPendingClarification(sessionKey, {
            question: state.clarification_question,
            options: state.clarification_options ?? [],
            assumptions: state.assumptions ?? [],
            originalTaskDescription: initialState.task_description,
          });
          if (!(effectiveBody.conversation_id ?? "").trim()) {
            request.log.warn(
              { authzTraceId, sessionSource: resolvedSession.source },
              "clarification_pending_stored_without_conversation_id",
            );
          }
        }

        spawnBackgroundCritic(state, request.log);
        const usage = state.llm_usage ?? ZERO_USAGE;
        const latencyS = (Date.now() - reqStart) / 1000;
        recordUsageMetrics(metrics, responseModel, initialState.model_tier ?? "auto", usage, latencyS);
        emitPlannerTrace(state, usage, Date.now() - reqStart, auth, { mode: "non-streaming" });
        emitPlannerUsageMeteringRow(state, usage, Date.now() - reqStart, auth);
        requestSpan.setStatus("ok");
        return {
          id: completionId,
          object: "chat.completion",
          created,
          model: state.response_model ?? body.model,
          system_fingerprint: SYSTEM_FINGERPRINT,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              logprobs: null,
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            cached_prompt_tokens: usage.cached_prompt_tokens,
            estimated_cost_usd: usage.estimated_cost_usd,
            actual_cost_usd: usage.actual_cost_usd
          },
          run_id: state.run_id,
          authz_trace_id: state.authz_trace_id
        };
      }

      const streamReqStart = Date.now();
      let firstTokenAt: number | undefined;
      initSse(reply.raw);
      reply.raw.once("close", () => {
        streamRelease?.();
      });
      writeAssistantRoleDelta(reply.raw, {
        id: completionId,
        created,
        model: responseModel,
        system_fingerprint: SYSTEM_FINGERPRINT,
      });

      // Immediate pulse so Open WebUI shows "Thinking" right away,
      // before entry_pipeline (classification + taxonomy) completes.
      writeReasoningDelta(reply.raw, {
        id: completionId,
        created,
        model: responseModel,
        reasoning_content: "[Synthesizing request]\n",
        system_fingerprint: SYSTEM_FINGERPRINT,
      });

      let finalState: GraphState = initialState;
      let streamingError: Error | undefined;

      try {
        let writerStreamed = false;
        const writerDeltaHandler = (delta: import("./llm/client.js").StreamDelta) => {
          if (!isSseWritable(reply.raw)) return;
          if (!firstTokenAt && (delta.content || delta.reasoning_content)) {
            firstTokenAt = Date.now();
          }
          if (delta.content) {
            writerStreamed = true;
            writeContentDelta(reply.raw, {
              id: completionId,
              created,
              model: responseModel,
              content: delta.content,
              system_fingerprint: SYSTEM_FINGERPRINT,
            });
          }
          if (delta.reasoning_content) {
            writeReasoningDelta(reply.raw, {
              id: completionId,
              created,
              model: responseModel,
              reasoning_content: delta.reasoning_content,
              system_fingerprint: SYSTEM_FINGERPRINT,
            });
          }
        };

        const directState = await directStreamPipeline(initialState, writerDeltaHandler);
        const usedDirectPath = directState.next_node === "respond";

        if (usedDirectPath) {
          finalState = directState;
        } else {
          if (isSseWritable(reply.raw)) {
            writeReasoningDelta(reply.raw, {
              id: completionId,
              created,
              model: responseModel,
              reasoning_content: "[Planning and gathering evidence — this may take a little while]\n",
              system_fingerprint: SYSTEM_FINGERPRINT,
            });
          }
          for await (const event of streamGraph(initialState, writerDeltaHandler)) {
            if (!isSseWritable(reply.raw)) break;
            finalState = event.state;

            const nextNode = event.state.next_node;
            if (
              (event.node === "plan_gate" || event.node === "critic") &&
              nextNode === "router"
            ) {
              writeStatusEvent(reply.raw, {
                description: "Gathering evidence…",
                done: false,
                detail: "Searching sources and ranking relevance",
              });
            }
            if (event.node === "router") {
              writeStatusEvent(reply.raw, {
                description: "Gathering evidence…",
                done: true,
              });
            }

            if (event.node !== "respond") {
              writeReasoningDelta(reply.raw, {
                id: completionId,
                created,
                model: responseModel,
                reasoning_content: `[${describePhase(event.node)}]\n`,
                system_fingerprint: SYSTEM_FINGERPRINT,
              });

              if (nextNode && nextNode !== "respond") {
                const previewPhases: Record<string, string> = {
                  planner: "Thinking through the approach…",
                  router: "Searching sources…",
                  writer: "Writing response…",
                };
                const preview = previewPhases[nextNode];
                if (preview) {
                  writeReasoningDelta(reply.raw, {
                    id: completionId,
                    created,
                    model: responseModel,
                    reasoning_content: `[${preview}]\n`,
                    system_fingerprint: SYSTEM_FINGERPRINT,
                  });
                }
              }
            }
          }
        }

        let content = finalState.generated_code ?? "";
        if (!content.trim() && !streamingError) {
          const filled = finalState.error?.trim()
            ? `Something went wrong: ${finalState.error}`
            : EMPTY_ASSISTANT_FALLBACK;
          content = filled;
          finalState = { ...finalState, generated_code: filled };
        }

        // When the graph bypasses the writer (e.g. clarification → respond),
        // content is set in generated_code but never streamed. Emit it now.
        if (content && !writerStreamed && isSseWritable(reply.raw)) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          writeContentDelta(reply.raw, {
            id: completionId,
            created,
            model: responseModel,
            content,
            system_fingerprint: SYSTEM_FINGERPRINT,
          });
        }

        if (config.SYNESIS_INJECTION_SCAN_ENABLED && content) {
          const outputScan = scanModelOutput(content);
          if (outputScan.detected) {
            request.log.warn(
              { authzTraceId, patterns: outputScan.patterns_found.slice(0, 5) },
              "output guardrail: possible injection compliance detected in streamed response"
            );
          }
        }

        const latestUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        await sessionManager.recordTurn(sessionKey, latestUser ?? "", content);

        if (finalState.clarification_question) {
          await sessionManager.setPendingClarification(sessionKey, {
            question: finalState.clarification_question,
            options: finalState.clarification_options ?? [],
            assumptions: finalState.assumptions ?? [],
            originalTaskDescription: initialState.task_description,
          });
          if (!(effectiveBody.conversation_id ?? "").trim()) {
            request.log.warn(
              { authzTraceId, sessionSource: resolvedSession.source },
              "clarification_pending_stored_without_conversation_id",
            );
          }
        }

        spawnBackgroundCritic(finalState, request.log);
      } catch (err) {
        streamingError = err instanceof Error ? err : new Error(String(err));
        failureStore.record("streaming_graph", "execution_error", streamingError.message);
        request.log.error(
          { authzTraceId, error: streamingError.message },
          "streaming graph execution failed",
        );
        if (isSseWritable(reply.raw)) {
          writeContentDelta(reply.raw, {
            id: completionId,
            created,
            model: responseModel,
            content: "\n\nAn error occurred while processing your request. Please try again.",
            system_fingerprint: SYSTEM_FINGERPRINT,
          });
        }
      }

      const streamUsage = finalState.llm_usage ?? ZERO_USAGE;
      const streamLatencyS = (Date.now() - streamReqStart) / 1000;
      recordUsageMetrics(metrics, responseModel, initialState.model_tier ?? "auto", streamUsage, streamLatencyS);
      emitPlannerTrace(finalState, streamUsage, Date.now() - streamReqStart, auth, {
        mode: "streaming",
        timeToFirstTokenMs: firstTokenAt ? firstTokenAt - streamReqStart : undefined,
      });
      emitPlannerUsageMeteringRow(finalState, streamUsage, Date.now() - streamReqStart, auth);
      if (isSseWritable(reply.raw)) {
        writeFinalChunk(reply.raw, {
          id: completionId,
          created,
          model: responseModel,
          usage: {
            prompt_tokens: streamUsage.prompt_tokens,
            completion_tokens: streamUsage.completion_tokens,
            total_tokens: streamUsage.total_tokens,
            cached_prompt_tokens: streamUsage.cached_prompt_tokens,
            estimated_cost_usd: streamUsage.estimated_cost_usd,
            actual_cost_usd: streamUsage.actual_cost_usd,
          },
          run_id: finalState.run_id,
          authz_trace_id: finalState.authz_trace_id,
          include_usage: finalState.stream_include_usage ?? true,
          system_fingerprint: SYSTEM_FINGERPRINT,
        });
        endSse(reply.raw);
      }
      streamRelease?.();
      requestSpan.setStatus("ok");
      return reply;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "Unknown server error";
      failureStore.record("request", error instanceof Error ? error.name : "UnknownError", rawMessage);
      const err = error as ErrorWithMeta;
      if (err.policyDecision?.matchedRules?.length) {
        reply.header("x-synesis-authz-rules", err.policyDecision.matchedRules.join(","));
      }
      request.log.warn(
        {
          authzTraceId,
          authzEngine: authzPolicyEngine.engineName,
          authzRules: err.policyDecision?.matchedRules ?? [],
          errorMessage: rawMessage
        },
        "authz reject or request validation failure"
      );
      const statusCode = err.statusCode
        ?? (rawMessage === "Missing Bearer token" ? 401 : 400);
      if (err.retryAfterSeconds) {
        reply.header("Retry-After", String(err.retryAfterSeconds));
      }
      const errorTrace: TraceRecord = {
        service: "planner",
        trace_id: authzTraceId,
        request_id: authzTraceId,
        authz_trace_id: authzTraceId,
        timestamp: Date.now() / 1000,
        user_id: "",
        org_id: "",
        tenant_id: "",
        model: "unknown",
        tokens: ZERO_USAGE,
        cost: { estimated_usd: 0, actual_usd: 0, rates_snapshot: { input_per_million: 0, output_per_million: 0, cached_input_per_million: null } },
        latency_ms: 0,
        error: rawMessage,
      };
      emitTrace(errorTrace, traceEmitterConfig, app.log);
      if (reply.raw.headersSent) {
        streamRelease?.();
        endSse(reply.raw);
        requestSpan.setStatus("error", rawMessage);
        return reply;
      }
      streamRelease?.();
      const clientMessage = sanitizeErrorMessage(rawMessage);
      requestSpan.setStatus("error", clientMessage);
      return reply.code(statusCode).send({
        error: {
          message: clientMessage,
          type: statusCode === 401
            ? "authentication_error"
            : statusCode === 403
              ? "permission_error"
            : statusCode === 429
              ? "rate_limit_error"
              : statusCode >= 500
                ? "server_error"
                : "invalid_request_error",
          code: String(statusCode)
        }
      });
    } finally {
      requestSpan.end();
    }
    },
  );

  return app;
}
