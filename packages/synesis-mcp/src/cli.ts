#!/usr/bin/env node
/**
 * Synesis MCP — lightweight stdio server for IDE integration.
 *
 * Required env vars:
 *   SYNESIS_URL — base URL of the Synesis planner backend (e.g. https://synesis.company.com)
 *   SYNESIS_PAT — personal access token with mcp:invoke scope
 *
 * Optional:
 *   SYNESIS_TOOLS — "all" to register niche/advanced tools in addition to the core set
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSynesisMcpTools, type SynesisMcpAuth, type SynesisMcpDeps } from "@synesis/mcp-tools";

function env(key: string): string {
  return (process.env[key] ?? "").trim();
}

function fatal(message: string): never {
  process.stderr.write(`synesis-mcp: ${message}\n`);
  process.exit(1);
}

const synesisUrl = env("SYNESIS_URL");
if (!synesisUrl) {
  fatal("SYNESIS_URL is required (e.g. https://synesis.company.com)");
}

const synesisPat = env("SYNESIS_PAT");
if (!synesisPat) {
  fatal("SYNESIS_PAT is required — create one in the Synesis admin UI with the mcp:invoke scope");
}

let plannerBaseUrl: string;
try {
  const parsed = new URL(synesisUrl);
  plannerBaseUrl = parsed.origin;
} catch {
  fatal(`SYNESIS_URL is not a valid URL: ${synesisUrl}`);
}

const allTools = env("SYNESIS_TOOLS").toLowerCase() === "all";

const auth: SynesisMcpAuth = {
  bearerToken: synesisPat,
  userId: "mcp-cli",
  orgId: "",
  tenantIds: [],
};

const deps: SynesisMcpDeps = {
  plannerBaseUrl,
  allowClientTokenFallback: true,
};

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "synesis-mcp", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  registerSynesisMcpTools(server, auth, deps, { allTools });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fatal(`startup failed: ${message}`);
});
