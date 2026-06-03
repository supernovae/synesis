import { describe, expect, it, vi } from "vitest";

import { assembleRouteModelMessages } from "../src/pipeline/route-model-message-assembly.js";
import type { ModelAdapter } from "../src/providers/model-adapter.js";

const adapter: ModelAdapter = {
  family: "test",
  supportsThinking: false,
  toolSystemPrompt: (toolCount) => `tool-count=${toolCount}`,
};

function baseInput(overrides: Partial<Parameters<typeof assembleRouteModelMessages>[0]> = {}) {
  return {
    adapter,
    effectiveTools: [{ name: "Read" }, { name: "Write" }],
    messages: [{ role: "user", content: "fix it" }],
    workspaceInspection: {
      isEmpty: false,
      projectInstructionFiles: [],
      root: "/repo",
    },
    forceReadRecovery: false,
    consecutiveEditContextMisses: 0,
    stateReground: {
      required: false,
      recommendedReadPath: null,
      reasons: [],
    },
    buildEditContextMissGuardPrompt: vi.fn((filePath: string, missCount: number) =>
      `edit-guard:${filePath}:${missCount}`
    ),
    buildEditContextMissForcedReadPrompt: vi.fn((filePath?: string) =>
      `forced-read:${filePath ?? ""}`
    ),
    buildStateRegroundReadPrompt: vi.fn((filePath: string, reasons: string[]) =>
      `reground:${filePath}:${reasons.join(",")}`
    ),
    ...overrides,
  };
}

describe("assembleRouteModelMessages", () => {
  it("prepends adapter tool prompt and preserves base messages", () => {
    const result = assembleRouteModelMessages(baseInput());

    expect(result.toolPrompt).toContain("tool-count=2");
    expect(result.messages[0]).toEqual({ role: "system", content: result.toolPrompt });
    expect(result.messages[1]).toEqual({ role: "user", content: "fix it" });
  });

  it("appends route guidance blocks in existing order", () => {
    const result = assembleRouteModelMessages(baseInput({
      workspaceInspection: {
        isEmpty: true,
        projectInstructionFiles: [],
        root: "/repo",
      },
      policyPivotPrompt: "policy-pivot",
      editMissGuard: { active: true, filePath: "src/app.ts", missCount: 2 },
      stateReground: {
        required: true,
        recommendedReadPath: "src/state.ts",
        reasons: ["stale"],
      },
      promptIntakeSystemBlock: "prompt-intake",
    }));

    const contents = result.messages.map((message) => String(message.content));
    expect(contents[0]).toContain("tool-count=2");
    const systemContent = contents[0];
    expect(systemContent).toContain("workspace is empty");
    expect(systemContent).toContain("workspace_inspection=complete");
    expect(systemContent).toContain("CLAUDE.md:absent");
    expect(systemContent).toContain("Do not re-read or claim absent project instruction files");
    expect(systemContent).toContain("policy-pivot");
    expect(systemContent).toContain("edit-guard:src/app.ts:2");
    expect(systemContent).toContain("reground:src/state.ts:stale");
    expect(systemContent).toContain("prompt-intake");
    expect(systemContent.indexOf("policy-pivot")).toBeLessThan(systemContent.indexOf("edit-guard:src/app.ts:2"));
    expect(systemContent.indexOf("edit-guard:src/app.ts:2")).toBeLessThan(systemContent.indexOf("reground:src/state.ts:stale"));
    expect(systemContent.indexOf("reground:src/state.ts:stale")).toBeLessThan(systemContent.indexOf("prompt-intake"));
  });

  it("uses forced-read recovery prompt when force read is active", () => {
    const buildEditContextMissGuardPrompt = vi.fn(() => "guard");
    const buildEditContextMissForcedReadPrompt = vi.fn(() => "forced");
    const result = assembleRouteModelMessages(baseInput({
      forceReadRecovery: true,
      latestReadRefreshFilePath: "src/read.ts",
      buildEditContextMissGuardPrompt,
      buildEditContextMissForcedReadPrompt,
    }));

    expect(result.messages[0].role).toBe("system");
    expect(String(result.messages[0].content)).toContain("forced");
    expect(buildEditContextMissForcedReadPrompt).toHaveBeenCalledWith("src/read.ts");
    expect(buildEditContextMissGuardPrompt).not.toHaveBeenCalled();
  });

  it("skips optional blocks when guards are inactive", () => {
    const result = assembleRouteModelMessages(baseInput({
      adapter: { family: "test", supportsThinking: false },
      effectiveTools: [],
      messages: [{ role: "user", content: "hello" }],
      workspaceInspection: {
        isEmpty: true,
        projectInstructionFiles: ["README.md"],
        root: "/repo",
      },
    }));

    expect(result.toolPrompt).toBeUndefined();
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});
