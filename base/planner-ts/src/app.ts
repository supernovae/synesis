import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Registry } from "prom-client";
import {
  ZERO_USAGE,
  PricingRegistry,
  createServiceMetrics,
  recordUsageMetrics,
  emitTrace,
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
import { assertCapabilityLock } from "./capability-lock.js";
import type { AppConfig } from "./config.js";
import { SessionManager } from "./context/session-manager.js";
import { createSessionStore } from "./context/session-store.js";
import { invokeGraph, streamGraph } from "./graph.js";
import { getLlmResilienceStats, setPricingContext } from "./llm/client.js";
import { setRetrievalClient, directStreamPipeline } from "./pipeline.js";
import { UnifiedRetrievalClient } from "./retrieval/client.js";
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
  writeContentDelta,
  writeReasoningDelta,
  writeFinalChunk,
} from "./streaming/sse.js";
import { describePhase } from "./streaming/phases.js";
import type { GraphState } from "./state/types.js";
import { scanUserInput, scanModelOutput, redactPatterns } from "./security/scanner.js";
import { FailureStore } from "./diagnostics/failure-store.js";
import { DependencyHealthMonitor } from "./diagnostics/health-monitor.js";
import { getTracer } from "./telemetry/otel.js";

type ErrorWithMeta = Error & {
  statusCode?: number;
  retryAfterSeconds?: number;
  policyDecision?: { matchedRules?: string[] };
};

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

