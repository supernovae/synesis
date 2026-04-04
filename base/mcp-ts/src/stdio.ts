/**
 * MCP over stdio — for local IDE subprocess launch. Uses internal service token only
 * (set SYNESIS_INTERNAL_SERVICE_TOKEN + SYNESIS_MCP_ALLOW_INTERNAL_ONLY=true or provide PAT via env).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSynesisMcpTools, type SynesisMcpDeps, type SynesisMcpAuth } from "@synesis/mcp-tools";
import { loadConfig } from "./config.js";
import { initOtel } from "./otel.js";

const config = loadConfig();
initOtel(config);

const deps: SynesisMcpDeps = {
  plannerBaseUrl: config.SYNESIS_PLANNER_URL,
  criticUrl: config.SYNESIS_CRITIC_URL,
  criticModel: config.SYNESIS_CRITIC_MODEL,
  internalServiceToken: config.SYNESIS_INTERNAL_SERVICE_TOKEN.trim() || undefined,
};

const patFromEnv = (process.env.SYNESIS_MCP_STDIO_PAT ?? "").trim();
const bearer = patFromEnv || (config.SYNESIS_INTERNAL_SERVICE_TOKEN.trim() || "");
if (!bearer) {
  console.error("stdio: set SYNESIS_MCP_STDIO_PAT or SYNESIS_INTERNAL_SERVICE_TOKEN");
  process.exit(1);
}

const auth: SynesisMcpAuth = {
  bearerToken: bearer,
  userId: process.env.SYNESIS_MCP_STDIO_USER_ID ?? "stdio-client",
  orgId: process.env.SYNESIS_MCP_STDIO_ORG_ID ?? "",
  tenantIds: [],
};

async function main() {
  const server = new McpServer(
    { name: "synesis-mcp", version: "0.2.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  registerSynesisMcpTools(server, auth, deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("stdio MCP failed:", err);
  process.exit(1);
});
