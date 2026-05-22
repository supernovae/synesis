/**
 * Synesis Admin MCP — Streamable HTTP (@modelcontextprotocol/sdk).
 * Internal-only service authenticated by Admin API with a service token. The
 * Admin API delegates the already-validated admin session for catalog and tool execution.
 */
import crypto from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { loadConfig, type AdminMcpConfig } from "./config.js";
import {
  AdminMcpToolError,
  invokeTool,
  type SessionUser,
  visibleToolDescriptorsForRole,
} from "./tools.js";

const FlexibleArgs = z.object({}).passthrough();

const DELEGATED_AUTH_HEADER = "x-synesis-delegated-authorization";
const DELEGATED_COOKIE_HEADER = "x-synesis-delegated-cookie";
const DELEGATED_CSRF_HEADER = "x-synesis-delegated-csrf";

type RateLimitOptions = { max: number; timeWindow: string | number };

function timeWindowMs(timeWindow: string | number): number {
  if (typeof timeWindow === "number" && Number.isFinite(timeWindow) && timeWindow > 0) return timeWindow;
  const match = String(timeWindow).trim().match(/^(\d+)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)$/i);
  if (!match) return 60000;
  const amount = Number(match[1] ?? "0");
  const unit = (match[2] ?? "m").toLowerCase();
  if (unit === "ms" || unit.startsWith("millisecond")) return amount;
  if (unit === "s" || unit.startsWith("second")) return amount * 1000;
  if (unit === "m" || unit.startsWith("minute")) return amount * 60_000;
  return amount * 3_600_000;
}

