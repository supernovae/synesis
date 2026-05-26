import { registerClaudeMessagesRoute } from "../routes/claude-messages-route.js";
import { registerOpenAIChatCompletionsRoute } from "../routes/openai-chat-completions-route.js";
import { registerPlatformRoutes } from "../routes/platform-routes.js";
import {
  buildClaudeMessagesRouteDependencies,
  buildOpenAIChatCompletionsRouteDependencies,
  buildPlatformRouteDependencies,
  type ClaudeMessagesRouteDependencySource,
  type OpenAIChatCompletionsRouteDependencies,
} from "./route-dependencies.js";

export type RouteDependencySource =
  OpenAIChatCompletionsRouteDependencies
  & ClaudeMessagesRouteDependencySource;

// Transitional grouping: index.ts still constructs services, but the route
// boundary now receives domain-shaped dependency facades instead of one
// undifferentiated object. Builders remain flat-compatible while route modules
// continue migrating toward typed protocol-specific inputs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteDependencyGroup = Record<string, any>;

export interface RouteDependencyGroups {
  runtime: RouteDependencyGroup;
  auth: RouteDependencyGroup;
  protocol: RouteDependencyGroup;
  session: RouteDependencyGroup;
  workspace: RouteDependencyGroup;
  reduction: RouteDependencyGroup;
  tools: RouteDependencyGroup;
  governance: RouteDependencyGroup;
  planning: RouteDependencyGroup;
  provider: RouteDependencyGroup;
  evidence: RouteDependencyGroup;
  telemetry: RouteDependencyGroup;
  adapter: RouteDependencyGroup;
}

function flattenRouteDependencyGroups(groups: RouteDependencyGroups): RouteDependencySource {
  return Object.assign(
    {},
    groups.runtime,
    groups.auth,
    groups.protocol,
    groups.session,
    groups.workspace,
    groups.reduction,
    groups.tools,
    groups.governance,
    groups.planning,
    groups.provider,
    groups.evidence,
    groups.telemetry,
    groups.adapter,
  ) as RouteDependencySource;
}

export function registerConfiguredRoutes(input: RouteDependencySource | RouteDependencyGroups): void {
  const source = "app" in input
    ? input as RouteDependencySource
    : flattenRouteDependencyGroups(input as RouteDependencyGroups);
  registerPlatformRoutes(buildPlatformRouteDependencies(source));
  registerOpenAIChatCompletionsRoute(buildOpenAIChatCompletionsRouteDependencies(source));
  registerClaudeMessagesRoute(buildClaudeMessagesRouteDependencies(source));
}
