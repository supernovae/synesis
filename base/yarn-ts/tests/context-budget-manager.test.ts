import { describe, expect, it } from "vitest";
import { estimateTokens, estimateMessageTokens } from "../src/governance/context-token-estimator.js";
import {
  buildBudgetPolicy,
  classifyZone,
  evaluateContextBudget,
  applySoftCompaction,
  applyHeavyCompaction,
  type ContextBudgetMessage,
} from "../src/governance/context-budget-manager.js";
import {
  classifyMessages,
  buildRetentionContext,
  type RetentionMessage,
} from "../src/governance/context-retention.js";
import {
  createContextCheckpoint,
  renderCheckpointMessage,
} from "../src/governance/context-checkpoint.js";
import type { ChatState } from "../src/governance/chat-state.js";
import type { FileState } from "../src/governance/file-state.js";
import type { ObjectiveEpochState } from "../src/governance/objective-scope.js";

function msg(role: string, content: string, extra?: {
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function?: { name: string; arguments?: string } }>;
}): ContextBudgetMessage {
  return { role, content, ...extra };
}

function toolResult(content: string, name = "Bash", toolCallId = "tc_1"): ContextBudgetMessage {
  return msg("tool", content, { name, tool_call_id: toolCallId });
}

function fileRead(path: string, content: string): ContextBudgetMessage {
  return msg("tool", JSON.stringify({ filePath: path, content }), { name: "read_file", tool_call_id: `tc_${path}` });
}

function assistantWithCalls(text: string, calls: Array<{ id: string; name: string }>): ContextBudgetMessage {
  return msg("assistant", text, {
    tool_calls: calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: "{}" } })),
  });
}

function makeChatState(overrides?: Partial<ChatState>): ChatState {
  return {
    activeObjective: "Fix the bug",
    phase: "edit",
    unresolvedCorrections: [],
    resolvedCorrections: [],
    lastAttemptSummary: null,
    lastVerificationOutcome: "unknown",
    blockers: [],
    currentFocusPaths: ["src/main.ts"],
    transcriptSummary: "",
    narrationResidueSummary: null,
    pendingUserDirective: "Fix the bug",
    completionStatus: "in_progress",
    ...overrides,
  };
}

function makeFileState(paths: string[]): FileState {
  const filesByPath: Record<string, any> = {};
  for (const p of paths) {
    filesByPath[p] = {
      path: p, status: "available", lastContent: "content", fullContentAvailable: true,
      summaryOnly: false, lastHash: "abc123", lastReadTurn: 1, lastEditTurn: null,
      staleSinceEdit: false, visibleRange: null, retainedRange: null,
      replayableSnapshotId: null, readReturnedContent: true,
      sourceSemantics: { signal: "full_content", envelopeStatus: "none" },
    };
  }
  return { filesByPath, fileCount: paths.length } as FileState;
}

function makeEpoch(): ObjectiveEpochState {
  return {
    epochId: 1,
    objectiveHash: "abc",
    objectiveText: "Fix the bug",
    anchorUserHash: "",
    objectiveSetRequest: 1,
    objectiveChanged: false,
    similarityToPrevious: 1,
  };
}

// ── Token Estimator ───────────────────────────────────────────────────────

