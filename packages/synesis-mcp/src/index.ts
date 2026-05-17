/**
 * Programmatic API for @synesis/mcp.
 *
 * SDK consumers can import this to create a Synesis MCP server instance
 * without going through the CLI entry point.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerSynesisMcpTools,
  type SynesisMcpAuth,
  type SynesisMcpDeps,
} from "@synesis/mcp-tools";

export type { SynesisMcpAuth, SynesisMcpDeps } from "@synesis/mcp-tools";

export interface CreateSynesisMcpServerOptions {
  /** Base URL of the Synesis planner backend. */
  url: string;
  /** Personal access token with mcp:invoke scope. */
  pat: string;
  /** Register all tools including niche/advanced (default: false). */
  allTools?: boolean;
}

/**
 * Create a configured MCP server ready to be connected to a transport.
 *
 * @example
 * ```ts
 * import { createSynesisMcpServer } from "@synesis/mcp";
 * import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 *
 * const server = createSynesisMcpServer({
 *   url: "https://synesis.company.com",
 *   pat: process.env.SYNESIS_PAT!,
 * });
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function createSynesisMcpServer(options: CreateSynesisMcpServerOptions): McpServer {
  const { url, pat, allTools = false } = options;
  if (!url) throw new Error("url is required");
  if (!pat) throw new Error("pat is required");

  let plannerBaseUrl: string;
  try {
    plannerBaseUrl = new URL(url).origin;
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const auth: SynesisMcpAuth = {
    bearerToken: pat,
    userId: "mcp-sdk",
    orgId: "",
    tenantIds: [],
  };

  const deps: SynesisMcpDeps = { plannerBaseUrl };

  const server = new McpServer(
    { name: "synesis-mcp", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  registerSynesisMcpTools(server, auth, deps, { allTools });

  return server;
}
