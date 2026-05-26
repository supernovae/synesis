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

export function registerConfiguredRoutes(source: RouteDependencySource): void {
  registerPlatformRoutes(buildPlatformRouteDependencies(source));
  registerOpenAIChatCompletionsRoute(buildOpenAIChatCompletionsRouteDependencies(source));
  registerClaudeMessagesRoute(buildClaudeMessagesRouteDependencies(source));
}
