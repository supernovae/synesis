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
import { adminApiBaseUrl, loadConfig, type AdminMcpConfig } from "./config.js";
import {
  AdminMcpConcurrencyLimiter,
  type AdminMcpConcurrencyRejection,
} from "./concurrency-limiter.js";
import { validateMcpJsonRpcPostBody } from "./json-rpc-preflight.js";
import {
  AdminMcpToolError,
  type AdminRole,
  invokeTool,
  type SessionUser,
  type ToolContext,
  visibleToolDescriptorsForRole,
  zodInputSchemaForTool,
} from "./tools.js";

const DELEGATED_AUTH_HEADER = "x-synesis-delegated-authorization";
const DELEGATED_COOKIE_HEADER = "x-synesis-delegated-cookie";
const DELEGATED_CSRF_HEADER = "x-synesis-delegated-csrf";
const ADMIN_ROLE_VALUES = ["readonly", "user", "org_admin", "platform_admin", "admin"] as const satisfies readonly AdminRole[];
const ORG_HEADER_RE = /^[A-Za-z0-9_.:-]{1,256}$/;

type RateLimitOptions = { max: number; timeWindow: string | number };
type AdminMcpAuditOutcome = "allowed" | "denied" | "error";

const boundedString = (maxLength: number) => z.string().trim().max(maxLength);
const boundedSecurityStringArray = (maxItems: number, maxLength: number) =>
  z.array(boundedString(maxLength).min(1)).max(maxItems);

const SessionUserSchema = z.object({
  username: boundedString(256).min(1),
  role: z.enum(ADMIN_ROLE_VALUES),
  user_id: boundedString(256).default(""),
  email: boundedString(256).optional().default(""),
  org_id: boundedString(256).default(""),
  org_name: boundedString(256).default(""),
  org_roles: boundedSecurityStringArray(50, 64).default([]),
  tenant_ids: boundedSecurityStringArray(50, 64).default([]),
  token_scopes: boundedSecurityStringArray(50, 128).default([]),
}).strict();

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

function readBoundedOrgHeader(req: FastifyRequest, headerName: "x-synesis-org-id" | "x-active-org-id"): string {
  const raw = req.headers[headerName];
  if (raw === undefined) return "";
  if (Array.isArray(raw)) throw new Error("invalid_org_header");
  const value = raw.trim();
  if (!value) return "";
  if (!ORG_HEADER_RE.test(value)) throw new Error("invalid_org_header");
  return value;
}

function forwardOrgHeaders(req: FastifyRequest): Record<string, string> {
  const h: Record<string, string> = {};
  const a = readBoundedOrgHeader(req, "x-synesis-org-id");
  const b = readBoundedOrgHeader(req, "x-active-org-id");
  if (a && b && a !== b) throw new Error("invalid_org_header");
  if (a) h["x-synesis-org-id"] = a;
  if (b) h["x-active-org-id"] = b;
  return h;
}

function assertOrgHeaderMatchesSession(orgHeaders: Record<string, string>, user: SessionUser): void {
  const requestedOrg = orgHeaders["x-synesis-org-id"] || orgHeaders["x-active-org-id"] || "";
  const sessionOrg = user.org_id.trim();
  if (requestedOrg && sessionOrg && requestedOrg !== sessionOrg) {
    throw new Error("org_header_mismatch");
  }
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
  const base = adminApiBaseUrl(cfg);
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
  const raw = await r.json();
  const parsed = SessionUserSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("auth_upstream_invalid_session");
  }
  return parsed.data;
}

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v)) }],
  };
}

export function parseAdminMcpToolName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > 128) return null;
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : null;
}

function parseInvokeBody(body: unknown): { name: string; args: Record<string, unknown> } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid_body");
  }
  const raw = body as { name?: unknown; arguments?: unknown };
  const allowed = new Set(["name", "arguments"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error("unknown_invoke_field");
  }
  const name = parseAdminMcpToolName(raw.name);
  if (!name) {
    if (typeof raw.name === "string" && raw.name.trim()) throw new Error("invalid_tool_name");
    throw new Error("name_required");
  }
  const argsRaw = raw.arguments;
  if (argsRaw === undefined || argsRaw === null) return { name, args: {} };
  if (typeof argsRaw === "object" && !Array.isArray(argsRaw)) {
    return { name, args: argsRaw as Record<string, unknown> };
  }
  throw new Error("arguments_must_be_object");
}

