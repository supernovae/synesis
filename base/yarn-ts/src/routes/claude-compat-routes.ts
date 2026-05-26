import {
  buildClaudeBootstrapTemplate,
  executeClaudeCompatCommand,
  resolveClaudeModelSelection,
} from "../claude-compat.js";
import {
  ClaudeBootstrapQuerySchema,
  ClaudeCommandExecuteRequestSchema,
  ClaudeModelResolutionQuerySchema,
  type ClaudeBootstrapQuery,
  type ClaudeCommandExecuteRequest,
  type ClaudeModelResolutionQuery,
} from "../schemas.js";
import type { SessionIdentity } from "../session/session-key.js";
import { authorizeClaudeCompatRequest, type PlatformRouteDependencies } from "./platform-route-support.js";

export function registerClaudeCompatRoutes(deps: PlatformRouteDependencies): void {
  const {
    app,
    config,
    tierRegistry,
    getSessionKey,
    getSessionState,
    forceCheckpoint,
    casSessionSave,
    recordSessionEvent,
  } = deps;

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
    catalog: deps.clientAdapterPacks.getCatalog(),
  }));
}
