import { describe, expect, it } from "vitest";
import {
  openAIToolsToSDK,
  claudeToolsToSDK,
  mapToolChoice,
  sdkToolCallsToOpenAI,
  sdkToolCallsToClaude,
  claudeMessagesToOpenAI,
  ensureSystemMessagesAtBeginning,
  sanitizeToolCalls
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

  it("returns undefined for invalid values", () => {
    expect(mapToolChoice("sometimes")).toBeUndefined();
    expect(mapToolChoice({ type: "weird" })).toBeUndefined();
  });
});

describe("sdkToolCallsToOpenAI", () => {
  it("maps SDK tool calls to OpenAI format", () => {
    const result = sdkToolCallsToOpenAI([
      { toolCallId: "tc_1", toolName: "read_file", input: { path: "/foo" } }
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
      { toolCallId: "tc_1", toolName: "bash", input: { command: "ls" } }
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
    expect(result[0].role).toBe("tool");
    expect(result[1].content).toBe("Here are the results:");
  });

  it("preserves tool_use blocks as OpenAI tool_calls on assistant messages", () => {
    const result = claudeMessagesToOpenAI([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me list the files." },
          { type: "tool_use", id: "toolu_01", name: "bash", input: { command: "ls -la" } }
        ]
      }
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toBe("Let me list the files.");
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].tool_calls![0].id).toBe("toolu_01");
    expect(result[0].tool_calls![0].function.name).toBe("bash");
    expect(JSON.parse(result[0].tool_calls![0].function.arguments)).toEqual({ command: "ls -la" });
  });

  it("pairs tool_use and tool_result correctly in a conversation", () => {
    const result = claudeMessagesToOpenAI([
      { role: "user", content: "List files" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_01", name: "bash", input: { command: "ls" } }
        ]
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: "file1.ts\nfile2.ts" }
        ]
      }
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "user", content: "List files" });
    expect(result[1].role).toBe("assistant");
    expect(result[1].tool_calls).toHaveLength(1);
    expect(result[1].tool_calls![0].id).toBe("toolu_01");
    expect(result[2].role).toBe("tool");
    expect(result[2].tool_call_id).toBe("toolu_01");
    expect(result[2].content).toBe("file1.ts\nfile2.ts");
  });

  it("passes through unchanged hint as-is (replay is handled by the normalizer layer)", () => {
    const result = claudeMessagesToOpenAI([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_read_1", name: "Read", input: { file_path: "/tmp/plan.md" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_read_1", content: "# Plan\n- item 1\n- item 2" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_read_2", name: "Read", input: { file_path: "/tmp/plan.md" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_read_2", content: "Unchanged since last read" },
        ],
      },
    ]);
    const toolMsgs = result.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0].content).toBe("# Plan\n- item 1\n- item 2");
    // claudeMessagesToOpenAI passes the stub through; normalizeReadSnapshotMessages
    // replays the file content when it processes these messages server-side.
    expect(toolMsgs[1].content).toBe("Unchanged since last read");
  });

  it("passes tool_use_id to reducer callback", () => {
    const seen: Array<{ id?: string; name?: string; content: string }> = [];
    claudeMessagesToOpenAI(
      [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_read_1", name: "Read", input: { file_path: "/tmp/plan.md" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_read_1", content: "plan content" },
          ],
        },
      ],
      (content, toolName, toolUseId) => {
        seen.push({ id: toolUseId, name: toolName, content: String(content) });
        return String(content);
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ id: "toolu_read_1", name: "Read", content: "plan content" });
  });
});

