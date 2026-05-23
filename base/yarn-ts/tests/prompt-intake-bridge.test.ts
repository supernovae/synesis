import { describe, expect, it } from "vitest";
import {
  evaluateYarnPromptIntakeSteer,
  readPromptIntakeRequestOptions,
} from "../src/upper-harness/bridge.js";

describe("Yarn prompt intake bridge", () => {
  it("leaves micro prompts unmodified", () => {
    const result = evaluateYarnPromptIntakeSteer({
      enabled: true,
      latestUserPrompt: "fix the missing import in src/auth.ts",
      metadata: {},
    });

    expect(result.decision.scope).toBe("micro");
    expect(result.shouldAppend).toBe(false);
    expect(result.systemBlock).toBeUndefined();
  });

  it("adds an advisory block for macro prompts", () => {
    const result = evaluateYarnPromptIntakeSteer({
      enabled: true,
      latestUserPrompt: "build a new app with auth, billing, and an admin UI",
      metadata: {},
    });

    expect(result.decision.scope).toBe("macro");
    expect(result.shouldAppend).toBe(true);
    expect(result.systemBlock).toContain("planning_suggested");
    expect(result.systemBlock).toContain("Keep this advisory");
    expect(result.metadataSnapshot.planning_steered).toBe(true);
  });

  it("uses native OpenCode planning tools when available", () => {
    const result = evaluateYarnPromptIntakeSteer({
      enabled: true,
      latestUserPrompt: "build a new app with auth, billing, and an admin UI",
      metadata: {},
      clientToolCapabilities: {
        clientKind: "opencode",
        toolNames: ["todowrite", "question", "apply_patch"],
        isOpenCode: true,
        isClaudeCode: false,
        planModeRequested: false,
        hasTodoTool: true,
        todoToolName: "todowrite",
        taskToolNames: [],
        hasQuestionTool: true,
        questionToolName: "question",
        hasApplyPatchTool: true,
        applyPatchToolName: "apply_patch",
        hasAgentTool: false,
        hasMonitorTool: false,
        hasPlanModeTool: false,
        enterPlanModeToolName: null,
        exitPlanModeToolName: null,
        hasLspTool: false,
        hasSkillTool: false,
        hasWebFetchTool: false,
        hasWebSearchTool: false,
      },
    });

    expect(result.systemBlock).toContain("calling question");
    expect(result.systemBlock).toContain("calling todowrite");
    expect(result.systemBlock).toContain("3-7 concrete todos");
    expect(result.systemBlock).toContain('"content":"Concrete task"');
    expect(result.systemBlock).toContain("Use content, not title");
    expect(result.metadataSnapshot.task_tool).toBe("todowrite");
    expect(result.metadataSnapshot.question_tool).toBe("question");
  });

  it("treats /plan as explicit plan-only mode even for micro-looking prompts", () => {
    const result = evaluateYarnPromptIntakeSteer({
      enabled: true,
      latestUserPrompt: "/plan fix the missing import in src/auth.ts",
      metadata: {},
      clientToolCapabilities: {
        clientKind: "opencode",
        toolNames: ["todowrite", "question"],
        isOpenCode: true,
        isClaudeCode: false,
        planModeRequested: true,
        hasTodoTool: true,
        todoToolName: "todowrite",
        taskToolNames: [],
        hasQuestionTool: true,
        questionToolName: "question",
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
      },
    });

    expect(result.shouldAppend).toBe(true);
    expect(result.systemBlock).toContain('action="plan_mode_requested"');
    expect(result.systemBlock).toContain("Do not perform implementation edits");
    expect(result.metadataSnapshot.plan_mode_requested).toBe(true);
  });

  it("honors metadata override", () => {
    const result = evaluateYarnPromptIntakeSteer({
      enabled: true,
      latestUserPrompt: "build a new app with auth, billing, and an admin UI",
      metadata: { synesis_planning_override: true },
    });

    expect(result.decision.scope).toBe("macro");
    expect(result.decision.override).toBe(true);
    expect(result.shouldAppend).toBe(false);
  });

  it("honors natural-language refusal without requiring metadata", () => {
    const result = evaluateYarnPromptIntakeSteer({
      enabled: true,
      latestUserPrompt: "skip planning and build the new app now",
      metadata: {},
    });

    expect(result.decision.scope).toBe("macro");
    expect(result.decision.override).toBe(true);
    expect(result.shouldAppend).toBe(false);
  });

  it("honors extra_body override and style text", () => {
    const opts = readPromptIntakeRequestOptions({
      metadata: {},
      extraBody: {
        synesis_planning_override: "yes",
        synesis_custom_style: "Skip explanations.",
      },
    });

    expect(opts.planningOverride).toBe(true);
    expect(opts.customStyle).toBe("Skip explanations.");
  });

  it("feature flag disables the block without losing classification metadata", () => {
    const result = evaluateYarnPromptIntakeSteer({
      enabled: false,
      latestUserPrompt: "build a new app with auth, billing, and an admin UI",
      metadata: {},
    });

    expect(result.decision.scope).toBe("macro");
    expect(result.decision.action).toBe("steer");
    expect(result.shouldAppend).toBe(false);
    expect(result.metadataSnapshot.enabled).toBe(false);
  });
});
