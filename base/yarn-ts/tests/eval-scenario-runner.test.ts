import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EvalScenario, EvalRunnerConfig } from "../src/eval/types.js";

// Mock fetch globally for scenario runner tests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { runScenario, runScenarios } = await import("../src/eval/scenario-runner.js");

function makeOaiResponse(content: string, toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: `chatcmpl-${Date.now()}`,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls?.map(tc => ({ ...tc, type: "function" })),
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
  };
}

const baseConfig: EvalRunnerConfig = {
  targetUrl: "http://test-yarn:8000",
  apiKey: "test-token",
  timeoutMs: 5000,
  conversationIdPrefix: "test",
};

const simpleScenario: EvalScenario = {
  id: "test-simple",
  name: "Simple test",
  category: "governor_regression",
  description: "A simple test scenario",
  target: { model: "test-model" },
  turns: [{
    messages: [{ role: "user", content: "Hello" }],
    assertions: [{ type: "governor_not_paused" }],
  }],
  scoring: { maxTotalTurns: 3 },
};

describe("runScenario", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes a simple single-turn scenario", async () => {
    mockFetch.mockResolvedValueOnce(makeOaiResponse("Hello! How can I help?"));

    const result = await runScenario(baseConfig, simpleScenario);

    expect(result.scenarioId).toBe("test-simple");
    expect(result.totalTurns).toBe(1);
    expect(result.passed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://test-yarn:8000/v1/chat/completions");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(false);
  });

  it("handles tool loops with simulated results", async () => {
    const scenarioWithTools: EvalScenario = {
      id: "test-tools",
      name: "Tool loop test",
      category: "e2e_build",
      description: "Tests tool loop simulation",
      target: {},
      turns: [{
        messages: [{ role: "user", content: "Write a file" }],
        simulatedToolResults: {
          Write: "File written successfully.",
        },
        maxToolRounds: 2,
        assertions: [{ type: "tool_name_present", params: { name: "Write" } }],
      }],
      scoring: { maxTotalTurns: 3 },
    };

    mockFetch
      .mockResolvedValueOnce(makeOaiResponse("", [
        { id: "tc-1", function: { name: "Write", arguments: '{"path":"test.ts"}' } },
      ]))
      .mockResolvedValueOnce(makeOaiResponse("File has been written."));

    const result = await runScenario(baseConfig, scenarioWithTools);

    expect(result.totalTurns).toBe(1);
    expect(result.totalToolRounds).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("caps tool rounds at maxToolRounds", async () => {
    const scenarioLoop: EvalScenario = {
      id: "test-loop-cap",
      name: "Loop cap test",
      category: "governor_regression",
      description: "Tests tool round capping",
      target: {},
      turns: [{
        messages: [{ role: "user", content: "Do something" }],
        simulatedToolResults: { Read: "content" },
        maxToolRounds: 1,
      }],
      scoring: { maxTotalTurns: 3 },
    };

    mockFetch
      .mockResolvedValueOnce(makeOaiResponse("", [
        { id: "tc-1", function: { name: "Read", arguments: "{}" } },
      ]))
      .mockResolvedValueOnce(makeOaiResponse("", [
        { id: "tc-2", function: { name: "Read", arguments: "{}" } },
      ]));

    const result = await runScenario(baseConfig, scenarioLoop);
    // maxToolRounds=1 allows up to 2 rounds (0..maxToolRounds inclusive), so 2 fetch calls
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.totalTurns).toBe(1);
  });

  it("reports fetch errors as anomalies", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await runScenario(baseConfig, simpleScenario);

    // Error is caught and recorded as an anomaly on the turn
    expect(result.turnResults[0].anomalies.length).toBeGreaterThan(0);
    expect(result.turnResults[0].anomalies[0].detail).toContain("Connection refused");
  });

  it("includes model override from config", async () => {
    mockFetch.mockResolvedValueOnce(makeOaiResponse("OK"));

    const configWithModel = { ...baseConfig, model: "override-model" };
    const result = await runScenario(configWithModel, simpleScenario);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("override-model");
    expect(result.model).toBe("override-model");
  });

  it("populates timestamp and duration", async () => {
    mockFetch.mockResolvedValueOnce(makeOaiResponse("OK"));

    const result = await runScenario(baseConfig, simpleScenario);

    expect(result.timestamp).toBeTruthy();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.targetUrl).toBe("http://test-yarn:8000");
  });
});

describe("runScenarios", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("runs multiple scenarios sequentially", async () => {
    mockFetch.mockResolvedValue(makeOaiResponse("OK"));

    const results = await runScenarios(baseConfig, [simpleScenario, { ...simpleScenario, id: "test-2" }]);

    expect(results.length).toBe(2);
    expect(results[0].scenarioId).toBe("test-simple");
    expect(results[1].scenarioId).toBe("test-2");
  });
});
