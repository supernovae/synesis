import { describe, expect, it } from "vitest";
import {
  openAIToolsToSDK,
  claudeToolsToSDK,
  mapToolChoice,
  sdkToolCallsToOpenAI,
  sdkToolCallsToClaude,
  claudeMessagesToOpenAI
} from "../src/tool-mapping.js";

describe("openAIToolsToSDK", () => {
  it("returns undefined for empty/no tools", () => {
    expect(openAIToolsToSDK(undefined)).toBeUndefined();
    expect(openAIToolsToSDK([])).toBeUndefined();
  });

  it("converts OpenAI function tools to SDK ToolSet", () => {
    const tools = [
      { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }
    ];
    const result = openAIToolsToSDK(tools);
    expect(result).toBeDefined();
    expect(result!["read_file"]).toBeDefined();
    expect(result!["read_file"].description).toBe("Read a file");
  });
});

describe("claudeToolsToSDK", () => {
  it("returns undefined for empty/no tools", () => {
    expect(claudeToolsToSDK(undefined)).toBeUndefined();
    expect(claudeToolsToSDK([])).toBeUndefined();
  });

  it("converts Claude tools to SDK ToolSet", () => {
    const tools = [
      { name: "bash", description: "Run shell", input_schema: { type: "object", properties: { command: { type: "string" } } } }
    ];
    const result = claudeToolsToSDK(tools);
    expect(result).toBeDefined();
    expect(result!["bash"]).toBeDefined();
    expect(result!["bash"].description).toBe("Run shell");
  });
});

describe("mapToolChoice", () => {
  it("maps string values", () => {
    expect(mapToolChoice("auto")).toBe("auto");
    expect(mapToolChoice("none")).toBe("none");
    expect(mapToolChoice("required")).toBe("required");
    expect(mapToolChoice("any")).toBe("required");
  });

  it("maps object tool choice", () => {
    expect(mapToolChoice({ type: "tool", name: "bash" })).toEqual({ type: "tool", toolName: "bash" });
    expect(mapToolChoice({ type: "function", function: { name: "bash" } })).toEqual({ type: "tool", toolName: "bash" });
  });

  it("returns undefined for null/undefined", () => {
    expect(mapToolChoice(undefined)).toBeUndefined();
    expect(mapToolChoice(null)).toBeUndefined();
  });
});

describe("sdkToolCallsToOpenAI", () => {
  it("maps SDK tool calls to OpenAI format", () => {
    const result = sdkToolCallsToOpenAI([
      { toolCallId: "tc_1", toolName: "read_file", args: { path: "/foo" } }
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("tc_1");
    expect(result[0].type).toBe("function");
    expect(result[0].function.name).toBe("read_file");
    expect(JSON.parse(result[0].function.arguments)).toEqual({ path: "/foo" });
  });
});

describe("sdkToolCallsToClaude", () => {
  it("maps SDK tool calls to Claude content blocks", () => {
    const result = sdkToolCallsToClaude([
      { toolCallId: "tc_1", toolName: "bash", args: { command: "ls" } }
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("tool_use");
    expect(result[0].id).toBe("tc_1");
    expect(result[0].name).toBe("bash");
    expect(result[0].input).toEqual({ command: "ls" });
  });
});

describe("claudeMessagesToOpenAI", () => {
  it("converts simple text messages", () => {
    const result = claudeMessagesToOpenAI([
      { role: "user", content: "hello" }
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", content: "hello" });
  });

  it("converts tool_result blocks to tool-role messages", () => {
    const result = claudeMessagesToOpenAI([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tc_1", content: "file contents" }
        ]
      }
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    expect(result[0].content).toBe("file contents");
    expect(result[0].tool_call_id).toBe("tc_1");
  });

  it("applies tool_result reducer callback when provided", () => {
    const result = claudeMessagesToOpenAI(
      [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tc_1", content: "very large output" }
          ]
        }
      ],
      (content) => `REDUCED:${String(content)}`
    );
    expect(result[0].role).toBe("tool");
    expect(result[0].content).toBe("REDUCED:very large output");
  });

  it("handles mixed text and tool_result content blocks", () => {
    const result = claudeMessagesToOpenAI([
      {
        role: "user",
        content: [
          { type: "text", text: "Here are the results:" },
          { type: "tool_result", tool_use_id: "tc_1", content: "ok" }
        ]
      }
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("Here are the results:");
    expect(result[1].role).toBe("tool");
  });
});
