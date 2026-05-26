import { describe, expect, it } from "vitest";

import type { ClientToolCapabilities } from "../src/adapters/client-tool-capabilities.js";
import { detectNonGitWorkspaceDiagnostic } from "../src/governance/non-git-workspace-diagnostic.js";
import { extractRecentToolCallDetails, prepareRouteTools } from "../src/pipeline/route-tool-preparation.js";
import { resolveAdapter } from "../src/providers/model-adapter.js";

const clientCapabilities: ClientToolCapabilities = {
  clientKind: "opencode",
  toolNames: [],
  isOpenCode: true,
  isClaudeCode: false,
  planModeRequested: false,
  hasTodoTool: false,
  todoToolName: null,
  taskToolNames: [],
  hasQuestionTool: false,
  questionToolName: null,
  hasApplyPatchTool: false,
  applyPatchToolName: null,
  hasAgentTool: false,
  hasMonitorTool: false,
  hasPlanModeTool: false,
  enterPlanModeToolName: null,
  exitPlanModeToolName: null,
  hasLspTool: false,
  hasSkillTool: false,
  hasWebFetchTool: false,
  hasWebSearchTool: false,
};

describe("non-git workspace diagnostic", () => {
  it("detects pytest plugin failures caused by git repository assumptions", () => {
    const result = detectNonGitWorkspaceDiagnostic([
      {
        toolName: "bash",
        args: { command: "python -m pytest tests/test_tasks.py -v" },
        resultContent: [
          "git.exc.InvalidGitRepositoryError: /home/byron/src/test/taskpulse",
          "../../../.pyenv/versions/3.11.11/lib/python3.11/site-packages/git/repo/base.py:289",
        ].join("\n"),
      },
    ]);

    expect(result).not.toBeNull();
    expect(result?.source).toBe("pytest_plugin");
    expect(result?.guidance).toContain("Do NOT run `git init`");
    expect(result?.guidance).toContain("pytest/plugin/GitPython");
  });

  it("treats git command failures as metadata, not a forced repo workflow", () => {
    const result = detectNonGitWorkspaceDiagnostic([
      {
        toolName: "bash",
        args: { command: "git status" },
        resultContent: "fatal: not a git repository (or any of the parent directories): .git",
      },
    ]);

    expect(result).not.toBeNull();
    expect(result?.source).toBe("git_command");
    expect(result?.guidance).toContain("fresh local experiments");
  });

  it("extracts recent tool result content for route diagnostics", () => {
    const calls = extractRecentToolCallDetails([
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: {
            name: "bash",
            arguments: JSON.stringify({ command: "python -m pytest tests/test_tasks.py -v" }),
          },
        }],
      } as unknown as { role: string; content: unknown },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "git.exc.InvalidGitRepositoryError: /workspace/taskpulse",
      } as unknown as { role: string; content: unknown },
    ]);

    expect(calls[0]?.resultContent).toContain("InvalidGitRepositoryError");
  });

  it("injects non-git guidance into route recovery messages", () => {
    const recoveryMessages: Array<{ role: string; content: unknown }> = [];
    prepareRouteTools({
      rawTools: [],
      adapter: resolveAdapter("generic"),
      clientCapabilities,
      clientKind: "opencode",
      phase: "implementation",
      pruningEnabled: false,
      pruningMaxOverride: 0,
      toolChoice: undefined,
      recentCallMessages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "python -m pytest tests/test_tasks.py -v" }),
            },
          }],
        } as unknown as { role: string; content: unknown },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "git.exc.InvalidGitRepositoryError: /workspace/taskpulse",
        } as unknown as { role: string; content: unknown },
      ],
      recoveryMessages,
      governanceDisabled: false,
      toolLoopSteeringEnabled: false,
      harnessTelemetryEnabled: false,
      requestId: "req-test",
      stats: { requestsConsidered: 0, requestsPruned: 0, toolsPrunedTotal: 0 },
      logger: { info: () => undefined },
      isWriteCapableToolName: () => false,
      recordSessionEvent: () => undefined,
    });

    expect(String(recoveryMessages.at(-1)?.content ?? "")).toContain("SYNESIS_NON_GIT_WORKSPACE_HINT");
  });
});
