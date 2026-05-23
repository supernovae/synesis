import { describe, expect, it } from "vitest";
import {
  applyAdapterToolHardening,
  prepareGovernedToolCall,
} from "../src/governance/tool-call-governor-service.js";
import type { ModelAdapter } from "../src/providers/model-adapter.js";

const adapter: ModelAdapter = {
  family: "test",
  supportsThinking: false,
  remapToolArgs(toolName, input) {
    if (toolName === "Write" && "path" in input && !("file_path" in input)) {
      return { input: { ...input, file_path: input.path }, remapped: true };
    }
    return { input, remapped: false };
  },
};

describe("tool-call-governor-service", () => {
  it("applies adapter hardening without HTTP/session context", () => {
    const hard = applyAdapterToolHardening(adapter, "Write", { path: "a.txt", content: "x" });

    expect(hard.toolName).toBe("Write");
    expect(hard.input).toMatchObject({ file_path: "a.txt", content: "x" });
    expect(hard.remapped).toBe(true);
  });

  it("composes hardening, path governance, and unavailable-tool rewrite", () => {
    const prepared = prepareGovernedToolCall({
      adapter,
      toolCallId: "tc1",
      toolName: "Glob",
      input: { pattern: "**/*.ts" },
      governanceOptions: {
        enforcePathRoot: false,
        blockBashPathDrift: false,
        blockWriteCapableTools: false,
      },
      availability: {
        offeredToolSet: new Set(["bash"]),
        offeredToolNames: ["Bash"],
        fallbackBashToolName: "Bash",
      },
    });

    expect(prepared.hardening.toolName).toBe("Glob");
    expect(prepared.governed.toolName).toBe("Glob");
    expect(prepared.unavailableRewrite).toMatchObject({ rewritten: true, requestedTool: "Glob" });
    expect(prepared.call.toolName).toBe("Bash");
    expect(String(prepared.call.input.command)).toContain("requested unavailable tool");
  });
});