function adminMcpLimitMeta(decision: AdminMcpConcurrencyRejection): Record<string, unknown> {
  return {
    userKey: decision.userKey,
    userActive: decision.userActive,
    userLimit: decision.userLimit,
    globalActive: decision.globalActive,
    globalLimit: decision.globalLimit,
  };
}

export function buildAdminMcpAuditFields(input: {
  user: SessionUser;
  toolName: string;
  requestId: string;
  outcome: AdminMcpAuditOutcome;
  reason: string;
  statusCode: number;
  surface?: "admin_mcp_direct" | "admin_mcp_streamable";
  elapsedMs?: number;
  limitMeta?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    surface: input.surface ?? "admin_mcp_direct",
    action: "admin_tool_invoke",
    outcome: input.outcome,
    reason: input.reason,
    statusCode: input.statusCode,
    tool: input.toolName,
    userId: input.user.user_id || input.user.username || "unknown",
    username: input.user.username,
    orgId: input.user.org_id,
    role: input.user.role,
    requestId: input.requestId,
    elapsed_ms: input.elapsedMs,
    ...(input.limitMeta ?? {}),
  };
}

type AdminMcpAuditLogger = (
  level: "info" | "warn" | "error",
  fields: Record<string, unknown>,
  message: string,
) => void;

export async function invokeAdminMcpToolWithControls(input: {
  authCtx: AuthenticatedRequestContext;
  toolContext: ToolContext;
  role: AdminRole;
  toolName: string;
  args: Record<string, unknown>;
  requestId: string;
  surface: "admin_mcp_direct" | "admin_mcp_streamable";
  limiter: AdminMcpConcurrencyLimiter;
  auditLog?: AdminMcpAuditLogger | undefined;
}): Promise<unknown> {
  const concurrencyDecision = input.limiter.tryAcquire({
    orgId: input.authCtx.user.org_id,
    userId: input.authCtx.user.user_id || input.authCtx.user.username,
  });
  if (!concurrencyDecision.allowed) {
    input.auditLog?.(
      "warn",
      buildAdminMcpAuditFields({
        user: input.authCtx.user,
        toolName: input.toolName,
        requestId: input.requestId,
        surface: input.surface,
        outcome: "denied",
        reason: concurrencyDecision.reason,
        statusCode: 429,
        limitMeta: adminMcpLimitMeta(concurrencyDecision),
      }),
      "admin_tools_invoke_denied",
    );
    throw new AdminMcpToolError("rate_limit_exceeded", 429, {
      reason: concurrencyDecision.reason,
      ...adminMcpLimitMeta(concurrencyDecision),
    });
  }

  const start = performance.now();
  try {
    const result = await invokeTool(input.toolContext, input.role, input.toolName, input.args);
    input.auditLog?.(
      "info",
      buildAdminMcpAuditFields({
        user: input.authCtx.user,
        toolName: input.toolName,
        requestId: input.requestId,
        surface: input.surface,
        outcome: "allowed",
        reason: "ok",
        statusCode: 200,
        elapsedMs: Math.round(performance.now() - start),
      }),
      "admin_tools_invoke",
    );
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let statusCode = e instanceof AdminMcpToolError && e.statusCode ? e.statusCode : 500;
    let reason = "tool_error";
    let level: "warn" | "error" = "error";
    if (msg.startsWith("Unknown tool:")) {
      statusCode = 404;
      reason = "tool_not_found";
      level = "warn";
    } else if (msg.includes("requires")) {
      statusCode = 403;
      reason = "forbidden";
      level = "warn";
    } else if (e instanceof AdminMcpToolError && e.code === "invalid_arguments") {
      statusCode = 400;
      reason = "invalid_arguments";
      level = "warn";
    } else if (e instanceof AdminMcpToolError && e.statusCode < 500) {
      reason = e.code;
      level = "warn";
    }
    input.auditLog?.(
      level,
      {
        ...(level === "error" ? { err: e } : {}),
        ...buildAdminMcpAuditFields({
          user: input.authCtx.user,
          toolName: input.toolName,
          requestId: input.requestId,
          surface: input.surface,
          outcome: level === "warn" ? "denied" : "error",
          reason,
          statusCode,
          elapsedMs: Math.round(performance.now() - start),
        }),
      },
      level === "warn" ? "admin_tools_invoke_denied" : "admin_tools_invoke_failed",
    );
    throw e;
  } finally {
    concurrencyDecision.release();
  }
}

