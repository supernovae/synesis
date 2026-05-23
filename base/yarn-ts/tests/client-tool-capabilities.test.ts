import { describe, expect, it } from "vitest";
import {
  buildClientToolCapabilityBlock,
  detectClientToolCapabilities,
  enrichToolDescriptionForClient,
  enrichToolSchemasForClient,
  isPlanModePrompt,
} from "../src/adapters/client-tool-capabilities.js";

describe("client tool capabilities", () => {
  it("detects OpenCode first-class planning tools", () => {
    const caps = detectClientToolCapabilities(
      [
        { function: { name: "bash" } },
        { function: { name: "todowrite" } },
        { function: { name: "question" } },
        { function: { name: "apply_patch" } },
        { function: { name: "websearch" } },
        { function: { name: "webfetch" } },
        { function: { name: "lsp" } },
      ],
      "opencode",
      "/plan build a new app",
    );

    expect(caps.isOpenCode).toBe(true);
    expect(caps.planModeRequested).toBe(true);
    expect(caps.todoToolName).toBe("todowrite");
    expect(caps.questionToolName).toBe("question");
    expect(caps.applyPatchToolName).toBe("apply_patch");
    expect(caps.hasWebSearchTool).toBe(true);
    expect(caps.hasWebFetchTool).toBe(true);
    expect(caps.hasLspTool).toBe(true);
  });

  it("recognizes /plan as explicit plan mode", () => {
    expect(isPlanModePrompt("/plan build a CLI")).toBe(true);
    expect(isPlanModePrompt(" /PLAN")).toBe(true);
    expect(isPlanModePrompt("please plan this")).toBe(false);
  });

  it("builds OpenCode tool guidance with todowrite and question", () => {
    const caps = detectClientToolCapabilities(
      [{ name: "todowrite" }, { name: "question" }, { name: "apply_patch" }],
      "opencode",
      "build a feature",
    );
    const block = buildClientToolCapabilityBlock(caps);

    expect(block).toContain("opencode_builtin_tools=");
    expect(block).toContain("task_tool=todowrite");
    expect(block).toContain("question_tool=question");
    expect(block).toContain("patch_tool=apply_patch");
    expect(block).toContain('"content":"Concrete task"');
    expect(block).toContain("Never call todowrite with arrays of strings, title-only items");
  });

  it("detects Claude Code native task, plan, agent, monitor, and LSP tools", () => {
    const caps = detectClientToolCapabilities(
      [
        { name: "TaskCreate" },
        { name: "TaskUpdate" },
        { name: "TaskList" },
        { name: "TaskGet" },
        { name: "EnterPlanMode" },
        { name: "ExitPlanMode" },
        { name: "AskUserQuestion" },
        { name: "Agent" },
        { name: "Monitor" },
        { name: "LSP" },
      ],
      "claude-code",
      "/plan design the implementation",
    );

    expect(caps.isClaudeCode).toBe(true);
    expect(caps.isOpenCode).toBe(false);
    expect(caps.planModeRequested).toBe(true);
    expect(caps.todoToolName).toBe("TaskUpdate");
    expect(caps.taskToolNames).toEqual(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
    expect(caps.questionToolName).toBe("AskUserQuestion");
    expect(caps.hasPlanModeTool).toBe(true);
    expect(caps.enterPlanModeToolName).toBe("EnterPlanMode");
    expect(caps.exitPlanModeToolName).toBe("ExitPlanMode");
    expect(caps.hasAgentTool).toBe(true);
    expect(caps.hasMonitorTool).toBe(true);
    expect(caps.hasLspTool).toBe(true);
  });

  it("infers Claude Code from native task and question tools even without client hint", () => {
    const caps = detectClientToolCapabilities(
      [{ name: "TaskCreate" }, { name: "TaskUpdate" }, { name: "AskUserQuestion" }],
      "unknown",
    );

    expect(caps.isClaudeCode).toBe(true);
    expect(caps.todoToolName).toBe("TaskUpdate");
  });

  it("builds Claude Code native tool guidance", () => {
    const caps = detectClientToolCapabilities(
      [{ name: "TaskCreate" }, { name: "TaskUpdate" }, { name: "EnterPlanMode" }, { name: "ExitPlanMode" }, { name: "AskUserQuestion" }, { name: "Agent" }, { name: "Monitor" }],
      "claude-code",
      "build a feature",
    );
    const block = buildClientToolCapabilityBlock(caps);

    expect(block).toContain("claude_code_builtin_tools=");
    expect(block).toContain("claude_code_task_tools=TaskCreate,TaskUpdate");
    expect(block).toContain("claude_code_plan_mode_tools=EnterPlanMode,ExitPlanMode");
    expect(block).toContain("prefer TaskCreate/TaskUpdate/TaskList/TaskGet over legacy TodoWrite");
    expect(block).toContain("Agent is for bounded subagent research");
  });

  it("enriches OpenCode tool descriptions", () => {
    const caps = detectClientToolCapabilities(
      [{ name: "todowrite" }, { name: "question" }],
      "opencode",
      "build a feature",
    );

    expect(enrichToolDescriptionForClient("todowrite", "Manage todos", caps))
      .toContain("3-7 concrete todos");
    expect(enrichToolDescriptionForClient("todowrite", "Manage todos", caps))
      .toContain("as each component finishes");
    expect(enrichToolDescriptionForClient("question", "Ask the user", caps))
      .toContain("real ambiguity");
  });

  it("enriches Claude Code tool descriptions", () => {
    const caps = detectClientToolCapabilities(
      [{ name: "TaskCreate" }, { name: "TaskUpdate" }, { name: "Agent" }, { name: "Monitor" }],
      "claude-code",
    );

    expect(enrichToolDescriptionForClient("TaskCreate", "Create a task", caps))
      .toContain("Claude Code native task list");
    expect(enrichToolDescriptionForClient("Agent", "Run a subagent", caps))
      .toContain("bounded autonomous research");
    expect(enrichToolDescriptionForClient("Grep", "Search files", caps))
      .toContain("ripgrep regex");
    expect(enrichToolDescriptionForClient("Monitor", "Watch output", caps))
      .toContain("background log/status/file-change watching");
  });

  it("enriches both OpenAI and Claude tool schema shapes", () => {
    const caps = detectClientToolCapabilities(
      [{ function: { name: "todowrite" } }, { name: "question" }],
      "opencode",
    );
    const tools = enrichToolSchemasForClient(
      [
        { type: "function", function: { name: "todowrite", description: "Manage todos" } },
        { name: "question", description: "Ask a question" },
      ],
      caps,
    ) as Array<Record<string, unknown>>;

    const todo = tools[0].function as Record<string, unknown>;
    expect(todo.description).toContain("3-7 concrete todos");
    expect(tools[1].description).toContain("real ambiguity");
  });
});
