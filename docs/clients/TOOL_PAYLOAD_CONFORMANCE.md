# Tool Payload Conformance

This pass adds fixture-backed conformance checks for major client profiles and verifies deterministic mapping into Yarn's canonical tool pipeline.

## Fixture profiles

- `claude-code` (`tests/fixtures/client_profiles/claude-code/tool_use_payload.json`)
  - Anthropic Messages payload with `tool_use` / `tool_result` blocks.
  - Validates `ClaudeMessagesRequestSchema` parse and conversion to OpenAI-compatible assistant/tool messages.
- `cursor` (`tests/fixtures/client_profiles/cursor/openai_function_tools_payload.json`)
  - OpenAI Chat Completions payload with function tools and `tool_calls`.
  - Validates schema parse and OpenAI->SDK tool/message mapping.
- `codex-cli` (`tests/fixtures/client_profiles/codex-cli/openai_malformed_tool_payload.json`)
  - OpenAI Chat Completions payload with malformed tool-call IDs.
  - Validates deterministic repair via `sanitizeToolCalls` and tool-choice mapping.

## Test suite

- `tests/client-payload-conformance.test.ts`
  - Enforces profile-mode expectations from `ClientAdapterPacks`.
  - Enforces per-profile payload parsing and tool-call conversion semantics.
  - Enforces malformed payload repair behavior for CLI-style inputs.

These fixtures are intended to remain stable contract tests and should be extended whenever client payload behavior changes.

