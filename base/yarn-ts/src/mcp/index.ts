import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  dispatchSynesisTool,
  getSynesisPlatformCatalog,
  SYNESIS_MCP_TOOL_NAMES,
  type SynesisMcpAuth,
  type SynesisMcpDeps,
} from "@synesis/mcp-tools";
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

const SYNESIS_PLATFORM_TOOL_SET = new Set<string>(SYNESIS_MCP_TOOL_NAMES);

export interface McpPluginOptions {
  authResolver: AuthResolver;
  enabled: boolean;
  openClawProfileEnabled: boolean;
  openClawMcpAllowlistEnabled: boolean;
  openClawStrictGovernanceEnabled: boolean;
  /** Same deps as `KnowledgeSearchService` / synesis-mcp-ts — planner + critic URLs for platform tools. */
  synesisMcpDeps: SynesisMcpDeps;
}

const OPENCLAW_MCP_ALLOWLIST = new Set<string>([
  "get_runtime_context",
  "list_dir",
  "read_file",
  "search_code",
  "run_test",
  "run_build",
  "run_lint",
  "git_status",
  "git_diff",
  /** Read-only Synesis platform tools (same handlers as synesis-mcp-ts). */
  "synesis_search",
  "synesis_knowledge_search",
  "synesis_code_search",
  "synesis_docs_search",
  "synesis_config_search",
  "synesis_cve_check",
  "synesis_license_check",
  "synesis_docs_lookup",
  "synesis_patch_integrity",
]);

const OPENCLAW_WRITE_CAPABLE_TOOLS = new Set<string>([
  "write_file",
  "apply_patch",
  "format_code",
  "git_add_guarded",
  "git_commit_guarded",
]);

export function isOpenClawClientHeader(raw: unknown): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return false;
  return v.includes("openclaw")
    || v.includes("open-claw")
    || v.includes("claw/")
    || v.startsWith("claw-")
    || v.endsWith("-claw");
}

export function filterMcpCatalogForOpenClaw<T extends { name: string }>(catalog: T[]): T[] {
  return catalog.filter((t) => OPENCLAW_MCP_ALLOWLIST.has(t.name));
}

function extractBearerAuthorization(req: FastifyRequest): string {
  const raw = req.headers.authorization ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) return "";
  return raw.slice(7).trim();
}

function synesisAuthForRequest(user: AuthUser, req: FastifyRequest): SynesisMcpAuth {
  return {
    bearerToken: extractBearerAuthorization(req),
    userId: user.userId,
    orgId: user.orgId,
    tenantIds: user.tenantIds,
  };
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
    const openClawClient = opts.openClawProfileEnabled
      && isOpenClawClientHeader(req.headers["x-synesis-client"]);
    const catalog = [...registry.getCatalog(), ...getSynesisPlatformCatalog()];
    const tools =
      openClawClient && opts.openClawMcpAllowlistEnabled
        ? filterMcpCatalogForOpenClaw(catalog)
        : catalog;
    if (openClawClient && opts.openClawMcpAllowlistEnabled) {
      app.log.info(
        { userId: user.userId, originalCount: catalog.length, filteredCount: tools.length },
        "mcp_tools_catalog_filtered_openclaw",
      );
    }

    return reply.send({
      tools,
      meta: {
        userId: user.userId,
        toolCount: tools.length,
        filteredForOpenClaw: openClawClient && opts.openClawMcpAllowlistEnabled,
      },
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
    const openClawClient = opts.openClawProfileEnabled
      && isOpenClawClientHeader(req.headers["x-synesis-client"]);
    if (openClawClient && opts.openClawMcpAllowlistEnabled && !OPENCLAW_MCP_ALLOWLIST.has(body.name)) {
      app.log.warn({ userId: user.userId, tool: body.name }, "mcp_tool_blocked_openclaw_allowlist");
      return reply.code(403).send({
        error: {
          type: "forbidden_tool",
          message: `Tool '${body.name}' is not available for OpenClaw profile`,
        },
      });
    }
    if (openClawClient && opts.openClawStrictGovernanceEnabled && OPENCLAW_WRITE_CAPABLE_TOOLS.has(body.name)) {
      app.log.warn({ userId: user.userId, tool: body.name }, "mcp_tool_blocked_openclaw_strict_write");
      return reply.code(403).send({
        error: {
          type: "forbidden_tool",
          message: `Write-capable MCP tool '${body.name}' is blocked for OpenClaw safety profile`,
        },
      });
    }

    const start = performance.now();
    const requestIdHeader = req.headers["x-request-id"];
    const requestId = typeof requestIdHeader === "string" && requestIdHeader.trim().length > 0
      ? requestIdHeader.trim()
      : req.id;
    try {
      let result: unknown;
      if (SYNESIS_PLATFORM_TOOL_SET.has(body.name)) {
        result = await dispatchSynesisTool(
          body.name,
          (body.arguments ?? {}) as Record<string, unknown>,
          synesisAuthForRequest(user, req),
          opts.synesisMcpDeps,
        );
      } else {
        result = await registry.call(body.name, body.arguments ?? {});
      }
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
    { toolCount: registry.getCatalog().length + getSynesisPlatformCatalog().length },
    "mcp_native_tools_registered",
  );
}
