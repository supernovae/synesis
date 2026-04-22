/**
 * Synesis Admin MCP — Streamable HTTP (@modelcontextprotocol/sdk).
 * Authenticates against Admin API (JWT / PAT), owns Admin MCP tool catalog/execution,
 * and serves Streamable HTTP plus a lightweight JSON tool API for the Admin Assistant.
 */
import Fastify, { type FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { loadConfig, type AdminMcpConfig } from "./config.js";
import {
  invokeTool,
  isOrgAdminOrHigher,
  type SessionUser,
  visibleToolDescriptorsForRole,
} from "./tools.js";

const FlexibleArgs = z.object({}).passthrough();

function extractBearer(req: FastifyRequest): string {
  const raw = req.headers.authorization ?? "";
  if (!raw.toLowerCase().startsWith("bearer ")) return "";
  return raw.slice(7).trim();
}

function forwardOrgHeaders(req: FastifyRequest): Record<string, string> {
  const h: Record<string, string> = {};
  const a = req.headers["x-synesis-org-id"];
  const b = req.headers["x-active-org-id"];
  if (typeof a === "string" && a.trim()) h["x-synesis-org-id"] = a.trim();
  if (typeof b === "string" && b.trim()) h["x-active-org-id"] = b.trim();
  return h;
}

async function validateSession(
  cfg: AdminMcpConfig,
  authHeader: string,
  orgHeaders: Record<string, string>,
): Promise<SessionUser> {
  const base = cfg.SYNESIS_ADMIN_API_URL.replace(/\/$/, "");
  const r = await fetch(`${base}/api/v1/auth/me`, {
    headers: { Authorization: authHeader, ...orgHeaders },
  });
  if (r.status === 401 || r.status === 403) {
    throw new Error("unauthorized");
  }
  if (!r.ok) {
    throw new Error(`auth_upstream_${r.status}`);
  }
  const data = (await r.json()) as SessionUser;
  return data;
}

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v)) }],
  };
}

function parseInvokeBody(body: unknown): { name: string; args: Record<string, unknown> } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid_body");
  }
  const raw = body as { name?: unknown; arguments?: unknown };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) throw new Error("name_required");
  const argsRaw = raw.arguments;
  if (argsRaw === undefined || argsRaw === null) return { name, args: {} };
  if (typeof argsRaw === "object" && !Array.isArray(argsRaw)) {
    return { name, args: argsRaw as Record<string, unknown> };
  }
  throw new Error("arguments_must_be_object");
}

interface AuthenticatedRequestContext {
  authHeader: string;
  orgHeaders: Record<string, string>;
  user: SessionUser;
}

async function authenticateAdminRequest(
  cfg: AdminMcpConfig,
  req: FastifyRequest,
): Promise<AuthenticatedRequestContext> {
  const bearer = extractBearer(req);
  if (!bearer) throw new Error("missing_bearer");
  const authHeader = `Bearer ${bearer}`;
  const orgHeaders = forwardOrgHeaders(req);
  const user = await validateSession(cfg, authHeader, orgHeaders);
  if (!isOrgAdminOrHigher(user.role)) {
    throw new Error("forbidden");
  }
  return { authHeader, orgHeaders, user };
}

export function buildAdminMcpServer(
  cfg: AdminMcpConfig,
  authCtx: AuthenticatedRequestContext,
): McpServer {
  const server = new McpServer(
    { name: "synesis-admin-mcp", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  const tools = visibleToolDescriptorsForRole(authCtx.user.role);
  const toolContext = {
    cfg,
    authHeader: authCtx.authHeader,
    orgHeaders: authCtx.orgHeaders,
  };

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: FlexibleArgs,
      },
      async (args) => {
        const raw = args && typeof args === "object" && !Array.isArray(args) ? args : {};
        const record = z.record(z.string(), z.unknown()).parse(raw);
        try {
          const result = await invokeTool(toolContext, authCtx.user.role, tool.name, record);
          return jsonResult(result);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return jsonResult({ error: "tool_failed", tool: tool.name, message: msg });
        }
      },
    );
  }

  return server;
}

