import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AuthResolver, AuthUser } from "../auth.js";
import { McpToolRegistry, McpToolNotFoundError, McpToolTimeoutError } from "./tool-registry.js";
import { classifyProjectTool } from "./handlers/classify-project.js";
import { inspectRepoTool } from "./handlers/inspect-repo.js";
import { scaffoldTool } from "./handlers/scaffold.js";
import { compareManifestTool } from "./handlers/compare-manifest.js";
import {
  applyPatchTool,
  formatCodeTool,
  getRuntimeContextTool,
  gitAddGuardedTool,
  gitCommitGuardedTool,
  gitDiffTool,
  gitStatusTool,
  listDirTool,
  readFileTool,
  runBuildTool,
  runLintTool,
  runTestTool,
  searchCodeTool,
  writeFileTool,
} from "./handlers/coding-tools.js";

export interface McpPluginOptions {
  authResolver: AuthResolver;
  enabled: boolean;
}

const registry = new McpToolRegistry();
registry.register(classifyProjectTool);
registry.register(inspectRepoTool);
registry.register(scaffoldTool);
registry.register(compareManifestTool);
registry.register(getRuntimeContextTool);
registry.register(listDirTool);
registry.register(readFileTool);
registry.register(writeFileTool);
registry.register(applyPatchTool);
registry.register(searchCodeTool);
registry.register(runTestTool);
registry.register(runBuildTool);
registry.register(gitStatusTool);
registry.register(runLintTool);
registry.register(formatCodeTool);
registry.register(gitDiffTool);
registry.register(gitAddGuardedTool);
registry.register(gitCommitGuardedTool);

export function getToolRegistry(): McpToolRegistry {
  return registry;
}

/**
 * Register native MCP tool routes on the Fastify app.
 * These replace the proxy-to-Python-MCP pattern for user-workload tools.
 * Auth: requires valid PAT (syn-*) via AuthResolver.
 */
export async function registerMcpRoutes(
  app: FastifyInstance,
  opts: McpPluginOptions,
): Promise<void> {
  if (!opts.enabled) {
    app.log.info("mcp_tools_disabled");
    return;
  }

  async function resolveUser(req: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
    try {
      const user = await opts.authResolver.resolve(req.headers.authorization);
      opts.authResolver.requireCoderScope(user);
      return user;
    } catch (err) {
      reply.code(401).send({
        error: {
          type: "authentication_error",
          message: err instanceof Error ? err.message : "Authentication required",
        },
      });
      return null;
    }
  }

  app.get("/v1/mcp/tools", async (req, reply) => {
    const user = await resolveUser(req, reply);
    if (!user) return;

    return reply.send({
      tools: registry.getCatalog(),
      meta: { userId: user.userId, toolCount: registry.getCatalog().length },
    });
  });

  app.post("/v1/mcp/tools/call", async (req, reply) => {
    const user = await resolveUser(req, reply);
    if (!user) return;

    const body = req.body as { name?: string; arguments?: unknown } | null;
    if (!body?.name) {
      return reply.code(400).send({
        error: { type: "invalid_request", message: "Missing tool name" },
      });
    }

    const start = performance.now();
    const requestIdHeader = req.headers["x-request-id"];
    const requestId = typeof requestIdHeader === "string" && requestIdHeader.trim().length > 0
      ? requestIdHeader.trim()
      : req.id;
    try {
      const result = await registry.call(body.name, body.arguments ?? {});
      const elapsed = Math.round(performance.now() - start);
      app.log.info({ tool: body.name, userId: user.userId, requestId, elapsed_ms: elapsed }, "mcp_tool_call");
      return reply.send({ result, meta: { tool: body.name, request_id: requestId, elapsed_ms: elapsed } });
    } catch (err) {
      if (err instanceof McpToolNotFoundError) {
        return reply.code(404).send({
          error: { type: "not_found", message: err.message },
        });
      }
      if (err instanceof McpToolTimeoutError) {
        const elapsed = Math.round(performance.now() - start);
        app.log.warn({ tool: body.name, requestId, elapsed_ms: elapsed }, "mcp_tool_timeout");
        return reply.code(504).send({
          error: { type: "timeout", message: err.message },
        });
      }
      const elapsed = Math.round(performance.now() - start);
      app.log.error({ err, tool: body.name, requestId, elapsed_ms: elapsed }, "mcp_tool_error");
      return reply.code(422).send({
        error: {
          type: "tool_error",
          message: "Tool execution failed",
        },
      });
    }
  });

  app.log.info(
    { toolCount: registry.getCatalog().length },
    "mcp_native_tools_registered",
  );
}