function createRouteRateLimit(options: RateLimitOptions) {
  const windowMs = timeWindowMs(options.timeWindow);
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [key, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(key);
      }
    }
    const routeId = request.routeOptions.url ?? request.url;
    const key = `${request.ip}:${request.method}:${routeId}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    bucket.count += 1;
    if (bucket.count <= options.max) return;

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    reply.header("retry-after", String(retryAfterSeconds));
    return reply.code(429).send({ error: "rate_limit_exceeded" });
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireInternalServiceToken(cfg: AdminMcpConfig, req: FastifyRequest): void {
  const expected = cfg.SYNESIS_INTERNAL_SERVICE_TOKEN.trim();
  if (!expected) {
    throw new Error("service_token_unconfigured");
  }
  const provided = String(req.headers["x-synesis-service-token"] ?? "").trim();
  if (!provided || !timingSafeEqual(provided, expected)) {
    throw new Error("invalid_service_token");
  }
}

function forwardOrgHeaders(req: FastifyRequest): Record<string, string> {
  const h: Record<string, string> = {};
  const a = req.headers["x-synesis-org-id"];
  const b = req.headers["x-active-org-id"];
  if (typeof a === "string" && a.trim()) h["x-synesis-org-id"] = a.trim();
  if (typeof b === "string" && b.trim()) h["x-active-org-id"] = b.trim();
  return h;
}

function delegatedAdminHeaders(req: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const delegatedAuth = req.headers[DELEGATED_AUTH_HEADER];
  const delegatedCookie = req.headers[DELEGATED_COOKIE_HEADER];
  const delegatedCsrf = req.headers[DELEGATED_CSRF_HEADER];
  if (typeof delegatedAuth === "string" && delegatedAuth.toLowerCase().startsWith("bearer ")) {
    headers.Authorization = delegatedAuth.trim();
  }
  if (typeof delegatedCookie === "string" && delegatedCookie.trim()) {
    headers.Cookie = delegatedCookie.trim();
  }
  if (typeof delegatedCsrf === "string" && delegatedCsrf.trim()) {
    headers["x-synesis-csrf"] = delegatedCsrf.trim();
  }
  return headers;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function validateSession(
  cfg: AdminMcpConfig,
  delegatedHeaders: Record<string, string>,
  orgHeaders: Record<string, string>,
): Promise<SessionUser> {
  const base = cfg.SYNESIS_ADMIN_API_URL.replace(/\/$/, "");
  if (!delegatedHeaders.Authorization && !delegatedHeaders.Cookie) {
    throw new Error("missing_delegated_admin_session");
  }
  const r = await fetchWithTimeout(
    `${base}/api/v1/auth/me`,
    { headers: { ...delegatedHeaders, ...orgHeaders } },
    cfg.SYNESIS_ADMIN_MCP_AUTH_TIMEOUT_MS,
  );
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
  delegatedHeaders: Record<string, string>;
  orgHeaders: Record<string, string>;
  user: SessionUser;
}

async function authenticateAdminRequest(
  cfg: AdminMcpConfig,
  req: FastifyRequest,
): Promise<AuthenticatedRequestContext> {
  requireInternalServiceToken(cfg, req);
  const delegatedHeaders = delegatedAdminHeaders(req);
  const orgHeaders = forwardOrgHeaders(req);
  const user = await validateSession(cfg, delegatedHeaders, orgHeaders);
  return { delegatedHeaders, orgHeaders, user };
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
    delegatedHeaders: authCtx.delegatedHeaders,
    orgHeaders: authCtx.orgHeaders,
    userId: authCtx.user.user_id ?? authCtx.user.username ?? "unknown",
    role: authCtx.user.role ?? "",
    user: authCtx.user,
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
          const err = toSafeToolError(e, tool.name);
          return jsonResult(err);
        }
      },
    );
  }

  return server;
}

export function createApp(cfg: AdminMcpConfig) {
  let mcpRequests = 0;
  let mcpAuthFailures = 0;
  let directToolInvocations = 0;

  const app = Fastify({ logger: { level: cfg.LOG_LEVEL } });
  void app.register(fastifyRateLimit, {
    global: true,
    max: cfg.SYNESIS_ADMIN_MCP_GLOBAL_RATE_LIMIT_MAX,
    timeWindow: cfg.SYNESIS_ADMIN_MCP_GLOBAL_RATE_LIMIT_WINDOW,
  });
  // Keep app-level limits even when Cloudflare is enabled so origin-only traffic
  // and trusted network paths still have bounded abuse protection.
  const adminAuthRateLimit = { max: 240, timeWindow: "1 minute" as const };
  const adminAuthPreHandler = createRouteRateLimit(adminAuthRateLimit);

  app.get("/health", async () => ({
    status: "ok",
    service: "synesis-admin-mcp-ts",
  }));

  app.get("/ready", async (_req, reply) => {
    if (!cfg.SYNESIS_INTERNAL_SERVICE_TOKEN.trim()) {
      return reply.code(503).send({ status: "not_ready", service: "synesis-admin-mcp-ts" });
    }
    try {
      const base = cfg.SYNESIS_ADMIN_API_URL.replace(/\/$/, "");
      const response = await fetchWithTimeout(`${base}/api/v1/health`, {}, cfg.SYNESIS_ADMIN_MCP_AUTH_TIMEOUT_MS);
      if (!response.ok) throw new Error(`admin_health_${response.status}`);
      return reply.code(200).send({ status: "ready", service: "synesis-admin-mcp-ts" });
    } catch {
      return reply.code(503).send({ status: "not_ready", service: "synesis-admin-mcp-ts" });
    }
  });

  app.get(
    "/v1/admin-tools",
    {
      config: { rateLimit: adminAuthRateLimit },
      preHandler: adminAuthPreHandler,
    },
    // codeql[js/missing-rate-limiting]
    async (req, reply) => {
    try {
      const authCtx = await authenticateAdminRequest(cfg, req);
      const tools = visibleToolDescriptorsForRole(authCtx.user.role);
      return reply.code(200).send({
        role: authCtx.user.role ?? "unknown",
        tools,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "service_token_unconfigured") {
        mcpAuthFailures++;
        return reply.code(503).send({ error: "service_token_unconfigured", message: "Admin MCP is not configured" });
      }
      if (msg === "invalid_service_token" || msg === "missing_delegated_admin_session" || msg === "unauthorized") {
        mcpAuthFailures++;
        return reply.code(401).send({ error: "unauthorized", message: "Invalid or missing admin session" });
      }
      app.log.error({ err: msg }, "admin_tools_catalog_failed");
      return reply.code(502).send({ error: "bad_gateway", message: "Could not validate admin session" });
    }
    },
  );

  app.post(
    "/v1/admin-tools/invoke",
    {
      config: { rateLimit: adminAuthRateLimit },
      preHandler: adminAuthPreHandler,
    },
    // codeql[js/missing-rate-limiting]
    async (req, reply) => {
    let authCtx: AuthenticatedRequestContext;
    try {
      authCtx = await authenticateAdminRequest(cfg, req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "service_token_unconfigured") {
        mcpAuthFailures++;
        return reply.code(503).send({ error: "service_token_unconfigured", message: "Admin MCP is not configured" });
      }
      if (msg === "invalid_service_token" || msg === "missing_delegated_admin_session" || msg === "unauthorized") {
        mcpAuthFailures++;
        return reply.code(401).send({ error: "unauthorized", message: "Invalid or missing admin session" });
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
          delegatedHeaders: authCtx.delegatedHeaders,
          orgHeaders: authCtx.orgHeaders,
          userId: authCtx.user.user_id ?? authCtx.user.username ?? "unknown",
          role: authCtx.user.role ?? "",
          user: authCtx.user,
        },
        authCtx.user.role,
        parsed.name,
        parsed.args,
      );
      directToolInvocations++;
      return reply.code(200).send({ result });
    } catch (e) {
      const safe = toSafeToolError(e, parsed.name);
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("Unknown tool:")) {
        return reply.code(404).send({ error: "tool_not_found", tool: parsed.name });
      }
      if (msg.includes("requires")) {
        return reply.code(403).send({ error: "forbidden", tool: parsed.name });
      }
      if (e instanceof AdminMcpToolError && e.code === "invalid_arguments") {
        return reply.code(400).send(safe);
      }
      app.log.error({ err: e, tool: parsed.name }, "admin_tools_invoke_failed");
      return reply.code(e instanceof AdminMcpToolError && e.statusCode ? e.statusCode : 500).send(safe);
    }
    },
  );

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: cfg.SYNESIS_ADMIN_MCP_HTTP_PATH,
    config: { rateLimit: adminAuthRateLimit },
    preHandler: adminAuthPreHandler,
    // codeql[js/missing-rate-limiting]
    handler: async (req, reply) => {
      mcpRequests++;
      let authCtx: AuthenticatedRequestContext;
      try {
        authCtx = await authenticateAdminRequest(cfg, req);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "service_token_unconfigured") {
          mcpAuthFailures++;
          return reply.code(503).send({ error: "service_token_unconfigured", message: "Admin MCP is not configured" });
        }
        if (msg === "invalid_service_token" || msg === "missing_delegated_admin_session" || msg === "unauthorized") {
          mcpAuthFailures++;
          return reply.code(401).send({ error: "unauthorized", message: "Invalid or missing admin session" });
        }
        return reply.code(502).send({ error: "bad_gateway", message: "Admin auth validation failed" });
      }

      reply.hijack();

      const server = buildAdminMcpServer(cfg, authCtx);
      const transport = new StreamableHTTPServerTransport({});
      let connected = false;
      try {
        await server.connect(transport as never);
        connected = true;
        const parsedBody = req.method === "POST" ? (req.body as unknown) : undefined;
        await transport.handleRequest(req.raw, reply.raw, parsedBody);
      } catch (e) {
        req.log.warn({ err: e }, "admin_mcp_transport_failed");
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.end(JSON.stringify({ error: "mcp_transport_failed" }));
        }
      } finally {
        if (connected) await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    },
  });

  return app;
}

function toSafeToolError(error: unknown, tool: string): Record<string, unknown> {
  if (error instanceof AdminMcpToolError) {
    return { error: error.code, tool, status_code: error.statusCode };
  }
  return { error: "tool_failed", tool };
}

async function main() {
  const config = loadConfig();
  const app = createApp(config);
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

  process.on("SIGTERM", async () => {
    await app.close();
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
