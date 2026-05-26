import { describe, expect, it, vi } from "vitest";
import type { EvalScenario, EvalRunnerConfig } from "../src/eval/types.js";
import {
  BUILTIN_EVAL_CLIENT_PROFILES,
  renderEvalClientLabMarkdown,
  resolveEvalClientProfiles,
  runEvalClientLab,
  summarizeScenarioResults,
} from "../src/eval/client-lab.js";
import { buildEvalRequestHeaders, runScenario } from "../src/eval/scenario-runner.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const baseConfig: EvalRunnerConfig = {
  targetUrl: "http://test-yarn:8000",
  apiKey: "test-token",
  timeoutMs: 5000,
  conversationIdPrefix: "client-lab-test",
};

const scenario: EvalScenario = {
  id: "client-profile-smoke",
  name: "Client profile smoke",
  category: "governor_regression",
  description: "Verifies client profile request overlays.",
  target: { model: "test-model" },
  turns: [{
    messages: [{ role: "user", content: "Hello" }],
    assertions: [{ type: "governor_not_paused" }],
  }],
  scoring: { maxTotalTurns: 3 },
};

function makeOaiResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: "chatcmpl-client-lab",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  };
}

describe("eval client lab", () => {
  it("builds protected headers with profile overlays", () => {
    const headers = buildEvalRequestHeaders({
      ...baseConfig,
      clientProfile: {
        id: "opencode",
        adminSessionClientId: "opencode",
        userAgent: "opencode/test",
        extraHeaders: {
          Authorization: "Bearer wrong",
          "x-synesis-harness": "opencode",
        },
      },
      extraHeaders: {
        "Content-Type": "text/plain",
        "x-extra": "1",
      },
    });

    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-synesis-client"]).toBe("opencode");
    expect(headers["x-synesis-harness"]).toBe("opencode");
    expect(headers["x-extra"]).toBe("1");
    expect(headers["User-Agent"]).toBe("opencode/test");
  });

  it("marks scenario results with the active client profile", async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(makeOaiResponse("OK"));

    const result = await runScenario({
      ...baseConfig,
      clientProfile: BUILTIN_EVAL_CLIENT_PROFILES.find((profile) => profile.id === "codex-cli"),
    }, scenario);

    expect(result.clientProfileId).toBe("codex-cli");
    const request = mockFetch.mock.calls[0]?.[1];
    expect(request?.headers["x-synesis-client"]).toBe("codex-cli");
    expect(JSON.parse(request?.body).metadata.eval_client_profile).toBe("codex-cli");
  });

  it("resolves built-in profiles by id", () => {
    expect(resolveEvalClientProfiles(["opencode", "claude-code"]).map((profile) => profile.id)).toEqual([
      "opencode",
      "claude-code",
    ]);
    expect(() => resolveEvalClientProfiles(["missing"])).toThrow("Unknown eval client profile");
  });

  it("runs scenarios across profiles and rounds", async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(makeOaiResponse("OK"));

    const result = await runEvalClientLab({
      config: baseConfig,
      scenarios: [scenario],
      profiles: resolveEvalClientProfiles(["raw-openai", "opencode"]),
      rounds: 2,
    });

    expect(result.profiles).toHaveLength(4);
    expect(result.summary.total).toBe(4);
    expect(result.profiles.map((run) => run.profile.id)).toEqual(["raw-openai", "raw-openai", "opencode", "opencode"]);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("summarizes scenario risks for markdown output", () => {
    const summary = summarizeScenarioResults([
      {
        scenarioId: "a",
        scenarioName: "A",
        category: "governor_regression",
        passed: false,
        score: 0.25,
        totalTurns: 1,
        totalToolRounds: 0,
        totalAnomalies: 0,
        governorInterventions: 1,
        allGovernorRules: ["governor:hard_stop"],
        turnResults: [],
        failureReasons: ["hard stop"],
        durationMs: 1,
        targetUrl: "http://test",
        model: "model",
        timestamp: "2026-05-26T00:00:00.000Z",
      },
    ]);

    expect(summary.failed).toBe(1);
    expect(summary.hardStopScenarios).toBe(1);

    const markdown = renderEvalClientLabMarkdown({
      startedAt: "2026-05-26T00:00:00.000Z",
      completedAt: "2026-05-26T00:00:01.000Z",
      durationMs: 1_000,
      summary,
      profiles: [{
        profile: BUILTIN_EVAL_CLIENT_PROFILES[0]!,
        round: 1,
        summary,
        results: [{
          scenarioId: "a",
          scenarioName: "A",
          category: "governor_regression",
          passed: false,
          score: 0.25,
          totalTurns: 1,
          totalToolRounds: 0,
          totalAnomalies: 0,
          governorInterventions: 1,
          allGovernorRules: ["governor:hard_stop"],
          turnResults: [],
          failureReasons: ["hard stop"],
          durationMs: 1,
          targetUrl: "http://test",
          model: "model",
          timestamp: "2026-05-26T00:00:00.000Z",
        }],
      }],
    });
    expect(markdown).toContain("Eval Client Lab");
    expect(markdown).toContain("hard stop");
  });
});