describe("context-token-estimator", () => {
  it("estimates tokens for simple messages", () => {
    const result = estimateTokens([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi there!" },
    ]);
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.breakdown.systemTokens).toBeGreaterThan(0);
    expect(result.breakdown.userTokens).toBeGreaterThan(0);
    expect(result.breakdown.assistantTokens).toBeGreaterThan(0);
    expect(result.messageTokens).toBe(
      result.breakdown.systemTokens + result.breakdown.userTokens
      + result.breakdown.assistantTokens + result.breakdown.toolResultTokens,
    );
  });

  it("estimates tool results with lower chars-per-token ratio", () => {
    const codeContent = "function foo() { return 42; }\n".repeat(100);
    const toolMsg = estimateMessageTokens({ role: "tool", content: codeContent });
    const assistantMsg = estimateMessageTokens({ role: "assistant", content: codeContent });
    expect(toolMsg).toBeGreaterThan(assistantMsg);
  });

  it("estimates tool schemas", () => {
    const tools = [
      { type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    ];
    const result = estimateTokens([{ role: "user", content: "hi" }], tools);
    expect(result.toolSchemaTokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBe(result.messageTokens + result.toolSchemaTokens);
  });

  it("handles array content (Claude format)", () => {
    const result = estimateTokens([
      { role: "user", content: [{ type: "text", text: "Hello world" }] },
    ]);
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.breakdown.userTokens).toBeGreaterThan(0);
  });

  it("handles empty messages", () => {
    const result = estimateTokens([]);
    expect(result.totalTokens).toBe(0);
  });
});

// ── Budget Policy ─────────────────────────────────────────────────────────

describe("budget policy", () => {
  it("builds policy with correct ratios", () => {
    const policy = buildBudgetPolicy(100_000);
    expect(policy.ceilingTokens).toBe(100_000);
    expect(policy.softTokens).toBe(75_000);
    expect(policy.heavyTokens).toBe(88_000);
    expect(policy.emergencyTokens).toBe(93_000);
    expect(policy.hardLimitTokens).toBe(95_000);
    expect(policy.outputReserveTokens).toBe(10_000);
  });

  it("scales proportionally for different ceilings", () => {
    const policy = buildBudgetPolicy(200_000);
    expect(policy.softTokens).toBe(150_000);
    expect(policy.heavyTokens).toBe(176_000);
    expect(policy.hardLimitTokens).toBe(190_000);
  });

  it("classifies zones correctly", () => {
    const policy = buildBudgetPolicy(100_000);
    expect(classifyZone(50_000, policy)).toBe("green");
    expect(classifyZone(74_999, policy)).toBe("green");
    expect(classifyZone(75_000, policy)).toBe("soft");
    expect(classifyZone(87_999, policy)).toBe("soft");
    expect(classifyZone(88_000, policy)).toBe("heavy");
    expect(classifyZone(92_999, policy)).toBe("heavy");
    expect(classifyZone(93_000, policy)).toBe("emergency");
    expect(classifyZone(94_999, policy)).toBe("emergency");
    expect(classifyZone(95_000, policy)).toBe("reject");
  });
});

// ── Retention Classification ──────────────────────────────────────────────

describe("context-retention", () => {
  it("classifies system messages as immutable", () => {
    const messages: RetentionMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const ctx = buildRetentionContext(messages);
    const classified = classifyMessages(messages, ctx);
    expect(classified[0].tier).toBe("immutable");
    expect(classified[0].retentionScore).toBe(1.0);
  });

  it("classifies recent messages as working", () => {
    const messages: RetentionMessage[] = [
      { role: "user", content: "Old message" },
      { role: "assistant", content: "analysis" },
      { role: "tool", content: "old output", name: "Bash" },
      { role: "user", content: "Fix the bug" },
      { role: "assistant", content: "Working on it" },
      { role: "tool", content: "test result", name: "Bash" },
    ];
    const ctx = buildRetentionContext(messages);
    const classified = classifyMessages(messages, ctx);
    expect(classified[5].tier).toBe("working");
    expect(classified[4].tier).toBe("working");
  });

  it("classifies old assistant narration as historical", () => {
    const messages: RetentionMessage[] = [
      { role: "user", content: "Old work" },
      { role: "assistant", content: "Let me think about this problem for a while and consider various approaches..." },
      { role: "user", content: "Fix the bug" },
      { role: "assistant", content: "Working" },
      { role: "tool", content: "done", name: "Bash" },
    ];
    const ctx = buildRetentionContext(messages);
    const classified = classifyMessages(messages, ctx);
    expect(classified[1].tier).toBe("historical");
    expect(classified[1].tags).toContain("narration");
  });

  it("flags unresolved failures with minimum 0.6 score", () => {
    const messages: RetentionMessage[] = [
      { role: "user", content: "Run tests" },
      { role: "tool", content: "FAIL: TestFoo - expected 42 got 0\nAssertionError at line 5", name: "Bash" },
      { role: "user", content: "Fix it" },
      { role: "tool", content: "done", name: "Bash" },
    ];
    const ctx = buildRetentionContext(messages);
    const classified = classifyMessages(messages, ctx);
    expect(classified[1].tags).toContain("unresolved_failure");
    expect(classified[1].retentionScore).toBeGreaterThanOrEqual(0.6);
  });

  it("classifies file reads referencing active paths as artifact_shadow", () => {
    const messages: RetentionMessage[] = [
      { role: "user", content: "Read files" },
      { role: "tool", content: JSON.stringify({ filePath: "src/main.ts", content: "code" }), name: "read_file" },
      { role: "user", content: "Now fix it" },
      { role: "tool", content: "done", name: "Bash" },
    ];
    const ctx = buildRetentionContext(messages, ["src/main.ts"]);
    const classified = classifyMessages(messages, ctx);
    expect(classified[1].tier).toBe("artifact_shadow");
    expect(classified[1].tags).toContain("active_file");
  });
});

