import { describe, expect, it } from "vitest";
import {
  assistantCall,
  evaluateHarnessFlow,
  standardHarnessFlowSpecs,
  toolResult,
  userText,
  type HarnessFlowSpec,
} from "../src/eval/harness-flow.js";

describe("standard harness flows", () => {
  it("covers the supported harness profiles", () => {
    const specs = standardHarnessFlowSpecs();
    expect(specs.map((spec) => spec.profile).sort()).toEqual([
      "claude-code",
      "codex-cli",
      "cursor",
      "generic-openai",
      "opencode",
      "pi",
    ]);
  });

  for (const spec of standardHarnessFlowSpecs()) {
    it(`allows normal ${spec.profile} ${spec.flowType} flow: ${spec.id}`, () => {
      const result = evaluateHarnessFlow(spec);
      expect(result.passed, `${spec.id}: ${result.signals.join(", ")}`).toBe(true);
      expect(result.signals, spec.id).toEqual([]);
      expect(result.missingTools, spec.id).toEqual([]);
      expect(result.forbiddenRules, spec.id).toEqual([]);

      for (const step of result.stepResults) {
        expect(step.decision.pause, `${spec.id}:${step.stepId}:${step.decision.reason}`).toBe(false);
      }
    });
  }

  it("keeps generic clients free of Claude and OpenCode native-task leakage", () => {
    const generic = standardHarnessFlowSpecs().find((spec) => spec.id === "generic-openai-no-native-task-tools");
    expect(generic).toBeDefined();
    const result = evaluateHarnessFlow(generic!);
    const eventTools = result.stepResults
      .flatMap((step) => step.decision.matchedRules)
      .join(" ");

    expect(result.signals).not.toContain("claude_leakage");
    expect(result.signals).not.toContain("opencode_leakage");
    expect(eventTools).not.toContain("task_creation_replay");
  });

  it("allows Claude native task setup immediately after plan approval", () => {
    const claude = standardHarnessFlowSpecs().find((spec) => spec.id === "claude-plan-build-rust");
    expect(claude).toBeDefined();
    const result = evaluateHarnessFlow(claude!);
    const nativeTaskStep = result.stepResults.find((step) => step.stepId === "native-task-setup");

    expect(nativeTaskStep).toBeDefined();
    expect(nativeTaskStep!.decision.pause).toBe(false);
    expect(nativeTaskStep!.decision.matchedRules).not.toContain("task_creation_replay");
    expect(nativeTaskStep!.decision.matchedRules).not.toContain("identical_tool_repeat");
  });

  it("allows early Claude Plan-subagent handoff before the first implementation edit", () => {
    const planHandoffSpec: HarnessFlowSpec = {
      id: "claude-plan-subagent-handoff",
      description: "Claude plan mode may use Explore/Plan subagents and one parent-agent plan reread before exiting plan mode.",
      profile: "claude-code",
      flowType: "plan-then-build",
      forbiddenRules: ["plan_reread_loop", "no_progress_loop"],
      steps: [
        {
          id: "subagent-plan-handoff",
          messages: [
            userText("/plan Build a complete Rust workspace application."),
            assistantCall("p1", "Explore", { description: "Explore Rust project structure" }),
            toolResult("p1", "Done (8 tool uses). Directories exist: cli, config, core, tests. No Rust files yet."),
            assistantCall("p2", "Plan", { description: "Design File Indexer Rust app" }),
            toolResult("p2", "Done (6 tool uses). Wrote .claude/plans/temp_plan_rust_file_indexer.md."),
            assistantCall("p3", "Read", { file_path: ".claude/plans/temp_plan_rust_file_indexer.md" }),
            toolResult("p3", "<SYNESIS_PLAN_LOADED path=\".claude/plans/temp_plan_rust_file_indexer.md\">Workspace setup - Cargo.toml, scaffold structure</SYNESIS_PLAN_LOADED>"),
            assistantCall("p4", "Read", { file_path: ".claude/plans/temp_plan_rust_file_indexer.md" }),
            toolResult("p4", "Unchanged since last read: .claude/plans/temp_plan_rust_file_indexer.md"),
          ],
          governorOptions: {
            clientPlanModeRequested: true,
            orchestratorWorkflowPhase: "planning",
            activePlanStage: "implement",
            taskLedgerOpenCount: 1,
            taskLedgerExplicitOpenCount: 1,
            chatState: { completionStatus: "blocked", lastVerificationOutcome: "fail" },
          },
          expectedRulesExclude: ["plan_reread_loop", "no_progress_loop"],
        },
      ],
    };

    const result = evaluateHarnessFlow(planHandoffSpec);
    expect(result.passed, result.signals.join(", ")).toBe(true);
    expect(result.stepResults[0]!.decision.pause).toBe(false);
    expect(result.stepResults[0]!.decision.matchedRules).not.toContain("plan_reread_loop");
    expect(result.stepResults[0]!.decision.matchedRules).not.toContain("no_progress_loop");
  });

  it("treats repeated source reads as a real loop in the negative control", () => {
    const repeatedReadSpec: HarnessFlowSpec = {
      id: "negative-repeated-source-read",
      description: "The flow layer must not make the governor toothless; repeated same-file reads should still pause.",
      profile: "generic-openai",
      flowType: "bugfix",
      forbiddenSignals: [],
      steps: [
        {
          id: "repeat-read",
          allowPause: true,
          messages: [
            userText("Fix helper.py now."),
            assistantCall("n1", "read_file", { path: "src/helper.py" }),
            toolResult("n1", "def helper(): return False"),
            assistantCall("n2", "read_file", { path: "src/helper.py" }),
            toolResult("n2", "def helper(): return False"),
            assistantCall("n3", "read_file", { path: "src/helper.py" }),
            toolResult("n3", "def helper(): return False"),
          ],
          expectedRulesInclude: ["source_file_stale_reread"],
        },
      ],
    };

    const result = evaluateHarnessFlow(repeatedReadSpec);
    const decision = result.stepResults[0]!.decision;
    expect(decision.pause).toBe(true);
    expect(decision.reason).toBe("source_file_stale_reread");
  });
});