function createApp(cfg: AdminMcpConfig) {
  let mcpRequests = 0;
  let mcpAuthFailures = 0;
  let directToolInvocations = 0;

  const app = Fastify({ logger: { level: cfg.LOG_LEVEL } });

  app.get("/health", async () => ({
    status: "ok",
    service: "synesis-admin-mcp-ts",
    protocol: "mcp-streamable-http",
    path: cfg.SYNESIS_ADMIN_MCP_HTTP_PATH,
    admin_api: cfg.SYNESIS_ADMIN_API_URL.replace(/\/$/, ""),
  }));

  app.get("/health/telemetry", async () => ({
    service: "synesis-admin-mcp-ts",
    mcp_http_requests: mcpRequests,
    mcp_auth_failures: mcpAuthFailures,
    direct_tool_invocations: directToolInvocations,
    otel: { configured: Boolean(cfg.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) },
  }));

  app.get("/v1/admin-tools", async (req, reply) => {
    try {
      const authCtx = await authenticateAdminRequest(cfg, req);
      const tools = visibleToolDescriptorsForRole(authCtx.user.role);
      return reply.code(200).send({
        role: authCtx.user.role ?? "unknown",
        tools,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "missing_bearer" || msg === "unauthorized") {
        mcpAuthFailures++;
        return reply.code(401).send({ error: "unauthorized", message: "Invalid or missing bearer token" });
      }
      if (msg === "forbidden") {
        return reply.code(403).send({ error: "forbidden", message: "Admin role required for admin MCP tools" });
      }
      app.log.error({ err: msg }, "admin_tools_catalog_failed");
      return reply.code(502).send({ error: "bad_gateway", message: "Could not validate admin session" });
    }
  });

  app.post("/v1/admin-tools/invoke", async (req, reply) => {
    let authCtx: AuthenticatedRequestContext;
    try {
      authCtx = await authenticateAdminRequest(cfg, req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "missing_bearer" || msg === "unauthorized") {
        mcpAuthFailures++;
        return reply.code(401).send({ error: "unauthorized", message: "Invalid or missing bearer token" });
      }
      if (msg === "forbidden") {
        return reply.code(403).send({ error: "forbidden", message: "Admin role required for admin MCP tools" });
      }
      app.log.error({ err: msg }, "admin_tools_invoke_auth_failed");
      return reply.code(502).send({ error: "bad_gateway", message: "Could not validate admin session" });
    }

    let parsed: { name: string; args: Record<string, unknown> };
    try {
      parsed = parseInvokeBody(req.body as unknown);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "name_required") {
        return reply.code(400).send({ error: "invalid_request", detail: "name required" });
      }
      if (msg === "arguments_must_be_object") {
        return reply.code(400).send({ error: "invalid_request", detail: "arguments must be an object" });
      }
      return reply.code(400).send({ error: "invalid_request", detail: "invalid request body" });
    }

    try {
      const result = await invokeTool(
        {
          cfg,
          authHeader: authCtx.authHeader,
          orgHeaders: authCtx.orgHeaders,
        },
        authCtx.user.role,
        parsed.name,
        parsed.args,
      );
      directToolInvocations++;
      return reply.code(200).send({ result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("Unknown tool:")) {
        return reply.code(404).send({ error: "tool_not_found", detail: msg });
      }
      if (msg.includes("requires")) {
        return reply.code(403).send({ error: "forbidden", detail: msg });
      }
      app.log.error({ err: msg, tool: parsed.name }, "admin_tools_invoke_failed");
      return reply.code(500).send({ error: "tool_failed", detail: msg });
    }
  });

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: cfg.SYNESIS_ADMIN_MCP_HTTP_PATH,
    handler: async (req, reply) => {
      mcpRequests++;
      let authCtx: AuthenticatedRequestContext;
      try {
        authCtx = await authenticateAdminRequest(cfg, req);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "missing_bearer" || msg === "unauthorized") {
          mcpAuthFailures++;
          return reply.code(401).send({ error: "unauthorized", message: "Invalid or missing bearer token" });
        }
        if (msg === "forbidden") {
          return reply.code(403).send({ error: "forbidden", message: "Admin role required for admin MCP tools" });
        }
        return reply.code(502).send({ error: "bad_gateway", message: "Admin auth validation failed" });
      }

      reply.hijack();

      const server = buildAdminMcpServer(cfg, authCtx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      const parsedBody = req.method === "POST" ? (req.body as unknown) : undefined;
      await transport.handleRequest(req.raw, reply.raw, parsedBody);
      await transport.close();
      await server.close();
    },
  });

  return app;
}

const config = loadConfig();
const app = createApp(config);

async function main() {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(
    {
      host: config.HOST,
      port: config.PORT,
      path: config.SYNESIS_ADMIN_MCP_HTTP_PATH,
      adminApi: config.SYNESIS_ADMIN_API_URL,
    },
    "synesis-admin-mcp-ts listening",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await app.close();
  process.exit(0);
});
