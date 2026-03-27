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
import { assertCapabilityLock } from "./capability-lock.js";
import type { AppConfig } from "./config.js";
import { SessionManager } from "./context/session-manager.js";
import { createSessionStore } from "./context/session-store.js";
import { invokeGraph, streamGraph } from "./graph.js";
import { setPricingContext } from "./llm/client.js";
import { setRetrievalClient, directStreamPipeline } from "./pipeline.js";
import { UnifiedRetrievalClient } from "./retrieval/client.js";
import { evaluateCritic } from "./nodes/critic-evaluator.js";
import { buildDomainProfile } from "./nodes/domain-profile.js";
import { listModelIds, resolveTierSettings } from "./model-tiers.js";
import { optimizeContext } from "./optimization/context-optimizer.js";
import {
  endSse,
  initSse,
  writeContentDelta,
  writeReasoningDelta,
  writeFinalChunk,
} from "./streaming/sse.js";
import { describePhase } from "./streaming/phases.js";
import type { GraphState } from "./state/types.js";

type ErrorWithMeta = Error & {
  statusCode?: number;
  policyDecision?: { matchedRules?: string[] };
};

export function buildApp(config: AppConfig): FastifyInstance {
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
    const defaultRates = pricingRegistry.getRates("synesis-general");
    setPricingContext(defaultRates, pricingRegistry.getCachedMultiplier());
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
    redisKeyPrefix: config.SYNESIS_PLANNER_TS_REDIS_KEY_PREFIX
  });
  const sessionManager = new SessionManager({
    enabled: config.SYNESIS_PLANNER_TS_SESSION_ENABLED,
    maxHistory: config.SYNESIS_PLANNER_TS_SESSION_MAX_HISTORY,
    checkpointEveryMessages: config.SYNESIS_PLANNER_TS_SESSION_CHECKPOINT_MESSAGES,
    ttlMs: config.SYNESIS_PLANNER_TS_SESSION_TTL_MS,
    store: sessionStore
  });
  const authzPolicyEngine = createAuthorizationPolicyEngine(config);

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
          request_id: state.run_id ?? crypto.randomUUID(),
          timestamp: criticEndTime,
          user_id: state.user_id ?? "",
          org_id: state.org_id ?? "",
          tenant_id: state.tenant_ids?.[0] ?? "",
          model,
          tokens: result.usage,
          cost: {
            estimated_usd: result.usage.estimated_cost_usd,
            actual_usd: result.usage.actual_cost_usd,
            rates_snapshot: pricingRegistry.getRates(model),
          },
          latency_ms: 0,
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
    requestBody: ReturnType<typeof ChatCompletionRequestSchema.parse>,
    auth: ReturnType<typeof resolveAuthContext>,
    authzTraceId: string,
    policyDecision: PolicyDecision
  ): Promise<GraphState> {
    const incomingWithSession = await sessionManager.enrichIncomingMessages(
      requestBody.conversation_id || requestBody.user || "anon",
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
    const taskText = userMessage?.content ?? "";
    const tierSettings = resolveTierSettings(requestBody.model);
    const requestedEffortMode = tierSettings.tier;

    const domainProfile = buildDomainProfile(taskText);
    const sessionKey = requestBody.conversation_id || requestBody.user || "anon";
    const pendingClarification = await sessionManager.consumePendingClarification(sessionKey);

    const baseState: GraphState = {
      messages: optimized.messages.map((m) => ({ role: m.role, content: m.content ?? "" })),
      user_id: auth.userEmail || auth.userId,
      org_id: auth.orgId,
      tenant_ids: auth.tenantIds,
      token_scopes: auth.tokenScopes,
      auth_method: auth.authMethod,
      authz_trace_id: authzTraceId,
      authz_engine: authzPolicyEngine.engineName,
      authz_rules: policyDecision.matchedRules,
      requested_model: tierSettings.requestedModel || requestBody.model,
      response_model: tierSettings.responseModel,
      model_tier: tierSettings.tier,
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
    };

    if (pendingClarification) {
      baseState.user_answer_to_clarification = taskText;
      baseState.assumptions = pendingClarification.assumptions;
    }

    return baseState;
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
    auth: {
      engine: authzPolicyEngine.engineName,
      policyStats: authzPolicyEngine.getStats(),
      openfga: {
        apiUrlConfigured: Boolean(config.SYNESIS_PLANNER_TS_OPENFGA_API_URL),
        storeConfigured: Boolean(config.SYNESIS_PLANNER_TS_OPENFGA_STORE_ID),
        modelConfigured: Boolean(config.SYNESIS_PLANNER_TS_OPENFGA_MODEL_ID),
        authTokenConfigured: Boolean(config.SYNESIS_PLANNER_TS_OPENFGA_AUTH_TOKEN)
      },
      requireBearerAuth: config.SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH,
      trustForwardedIdentityHeaders: config.SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS,
      strictForwardedIdentityMode: config.SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE
    }
  }));

  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", promRegistry.contentType);
    return promRegistry.metrics();
  });

  app.get("/health/authz-events", async () => ({
    status: "ok",
    service: "planner-ts",
    auth: {
      engine: authzPolicyEngine.engineName,
      recentEvents: authzPolicyEngine.getStats().recentEvents
    }
  }));

  app.get("/debug/retrieval-config", async (request) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (token && request.headers.authorization !== `Bearer ${token}`) {
      return { error: "unauthorized" };
    }
    return {
      embedder_url: config.SYNESIS_EMBEDDER_URL ? "configured" : "not_set",
      milvus_host: config.SYNESIS_MILVUS_HOST,
      web_search_enabled: config.SYNESIS_WEB_SEARCH_ENABLED,
      web_search_url: config.SYNESIS_WEB_SEARCH_URL ? "configured" : "not_set",
      cohesion_lock_enabled: config.SYNESIS_COHESION_LOCK_ENABLED,
      gliner_service_url: config.SYNESIS_GLINER_SERVICE_URL ? "configured" : "not_set",
      rag_strategy: config.SYNESIS_RAG_RETRIEVAL_STRATEGY,
      bge_reranker: config.SYNESIS_BGE_RERANKER_URL ? "configured" : "not_set",
    };
  });

  app.get("/debug/session-stats", async (request) => {
    const token = config.SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN;
    if (token && request.headers.authorization !== `Bearer ${token}`) {
      return { error: "unauthorized" };
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
      const auth = resolveAuthContext(request, config);
      const policyDecision = authorizeChatCompletionsWithPolicy(authzPolicyEngine, auth, {
        traceId: authzTraceId
      });
      reply.header("x-synesis-authz-rules", policyDecision.matchedRules.join(","));
      const { conversationId } = request.params as { conversationId: string };
      if (!conversationId?.trim()) {
        return reply.code(400).send({
          error: { message: "conversation_id is required", type: "invalid_request_error", code: "400" }
        });
      }
      const deleted = await sessionManager.purge(conversationId.trim());
      request.log.info(
        {
          authzTraceId,
          conversationId: conversationId.trim(),
          userId: auth.userId,
          deleted
        },
        "memory purge"
      );
      return { deleted, conversation_id: conversationId.trim(), authz_trace_id: authzTraceId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error";
      const err = error as ErrorWithMeta;
      if (err.policyDecision?.matchedRules?.length) {
        reply.header("x-synesis-authz-rules", err.policyDecision.matchedRules.join(","));
      }
      request.log.warn({ authzTraceId, errorMessage: message }, "memory purge rejected");
      const statusCode = err.statusCode ?? (message === "Missing Bearer token" ? 401 : 400);
      return reply.code(statusCode).send({
        error: {
          message,
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
    return {
      difficulty: classification.difficulty,
      task_size: classification.task_size,
      risk_score: classification.risk_score,
      effort_mode: classification.effort_mode,
      model_tier: classification.model_tier,
      rag_mode: classification.rag_mode,
      plan_required: classification.plan_required,
      taxonomy_key: classification.taxonomy_key,
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
    auth: ReturnType<typeof resolveAuthContext>,
    streamingCtx?: { mode: "streaming" | "non-streaming"; timeToFirstTokenMs?: number },
  ): void {
    const model = state.response_model ?? state.requested_model ?? "unknown";
    const rates = pricingRegistry.getRates(model);
    const collector = state._span_collector;
    const spans = collector?.getSpans() ?? [];
    const phaseTimings = collector?.getPhaseTimings() ?? {};

    const classification = buildClassificationTrace(state);
    const domainProfile = state.domain_profile;
    const domainTags = domainProfile?.domains?.map((d) => d.key) ?? [];
    const taxonomyKey = classification.taxonomy_key ?? "";
    const isCode = taxonomyKey.startsWith("code") || taxonomyKey.includes("programming");

    const inlineCritic = buildInlineCriticTrace(state);
    const criticScores: Record<string, unknown> = inlineCritic
      ? { ...inlineCritic.scores, approved: inlineCritic.approved }
      : {};

    const trace: TraceRecord = {
      service: "planner",
      trace_id: state.authz_trace_id ?? crypto.randomUUID(),
      request_id: state.run_id ?? crypto.randomUUID(),
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
    };
    emitTrace(trace, traceEmitterConfig, app.log);
  }

  app.post("/v1/chat/completions", async (request, reply) => {
    const authzTraceId = crypto.randomUUID();
    reply.header("x-synesis-authz-trace-id", authzTraceId);
    reply.header("x-synesis-authz-engine", authzPolicyEngine.engineName);
    try {
      assertCapabilityLock();
      const auth = resolveAuthContext(request, config);
      const policyDecision = authorizeChatCompletionsWithPolicy(authzPolicyEngine, auth, {
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
      const created = Math.floor(Date.now() / 1000);
      const completionId = `chatcmpl-${crypto.randomUUID()}`;
      const initialState = await toState(body, auth, authzTraceId, policyDecision);
      const responseModel = initialState.response_model ?? body.model;

      const sessionKey = body.conversation_id || body.user || "anon";

      if (!body.stream) {
        const reqStart = Date.now();
        const state = await invokeGraph(initialState);
        const content = state.generated_code ?? "";
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

      let finalState: GraphState = initialState;
      let streamingError: Error | undefined;

      try {
        const writerDeltaHandler = (delta: import("./llm/client.js").StreamDelta) => {
          if (reply.raw.writableEnded) return;
          if (!firstTokenAt && (delta.content || delta.reasoning_content)) {
            firstTokenAt = Date.now();
          }
          if (delta.content) {
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
            if (reply.raw.writableEnded) break;
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
        request.log.error(
          { authzTraceId, error: streamingError.message },
          "streaming graph execution failed",
        );
        if (!reply.raw.writableEnded) {
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
      if (!reply.raw.writableEnded) {
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
      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown server error";
      const err = error as ErrorWithMeta;
      if (err.policyDecision?.matchedRules?.length) {
        reply.header("x-synesis-authz-rules", err.policyDecision.matchedRules.join(","));
      }
      request.log.warn(
        {
          authzTraceId,
          authzEngine: authzPolicyEngine.engineName,
          authzRules: err.policyDecision?.matchedRules ?? [],
          errorMessage: message
        },
        "authz reject or request validation failure"
      );
      const statusCode = err.statusCode
        ?? (message === "Missing Bearer token" ? 401 : 400);
      const errorTrace: TraceRecord = {
        service: "planner",
        trace_id: authzTraceId,
        request_id: authzTraceId,
        timestamp: Date.now() / 1000,
        user_id: "",
        org_id: "",
        tenant_id: "",
        model: "unknown",
        tokens: ZERO_USAGE,
        cost: { estimated_usd: 0, actual_usd: 0, rates_snapshot: { input_per_million: 0, output_per_million: 0, cached_input_per_million: null } },
        latency_ms: 0,
        error: message,
      };
      emitTrace(errorTrace, traceEmitterConfig, app.log);
      return reply.code(statusCode).send({
        error: {
          message,
          type: statusCode === 401 ? "authentication_error" : "invalid_request_error",
          code: String(statusCode)
        }
      });
    }
  });

  return app;
}