describe("ensureSystemMessagesAtBeginning", () => {
  it("moves late system messages to the beginning", () => {
    const messages = [
      { role: "system", content: "stable-core" },
      { role: "user", content: "first user turn" },
      { role: "assistant", content: "assistant response" },
      { role: "system", content: "task frame" },
      { role: "tool", content: "tool result", tool_call_id: "call_1" },
      { role: "system", content: "live context" },
    ];

    const result = ensureSystemMessagesAtBeginning(messages as never);

    expect(result.map((m) => m.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(result[0].content).toBe("stable-core");
    expect(result[1].content).toBe("task frame");
    expect(result[2].content).toBe("live context");
    expect(result[3].content).toBe("first user turn");
    expect(result[4].content).toBe("assistant response");
    expect(result[5].content).toBe("tool result");
  });

  it("returns the same array when system messages already lead", () => {
    const messages = [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];

    const result = ensureSystemMessagesAtBeginning(messages as never);
    expect(result).toBe(messages);
  });
});

describe("sanitizeToolCalls", () => {
  it("passes through well-formed messages unchanged", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "thinking", tool_calls: [
        { id: "call_1", type: "function", function: { name: "Glob", arguments: '{"pattern":"*.ts"}' } }
      ]},
      { role: "tool", content: "file.ts", tool_call_id: "call_1" },
    ];
    const result = sanitizeToolCalls(msgs as never);
    expect(result[1].tool_calls![0].id).toBe("call_1");
    expect(result[2].tool_call_id).toBe("call_1");
  });

  it("generates synthetic ID for empty tool_call id", () => {
    const msgs = [
      { role: "assistant", content: "let me check", tool_calls: [
        { id: "", type: "function", function: { name: "Glob", arguments: '{}' } }
      ]},
      { role: "tool", content: "result", tool_call_id: "" },
    ];
    const result = sanitizeToolCalls(msgs as never);
    expect(result[0].tool_calls![0].id).toMatch(/^call_synth_/);
    expect(result[1].tool_call_id).toBe(result[0].tool_calls![0].id);
  });

  it("fills missing function.arguments with '{}'", () => {
    const msgs = [
      { role: "assistant", content: "", tool_calls: [
        { id: "call_1", type: "function", function: { name: "Glob" } }
      ]},
      { role: "tool", content: "result", tool_call_id: "call_1" },
    ];
    const result = sanitizeToolCalls(msgs as never);
    expect(result[0].tool_calls![0].function.arguments).toBe("{}");
  });

  it("handles missing function object entirely", () => {
    const msgs = [
      { role: "assistant", content: "", tool_calls: [
        { id: "", type: "function" }
      ]},
      { role: "tool", content: "result", tool_call_id: "" },
    ];
    const result = sanitizeToolCalls(msgs as never);
    expect(result[0].tool_calls![0].function.name).toBe("");
    expect(result[0].tool_calls![0].function.arguments).toBe("{}");
    expect(result[0].tool_calls![0].id).toMatch(/^call_synth_/);
  });

  it("matches multiple empty-id tool calls to subsequent tool messages in order", () => {
    const msgs = [
      { role: "assistant", content: "", tool_calls: [
        { id: "", type: "function", function: { name: "A", arguments: "{}" } },
        { id: "", type: "function", function: { name: "B", arguments: "{}" } },
      ]},
      { role: "tool", content: "a-result" },
      { role: "tool", content: "b-result" },
    ];
    const result = sanitizeToolCalls(msgs as never);
    const [idA, idB] = result[0].tool_calls!.map((tc: { id: string }) => tc.id);
    expect(idA).not.toBe(idB);
    expect(result[1].tool_call_id).toBe(idA);
    expect(result[2].tool_call_id).toBe(idB);
  });

  it("does not rewrite tool messages that already have valid tool_call_id", () => {
    const msgs = [
      { role: "assistant", content: "", tool_calls: [
        { id: "existing_id", type: "function", function: { name: "A", arguments: "{}" } },
      ]},
      { role: "tool", content: "result", tool_call_id: "existing_id" },
    ];
    const result = sanitizeToolCalls(msgs as never);
    expect(result[1].tool_call_id).toBe("existing_id");
  });

  it("drops orphaned tool calls with an ID that has no matching tool result", () => {
    const msgs = [
      { role: "assistant", content: "I will call a tool", tool_calls: [
        { id: "call_1", type: "function", function: { name: "A", arguments: "{}" } },
      ]},
    ];
    const result = sanitizeToolCalls(msgs as never);
    expect(result[0].tool_calls).toBeUndefined();
    expect(result[0].content).toBe("I will call a tool");
  });

  it("drops orphaned tool calls without an ID that have no matching empty tool result", () => {
    const msgs = [
      { role: "assistant", content: "I will call a tool", tool_calls: [
        { id: "", type: "function", function: { name: "A", arguments: "{}" } },
      ]},
    ];
    const result = sanitizeToolCalls(msgs as never);
    expect(result[0].tool_calls).toBeUndefined();
    expect(result[0].content).toBe("I will call a tool");
  });

  it("drops orphaned tool messages that have no matching tool call", () => {
    const msgs = [
      { role: "assistant", content: "I will call a tool" },
      { role: "tool", content: "result", tool_call_id: "orphaned_id" },
    ];
    const result = sanitizeToolCalls(msgs as never);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
  });

  it("drops orphaned tool messages without an ID that have no matching empty tool call", () => {
    const msgs = [
      { role: "assistant", content: "I will call a tool" },
      { role: "tool", content: "result", tool_call_id: "" },
    ];
    const result = sanitizeToolCalls(msgs as never);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
  });

  it("preserves valid tool calls and drops invalid ones in the same message", () => {
    const msgs = [
      { role: "assistant", content: "I will call two tools", tool_calls: [
        { id: "call_1", type: "function", function: { name: "A", arguments: "{}" } },
        { id: "call_2", type: "function", function: { name: "B", arguments: "{}" } },
      ]},
      { role: "tool", content: "result", tool_call_id: "call_1" },
    ];
    const result = sanitizeToolCalls(msgs as never);
    expect(result[0].tool_calls).toHaveLength(1);
    expect(result[0].tool_calls![0].id).toBe("call_1");
  });

  it("reorders out-of-order tool results immediately after matching assistant tool calls", () => {
    const msgs = [
      { role: "assistant", content: "I will run a tool", tool_calls: [
        { id: "call_1", type: "function", function: { name: "Glob", arguments: '{"glob_pattern":"*.ts"}' } },
      ]},
      { role: "user", content: "Thanks, continue." },
      { role: "tool", content: "file.ts", tool_call_id: "call_1" },
    ];
    const result = sanitizeToolCalls(msgs as never);
    expect(result.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(result[1].tool_call_id).toBe("call_1");
  });
});

describe("vercel tool protocol ordering", () => {
  it("normalizes claude-converted history to assistant -> tool-result ordering", () => {
    const converted = claudeMessagesToOpenAI([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_01", name: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "continuing" },
          { type: "tool_result", tool_use_id: "toolu_01", content: "ok" },
        ],
      },
    ]);
    const sanitized = sanitizeToolCalls(converted as never);
    expect(sanitized.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(sanitized[1].tool_call_id).toBe("toolu_01");
  });
});

