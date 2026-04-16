import { describe, expect, it } from "vitest";
import { deriveGovernorLoopObservability } from "../src/governance/governor-observability.js";

describe("deriveGovernorLoopObservability", () => {
  it("detects no tool calls after latest user", () => {
    const out = deriveGovernorLoopObservability([
      { role: "user" },
      { role: "assistant" },
      { role: "assistant" },
    ]);
    expect(out.hasRunTest).toBe(false);
    expect(out.lastAssistantToolCalls).toBe(0);
    expect(out.assistantToolCallsSinceLatestUser).toBe(0);
  });

  it("counts assistant tool calls and detects test commands", () => {
    const out = deriveGovernorLoopObservability([
      { role: "user" },
      {
        role: "assistant",
        tool_calls: [
          { id: "1", function: { name: "bash", arguments: "{\"command\":\"go test ./cmd/synesis -run TestRunCompletion -v\"}" } },
        ],
      },
      {
        role: "assistant",
        tool_calls: [
          { id: "2", function: { name: "read_file", arguments: "{\"path\":\"cmd/synesis/completion_test.go\"}" } },
        ],
      },
    ]);
    expect(out.hasRunTest).toBe(true);
    expect(out.lastAssistantToolCalls).toBe(1);
    expect(out.assistantToolCallsSinceLatestUser).toBe(2);
  });

  it("only considers messages after most recent user turn", () => {
    const out = deriveGovernorLoopObservability([
      {
        role: "assistant",
        tool_calls: [
          { id: "0", function: { name: "bash", arguments: "{\"command\":\"go test ./...\"}" } },
        ],
      },
      { role: "user" },
      { role: "assistant" },
    ]);
    expect(out.hasRunTest).toBe(false);
    expect(out.assistantToolCallsSinceLatestUser).toBe(0);
  });

  // --- isTestToolCall coverage matrix ---

  it.each([
    ["go test with -run flag and pipes", "go test ./cmd/synesis -run TestRunCompletion -v 2>&1 | head -50"],
    ["vitest run", "npx vitest run tests/execution-governor.test.ts"],
    ["vitest bare", "vitest run --reporter=verbose"],
    ["uv run pytest", "uv run pytest tests/ -v"],
    ["uv run pytest scoped", "uv run pytest tests/test_indexer.py::test_chunk -v"],
    ["uv run ruff", "uv run ruff check ."],
    ["npm test", "npm test"],
    ["pytest bare", "pytest tests/test_completion.py -v"],
    ["cargo test", "cargo test --lib -- completion::tests"],
  ])("detects %s as a test run (hasRunTest=true)", (_label, command) => {
    const out = deriveGovernorLoopObservability([
      { role: "user" },
      {
        role: "assistant",
        tool_calls: [
          { id: "1", function: { name: "bash", arguments: JSON.stringify({ command }) } },
        ],
      },
    ]);
    expect(out.hasRunTest).toBe(true);
  });

  it.each([
    ["CLI binary ./synesis completion", "go build -o /tmp/synesis ./cmd/synesis && /tmp/synesis completion --shell bash"],
    ["CLI binary with args", "./synesis completion --shell fish"],
    ["CLI binary bare", "./synesis --help"],
  ])("detects %s as a test run via CLI invocation (hasRunTest=true)", (_label, command) => {
    const out = deriveGovernorLoopObservability([
      { role: "user" },
      {
        role: "assistant",
        tool_calls: [
          { id: "1", function: { name: "bash", arguments: JSON.stringify({ command }) } },
        ],
      },
    ]);
    expect(out.hasRunTest).toBe(true);
  });

  it.each([
    ["mkdir", "mkdir -p /tmp/build"],
    ["ls", "ls -la"],
    ["cat", "cat README.md"],
    ["echo", "echo hello"],
    ["cd", "cd /tmp && ls"],
  ])("does NOT count %s as a test run (hasRunTest=false)", (_label, command) => {
    const out = deriveGovernorLoopObservability([
      { role: "user" },
      {
        role: "assistant",
        tool_calls: [
          { id: "1", function: { name: "bash", arguments: JSON.stringify({ command }) } },
        ],
      },
    ]);
    expect(out.hasRunTest).toBe(false);
  });
});
