/**
 * Synesis MCP — Streamable HTTP transport (official MCP protocol).
 */
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getSynesisPlatformCatalog, registerSynesisMcpTools, type SynesisMcpDeps } from "@synesis/mcp-tools";
import { loadConfig } from "./config.js";
import { McpAuthResolver, type PatUser } from "./auth.js";
import { initFgaClient, fgaCheckMcpTools, getFgaClient } from "./fga.js";
import { initOtel, withSpan } from "./otel.js";

const config = loadConfig();
initOtel(config);
initFgaClient(config);

const authResolver = new McpAuthResolver(config);

let mcpHttpRequests = 0;
let mcpAuthFailures = 0;
let mcpPolicyDenials = 0;

type RateLimitOptions = { max: number; timeWindow: string | number };

function timeWindowMs(timeWindow: string | number): number {
  if (typeof timeWindow === "number" && Number.isFinite(timeWindow) && timeWindow > 0) return timeWindow;
  const match = String(timeWindow).trim().match(/^(\d+)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)$/i);
  if (!match) return 60000;
  const amount = Number(match[1]);
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

function createDeps(): SynesisMcpDeps {
  const deps: SynesisMcpDeps = {
    plannerBaseUrl: config.SYNESIS_PLANNER_URL,
  };
  const internalServiceToken = config.SYNESIS_INTERNAL_SERVICE_TOKEN.trim();
  if (internalServiceToken) deps.internalServiceToken = internalServiceToken;
  return deps;
}

