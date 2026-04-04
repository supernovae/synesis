/**
 * Synesis Admin MCP — Streamable HTTP (@modelcontextprotocol/sdk).
 * Authenticates against Admin API (JWT / PAT), loads role-filtered tools, invokes Python handlers via internal routes.
 */
import Fastify, { type FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { loadConfig, type AdminMcpConfig } from "./config.js";

const FlexibleArgs = z.object({}).passthrough();

interface AdminToolRow {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

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
): Promise<void> {
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
}

async function fetchAdminToolCatalog(
  cfg: AdminMcpConfig,
  authHeader: string,
  orgHeaders: Record<string, string>,
): Promise<AdminToolRow[]> {
  const base = cfg.SYNESIS_ADMIN_API_URL.replace(/\/$/, "");
  const r = await fetch(`${base}/api/v1/internal/mcp/tools`, {
    headers: { Authorization: authHeader, ...orgHeaders },
  });
  if (r.status === 401) throw new Error("unauthorized");
  if (r.status === 403) throw new Error("forbidden");
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`catalog_${r.status}:${t.slice(0, 120)}`);
  }
  const data = (await r.json()) as { tools?: AdminToolRow[] };
  return Array.isArray(data.tools) ? data.tools : [];
}

async function invokeAdminTool(
  cfg: AdminMcpConfig,
  authHeader: string,
  orgHeaders: Record<string, string>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const base = cfg.SYNESIS_ADMIN_API_URL.replace(/\/$/, "");
  const r = await fetch(`${base}/api/v1/internal/mcp/invoke`, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json", ...orgHeaders },
    body: JSON.stringify({ name, arguments: args }),
  });
  const text = await r.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`invoke_bad_json:${text.slice(0, 200)}`);
  }
  if (!r.ok) {
    const detail =
      typeof parsed === "object" && parsed !== null && "detail" in parsed
        ? (parsed as { detail: unknown }).detail
        : parsed;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (typeof parsed === "object" && parsed !== null && "result" in parsed) {
    return (parsed as { result: unknown }).result;
  }
  return parsed;
}

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v)) }],
  };
}

export function buildAdminMcpServer(
  cfg: AdminMcpConfig,
  authHeader: string,
  orgHeaders: Record<string, string>,
  tools: AdminToolRow[],
): McpServer {
  const server = new McpServer(
    { name: "synesis-admin-mcp", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

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
          const result = await invokeAdminTool(cfg, authHeader, orgHeaders, tool.name, record);
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
    otel: { configured: Boolean(cfg.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) },
  }));

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: cfg.SYNESIS_ADMIN_MCP_HTTP_PATH,
    handler: async (req, reply) => {
      mcpRequests++;
      const bearer = extractBearer(req);
      if (!bearer) {
        mcpAuthFailures++;
        return reply.code(401).send({
          error: "unauthorized",
          message: "Bearer token required (Keycloak JWT or syn- PAT)",
        });
      }
      const authHeader = `Bearer ${bearer}`;
      const orgHeaders = forwardOrgHeaders(req);

      try {
        await validateSession(cfg, authHeader, orgHeaders);
      } catch (e) {
        mcpAuthFailures++;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "unauthorized") {
          return reply.code(401).send({ error: "unauthorized", message: "Invalid or expired token" });
        }
        return reply.code(502).send({ error: "bad_gateway", message: "Admin auth validation failed" });
      }

      let tools: AdminToolRow[];
      try {
        tools = await fetchAdminToolCatalog(cfg, authHeader, orgHeaders);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "unauthorized") {
          mcpAuthFailures++;
          return reply.code(401).send({ error: "unauthorized", message: "Invalid token for MCP catalog" });
        }
        if (msg === "forbidden") {
          return reply.code(403).send({ error: "forbidden", message: "Not allowed to list MCP tools" });
        }
        app.log.error({ err: msg }, "admin_mcp_catalog_failed");
        return reply.code(502).send({ error: "bad_gateway", message: "Could not load tool catalog from admin API" });
      }

      reply.hijack();

      const server = buildAdminMcpServer(cfg, authHeader, orgHeaders, tools);
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