export function buildApp(config: AppConfig): FastifyInstance {
  initFgaClient(config);

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    forceCloseConnections: "idle"
  });

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

  if (config.SYNESIS_EMBEDDER_URL) {
    setRetrievalClient(new UnifiedRetrievalClient(config));
  }

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
  ): Promise<GraphState> {
    const incomingWithSession = await sessionManager.enrichIncomingMessages(
      sessionKey,
      requestBody.messages.map((m) => ({ role: m.role, content: m.content ?? "" }))
    );
    const optimized = optimizeContext(incomingWithSession, {
      maxCharsPerMessage: config.SYNESIS_PLANNER_TS_CONTEXT_MAX_CHARS,
      recentMessageLimit: config.SYNESIS_PLANNER_TS_CONTEXT_RECENT_MESSAGE_LIMIT
    });
    optimizationCounters.reducedCount += optimized.stats.reducedCount;
    optimizationCounters.reducedCharsTotal += optimized.stats.reducedCharsTotal;
    optimizationCounters.rawCharsTotal += optimized.stats.rawCharsTotal;

    const userMessage = [...requestBody.messages].reverse().find((m) => m.role === "user");
    let taskText = userMessage?.content ?? "";
    const tierSettings = resolveTierSettings(requestBody.model);
    const requestedEffortMode = tierSettings.tier;

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

      if (detected && config.SYNESIS_INJECTION_ACTION === "block") {
        const err = new Error("Suspicious content detected. If this was unintentional, rephrase your message and try again.");
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (detected && config.SYNESIS_INJECTION_ACTION === "reduce" && taskText) {
        taskText = redactPatterns(taskText);
      }
    }

    const domainProfile = buildDomainProfile(taskText);
    const pendingClarification = await sessionManager.consumePendingClarification(sessionKey);

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
      task_description: taskText,
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
      },
      run_id: requestBody.conversation_id ?? undefined,
      domain_profile: domainProfile,
      injection_detected: injectionDetected,
      injection_scan_result: injectionScanResult,
    };

    if (pendingClarification) {
      baseState.user_answer_to_clarification = taskText;
      baseState.assumptions = pendingClarification.assumptions;
      // The original request was complex enough to trigger clarification.
      // The follow-up answer is typically short ("on prem, 50 users") so the
      // entry classifier would downgrade it to trivial. Force the full
      // pipeline so the planner runs with conversation context + answer.
      baseState.plan_required = true;
      baseState.difficulty = Math.max(baseState.difficulty ?? 0, 0.6);
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
        const base = config.SYNESIS_PLANNER_TS_LLM_BASE_URL.replace(/\/$/, "");
        const resp = await fetch(`${base}/health`, {
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
    admissionControl: {
      userRateLimit: userRateLimiter.getStats(),
      streamAdmission: streamAdmission.getStats(),
    },
    failures: failureStore.stats(),
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

  app.get("/v1/models", async () => ({
    object: "list",
    data: listModelIds(config).map((id) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "synesis"
    }))
  }));

  app.delete("/v1/memory/:conversationId", async (request, reply) => {
    const authzTraceId = crypto.randomUUID();
    reply.header("x-synesis-authz-trace-id", authzTraceId);
    reply.header("x-synesis-authz-engine", authzPolicyEngine.engineName);
    try {
      const auth = await resolveAuthContext(request, config);
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
          type: statusCode === 401 ? "authentication_error" : "invalid_request_error",
          code: String(statusCode)
        }
      });
    }
  });

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
    const citedPattern = /\[Source:\s*[^\]]*?-\s*(https?:\/\/[^\]\s]+)/g;
    const cited = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = citedPattern.exec(draft)) !== null) {
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
    if (packets.length === 0 && !state.writer_max_tokens) return undefined;
    const totalSnippets = packets.reduce((s, p) => s + (p.snippets?.length ?? 0), 0);
    const totalChars = packets.reduce((s, p) =>
      s + (p.snippets ?? []).reduce((c, sn) => c + (sn.text?.length ?? 0), 0), 0);
    const writerBudget = state.writer_max_tokens ?? 0;
    const completionTokens = state.llm_usage?.completion_tokens ?? 0;
    const utilization = writerBudget > 0 ? completionTokens / writerBudget : 0;
    const lowUtilization = writerBudget > 0 && utilization < 0.15;
    const budgetAlert = writerBudget > 0 && utilization > 0.95
      ? `Writer used ${Math.round(utilization * 100)}% of ${writerBudget} token budget — potential truncation`
      : undefined;
    return {
      packets_in: packets.length,
      packets_kept: packets.length,
      excluded_count: 0,
      token_budget: writerBudget,
      tokens_used: completionTokens,
      utilization: Number(utilization.toFixed(4)),
      chars_used: totalChars,
      snippets_total: totalSnippets,
      low_utilization: lowUtilization,
      ...(budgetAlert ? { budget_alert: budgetAlert } : {}),
    };
  }

  function buildTraceContext(state: GraphState): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};
    if (state.writer_max_tokens) ctx.token_budget_total = state.writer_max_tokens;
    if (state.iteration_count !== undefined) ctx.iteration_count = state.iteration_count;
    if (state.max_iterations !== undefined) ctx.max_iterations = state.max_iterations;
    if (state.error) {
      ctx.failure_stage = state.next_node ?? "unknown";
      ctx.failure_reason = state.error;
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

  app.post("/v1/chat/completions", async (request, reply) => {
    const authzTraceId = crypto.randomUUID();
    const requestSpan = getTracer().startSpan("planner.chat.completions", {
      "http.method": request.method,
      "http.route": "/v1/chat/completions",
    });
    requestSpan.setAttribute("planner.authz_trace_id", authzTraceId);
    reply.header("x-synesis-authz-trace-id", authzTraceId);
    reply.header("x-synesis-authz-engine", authzPolicyEngine.engineName);
    let streamRelease: (() => void) | undefined;
    try {
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
      const body = ChatCompletionRequestSchema.parse(request.body);
      requestSpan.setAttribute("planner.request.stream", Boolean(body.stream));
      requestSpan.setAttribute("planner.request.model", body.model);
      const resolvedSession = resolvePlannerSessionKey(body, authzTraceId);
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

      const initialState = await toState(body, auth, authzTraceId, policyDecision, resolvedSession.sessionKey);
      const responseModel = initialState.response_model ?? body.model;

      const sessionKey = resolvedSession.sessionKey;

      if (!body.stream) {
        const reqStart = Date.now();
        const state = await invokeGraph(initialState);
        const content = state.generated_code ?? "";

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
          });
        }

        spawnBackgroundCritic(state, request.log);
        const usage = state.llm_usage ?? ZERO_USAGE;
        const latencyS = (Date.now() - reqStart) / 1000;
        recordUsageMetrics(metrics, responseModel, initialState.model_tier ?? "auto", usage, latencyS);
        emitPlannerTrace(state, usage, Date.now() - reqStart, auth, { mode: "non-streaming" });
        requestSpan.setStatus("ok");
        return {
          id: completionId,
          object: "chat.completion",
          created,
          model: state.response_model ?? body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
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

      // Immediate pulse so Open WebUI shows "Thinking" right away,
      // before entry_pipeline (classification + taxonomy) completes.
      writeReasoningDelta(reply.raw, {
        id: completionId,
        created,
        model: responseModel,
        reasoning_content: "[Synthesizing request]\n",
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
            });
          }
          if (delta.reasoning_content) {
            writeReasoningDelta(reply.raw, {
              id: completionId,
              created,
              model: responseModel,
              reasoning_content: delta.reasoning_content,
            });
          }
        };

        const directState = await directStreamPipeline(initialState, writerDeltaHandler);
        const usedDirectPath = directState.next_node === "respond";

        if (usedDirectPath) {
          finalState = directState;
        } else {
          for await (const event of streamGraph(initialState, writerDeltaHandler)) {
            if (!isSseWritable(reply.raw)) break;
            finalState = event.state;

            if (event.node !== "respond") {
              writeReasoningDelta(reply.raw, {
                id: completionId,
                created,
                model: responseModel,
                reasoning_content: `[${describePhase(event.node)}]\n`,
              });
            }
          }
        }

        const content = finalState.generated_code ?? "";

        // When the graph bypasses the writer (e.g. clarification → respond),
        // content is set in generated_code but never streamed. Emit it now.
        if (content && !writerStreamed && isSseWritable(reply.raw)) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          writeContentDelta(reply.raw, {
            id: completionId,
            created,
            model: responseModel,
            content,
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
          });
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
  });

  return app;
}