async function checkPlannerReady(): Promise<boolean> {
  try {
    const base = config.SYNESIS_PLANNER_URL.replace(/\/$/, "");
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function resolvePatAndAuth(
  req: FastifyRequest,
): Promise<{ patUser: PatUser; bearer: string; mcpAuth: import("@synesis/mcp-tools").SynesisMcpAuth }> {
  const bearer = authResolver.extractBearer(req.headers.authorization);
  const internal = config.SYNESIS_INTERNAL_SERVICE_TOKEN.trim();

  if (internal && bearer === internal) {
    if (!config.SYNESIS_MCP_ALLOW_INTERNAL_ONLY) {
      throw new Error("internal_token_not_allowed");
    }
    const patUser: PatUser = {
      userId: "mcp-internal",
      orgId: "",
      tenantIds: [],
      role: "service",
      tokenScopes: ["coder"],
    };
    return {
      patUser,
      bearer,
      mcpAuth: authResolver.toSynesisMcpAuth(patUser, bearer),
    };
  }

  if (!bearer.startsWith("syn-")) {
    throw new Error("pat_required");
  }

  if (!config.SYNESIS_ADMIN_DB_URL?.trim()) {
    throw new Error("admin_db_not_configured");
  }

  const user = await authResolver.resolvePat(bearer);
  if (!user) {
    throw new Error("invalid_pat");
  }

  authResolver.requireCoderScope(user);

  return {
    patUser: user,
    bearer,
    mcpAuth: authResolver.toSynesisMcpAuth(user, bearer),
  };
}

async function enforceFga(patUser: PatUser): Promise<void> {
  if (config.SYNESIS_MCP_AUTHZ_MODE === "disabled") return;
  if (patUser.userId === "mcp-internal") return;
  if (!getFgaClient()) {
    if (config.SYNESIS_MCP_AUTHZ_MODE === "audit") {
      app.log.warn({ userId: patUser.userId }, "MCP OpenFGA audit: OpenFGA is not configured");
      return;
    }
    mcpPolicyDenials++;
    throw new Error("policy_denied");
  }
  const r = await fgaCheckMcpTools(patUser.userId);
  if (!r.allowed) {
    if (config.SYNESIS_MCP_AUTHZ_MODE === "audit") {
      app.log.warn({ userId: patUser.userId, resolution: r.resolution }, "MCP OpenFGA audit: authorization would be denied");
      return;
    }
    mcpPolicyDenials++;
    throw new Error("policy_denied");
  }
}

const app = Fastify({ logger: { level: config.LOG_LEVEL } });
void app.register(fastifyRateLimit, {
  global: true,
  max: config.SYNESIS_MCP_GLOBAL_RATE_LIMIT_MAX,
  timeWindow: config.SYNESIS_MCP_GLOBAL_RATE_LIMIT_WINDOW,
});
// Cloudflare edge policies are the first line of defense, but we also enforce
// app-layer limits so direct origin traffic and internal callers are bounded.
const mcpAuthRateLimit = { max: 240, timeWindow: "1 minute" as const };
const mcpAuthPreHandler = createRouteRateLimit(mcpAuthRateLimit);

/** Public catalog for UIs (Integrations page) — no secrets; same tool surface as Streamable MCP. */
app.get("/v1/synesis-tools", async () => ({
  service: "synesis-mcp-ts",
  protocol: "mcp-streamable-http",
  mcp_path: config.SYNESIS_MCP_HTTP_PATH,
  tools: getSynesisPlatformCatalog(),
}));

app.route({
  method: ["GET", "POST", "DELETE"],
  url: config.SYNESIS_MCP_HTTP_PATH,
  config: { rateLimit: mcpAuthRateLimit },
  preHandler: mcpAuthPreHandler,
  // codeql[js/missing-rate-limiting]
  handler: async (req, reply) => {
    mcpHttpRequests++;
    let patUser: PatUser;
    let mcpAuth: import("@synesis/mcp-tools").SynesisMcpAuth;
    try {
      const resolved = await resolvePatAndAuth(req);
      patUser = resolved.patUser;
      mcpAuth = resolved.mcpAuth;
      await enforceFga(patUser);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg === "policy_denied" ||
        msg === "internal_token_not_allowed" ||
        msg === "pat_required" ||
        msg === "invalid_pat" ||
        msg === "admin_db_not_configured"
      ) {
        mcpAuthFailures++;
      }
      if (msg === "policy_denied") {
        return reply.code(403).send({
          error: "forbidden",
          message: "Authorization denied by policy",
        });
      }
      if (msg === "internal_token_not_allowed") {
        return reply.code(403).send({
          error: "forbidden",
          message: "Internal token not accepted for this endpoint",
        });
      }
      if (msg === "pat_required") {
        return reply.code(401).send({
          error: "unauthorized",
          message: "Synesis PAT required (Bearer syn-...)",
        });
      }
      if (msg === "admin_db_not_configured") {
        return reply.code(503).send({
          error: "service_unavailable",
          message: "PAT validation not configured (SYNESIS_ADMIN_DB_URL)",
        });
      }
      if (msg.includes("scope") || msg.includes("Insufficient")) {
        return reply.code(403).send({ error: "forbidden", message: msg });
      }
      if (msg.includes("Missing Bearer")) {
        return reply.code(401).send({ error: "unauthorized", message: msg });
      }
      return reply.code(401).send({ error: "unauthorized", message: "Invalid or missing credentials" });
    }

    reply.hijack();

    await withSpan(
      "mcp.streamable_http",
      async (span) => {
        span.setAttribute("synesis.user_id", patUser.userId);
        span.setAttribute("synesis.org_id", patUser.orgId);
        let server: McpServer | undefined;
        let transport: StreamableHTTPServerTransport | undefined;
        try {
          server = new McpServer(
            { name: "synesis-mcp", version: "0.2.0" },
            { capabilities: { tools: { listChanged: true } } },
          );
          registerSynesisMcpTools(server, mcpAuth, createDeps());
          transport = new StreamableHTTPServerTransport({});
          await server.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
          const parsedBody = req.method === "POST" ? (req.body as unknown) : undefined;
          await transport.handleRequest(req.raw, reply.raw, parsedBody);
        } catch (error) {
          req.log.error(
            {
              error: error instanceof Error ? error.message : String(error),
              userId: patUser.userId,
            },
            "MCP Streamable HTTP request failed",
          );
          if (!reply.raw.headersSent) {
            reply.raw.statusCode = 500;
            reply.raw.end(JSON.stringify({ error: "mcp_request_failed", message: "MCP request failed" }));
          }
        } finally {
          await transport?.close().catch((error: unknown) => {
            req.log.warn({ error: error instanceof Error ? error.message : String(error) }, "MCP transport close failed");
          });
          await server?.close().catch((error: unknown) => {
            req.log.warn({ error: error instanceof Error ? error.message : String(error) }, "MCP server close failed");
          });
        }
      },
      { "http.method": req.method ?? "GET" },
    );
  },
});

app.get("/health", async () => ({
  status: "ok",
  service: "synesis-mcp-ts",
  protocol: "mcp-streamable-http",
  path: config.SYNESIS_MCP_HTTP_PATH,
}));

app.get("/health/readiness", async (request, reply) => {
  const adminDbRequired = !config.SYNESIS_MCP_ALLOW_INTERNAL_ONLY;
  const checks: Record<string, boolean> = {
    planner_url_configured: Boolean(config.SYNESIS_PLANNER_URL.trim()),
    planner_reachable: await checkPlannerReady(),
    admin_db_required: adminDbRequired ? Boolean(config.SYNESIS_ADMIN_DB_URL?.trim()) : true,
    openfga_configured: config.SYNESIS_MCP_AUTHZ_MODE === "enforce" ? Boolean(getFgaClient()) : true,
  };
  if (adminDbRequired && config.SYNESIS_ADMIN_DB_URL?.trim()) {
    checks.admin_db_reachable = await authResolver.ping();
  }
  if (config.SYNESIS_MCP_AUTHZ_MODE === "enforce") {
    checks.openfga_required = Boolean(checks.openfga_configured);
  }
  const ready = Object.values(checks).every(Boolean);
  if (!ready) return reply.code(503).send({ status: "not_ready", checks });
  return { status: "ready", checks };
});

app.get("/health/telemetry", async () => ({
  service: "synesis-mcp-ts",
  mcp_http_requests: mcpHttpRequests,
  mcp_auth_failures: mcpAuthFailures,
  mcp_policy_denials: mcpPolicyDenials,
  openfga_configured: Boolean(getFgaClient()),
  authz_mode: config.SYNESIS_MCP_AUTHZ_MODE,
  otel: { configured: Boolean(config.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) },
}));

async function main() {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(
    { host: config.HOST, port: config.PORT, path: config.SYNESIS_MCP_HTTP_PATH },
    "synesis-mcp-ts MCP Streamable HTTP listening",
  );
}

main().catch((err) => {
  console.error("MCP-TS startup failed:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await authResolver.close();
  await app.close();
  process.exit(0);
});
