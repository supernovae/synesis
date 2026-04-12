import { describe, it, expect } from "vitest";
import {
  materializeSft,
  materializeDpo,
  materializeRlaif,
  materialize,
  toJsonl,
  scenarioResultToTrajectoryRow,
} from "../src/eval/training-materializer.js";
import type { ScenarioResult, TurnResult } from "../src/eval/types.js";

function makeTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    turnIndex: 0,
    toolRounds: 1,
    messages: [
      { role: "user", content: "Build a feature" },
      { role: "assistant", content: "I'll create the file.", tool_calls: [
        { id: "tc-1", type: "function", function: { name: "Write", arguments: '{"path":"test.go"}' } },
      ]},
      { role: "tool", content: "File written", tool_call_id: "tc-1" },
    ],
    governorRulesFired: [],
    assertionResults: [],
    latencyMs: 500,
    anomalies: [],
    ...overrides,
  };
}

function makeScenarioResult(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    scenarioId: "test-scenario",
    scenarioName: "Test Scenario",
    category: "governor_regression",
    passed: true,
    score: 0.95,
    totalTurns: 1,
    totalToolRounds: 1,
    totalAnomalies: 0,
    governorInterventions: 0,
    allGovernorRules: [],
    turnResults: [makeTurnResult()],
    failureReasons: [],
    durationMs: 1000,
    targetUrl: "http://test:8000",
    model: "test-model",
    timestamp: "2026-04-10T12:00:00.000Z",
    ...overrides,
  };
}

describe("materializeSft", () => {
  it("produces positive SFT examples from passing scenarios", () => {
    const result = makeScenarioResult();
    const examples = materializeSft(result);
    expect(examples.length).toBe(1);
    expect(examples[0].quality_label).toBe("positive");
    expect(examples[0].source).toBe("eval_gym");
    expect(examples[0].scenario_id).toBe("test-scenario");
    expect(examples[0].messages.length).toBe(3);
  });

  it("produces negative SFT examples from failing scenarios", () => {
    const result = makeScenarioResult({
      passed: false,
      turnResults: [makeTurnResult({
        anomalies: [{ kind: "repeated_content", detail: "repeated", severity: "error" }],
      })],
    });
    const examples = materializeSft(result);
    expect(examples[0].quality_label).toBe("negative");
  });

  it("skips turns with fewer than 2 messages", () => {
    const result = makeScenarioResult({
      turnResults: [makeTurnResult({ messages: [{ role: "user", content: "hi" }] })],
    });
    const examples = materializeSft(result);
    expect(examples.length).toBe(0);
  });
});

describe("materializeDpo", () => {
  it("produces DPO pairs from governor interventions", () => {
    const result = makeScenarioResult({
      turnResults: [makeTurnResult({
        governorRulesFired: ["verification_stall_no_edit"],
        messages: [
          { role: "user", content: "Fix the build" },
          { role: "assistant", content: "I'll check the build again." },
        ],
      })],
    });
    const examples = materializeDpo(result);
    expect(examples.length).toBe(1);
    expect(examples[0].rejected).toContain("check the build again");
    expect(examples[0].chosen).toContain("issue");
    expect(examples[0].prompt.length).toBe(1);
    expect(examples[0].prompt[0].role).toBe("user");
  });

  it("returns empty for turns without governor intervention", () => {
    const result = makeScenarioResult();
    const examples = materializeDpo(result);
    expect(examples.length).toBe(0);
  });

  it("skips turns where assistant had no text content", () => {
    const result = makeScenarioResult({
      turnResults: [makeTurnResult({
        governorRulesFired: ["exploration_stall_no_edit"],
        messages: [
          { role: "user", content: "Do it" },
          { role: "assistant", content: null },
        ],
      })],
    });
    const examples = materializeDpo(result);
    expect(examples.length).toBe(0);
  });
});

describe("materializeRlaif", () => {
  it("assigns positive reward for clean turns", () => {
    const result = makeScenarioResult();
    const examples = materializeRlaif(result);
    expect(examples.length).toBe(1);
    expect(examples[0].reward).toBe(1);
    expect(examples[0].anomaly_count).toBe(0);
  });

  it("reduces reward for anomalies and governor pause", () => {
    const result = makeScenarioResult({
      turnResults: [makeTurnResult({
        governorRulesFired: ["verification_stall_no_edit"],
        anomalies: [
          { kind: "repeated_content", detail: "repeated", severity: "error" },
          { kind: "waffling_marker", detail: "waffling", severity: "warning" },
        ],
      })],
    });
    const examples = materializeRlaif(result);
    expect(examples[0].reward).toBeLessThan(0.5);
    expect(examples[0].anomaly_count).toBe(2);
  });

  it("clamps reward to -1 minimum", () => {
    const anomalies = Array.from({ length: 10 }, (_, i) => ({
      kind: "repeated_content" as const,
      detail: `error ${i}`,
      severity: "error" as const,
    }));
    const result = makeScenarioResult({
      turnResults: [makeTurnResult({
        governorRulesFired: ["verification_stall_no_edit"],
        anomalies,
      })],
    });
    const examples = materializeRlaif(result);
    expect(examples[0].reward).toBeGreaterThanOrEqual(-1);
  });
});

describe("materialize", () => {
  it("routes to correct materializer by format", () => {
    const result = makeScenarioResult();
    expect(materialize([result], "sft").length).toBeGreaterThan(0);
    expect(materialize([result], "rlaif").length).toBeGreaterThan(0);
    expect(materialize([result], "dpo").length).toBe(0);
  });
});

describe("toJsonl", () => {
  it("produces newline-delimited JSON", () => {
    const result = makeScenarioResult();
    const examples = materializeSft(result);
    const jsonl = toJsonl(examples);
    const lines = jsonl.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.source).toBe("eval_gym");
  });
});

describe("scenarioResultToTrajectoryRow", () => {
  it("produces canonical trajectory format", () => {
    const result = makeScenarioResult();
    const row = scenarioResultToTrajectoryRow(result);

    expect(row.task_id).toContain("eval:test-scenario:");
    expect(row.model_id).toBe("test-model");
    expect(row.outcome).toBe("completed");
    expect(row.user_intent).toBe("governor_regression");
    expect(row.trajectory_steps).toHaveLength(1);
    expect(row.quality_signals).toBeDefined();
    expect(row.governor).toBeDefined();
    expect(row.training_signals).toBeDefined();
    const signals = row.training_signals as Record<string, unknown>;
    expect(signals.governor_intervened).toBe(false);
  });

  it("marks stalled outcome for failed scenarios", () => {
    const result = makeScenarioResult({ passed: false });
    const row = scenarioResultToTrajectoryRow(result);
    expect(row.outcome).toBe("stalled");
  });

  it("includes tool sequence in trajectory steps", () => {
    const result = makeScenarioResult();
    const row = scenarioResultToTrajectoryRow(result);
    const steps = row.trajectory_steps as Array<Record<string, unknown>>;
    const toolSeq = steps[0].tool_sequence as string[];
    expect(toolSeq).toContain("Write");
  });
});