// ── Soft Compaction ───────────────────────────────────────────────────────

describe("soft compaction", () => {
  it("collapses repeated file reads", () => {
    const padding: ContextBudgetMessage[] = [];
    for (let i = 0; i < 10; i++) {
      padding.push(msg("assistant", `step ${i}`));
      padding.push(toolResult(`output ${i} ` + "x".repeat(200), "Bash", `tc_pad_${i}`));
    }
    const messages: ContextBudgetMessage[] = [
      msg("user", "Read files"),
      fileRead("src/main.ts", "x".repeat(500)),
      msg("assistant", "I see the code"),
      fileRead("src/main.ts", "x".repeat(500)),
      ...padding,
      msg("user", "Continue"),
      msg("assistant", "Working on it"),
      msg("tool", "test passed", { name: "Bash" }),
    ];
    const ctx = buildRetentionContext(messages as RetentionMessage[]);
    const classified = classifyMessages(messages as RetentionMessage[], ctx);
    const result = applySoftCompaction(messages, classified, 100);
    expect(result.tokensRecovered).toBeGreaterThan(0);
    const firstRead = result.messages[1];
    expect(typeof firstRead.content === "string" && firstRead.content.includes("FILE_SHADOW")).toBe(true);
  });

  it("folds repeated successful verifications", () => {
    const padding: ContextBudgetMessage[] = [];
    for (let i = 0; i < 10; i++) {
      padding.push(msg("assistant", `step ${i}`));
      padding.push(toolResult(`output ${i}`, "Bash", `tc_pad_${i}`));
    }
    const messages: ContextBudgetMessage[] = [
      msg("user", "Build the project"),
      toolResult("Build success. All tests passed. ok. " + "x".repeat(200), "Bash", "tc_1"),
      msg("assistant", "Great, continuing"),
      toolResult("Build success. All tests passed. ok. " + "x".repeat(200), "Bash", "tc_2"),
      msg("assistant", "Still good"),
      toolResult("Build success. All tests passed. ok. " + "x".repeat(200), "Bash", "tc_3"),
      ...padding,
      msg("user", "Continue"),
      msg("tool", "done", { name: "Bash" }),
    ];
    const ctx = buildRetentionContext(messages as RetentionMessage[]);
    const classified = classifyMessages(messages as RetentionMessage[], ctx);
    const verifyIndices = [1, 3, 5];
    for (const vi of verifyIndices) {
      const cl = classified[vi];
      expect(cl.tier, `msg[${vi}] tier`).not.toBe("immutable");
      expect(cl.tier, `msg[${vi}] should not be working`).not.toBe("working");
    }
    const totalTokens = classified.reduce((s, c) => s + c.estimatedTokens, 0);
    expect(totalTokens).toBeGreaterThan(100);
    const result = applySoftCompaction(messages, classified, Math.floor(totalTokens * 0.3));
    const folded = result.messages.filter((m) =>
      typeof m.content === "string" && m.content.includes("VERIFICATION_FOLDED"),
    );
    expect(folded.length).toBeGreaterThanOrEqual(1);
  });

  it("condenses assistant narration without tool calls", () => {
    const padding: ContextBudgetMessage[] = [];
    for (let i = 0; i < 10; i++) {
      padding.push(msg("assistant", `step ${i}`));
      padding.push(toolResult(`output ${i}`, "Bash", `tc_pad_${i}`));
    }
    const messages: ContextBudgetMessage[] = [
      msg("user", "Do something"),
      msg("assistant", "Let me think about this for a while. " + "analysis ".repeat(100)),
      msg("assistant", "More thinking. " + "reasoning ".repeat(100)),
      ...padding,
      msg("user", "Continue"),
      msg("tool", "result", { name: "Bash" }),
    ];
    const ctx = buildRetentionContext(messages as RetentionMessage[]);
    const classified = classifyMessages(messages as RetentionMessage[], ctx);
    const result = applySoftCompaction(messages, classified, 100);
    const condensed = result.messages.filter((m) =>
      typeof m.content === "string" && m.content.includes("NARRATION_CONDENSED"),
    );
    expect(condensed.length).toBeGreaterThanOrEqual(1);
  });

  it("dedupes superseded plan reads", () => {
    const planContent = JSON.stringify({ filePath: "~/.claude/plans/my-plan.md", content: "plan content ".repeat(50) });
    const padding: ContextBudgetMessage[] = [];
    for (let i = 0; i < 10; i++) {
      padding.push(msg("assistant", `step ${i}`));
      padding.push(toolResult(`output ${i}`, "Bash", `tc_pad_${i}`));
    }
    const messages: ContextBudgetMessage[] = [
      msg("user", "Read plan"),
      msg("tool", planContent, { name: "read_file", tool_call_id: "tc_p1" }),
      msg("assistant", "I see the plan"),
      msg("tool", planContent, { name: "read_file", tool_call_id: "tc_p2" }),
      ...padding,
      msg("user", "Continue"),
      msg("tool", "done", { name: "Bash" }),
    ];
    const ctx = buildRetentionContext(messages as RetentionMessage[]);
    const classified = classifyMessages(messages as RetentionMessage[], ctx);
    const result = applySoftCompaction(messages, classified, 100);
    const superseded = result.messages.filter((m) =>
      typeof m.content === "string" && m.content.includes("PLAN_SUPERSEDED"),
    );
    expect(superseded.length).toBe(1);
  });

  it("never compacts unresolved failures", () => {
    const messages: ContextBudgetMessage[] = [
      msg("user", "Run tests"),
      toolResult("FAIL: TestMain - assertion error\nexit code 1", "Bash", "tc_fail"),
      msg("user", "Fix it"),
      msg("tool", "done", { name: "Bash" }),
    ];
    const ctx = buildRetentionContext(messages as RetentionMessage[]);
    const classified = classifyMessages(messages as RetentionMessage[], ctx);
    const result = applySoftCompaction(messages, classified, 100);
    const failContent = typeof result.messages[1].content === "string"
      ? result.messages[1].content : "";
    expect(failContent).toContain("FAIL");
    expect(failContent).not.toContain("STALE_EXPLORATION");
  });

  it("does nothing when under target budget", () => {
    const messages: ContextBudgetMessage[] = [
      msg("user", "Hello"),
      msg("assistant", "Hi"),
    ];
    const ctx = buildRetentionContext(messages as RetentionMessage[]);
    const classified = classifyMessages(messages as RetentionMessage[], ctx);
    const result = applySoftCompaction(messages, classified, 100_000);
    expect(result.tokensRecovered).toBe(0);
    expect(result.messages).toEqual(messages);
  });
});

