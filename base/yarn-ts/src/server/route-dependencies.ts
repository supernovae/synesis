/*
 * Shared route dependency type aliases.
 *
 * These are type-only aliases to the current bootstrap-assembled dependency
 * objects. Route and pipeline modules import this module instead of importing
 * index.ts directly, which removes the direct source dependency while
 * preserving the exact inferred contracts during the migration.
 */

export type OpenAIChatCompletionsRouteDependencies =
  typeof import("../index.js").openAIChatCompletionsRouteDependencies;

export type ClaudeMessagesRouteDependencies =
  typeof import("../index.js").claudeMessagesRouteDependencies;
