import type { OpenAIChatCompletionsRouteDependencies } from "../server/route-dependencies.js";
import { OptimizationLedger } from "../telemetry/optimization-ledger.js";
import { sendOpenAIChatPipelineResult } from "../pipeline/openai-chat-pipeline.js";

type AuthUser = import("../auth.js").AuthUser;

export function registerOpenAIChatCompletionsRoute(deps: OpenAIChatCompletionsRouteDependencies): void {
  const {
    app,
    applyClarificationRoundResponseHeader,
    authResolver,
    config,
    fgaCheck,
    openAiChatPipeline,
    policyRejectOpenAIBody,
    recordSessionEvent,
    resolveRequestId,
    sendOpenAISoftFail,
    sendOpenAIWorkspaceHandshake,
    userRateLimiter,
  } = deps;

  // --- OpenAI chat completions ---
  app.post("/v1/chat/completions", async (req, reply) => {
    const oaiOptLedger = new OptimizationLedger();
    const endOaiIngressStage = oaiOptLedger.startStage("ingress");
    const oaiTraceReqId = resolveRequestId(req.headers as Record<string, unknown>);
    const oaiIngress = openAiChatPipeline.prepareIngress({
      body: req.body,
      headers: req.headers as Record<string, unknown>,
      config,
    });
    for (const truncation of oaiIngress.truncations) {
      app.log.warn({ reqId: oaiTraceReqId, ...truncation }, "tool_description_truncated");
    }
    if (!oaiIngress.ok) {
      endOaiIngressStage();
      return sendOpenAIChatPipelineResult(reply, {
        kind: "error",
        statusCode: oaiIngress.statusCode,
        body: oaiIngress.body,
      });
    }
    let authUser: AuthUser;
    try {
      authUser = await authResolver.resolve(req.headers.authorization);
    } catch {
      return reply.code(401).send({ error: { type: "auth_error", message: "Authentication required" } });
    }

    try {
      authResolver.requireCoderScope(authUser);
    } catch {
      return reply.code(403).send({ error: { type: "authz_error", message: "Insufficient scope for coder access" } });
    }

    const fgaResult = await fgaCheck(`user:${authUser.userId}`, "can_invoke", "yarn_endpoint", "completions");
    if (!fgaResult.allowed) {
      return reply.code(403).send({ error: { type: "authz_error", message: "Authorization denied by policy" } });
    }

    const oaiRateResult = await userRateLimiter.check(authUser.userId);
    if (!oaiRateResult.allowed) {
      app.log.warn({ userId: authUser.userId, count: oaiRateResult.currentCount, limit: oaiRateResult.limit }, "rate_limit_rejected");
      recordSessionEvent("", authUser.userId, authUser.orgId, "rate_limit_reject", "user-rate-limiter",
        `${oaiRateResult.currentCount}/${oaiRateResult.limit} in window — retry after ${oaiRateResult.retryAfterSeconds}s`);
      return sendOpenAIChatPipelineResult(reply, {
        kind: "error",
        statusCode: 429,
        headers: { "Retry-After": String(oaiRateResult.retryAfterSeconds) },
        body: { error: { type: "rate_limit_error", message: `Rate limit exceeded. Retry after ${oaiRateResult.retryAfterSeconds} seconds.` } },
      });
    }

    endOaiIngressStage();
    const routeExecution = await openAiChatPipeline.executeAuthenticatedRoute({
      deps,
      ingress: oaiIngress,
      authUser,
      requestHeaders: req.headers as Record<string, string | string[] | undefined>,
      rawReply: reply.raw,
      requestId: oaiTraceReqId,
      optimizationLedger: oaiOptLedger,
    });
    if (routeExecution.kind === "workspaceHandshake") {
      return sendOpenAIWorkspaceHandshake(
        reply,
        routeExecution.requestId,
        routeExecution.model,
        routeExecution.stream,
        routeExecution.toolCallId,
        routeExecution.toolName,
      );
    }
    if (routeExecution.kind === "softFail") {
      return sendOpenAISoftFail(
        reply,
        routeExecution.requestId,
        routeExecution.selectedModel,
        routeExecution.content,
        routeExecution.stream,
        routeExecution.envelope as never,
      );
    }
    if (routeExecution.kind === "policyReject") {
      return reply.code(400).send(policyRejectOpenAIBody(routeExecution.decision as never));
    }
    if (routeExecution.clarificationMetadata) {
      applyClarificationRoundResponseHeader(reply, routeExecution.clarificationMetadata);
    }
    return sendOpenAIChatPipelineResult(reply, routeExecution.result);
  });
}