// ── Heavy Compaction ──────────────────────────────────────────────────────

describe("heavy compaction", () => {
  it("creates checkpoint and removes historical messages", () => {
    const messages: ContextBudgetMessage[] = [
      msg("system", "You are helpful."),
      msg("user", "Old task"),
      msg("assistant", "Old narration " + "x".repeat(500)),
      toolResult("old output " + "x".repeat(500), "Bash", "tc_old1"),
      msg("assistant", "More old narration " + "x".repeat(500)),
      toolResult("more old output " + "x".repeat(500), "Bash", "tc_old2"),
      msg("user", "Fix the bug"),
      assistantWithCalls("Working", [{ id: "tc_new", name: "edit" }]),
      toolResult("edit result", "edit", "tc_new"),
    ];
    const ctx = buildRetentionContext(messages as RetentionMessage[], ["src/main.ts"]);
    const classified = classifyMessages(messages as RetentionMessage[], ctx);
    const result = applyHeavyCompaction(
      messages, classified, 100,
      {
        sessionKey: "test-session",
        chatState: makeChatState(),
        fileState: makeFileState(["src/main.ts"]),
        objectiveEpoch: makeEpoch(),
      },
    );
    expect(result.tokensRecovered).toBeGreaterThan(0);
    expect(result.checkpoint.checkpointId).toMatch(/^ckpt_/);
    expect(result.checkpoint.currentObjective).toBe("Fix the bug");
    const checkpointMsg = result.messages.find((m) =>
      typeof m.content === "string" && m.content.includes("CONTEXT_CHECKPOINT"),
    );
    expect(checkpointMsg).toBeDefined();
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("preserves unresolved failure messages", () => {
    const messages: ContextBudgetMessage[] = [
      msg("system", "You are helpful."),
      msg("user", "Fix it"),
      toolResult("FAIL: TestFoo - assertion error\npanic at line 5", "Bash", "tc_fail"),
      msg("user", "Try again"),
      msg("tool", "done", { name: "Bash" }),
    ];
    const ctx = buildRetentionContext(messages as RetentionMessage[]);
    const classified = classifyMessages(messages as RetentionMessage[], ctx);
    const result = applyHeavyCompaction(
      messages, classified, 100,
      {
        sessionKey: "test-session",
        chatState: makeChatState({ blockers: ["Test failure"] }),
        fileState: makeFileState([]),
        objectiveEpoch: makeEpoch(),
      },
    );
    const failMsg = result.messages.find((m) =>
      typeof m.content === "string" && m.content.includes("FAIL"),
    );
    expect(failMsg).toBeDefined();
  });
});

// ── Checkpoint ────────────────────────────────────────────────────────────

describe("context-checkpoint", () => {
  it("creates checkpoint with structured fields", () => {
    const chatState = makeChatState({
      blockers: ["Build failed at line 5"],
      unresolvedCorrections: [{ issue: "Wrong import", sourceTurn: 3, sourceRole: "user", status: "open", resolutionEvidenceSummary: null, reopened: false }],
    });
    const classified = classifyMessages(
      [
        { role: "user", content: "Fix it" },
        { role: "tool", content: "FAIL at line 5\npanic", name: "Bash" },
      ] as RetentionMessage[],
      buildRetentionContext([{ role: "user", content: "Fix it" }, { role: "tool", content: "FAIL" }] as RetentionMessage[]),
    );

    const checkpoint = createContextCheckpoint(
      "test-session",
      chatState,
      makeFileState(["src/main.ts"]),
      makeEpoch(),
      classified,
    );

    expect(checkpoint.checkpointId).toMatch(/^ckpt_/);
    expect(checkpoint.currentObjective).toBe("Fix the bug");
    expect(checkpoint.activeFiles.length).toBe(1);
    expect(checkpoint.activeFiles[0].path).toBe("src/main.ts");
    expect(checkpoint.activeConstraints.length).toBe(1);
  });

  it("renders checkpoint as structured XML", () => {
    const checkpoint = createContextCheckpoint(
      "test-session",
      makeChatState(),
      makeFileState(["src/main.ts"]),
      makeEpoch(),
      [],
    );
    const rendered = renderCheckpointMessage(checkpoint);
    expect(rendered).toContain("<CONTEXT_CHECKPOINT");
    expect(rendered).toContain("<objective>");
    expect(rendered).toContain("</CONTEXT_CHECKPOINT>");
    expect(rendered).toContain("<active_files");
    expect(rendered).not.toContain("undefined");
  });
});

// ── Full Pipeline ─────────────────────────────────────────────────────────

describe("evaluateContextBudget", () => {
  it("returns green zone for small contexts", () => {
    const messages: ContextBudgetMessage[] = [
      msg("user", "Hello"),
      msg("assistant", "Hi"),
    ];
    const policy = buildBudgetPolicy(100_000);
    const result = evaluateContextBudget({
      messages,
      policy,
      enableCompaction: true,
    });
    expect(result.evaluation.zone).toBe("green");
    expect(result.evaluation.compactionApplied).toBe("none");
    expect(result.messages).toEqual(messages);
  });

  it("applies soft compaction in soft zone", () => {
    const messages: ContextBudgetMessage[] = [
      msg("system", "You are helpful."),
      msg("user", "Build it"),
    ];
    for (let i = 0; i < 30; i++) {
      messages.push(msg("assistant", "Working on step " + i));
      messages.push(toolResult("output ".repeat(200), "Bash", `tc_${i}`));
    }
    messages.push(msg("user", "Continue"));
    messages.push(msg("tool", "done", { name: "Bash" }));

    const policy = buildBudgetPolicy(100_000);
    const retentionCtx = buildRetentionContext(
      messages as RetentionMessage[],
      [],
      [],
    );
    const result = evaluateContextBudget({
      messages,
      policy,
      retentionContext: retentionCtx,
      enableCompaction: true,
    });

    if (result.evaluation.estimate.totalTokens >= policy.softTokens) {
      expect(result.evaluation.compactionApplied).not.toBe("none");
      expect(result.evaluation.tokensRecovered).toBeGreaterThan(0);
    }
  });

  it("skips compaction when disabled", () => {
    const messages: ContextBudgetMessage[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push(msg("assistant", "text ".repeat(200)));
      messages.push(toolResult("output ".repeat(200)));
    }
    const policy = buildBudgetPolicy(100_000);
    const result = evaluateContextBudget({
      messages,
      policy,
      enableCompaction: false,
    });
    expect(result.evaluation.compactionApplied).toBe("none");
    expect(result.messages).toEqual(messages);
  });
});

// ── Governor Integration (Phase 5) ───────────────────────────────────────

describe("governor budget signal integration", () => {
  it("budget signal catalog entries exist with correct weights", async () => {
    const { computeFriction } = await import("../src/governance/sensemaking-governor.js");

    const softResult = computeFriction({
      matchedRules: ["context_budget_soft"],
      events: [],
      phase: "implementation",
      turnsSinceUserPrompt: 1,
      changedFileCount: 0,
      planRecoveryGraceActive: false,
    });
    expect(softResult.firedSignals.length).toBe(1);
    expect(softResult.firedSignals[0].name).toBe("context_budget_soft");
    expect(softResult.score).toBeLessThan(0.10);

    const heavyResult = computeFriction({
      matchedRules: ["context_budget_heavy"],
      events: [],
      phase: "implementation",
      turnsSinceUserPrompt: 1,
      changedFileCount: 0,
      planRecoveryGraceActive: false,
    });
    expect(heavyResult.firedSignals.length).toBe(1);
    expect(heavyResult.firedSignals[0].name).toBe("context_budget_heavy");
    expect(heavyResult.score).toBeGreaterThan(0.05);

    const emergencyResult = computeFriction({
      matchedRules: ["context_budget_emergency"],
      events: [],
      phase: "implementation",
      turnsSinceUserPrompt: 1,
      changedFileCount: 0,
      planRecoveryGraceActive: false,
    });
    expect(emergencyResult.firedSignals.length).toBe(1);
    expect(emergencyResult.firedSignals[0].name).toBe("context_budget_emergency");
    expect(emergencyResult.score).toBeGreaterThan(0.15);
  });

  it("evaluateSensemakingGovernor injects budget zone signal", async () => {
    const { evaluateSensemakingGovernor } = await import("../src/governance/sensemaking-governor.js");
    const { evaluateExecutionGovernor } = await import("../src/governance/execution-governor.js");

    const msgs = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there" },
    ];

    const legacyDecision = evaluateExecutionGovernor(msgs as any, {
      profile: "balanced_completion",
      activePlanStage: null,
      taskCompleted: false,
      consecutiveRecoveryFires: 0,
      planRecoveryDiscoveryGraceActive: false,
    });

    const withoutBudget = evaluateSensemakingGovernor(legacyDecision, [], 1, 0, false);
    const withBudgetHeavy = evaluateSensemakingGovernor(legacyDecision, [], 1, 0, false, "heavy");

    expect(withBudgetHeavy.firedSignals.some((s) => s.name === "context_budget_heavy")).toBe(true);
    expect(withBudgetHeavy.frictionScore).toBeGreaterThanOrEqual(withoutBudget.frictionScore);
  });
});

describe("applySoftCompaction preserves SDK ModelMessage content format", () => {
  function sdkToolResult(value: string, toolCallId: string, toolName = "read_file"): ContextBudgetMessage {
    return {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId,
        toolName,
        output: { type: "text", value },
      }],
    };
  }

  function sdkAssistant(text: string): ContextBudgetMessage {
    return { role: "assistant", content: [{ type: "text", text }] };
  }

  it("preserves array content format for tool messages after file-read dedup", () => {
    const longFileContent = "x".repeat(2000);
    const messages: ContextBudgetMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "read foo" },
      sdkAssistant("reading foo.ts"),
      sdkToolResult(JSON.stringify({ filePath: "foo.ts", content: longFileContent }), "tc_1", "read_file"),
      sdkAssistant("reading foo.ts again"),
      sdkToolResult(JSON.stringify({ filePath: "foo.ts", content: longFileContent }), "tc_2", "read_file"),
    ];
    const retention = buildRetentionContext(messages as unknown as RetentionMessage[]);
    const classified = classifyMessages(messages as unknown as RetentionMessage[], retention);
    const result = applySoftCompaction(messages, classified, 100);

    for (const m of result.messages) {
      if (m.role === "tool") {
        expect(Array.isArray(m.content)).toBe(true);
        const parts = m.content as Array<{ type: string }>;
        expect(parts[0].type).toBe("tool-result");
      }
    }
  });

  it("preserves array content format for assistant messages after narration condensation", () => {
    const longNarration = "Here is my detailed explanation of the changes I made to the codebase. ".repeat(50);
    const messages: ContextBudgetMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "do something" },
      sdkAssistant(longNarration),
      { role: "user", content: "ok" },
      sdkAssistant("done"),
    ];
    const retention = buildRetentionContext(messages as unknown as RetentionMessage[]);
    const classified = classifyMessages(messages as unknown as RetentionMessage[], retention);
    const result = applySoftCompaction(messages, classified, 100);

    for (const m of result.messages) {
      if (m.role === "assistant") {
        expect(Array.isArray(m.content)).toBe(true);
        const parts = m.content as Array<{ type: string }>;
        expect(parts[0].type).toBe("text");
      }
    }
  });
});
