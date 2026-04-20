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
    expect(result.sessionCompletionKpi).toEqual({
      taskFinished: false,
      verificationEvidence: false,
      completed: false,
    });
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
    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(Array.isArray(firstBody.tools)).toBe(true);
    expect(firstBody.tools[0].function.name).toBe("Write");
  });

  it("reports completed session KPI when edit + verification + completion happen", async () => {
    const scenarioWithCompletionKpi: EvalScenario = {
      id: "test-completion-kpi",
      name: "Completion KPI test",
      category: "swe_bench",
      description: "Ensures runner emits completion KPI",
      target: {},
      turns: [{
        messages: [{ role: "user", content: "Fix and verify" }],
        simulatedToolResults: {
          Write: "File written: src/fix.ts",
          Bash: "PASS src/fix.test.ts\n0 failed",
        },
        maxToolRounds: 3,
      }],
      scoring: {
        maxTotalTurns: 3,
        requireSessionCompletionKpi: true,
      },
    };

    mockFetch
      .mockResolvedValueOnce(makeOaiResponse("", [
        { id: "tc-1", function: { name: "Write", arguments: '{"path":"src/fix.ts"}' } },
        { id: "tc-2", function: { name: "Bash", arguments: '{"command":"npm test -- src/fix.test.ts"}' } },
      ]))
      .mockResolvedValueOnce(makeOaiResponse("Implemented and completed."));

    const result = await runScenario(baseConfig, scenarioWithCompletionKpi);
    expect(result.sessionCompletionKpi?.completed).toBe(true);
    expect(result.sessionCompletionKpi?.verificationEvidence).toBe(true);
    expect(result.sessionCompletionKpi?.taskFinished).toBe(true);
  });

  it("maps aliased tool names to simulated results", async () => {
    const scenarioWithAlias: EvalScenario = {
      id: "test-alias-tools",
      name: "Alias tool loop test",
      category: "e2e_build",
      description: "Tests alias mapping for simulated tool results",
      target: {},
      turns: [{
        messages: [{ role: "user", content: "Write a file" }],
        simulatedToolResults: {
          Write: "File written successfully.",
        },
        maxToolRounds: 2,
      }],
      scoring: { maxTotalTurns: 3 },
    };

    mockFetch
      .mockResolvedValueOnce(makeOaiResponse("", [
        { id: "tc-1", function: { name: "write_file", arguments: '{"file_path":"test.ts"}' } },
      ]))
      .mockResolvedValueOnce(makeOaiResponse("File has been written."));

    const result = await runScenario(baseConfig, scenarioWithAlias);
    expect(result.totalToolRounds).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("counts policy-layer intervention rules from admin session events", async () => {
    const configWithAdmin = {
      ...baseConfig,
      adminUrl: "http://test-admin:8000",
      adminToken: "admintoken",
    };
    mockFetch
      // chat completion
      .mockResolvedValueOnce(makeOaiResponse("Done"))
      // execution_governor_evaluated
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [{ metadata_json: { matched_rules: ["allow"] }, detail: "phase=edit rules=allow pause=false" }] }),
      })
      // execution_governor_recovery_rewrite
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [{ detail: "Rewrote loop path (source_file_stale_reread); phase=edit;" }] }),
      })
      // execution_governor_hard_stop
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [] }),
      })
      // phase_execution_policy_applied
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [{ detail: "phase=edit reason=stale_source_required_action" }] }),
      })
      // tool_loop_soft_fail
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [{ detail: "Tool call loop detected" }] }),
      });

    const result = await runScenario(configWithAdmin, simpleScenario);
    expect(result.allGovernorRules).toContain("governor:recovery_rewrite");
    expect(result.allGovernorRules).toContain("policy:phase_execution_policy_applied");
    expect(result.allGovernorRules).toContain("policy:tool_loop_soft_fail");
    expect(result.governorInterventions).toBeGreaterThan(0);
    expect(result.adminTelemetry?.status).toBe("ok");
  });

  it("fails scenarios when admin telemetry reports forbidden governor rules", async () => {
    const configWithAdmin = {
      ...baseConfig,
      adminUrl: "http://test-admin:8000",
      adminToken: "admintoken",
    };
    const failIfRuleScenario: EvalScenario = {
      id: "test-fail-if-rule",
      name: "Fail if forbidden rule fires",
      category: "governor_regression",
      description: "Ensure failIfRules trips from admin telemetry.",
      target: {},
      turns: [{ messages: [{ role: "user", content: "Do work" }] }],
      scoring: {
        maxTotalTurns: 2,
        failIfRules: ["completion_claim_requires_task_update"],
      },
    };
    mockFetch
      // chat completion
      .mockResolvedValueOnce(makeOaiResponse("Done"))
      // execution_governor_evaluated
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [{ metadata_json: { matched_rules: ["completion_claim_requires_task_update"] }, detail: "phase=report rules=completion_claim_requires_task_update pause=true" }] }),
      })
      // execution_governor_recovery_rewrite
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [] }),
      })
      // execution_governor_hard_stop
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [] }),
      })
      // phase_execution_policy_applied
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [] }),
      })
      // tool_loop_soft_fail
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [] }),
      });

    const result = await runScenario(configWithAdmin, failIfRuleScenario);
    expect(result.passed).toBe(false);
    expect(result.failureReasons.some((r) => r.includes("Forbidden governor rules fired"))).toBe(true);
    expect(result.allGovernorRules).toContain("completion_claim_requires_task_update");
  });

  it("reports unreachable admin telemetry when session-events endpoint fails", async () => {
    const configWithAdmin = {
      ...baseConfig,
      adminUrl: "http://test-admin:8000",
      adminToken: "admintoken",
    };
    mockFetch
      .mockResolvedValueOnce(makeOaiResponse("Done"))
      .mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ events: [] }),
      });

    const result = await runScenario(configWithAdmin, simpleScenario);
    expect(result.adminTelemetry?.status).toBe("unreachable");
    expect(result.adminTelemetry?.detail).toContain("status=404");
  });

  it("reports unauthorized admin telemetry when auth is rejected", async () => {
    const configWithAdmin = {
      ...baseConfig,
      adminUrl: "http://test-admin:8000",
      adminToken: "badtoken",
    };
    mockFetch
      .mockResolvedValueOnce(makeOaiResponse("Done"))
      .mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ events: [] }),
      });

    const result = await runScenario(configWithAdmin, simpleScenario);
    expect(result.adminTelemetry?.status).toBe("unauthorized");
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
