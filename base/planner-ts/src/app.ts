import crypto from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
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
import { invokeGraph } from "./graph.js";
import { evaluateCritic } from "./nodes/critic-evaluator.js";
import { listModelIds, resolveTierSettings } from "./model-tiers.js";
import { optimizeContext } from "./optimization/context-optimizer.js";
import {
  endSse,
  initSse,
  writeCompletionChunk,
  writeFinalChunk,
  writeStatusEvent
} from "./streaming/sse.js";
import { chunkContent, describePhase } from "./streaming/phases.js";
import { ZERO_USAGE } from "./llm/client.js";
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
    void evaluateCritic({ ...state, next_node: "critic" })
      .then((result) => {
        requestLog.info(
          {
            authzTraceId: state.authz_trace_id,
            approved: result.approved,
            needMoreEvidence: result.need_more_evidence
          },
          "background critic completed"
        );
      })
      .catch((error: unknown) => {
        requestLog.warn(
          {
            authzTraceId: state.authz_trace_id,
            error: error instanceof Error ? error.message : String(error)
          },
          "background critic failed"
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
    const tierSettings = resolveTierSettings(requestBody.model);
    const requestedEffortMode = tierSettings.tier;
    return {
      messages: optimized.messages.map((m) => ({ role: m.role, content: m.content ?? "" })),
      user_id: auth.userId,
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
      task_description: userMessage?.content ?? "",
      evidence_packets: [],
      decision_ledger: [],
      critique_register: {},
      draft_fingerprints: [],
      patch_ops: [],
      writer_max_tokens: tierSettings.writerMaxTokens,
      critic_max_tokens: tierSettings.criticMaxTokens,
      execution_policy: {
        critique_passes: tierSettings.critiquePasses,
        critic_background: config.SYNESIS_PLANNER_TS_CRITIC_BACKGROUND
      },
      run_id: requestBody.conversation_id ?? undefined
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

  app.get("/health/authz-events", async () => ({
    status: "ok",
    service: "planner-ts",
    auth: {
      engine: authzPolicyEngine.engineName,
      recentEvents: authzPolicyEngine.getStats().recentEvents
    }
  }));

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

      if (!body.stream) {
        const state = await invokeGraph(initialState);
        const content = state.generated_code ?? "";
        const latestUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        await sessionManager.recordTurn(
          body.conversation_id || body.user || "anon",
          latestUser ?? "",
          content
        );
        spawnBackgroundCritic(state, request.log);
        const usage = state.llm_usage ?? ZERO_USAGE;
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
            cached_prompt_tokens: usage.cached_prompt_tokens
          },
          run_id: state.run_id,
          authz_trace_id: state.authz_trace_id
        };
      }

      initSse(reply.raw);
      writeStatusEvent(reply.raw, {
        description: "Planner request accepted",
        done: false,
        authz_trace_id: authzTraceId
      });
      writeStatusEvent(reply.raw, {
        description: describePhase("entry_pipeline"),
        done: false,
        node: "entry_pipeline",
        authz_trace_id: authzTraceId
      });
      if (initialState.next_node === "writer") {
        writeStatusEvent(reply.raw, {
          description: "Fast path selected for low-complexity request",
          done: false,
          node: "writer",
          authz_trace_id: authzTraceId
        });
      }

      const heartbeat = setInterval(() => {
        if (reply.raw.writableEnded) return;
        writeStatusEvent(reply.raw, {
          description: "Planner is still processing",
          done: false,
          authz_trace_id: authzTraceId
        });
      }, 1800);

      const state = await invokeGraph(initialState).finally(() => clearInterval(heartbeat));
      const content = state.generated_code ?? "";
      const latestUser = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      await sessionManager.recordTurn(
        body.conversation_id || body.user || "anon",
        latestUser ?? "",
        content
      );
      spawnBackgroundCritic(state, request.log);

      const traces = state.node_traces ?? [];
      const emitted = new Set<string>();
      for (const trace of traces) {
        const node = typeof trace === "object" && trace !== null ? String((trace as { node_name?: string }).node_name ?? "") : "";
        if (!node || emitted.has(node)) continue;
        emitted.add(node);
        writeStatusEvent(reply.raw, {
          description: describePhase(node),
          done: false,
          node,
          authz_trace_id: authzTraceId
        });
      }

      for (const chunk of chunkContent(content)) {
        writeCompletionChunk(reply.raw, {
          id: completionId,
          created,
          model: responseModel,
          content: chunk
        });
      }

      writeStatusEvent(reply.raw, {
        description: "Planner response complete",
        done: true,
        node: "respond",
        authz_trace_id: authzTraceId
      });
      const streamUsage = state.llm_usage ?? ZERO_USAGE;
      writeFinalChunk(reply.raw, {
        id: completionId,
        created,
        model: responseModel,
        usage: {
          prompt_tokens: streamUsage.prompt_tokens,
          completion_tokens: streamUsage.completion_tokens,
          total_tokens: streamUsage.total_tokens,
          cached_prompt_tokens: streamUsage.cached_prompt_tokens
        }
      });
      endSse(reply.raw);
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
