import { describe, it, expect } from "vitest";
import { detectAnomalies, scoreTurn, scoreScenario } from "../src/eval/turn-scorer.js";
import type { EvalChatMessage, TurnAssertion, TurnResult, ScoringCriteria } from "../src/eval/types.js";

function msg(role: string, content: string, toolCalls?: Array<{ function: { name: string; arguments: string } }>): EvalChatMessage {
  return {
    role: role as "assistant",
    content,
    tool_calls: toolCalls?.map((tc, i) => ({ id: `tc-${i}`, type: "function" as const, function: tc.function })),
  };
}

describe("detectAnomalies", () => {
  it("detects repeated assistant content", () => {
    const messages: EvalChatMessage[] = [
      msg("assistant", "I'll implement the feature."),
      msg("assistant", "I'll implement the feature."),
      msg("assistant", "I'll implement the feature."),
    ];
    const anomalies = detectAnomalies(messages);
    expect(anomalies.some(a => a.kind === "repeated_content")).toBe(true);
    expect(anomalies.find(a => a.kind === "repeated_content")!.severity).toBe("error");
  });

  it("detects repeated tool calls with same args", () => {
    const messages: EvalChatMessage[] = [
      msg("assistant", "", [{ function: { name: "Bash", arguments: '{"command":"go build"}' } }]),
      msg("assistant", "", [{ function: { name: "Bash", arguments: '{"command":"go build"}' } }]),
    ];
    const anomalies = detectAnomalies(messages);
    expect(anomalies.some(a => a.kind === "repeated_tool_call")).toBe(true);
  });

  it("detects waffling markers without edits", () => {
    const messages: EvalChatMessage[] = [
      msg("assistant", "I'll implement the bundle files feature."),
      msg("assistant", "Let me check the current state."),
    ];
    const anomalies = detectAnomalies(messages);
    expect(anomalies.some(a => a.kind === "waffling_marker")).toBe(true);
  });

  it("does not flag waffling when edits are present", () => {
    const messages: EvalChatMessage[] = [
      msg("assistant", "I'll implement the feature.", [
        { function: { name: "Write", arguments: '{"path":"test.go"}' } },
      ]),
    ];
    const anomalies = detectAnomalies(messages);
    expect(anomalies.some(a => a.kind === "waffling_marker")).toBe(false);
  });

  it("detects stub content in tool results", () => {
    const messages: EvalChatMessage[] = [
      { role: "tool", content: "Unchanged since last read", tool_call_id: "tc-1" },
    ];
    const anomalies = detectAnomalies(messages);
    expect(anomalies.some(a => a.kind === "stub_content_detected")).toBe(true);
  });

  it("detects plan re-read after update", () => {
    const messages: EvalChatMessage[] = [
      msg("assistant", "", [{ function: { name: "Edit", arguments: '{"path":".claude/plans/test.md"}' } }]),
      { role: "tool", content: "OK", tool_call_id: "tc-0" },
      msg("assistant", "", [{ function: { name: "Read", arguments: '{"path":".claude/plans/test.md"}' } }]),
    ];
    const anomalies = detectAnomalies(messages);
    expect(anomalies.some(a => a.kind === "plan_re_read_after_update")).toBe(true);
  });

  it("returns empty for clean conversations", () => {
    const messages: EvalChatMessage[] = [
      { role: "user", content: "Add a feature" },
      msg("assistant", "Done.", [{ function: { name: "Write", arguments: '{"path":"feature.go"}' } }]),
      { role: "tool", content: "File written", tool_call_id: "tc-0" },
    ];
    const anomalies = detectAnomalies(messages);
    expect(anomalies.length).toBe(0);
  });
});