export interface AuthenticatedRequestContext {
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
  assertOrgHeaderMatchesSession(orgHeaders, user);
  return { delegatedHeaders, orgHeaders, user };
}

function sendAuthError(
  reply: FastifyReply,
  msg: string,
  onAuthFailure: () => void,
  logUnexpected?: () => void,
): FastifyReply {
  if (msg === "service_token_unconfigured") {
    onAuthFailure();
    return reply.code(503).send({ error: "service_token_unconfigured", message: "Admin MCP is not configured" });
  }
  if (msg === "invalid_service_token" || msg === "missing_delegated_admin_session" || msg === "unauthorized") {
    onAuthFailure();
    return reply.code(401).send({ error: "unauthorized", message: "Invalid or missing admin session" });
  }
  if (msg === "invalid_org_header") {
    onAuthFailure();
    return reply.code(400).send({ error: "invalid_org_header", message: "Invalid active organization header" });
  }
  if (msg === "org_header_mismatch") {
    onAuthFailure();
    return reply.code(403).send({ error: "forbidden", message: "Active organization does not match session" });
  }
  logUnexpected?.();
  return reply.code(502).send({ error: "bad_gateway", message: "Could not validate admin session" });
}

export function buildAdminMcpServer(
  cfg: AdminMcpConfig,
  authCtx: AuthenticatedRequestContext,
  options: {
    limiter?: AdminMcpConcurrencyLimiter;
    requestId?: string;
    auditLog?: AdminMcpAuditLogger;
  } = {},
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
        inputSchema: zodInputSchemaForTool(tool.inputSchema),
      },
      async (args) => {
        const raw = args && typeof args === "object" && !Array.isArray(args) ? args : {};
        try {
          const result = options.limiter
            ? await invokeAdminMcpToolWithControls({
                authCtx,
                toolContext,
                role: authCtx.user.role,
                toolName: tool.name,
                args: raw as Record<string, unknown>,
                requestId: options.requestId ?? "mcp-transport",
                surface: "admin_mcp_streamable",
                limiter: options.limiter,
                auditLog: options.auditLog,
              })
            : await invokeTool(toolContext, authCtx.user.role, tool.name, raw as Record<string, unknown>);
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
  let _mcpRequests = 0;
  let _mcpAuthFailures = 0;
  let _directToolInvocations = 0;

  const app = Fastify({ logger: { level: cfg.LOG_LEVEL }, bodyLimit: 1_048_576 });
  void app.register(fastifyRateLimit, {
    global: true,
    max: cfg.SYNESIS_ADMIN_MCP_GLOBAL_RATE_LIMIT_MAX,
    timeWindow: cfg.SYNESIS_ADMIN_MCP_GLOBAL_RATE_LIMIT_WINDOW,
  });
  // Keep app-level limits even when Cloudflare is enabled so origin-only traffic
  // and trusted network paths still have bounded abuse protection.
  const adminAuthRateLimit = { max: 240, timeWindow: "1 minute" as const };
  const adminAuthPreHandler = createRouteRateLimit(adminAuthRateLimit);
  const directInvokeLimiter = new AdminMcpConcurrencyLimiter({
    maxPerUser: cfg.SYNESIS_ADMIN_MCP_TOOL_MAX_CONCURRENT_PER_USER,
    maxGlobal: cfg.SYNESIS_ADMIN_MCP_TOOL_MAX_CONCURRENT_GLOBAL,
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "synesis-admin-mcp-ts",
  }));

  app.get("/ready", async (_req, reply) => {
    const checks = {
      internal_service_token_configured: Boolean(cfg.SYNESIS_INTERNAL_SERVICE_TOKEN.trim()),
      admin_api_url_configured: Boolean(adminApiBaseUrl(cfg)),
      mcp_http_path_configured: cfg.SYNESIS_ADMIN_MCP_HTTP_PATH.startsWith("/"),
    };
    const ready = Object.values(checks).every(Boolean);
    const payload = { status: ready ? "ready" : "not_ready", service: "synesis-admin-mcp-ts", checks };
    return reply.code(ready ? 200 : 503).send(payload);
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
        role: authCtx.user.role,
        tools,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return sendAuthError(reply, msg, () => { _mcpAuthFailures++; }, () => {
        app.log.error({ err: msg }, "admin_tools_catalog_failed");
      });
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
    const requestId = req.id;
    let authCtx: AuthenticatedRequestContext;
    try {
      authCtx = await authenticateAdminRequest(cfg, req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return sendAuthError(reply, msg, () => { _mcpAuthFailures++; }, () => {
        app.log.error({ err: msg }, "admin_tools_invoke_auth_failed");
      });
    }

    let parsed: { name: string; args: Record<string, unknown> };
    try {
      parsed = parseInvokeBody(req.body as unknown);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "name_required") {
        return reply.code(400).send({ error: "invalid_request", detail: "name required" });
      }
      if (msg === "invalid_tool_name") {
        app.log.warn(
          buildAdminMcpAuditFields({
            user: authCtx.user,
            toolName: "invalid",
            requestId,
            outcome: "denied",
            reason: "invalid_tool_name",
            statusCode: 400,
          }),
          "admin_tools_invoke_denied",
        );
        return reply.code(400).send({ error: "invalid_request", detail: "invalid tool name" });
      }
      if (msg === "arguments_must_be_object") {
        return reply.code(400).send({ error: "invalid_request", detail: "arguments must be an object" });
      }
      return reply.code(400).send({ error: "invalid_request", detail: "invalid request body" });
    }

    try {
      const result = await invokeAdminMcpToolWithControls({
        authCtx,
        toolContext: {
          cfg,
          delegatedHeaders: authCtx.delegatedHeaders,
          orgHeaders: authCtx.orgHeaders,
          userId: authCtx.user.user_id ?? authCtx.user.username ?? "unknown",
          role: authCtx.user.role ?? "",
          user: authCtx.user,
        },
        role: authCtx.user.role,
        toolName: parsed.name,
        args: parsed.args,
        requestId,
        surface: "admin_mcp_direct",
        limiter: directInvokeLimiter,
        auditLog: (level, fields, message) => req.log[level](fields, message),
      });
      _directToolInvocations++;
      return reply.code(200).send({ result });
    } catch (e) {
      const safe = toSafeToolError(e, parsed.name);
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof AdminMcpToolError && e.code === "rate_limit_exceeded") {
        return reply.code(429).send({
          error: "rate_limit_exceeded",
          message: "Too many concurrent admin MCP tool calls. Retry after an active call completes.",
        });
      }
      if (msg.startsWith("Unknown tool:")) {
        return reply.code(404).send({ error: "tool_not_found", tool: parsed.name });
      }
      if (msg.includes("requires")) {
        return reply.code(403).send({ error: "forbidden", tool: parsed.name });
      }
      if (e instanceof AdminMcpToolError && e.code === "invalid_arguments") {
        return reply.code(400).send(safe);
      }
      const statusCode = e instanceof AdminMcpToolError && e.statusCode ? e.statusCode : 500;
      return reply.code(statusCode).send(safe);
    }
    },
  );

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: cfg.SYNESIS_ADMIN_MCP_HTTP_PATH,
    config: { rateLimit: adminAuthRateLimit },
    preHandler: adminAuthPreHandler,
    // Rate limited by both @fastify/rate-limit route config and adminAuthPreHandler.
    // lgtm[js/missing-rate-limiting]
    // codeql[js/missing-rate-limiting]
    handler: async (req, reply) => {
      _mcpRequests++;
      let authCtx: AuthenticatedRequestContext;
      try {
        authCtx = await authenticateAdminRequest(cfg, req);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return sendAuthError(reply, msg, () => { _mcpAuthFailures++; }, () => {
          req.log.error({ err: msg }, "admin_mcp_auth_failed");
        });
      }

      if (req.method === "POST") {
        const preflight = validateMcpJsonRpcPostBody(req.body as unknown);
        if (!preflight.ok) {
          req.log.warn({ reason: preflight.reason }, "admin_mcp_jsonrpc_preflight_failed");
          return reply.code(400).send({ error: "invalid_mcp_request", message: "Invalid MCP JSON-RPC request" });
        }
      }

      reply.hijack();

      const server = buildAdminMcpServer(cfg, authCtx, {
        limiter: directInvokeLimiter,
        requestId: req.id,
        auditLog: (level, fields, message) => req.log[level](fields, message),
      });
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
