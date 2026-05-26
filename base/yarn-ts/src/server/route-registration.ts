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
export type RouteDependencyGroups = Record<string, Record<string, any>>;

function flattenRouteDependencyGroups(groups: RouteDependencyGroups): RouteDependencySource {
  return Object.assign({}, ...Object.values(groups)) as RouteDependencySource;
}

export function registerConfiguredRoutes(input: RouteDependencySource | RouteDependencyGroups): void {
  const source = "app" in input
    ? input as RouteDependencySource
    : flattenRouteDependencyGroups(input as RouteDependencyGroups);
  registerPlatformRoutes(buildPlatformRouteDependencies(source));
  registerOpenAIChatCompletionsRoute(buildOpenAIChatCompletionsRouteDependencies(source));
  registerClaudeMessagesRoute(buildClaudeMessagesRouteDependencies(source));
}
