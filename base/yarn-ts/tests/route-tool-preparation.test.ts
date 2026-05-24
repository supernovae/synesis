import { describe, expect, it, vi } from "vitest";

import {
  extractRecentToolNames,
  prepareRouteTools,
} from "../src/pipeline/route-tool-preparation.js";
import type { ClientToolCapabilities } from "../src/adapters/client-tool-capabilities.js";
import type { ModelAdapter } from "../src/providers/model-adapter.js";

const clientCapabilities: ClientToolCapabilities = {
  clientKind: "claude-code",
  toolNames: [],
  isOpenCode: false,
  isClaudeCode: true,
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

const adapter: ModelAdapter = {
  family: "qwen3-coder",
  supportsThinking: false,
  maxEffectiveTools: 2,
  enrichToolDescription: (_name, description) => `${description} [adapter]`,
};

function tool(name: string): unknown {
  return {
    type: "function",
    function: {
      name,
      description: `${name} tool`,
    },
  };
}

function assistantToolCall(name: string, args: Record<string, unknown> = {}): { role: string; content: unknown } {
  return {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      },
    ],
  } as never;
}

describe("route tool preparation", () => {
  it("extracts recent tool names from OpenAI-shaped assistant turns", () => {
    expect(extractRecentToolNames([
      assistantToolCall("Read"),
      { role: "user", content: "next" },
      assistantToolCall("Write"),
    ])).toEqual(["Read", "Write"]);
  });

  it("applies shared pruning, qwen write prioritization, and schema enrichment", () => {
    const stats = { requestsConsidered: 0, requestsPruned: 0, toolsPrunedTotal: 0 };
    const result = prepareRouteTools({
      rawTools: [tool("Read"), tool("Write"), tool("Extra")],
      adapter,
      clientCapabilities,
      clientKind: "claude-code",
      phase: "implementation",
      profileToolBudgetCap: 2,
      pruningEnabled: true,
      pruningMaxOverride: 0,
      toolChoice: "auto",
      latestUserContent: "please use Write if needed",
      recentCallMessages: [
        assistantToolCall("Read"),
        assistantToolCall("Grep"),
        assistantToolCall("Glob"),
        assistantToolCall("Read"),
      ],
      recoveryMessages: [],
      governanceDisabled: false,
      toolLoopSteeringEnabled: true,
      harnessTelemetryEnabled: false,
      requestId: "req_1",
      stats,
      logger: { info: vi.fn() },
      isWriteCapableToolName: (name) => name.toLowerCase() === "write",
      recordSessionEvent: vi.fn(),
    });

    expect(result.qwenLoopRisk).toBe(true);
    expect(result.prunedTools.pruned).toBe(true);
    expect(stats).toEqual({ requestsConsidered: 1, requestsPruned: 1, toolsPrunedTotal: 1 });
    expect((result.effectiveTools[0] as { function: { name: string } }).function.name).toBe("Write");
    expect((result.effectiveTools[0] as { function: { description: string } }).function.description).toContain("[adapter]");
    expect(result.clientToolChoice).toBe("auto");
    expect(result.invalidToolChoice).toBe(false);
  });

  it("reports invalid tool_choice without route-specific reply handling", () => {
    const result = prepareRouteTools({
      rawTools: [tool("Read")],
      adapter,
      clientCapabilities,
      clientKind: "opencode",
      phase: "planning",
      pruningEnabled: false,
      pruningMaxOverride: 0,
      toolChoice: { type: "function", name: "Read" },
      recentCallMessages: [],
      recoveryMessages: [],
      governanceDisabled: true,
      toolLoopSteeringEnabled: false,
      harnessTelemetryEnabled: false,
      requestId: "req_2",
      stats: { requestsConsidered: 0, requestsPruned: 0, toolsPrunedTotal: 0 },
      logger: { info: vi.fn() },
      isWriteCapableToolName: vi.fn(),
      recordSessionEvent: vi.fn(),
    });

    expect(result.clientToolChoice).toBeUndefined();
    expect(result.invalidToolChoice).toBe(true);
  });

  it("injects stdout-capture recovery guidance through shared route hooks", () => {
    const recordSessionEvent = vi.fn();
    const recoveryMessages: Array<{ role: string; content: unknown }> = [];
    const logger = { info: vi.fn() };

    prepareRouteTools({
      rawTools: [tool("Bash")],
      adapter,
      clientCapabilities,
      clientKind: "claude-code",
      phase: "validation",
      pruningEnabled: false,
      pruningMaxOverride: 0,
      toolChoice: undefined,
      recentCallMessages: [
        assistantToolCall("Bash", { command: "npm test" }),
        assistantToolCall("Bash", { command: "npm test 2>&1 | cat" }),
      ],
      recoveryMessages,
      governanceDisabled: false,
      toolLoopSteeringEnabled: false,
      harnessTelemetryEnabled: true,
      requestId: "req_3",
      stats: { requestsConsidered: 0, requestsPruned: 0, toolsPrunedTotal: 0 },
      logger,
      isWriteCapableToolName: vi.fn(),
      recordSessionEvent,
    });

    const stdoutRecovery = recoveryMessages.find((message) =>
      String(message.content).includes("SYNESIS_OUTPUT_CAPTURE_HINT")
    );
    expect(stdoutRecovery).toBeTruthy();
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "stdout_capture_loop_detected",
      "governor",
      expect.stringContaining("base_cmd=npm test"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reqId: "req_3", retryCount: 2 }),
      "yarn_harness_stdout_capture_loop",
    );
  });
});
