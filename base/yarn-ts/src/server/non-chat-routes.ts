import type { FastifyInstance } from "fastify";

import type { AuthResolver } from "../auth.js";
import type { AppConfig } from "../config.js";
import { registerEvalRoutes } from "../eval/routes.js";
import { enableObserver as enableEvalObserver } from "../eval/session-observer.js";
import { getToolRegistry, registerMcpRoutes } from "../mcp/index.js";
import type { DedupeLayer } from "../dedupe/DedupeLayer.js";
import type { ToolPrefixCache } from "../tool-prefix-cache/ToolPrefixCache.js";
import { registerToolCollapseRoutes } from "../tool-collapse/index.js";

export interface RegisterNonChatRoutesInput {
  app: FastifyInstance;
  config: AppConfig;
  authResolver: AuthResolver;
  dedupeLayer: DedupeLayer | null;
  toolPrefixCache: ToolPrefixCache | null;
  requireInternalToken: (request: { headers: Record<string, unknown> }) => boolean;
}

export async function registerNonChatRoutes(input: RegisterNonChatRoutesInput): Promise<void> {
  const {
    app,
    config,
    authResolver,
    dedupeLayer,
    toolPrefixCache,
    requireInternalToken,
  } = input;

  getToolRegistry().setTimeoutMs(config.SYNESIS_YARN_MCP_TOOL_TIMEOUT_MS);
  await registerMcpRoutes(app, {
    authResolver,
    enabled: config.SYNESIS_YARN_MCP_TOOLS_ENABLED,
    openClawProfileEnabled: config.SYNESIS_YARN_OPENCLAW_PROFILE_ENABLED,
    openClawMcpAllowlistEnabled: config.SYNESIS_YARN_OPENCLAW_MCP_ALLOWLIST_ENABLED,
    openClawStrictGovernanceEnabled: config.SYNESIS_YARN_OPENCLAW_STRICT_GOVERNANCE_ENABLED,
    toolMaxConcurrentPerCaller: config.SYNESIS_YARN_MCP_TOOL_MAX_CONCURRENT_PER_CALLER,
    toolMaxConcurrentGlobal: config.SYNESIS_YARN_MCP_TOOL_MAX_CONCURRENT_GLOBAL,
    synesisMcpDeps: {
      plannerBaseUrl: config.SYNESIS_YARN_PLANNER_URL,
      internalServiceToken: config.SYNESIS_INTERNAL_SERVICE_TOKEN,
    },
  });
  await registerToolCollapseRoutes(app, {
    authResolver,
    config,
    dedupeLayer,
    toolPrefixCache,
  });

  registerEvalRoutes(app, config, { requireInternalToken });
  if (config.SYNESIS_YARN_EVAL_OBSERVER_ENABLED) {
    enableEvalObserver();
    console.log("[eval-observer] Session observer enabled via env");
  }
}
