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
  strReplaceTool,
  formatCodeTool,
  getRuntimeContextTool,
  gitAddGuardedTool,
  gitBranchInfoTool,
  gitCommitGuardedTool,
  gitDiffTool,
  gitFileStateTool,
  gitRevParseTool,
  gitStatusTool,
  listDirTool,
  readFileTool,
  runBuildTool,
  runLintTool,
  runTestTool,
  runInSandboxTool,
  repoApplyPatchTool,
  repoFindSymbolTool,
  repoGitDiffTool,
  repoListChangedFilesTool,
  repoReadRangeTool,
  repoRunLintTool,
  repoRunTestsTool,
  repoSearchTool,
  repoWriteDecisionRecordTool,
  searchCodeTool,
  takeScreenshotTool,
  delegateTaskTool,
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
  "git_rev_parse",
  "git_branch_info",
  "git_file_state",
  /** Read-only Synesis platform tools (same handlers as synesis-mcp-ts). */
  "synesis_search",
  "synesis_knowledge_search",
  "synesis_web_search",
  "web_search",
  "synesis_code_search",
  "synesis_docs_search",
  "search_developer_docs",
  "synesis_config_search",
  "synesis_cve_check",
  "synesis_license_check",
  "synesis_docs_lookup",
  "synesis_patch_integrity",
]);

const OPENCLAW_WRITE_CAPABLE_TOOLS = new Set<string>([
  "write_file",
  "str_replace",
  "format_code",
  "git_add_guarded",
  "git_commit_guarded",
  "take_screenshot",
  "delegate_task",
]);

