/**
 * MCP over stdio — local IDE subprocess launch only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSynesisMcpTools, type SynesisMcpDeps, type SynesisMcpAuth } from "@synesis/mcp-tools";
import { McpAuthResolver } from "./auth.js";
import { loadConfig } from "./config.js";
import { fgaCheckMcpTools, getFgaClient, initFgaClient } from "./fga.js";
import { initOtel } from "./otel.js";

const config = loadConfig();
initOtel(config);
initFgaClient(config);
const authResolver = new McpAuthResolver(config);

const deps: SynesisMcpDeps = {
  plannerBaseUrl: config.SYNESIS_PLANNER_URL,
};
const internalServiceToken = config.SYNESIS_INTERNAL_SERVICE_TOKEN.trim();
if (internalServiceToken) deps.internalServiceToken = internalServiceToken;

const patFromEnv = (process.env.SYNESIS_MCP_STDIO_PAT ?? "").trim();
if (!patFromEnv) {
  console.error("stdio: set SYNESIS_MCP_STDIO_PAT");
  process.exit(1);
}

async function resolveStdioAuth(): Promise<SynesisMcpAuth> {
  if (config.SYNESIS_ADMIN_DB_URL?.trim()) {
    const user = await authResolver.resolvePat(patFromEnv);
    if (!user) throw new Error("invalid_stdio_pat");
    authResolver.requireCoderScope(user);
    if (config.SYNESIS_MCP_AUTHZ_MODE === "enforce" && !getFgaClient()) {
      throw new Error("stdio_policy_not_configured");
    }
    if (config.SYNESIS_MCP_AUTHZ_MODE !== "disabled" && getFgaClient()) {
      const result = await fgaCheckMcpTools(user.userId);
      if (!result.allowed && config.SYNESIS_MCP_AUTHZ_MODE === "enforce") {
        throw new Error("stdio_policy_denied");
      }
    }
    return authResolver.toSynesisMcpAuth(user, patFromEnv);
  }
  return {
    bearerToken: patFromEnv,
    userId: process.env.SYNESIS_MCP_STDIO_USER_ID ?? "stdio-client",
    orgId: process.env.SYNESIS_MCP_STDIO_ORG_ID ?? "",
    tenantIds: [],
  };
}

async function main() {
  const auth = await resolveStdioAuth();
  const server = new McpServer(
    { name: "synesis-mcp", version: "0.2.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  registerSynesisMcpTools(server, auth, deps, { allTools: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("stdio MCP failed:", err);
  void authResolver.close();
  process.exit(1);
});
