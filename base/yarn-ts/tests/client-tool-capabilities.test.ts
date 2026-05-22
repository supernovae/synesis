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
  });

  it("enriches OpenCode tool descriptions", () => {
    const caps = detectClientToolCapabilities(
      [{ name: "todowrite" }, { name: "question" }],
      "opencode",
      "build a feature",
    );

    expect(enrichToolDescriptionForClient("todowrite", "Manage todos", caps))
      .toContain("3-7 concrete todos");
    expect(enrichToolDescriptionForClient("question", "Ask the user", caps))
      .toContain("real ambiguity");
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