const AGENT_FLOW_ONLY_TOOLS = new Set<string>([
  "repo.search",
  "repo.read_range",
  "repo.find_symbol",
  "repo.apply_patch",
  "repo.run_tests",
  "repo.run_lint",
  "repo.git_diff",
  "repo.list_changed_files",
  "repo.write_decision_record",
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

function isAgentFlowRequest(req: FastifyRequest): boolean {
  const raw = String(req.headers["x-synesis-agent-flow"] ?? "").trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "agent" || raw === "supervisor" || raw === "worker" || raw === "reviewer";
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

function classifyToolKind(toolName: string): "discovery" | "evidence" | "mutation" | "verification" | "other" {
  const n = toolName.toLowerCase();
  if (n.includes("search") || n.includes("inspect") || n.includes("classify")) return "discovery";
  if (n.includes("read") || n.includes("diff") || n.includes("status")) return "evidence";
  if (n.includes("patch") || n.includes("write") || n.includes("format") || n.includes("git_add") || n.includes("git_commit")) {
    return "mutation";
  }
  if (n.includes("run_test") || n.includes("run_build") || n.includes("run_lint")) return "verification";
  return "other";
}

function inferTargetScope(args: unknown): "workspace" | "package" | "file" | "unknown" {
  if (!args || typeof args !== "object") return "unknown";
  const row = args as Record<string, unknown>;
  if (typeof row.filePath === "string" && row.filePath.length > 0) return "file";
  if (typeof row.dir === "string") {
    return row.dir === "." ? "workspace" : "package";
  }
  return "unknown";
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
registry.register(strReplaceTool);
registry.register(searchCodeTool);
registry.register(runTestTool);
registry.register(runBuildTool);
registry.register(gitStatusTool);
registry.register(runLintTool);
registry.register(formatCodeTool);
registry.register(gitDiffTool);
registry.register(gitRevParseTool);
registry.register(gitBranchInfoTool);
registry.register(gitFileStateTool);
registry.register(gitAddGuardedTool);
registry.register(gitCommitGuardedTool);
registry.register(runInSandboxTool);
registry.register(takeScreenshotTool);
registry.register(delegateTaskTool);
registry.register(repoSearchTool);
registry.register(repoReadRangeTool);
registry.register(repoFindSymbolTool);
registry.register(repoApplyPatchTool);
registry.register(repoRunTestsTool);
registry.register(repoRunLintTool);
registry.register(repoGitDiffTool);
registry.register(repoListChangedFilesTool);
registry.register(repoWriteDecisionRecordTool);

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
    const agentFlow = isAgentFlowRequest(req);
    const catalog = [...registry.getCatalog(), ...getSynesisPlatformCatalog()];
    const openClawFiltered =
      openClawClient && opts.openClawMcpAllowlistEnabled
        ? filterMcpCatalogForOpenClaw(catalog)
        : catalog;
    const tools = agentFlow
      ? openClawFiltered
      : openClawFiltered.filter((tool) => !AGENT_FLOW_ONLY_TOOLS.has(tool.name));
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
        filteredForAgentFlow: !agentFlow,
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
    const agentFlow = isAgentFlowRequest(req);
    if (!agentFlow && AGENT_FLOW_ONLY_TOOLS.has(body.name)) {
      app.log.warn({ userId: user.userId, tool: body.name }, "mcp_tool_blocked_non_agent_flow");
      return reply.code(403).send({
        error: {
          type: "forbidden_tool",
          message: `Tool '${body.name}' is only available during agent flow`,
        },
      });
    }
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
        const rawArgs =
          body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
            ? (body.arguments as Record<string, unknown>)
            : {};
        const isWebSearchTool = body.name === "synesis_web_search" || body.name === "web_search";
        const mcpArgs = isWebSearchTool
          ? {
              ...rawArgs,
              source_surface: typeof rawArgs.source_surface === "string" && rawArgs.source_surface.trim().length > 0
                ? rawArgs.source_surface
                : "yarn_mcp_http",
              tool_name: "synesis_web_search",
              request_id:
                typeof rawArgs.request_id === "string" && rawArgs.request_id.trim().length > 0
                  ? rawArgs.request_id
                  : requestId,
              session_key:
                typeof rawArgs.session_key === "string" && rawArgs.session_key.trim().length > 0
                  ? rawArgs.session_key
                  : (typeof req.headers["x-synesis-session-key"] === "string"
                    ? req.headers["x-synesis-session-key"]
                    : undefined),
              conversation_id:
                typeof rawArgs.conversation_id === "string" && rawArgs.conversation_id.trim().length > 0
                  ? rawArgs.conversation_id
                  : (typeof req.headers["x-synesis-conversation-id"] === "string"
                    ? req.headers["x-synesis-conversation-id"]
                    : undefined),
              trace_id:
                typeof rawArgs.trace_id === "string" && rawArgs.trace_id.trim().length > 0
                  ? rawArgs.trace_id
                  : requestId,
            }
          : rawArgs;
        result = await dispatchSynesisTool(
          body.name,
          mcpArgs,
          synesisAuthForRequest(user, req),
          opts.synesisMcpDeps,
        );
      } else {
        result = await registry.call(body.name, body.arguments ?? {});
      }
      const elapsed = Math.round(performance.now() - start);
      const runMeta =
        typeof result === "object" && result !== null && "ok" in result && "exitCode" in result
          ? {
              ok: (result as { ok: boolean }).ok,
              exitCode: (result as { exitCode: number }).exitCode,
            }
          : undefined;
      const diagnosticsMeta = (() => {
        if (typeof result !== "object" || result === null) return undefined;
        const row = result as Record<string, unknown>;
        const errors = Array.isArray(row.errors) ? row.errors : [];
        const errorLines = Array.isArray(row.errorLines) ? row.errorLines : [];
        if (errors.length === 0 && errorLines.length === 0) return undefined;
        const coverage =
          errorLines.length > 0
            ? Number((errors.length / errorLines.length).toFixed(3))
            : (errors.length > 0 ? 1 : 0);
        return {
          structured_errors_count: errors.length,
          diagnostic_lines_count: errorLines.length,
          structured_error_coverage: coverage,
        };
      })();
      app.log.info(
        {
          tool: body.name,
          tool_kind: classifyToolKind(body.name),
          target_scope: inferTargetScope(body.arguments),
          userId: user.userId,
          requestId,
          elapsed_ms: elapsed,
          ...(runMeta ?? {}),
          ...(diagnosticsMeta ?? {}),
        },
        "mcp_tool_call",
      );
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
