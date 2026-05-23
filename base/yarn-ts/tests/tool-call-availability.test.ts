import { describe, expect, it } from "vitest";
import {
  buildOfferedToolNameSet,
  findOfferedToolNameByCanonical,
  listOfferedToolNames,
  restoreGuardrailCallForClient,
  rewriteUnavailableToolCall,
} from "../src/tools/tool-call-availability.js";

const tools = [
  { type: "function", function: { name: "Bash" } },
  { type: "function", function: { name: "read_file" } },
  { type: "function", function: { name: "Bash" } },
];

describe("tool call availability helpers", () => {
  it("lists offered tool names once in schema order", () => {
    expect(listOfferedToolNames(tools)).toEqual(["Bash", "read_file"]);
  });

  it("builds lookup set with raw and canonical names", () => {
    const set = buildOfferedToolNameSet(tools);
    expect(set.has("bash")).toBe(true);
    expect(set.has("read")).toBe(true);
  });

  it("finds the offered tool name by canonical name", () => {
    expect(findOfferedToolNameByCanonical(tools, "Read")).toBe("read_file");
  });

  it("rewrites unavailable calls to the fallback Bash tool", () => {
    const result = rewriteUnavailableToolCall(
      { toolCallId: "tc1", toolName: "Glob", input: { pattern: "**/*.ts" } },
      buildOfferedToolNameSet(tools),
      listOfferedToolNames(tools),
      "Bash",
    );

    expect(result.rewritten).toBe(true);
    expect(result.requestedTool).toBe("Glob");
    expect(result.call.toolName).toBe("Bash");
    expect(result.call.input.description).toBe("Blocked unavailable tool call");
    expect(String(result.call.input.command)).toContain("requested unavailable tool");
  });

  it("restores guarded call inputs to client schema", () => {
    const restored = restoreGuardrailCallForClient(
      { toolCallId: "tc1", toolName: "write_file", input: { path: "a.txt", content: "x" } },
      [{ type: "function", function: { name: "write_file" } }],
      "opencode",
    );

    expect(restored.toolName).toBe("write_file");
    expect(restored.input).toMatchObject({ path: "a.txt", content: "x" });
  });
});
