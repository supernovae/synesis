/**
 * Synesis MCP — Streamable HTTP transport (official MCP protocol).
 */
import Fastify, { type FastifyRequest } from "fastify";
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

function createDeps(): SynesisMcpDeps {
  return {
    plannerBaseUrl: config.SYNESIS_PLANNER_URL,
    criticUrl: config.SYNESIS_CRITIC_URL,
    criticModel: config.SYNESIS_CRITIC_MODEL,
    internalServiceToken: config.SYNESIS_INTERNAL_SERVICE_TOKEN.trim() || undefined,
  };
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
  if (patUser.userId === "mcp-internal") return;
  if (!getFgaClient()) return;
  const r = await fgaCheckMcpTools(patUser.userId);
  if (!r.allowed) {
    mcpPolicyDenials++;
    throw new Error("policy_denied");
  }
}

const app = Fastify({ logger: { level: config.LOG_LEVEL } });
void app.register(fastifyRateLimit, { global: false });
const authRouteRateLimit = (max: number) => ({
  config: { rateLimit: { max, timeWindow: "1 minute" as const } },
});

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
  ...authRouteRateLimit(240),
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
        const server = new McpServer(
          { name: "synesis-mcp", version: "0.2.0" },
          { capabilities: { tools: { listChanged: true } } },
        );
        registerSynesisMcpTools(server, mcpAuth, createDeps());
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        const parsedBody = req.method === "POST" ? (req.body as unknown) : undefined;
        await transport.handleRequest(req.raw, reply.raw, parsedBody);
        await transport.close();
        await server.close();
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

app.get("/health/readiness", async () => ({
  status: "ready",
}));

app.get("/health/telemetry", async () => ({
  service: "synesis-mcp-ts",
  mcp_http_requests: mcpHttpRequests,
  mcp_auth_failures: mcpAuthFailures,
  mcp_policy_denials: mcpPolicyDenials,
  openfga_configured: Boolean(getFgaClient()),
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
