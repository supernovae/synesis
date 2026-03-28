import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudeMessagesToOpenAI,
  claudeToolsToSDK,
  mapToolChoice,
} from "../src/tool-mapping.js";
import {
  ClaudeMessagesRequestSchema,
} from "../src/schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "claude_code");

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));
}

describe("Claude Messages schema parsing", () => {
  it("parses non-streaming request", () => {
    const fixture = loadFixture("non_streaming_request.json");
    const result = ClaudeMessagesRequestSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("claude-opus-4-6");
      expect(result.data.max_tokens).toBe(1024);
      expect(result.data.messages).toHaveLength(1);
    }
  });

  it("parses streaming request", () => {
    const fixture = loadFixture("streaming_request.json");
    const result = ClaudeMessagesRequestSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stream).toBe(true);
    }
  });

  it("parses tool_use request with input_schema tools", () => {
    const fixture = loadFixture("tool_use_request.json");
    const result = ClaudeMessagesRequestSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toHaveLength(1);
      const tool = result.data.tools![0] as Record<string, unknown>;
      expect(tool.name).toBe("get_weather");
      expect(tool.input_schema).toBeDefined();
    }
  });

  it("parses thinking request", () => {
    const fixture = loadFixture("thinking_request.json");
    const result = ClaudeMessagesRequestSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    }
  });

  it("parses top-level system as string", () => {
    const fixture = loadFixture("system_string_request.json");
    const result = ClaudeMessagesRequestSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.system).toBe("You are a helpful coding assistant.");
    }
  });

  it("parses top-level system as content-block array", () => {
    const fixture = loadFixture("system_blocks_request.json");
    const result = ClaudeMessagesRequestSchema.safeParse(fixture);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Array.isArray(result.data.system)).toBe(true);
      const blocks = result.data.system as Array<{ type: string; text: string }>;
      expect(blocks).toHaveLength(2);
      expect(blocks[0].text).toContain("helpful assistant");
    }
  });

  it("parses temperature, top_p, stop_sequences, metadata", () => {
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ["\n\nHuman:"],
      metadata: { user_id: "test-user" },
    };
    const result = ClaudeMessagesRequestSchema.safeParse(body);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.temperature).toBe(0.7);
      expect(result.data.top_p).toBe(0.9);
      expect(result.data.stop_sequences).toEqual(["\n\nHuman:"]);
      expect(result.data.metadata).toEqual({ user_id: "test-user" });
    }
  });

  it("rejects missing required fields", () => {
    const body = { model: "claude-sonnet-4-6", messages: [] };
    const result = ClaudeMessagesRequestSchema.safeParse(body);
    expect(result.success).toBe(false);
  });
});

describe("Claude message conversion (fixture round-trips)", () => {
  it("converts simple text message", () => {
    const fixture = loadFixture("non_streaming_request.json");
    const messages = fixture.messages as Array<{ role: string; content: unknown }>;
    const result = claudeMessagesToOpenAI(messages as never);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("What is the capital of France?");
  });

  it("converts multipart tool_result conversation", () => {
    const fixture = loadFixture("tool_result_multipart.json");
    const messages = fixture.messages as Array<{ role: string; content: unknown }>;
    const result = claudeMessagesToOpenAI(messages as never);

    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("What's the weather?");

    // Assistant with text + tool_use
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toBe("I'll check the weather for you.");
    expect(result[1].tool_calls).toHaveLength(1);
    expect(result[1].tool_calls![0].id).toBe("toolu_01abc");
    expect(result[1].tool_calls![0].function.name).toBe("get_weather");

    // tool_result → tool message
    expect(result[2].role).toBe("tool");
    expect(result[2].content).toBe("72°F, sunny");
    expect(result[2].tool_call_id).toBe("toolu_01abc");
  });

  it("converts tool_use request's tools to SDK ToolSet", () => {
    const fixture = loadFixture("tool_use_request.json");
    const tools = fixture.tools as Array<{ name: string; input_schema: Record<string, unknown> }>;
    const sdkTools = claudeToolsToSDK(tools);
    expect(sdkTools).toBeDefined();
    expect(sdkTools!["get_weather"]).toBeDefined();
    expect(sdkTools!["get_weather"].description).toBe("Get the current weather in a given location");
  });
});

describe("Claude tool_choice mapping", () => {
  it("maps Claude auto/none/any/tool semantics", () => {
    expect(mapToolChoice("auto")).toBe("auto");
    expect(mapToolChoice("none")).toBe("none");
    expect(mapToolChoice("any")).toBe("required");
    expect(mapToolChoice({ type: "tool", name: "bash" })).toEqual({
      type: "tool",
      toolName: "bash",
    });
  });
});