describe("scoreTurn", () => {
  it("passes governor_paused when rules fired", () => {
    const assertions: TurnAssertion[] = [{ type: "governor_paused" }];
    const results = scoreTurn(assertions, [], ["verification_stall_no_edit"], []);
    expect(results[0].passed).toBe(true);
  });

  it("fails governor_paused when no rules fired", () => {
    const assertions: TurnAssertion[] = [{ type: "governor_paused" }];
    const results = scoreTurn(assertions, [], ["allow"], []);
    expect(results[0].passed).toBe(false);
  });

  it("passes contains_edit when Write tool present", () => {
    const messages: EvalChatMessage[] = [
      msg("assistant", "", [{ function: { name: "Write", arguments: "{}" } }]),
    ];
    const assertions: TurnAssertion[] = [{ type: "contains_edit" }];
    const results = scoreTurn(assertions, messages, [], []);
    expect(results[0].passed).toBe(true);
  });

  it("fails contains_edit when no edit tools", () => {
    const messages: EvalChatMessage[] = [
      msg("assistant", "", [{ function: { name: "Read", arguments: "{}" } }]),
    ];
    const assertions: TurnAssertion[] = [{ type: "contains_edit" }];
    const results = scoreTurn(assertions, messages, [], []);
    expect(results[0].passed).toBe(false);
  });

  it("passes no_repeated_tool when no repeats", () => {
    const assertions: TurnAssertion[] = [{ type: "no_repeated_tool" }];
    const results = scoreTurn(assertions, [], [], []);
    expect(results[0].passed).toBe(true);
  });

  it("passes tool_count_lte within limit", () => {
    const messages: EvalChatMessage[] = [
      msg("assistant", "", [{ function: { name: "Read", arguments: "{}" } }]),
    ];
    const assertions: TurnAssertion[] = [{ type: "tool_count_lte", params: { max: 5 } }];
    const results = scoreTurn(assertions, messages, [], []);
    expect(results[0].passed).toBe(true);
  });

  it("fails tool_count_lte over limit", () => {
    const messages: EvalChatMessage[] = Array.from({ length: 3 }, (_, i) =>
      msg("assistant", "", [{ function: { name: "Read", arguments: `{"i":${i}}` } }]),
    );
    const assertions: TurnAssertion[] = [{ type: "tool_count_lte", params: { max: 2 } }];
    const results = scoreTurn(assertions, messages, [], []);
    expect(results[0].passed).toBe(false);
  });

  it("passes content_matches with regex", () => {
    const messages: EvalChatMessage[] = [msg("assistant", "File written: test.go")];
    const assertions: TurnAssertion[] = [{ type: "content_matches", params: { pattern: "file written" } }];
    const results = scoreTurn(assertions, messages, [], []);
    expect(results[0].passed).toBe(true);
  });

  it("passes no_waffling_markers for clean turn", () => {
    const assertions: TurnAssertion[] = [{ type: "no_waffling_markers" }];
    const results = scoreTurn(assertions, [], [], []);
    expect(results[0].passed).toBe(true);
  });

  it("passes tool_name_present when tool exists", () => {
    const messages: EvalChatMessage[] = [
      msg("assistant", "", [{ function: { name: "Write", arguments: "{}" } }]),
    ];
    const assertions: TurnAssertion[] = [{ type: "tool_name_present", params: { name: "Write" } }];
    const results = scoreTurn(assertions, messages, [], []);
    expect(results[0].passed).toBe(true);
  });

  it("passes tool_name_absent when tool not used", () => {
    const messages: EvalChatMessage[] = [
      msg("assistant", "", [{ function: { name: "Read", arguments: "{}" } }]),
    ];
    const assertions: TurnAssertion[] = [{ type: "tool_name_absent", params: { name: "Write" } }];
    const results = scoreTurn(assertions, messages, [], []);
    expect(results[0].passed).toBe(true);
  });
});

describe("scoreScenario", () => {
  const baseTurn: TurnResult = {
    turnIndex: 0,
    toolRounds: 1,
    messages: [],
    governorRulesFired: [],
    assertionResults: [],
    latencyMs: 100,
    anomalies: [],
  };

  it("passes when within limits", () => {
    const criteria: ScoringCriteria = { maxTotalTurns: 5 };
    const { passed, score } = scoreScenario(criteria, [baseTurn], [], 0);
    expect(passed).toBe(true);
    expect(score).toBe(1);
  });

  it("fails when exceeding max turns", () => {
    const criteria: ScoringCriteria = { maxTotalTurns: 1 };
    const turns = [baseTurn, baseTurn, baseTurn];
    const { passed, failureReasons } = scoreScenario(criteria, turns, [], 0);
    expect(passed).toBe(false);
    expect(failureReasons.some(r => r.includes("max turns"))).toBe(true);
  });

  it("fails when forbidden governor rules fire", () => {
    const criteria: ScoringCriteria = {
      maxTotalTurns: 5,
      failIfRules: ["verification_stall_no_edit"],
    };
    const { passed } = scoreScenario(criteria, [baseTurn], ["verification_stall_no_edit"], 1);
    expect(passed).toBe(false);
  });

  it("fails when required governor rules missing", () => {
    const criteria: ScoringCriteria = {
      maxTotalTurns: 5,
      passIfRules: ["exploration_stall_no_edit"],
    };
    const { passed } = scoreScenario(criteria, [baseTurn], ["allow"], 0);
    expect(passed).toBe(false);
  });

  it("passes when required governor rules present", () => {
    const criteria: ScoringCriteria = {
      maxTotalTurns: 5,
      passIfRules: ["exploration_stall_no_edit"],
    };
    const { passed } = scoreScenario(criteria, [baseTurn], ["exploration_stall_no_edit"], 1);
    expect(passed).toBe(true);
  });

  it("deducts score for failed assertions", () => {
    const criteria: ScoringCriteria = { maxTotalTurns: 5 };
    const turnWithFailure: TurnResult = {
      ...baseTurn,
      assertionResults: [
        { assertion: { type: "contains_edit" }, passed: false, detail: "No edit" },
      ],
    };
    const { score } = scoreScenario(criteria, [turnWithFailure], [], 0);
    expect(score).toBeLessThan(1);
  });

  it("deducts score for error anomalies", () => {
    const criteria: ScoringCriteria = { maxTotalTurns: 5 };
    const turnWithError: TurnResult = {
      ...baseTurn,
      anomalies: [{ kind: "repeated_content", detail: "repeated", severity: "error" }],
    };
    const { score } = scoreScenario(criteria, [turnWithError], [], 0);
    expect(score).toBeLessThan(1);
  });
});
