import { describe, expect, it } from "vitest";
import {
  appendSystemMessageAndNormalize,
  normalizeSystemMessageOrdering,
} from "../src/transcript/system-message-ordering.js";

describe("system message ordering normalization", () => {
  it("normalizes late system guidance for OpenAI-style messages", () => {
    const input = [
      { role: "system", content: "client steering" },
      { role: "user", content: "Implement feature" },
      { role: "assistant", content: "Starting now" },
    ];

    const out = appendSystemMessageAndNormalize(input, "policy guidance");
    expect(out.filter((m) => m.role === "system")).toHaveLength(2);
    expect(out[0]?.role).toBe("system");
    expect(out[1]?.role).toBe("system");
    expect(out[2]?.role).toBe("user");
    expect(out[3]?.role).toBe("assistant");
  });

  it("preserves assistant/tool adjacency while reordering Claude/OpenAI-converted turns", () => {
    const input = [
      { role: "system", content: "agent.md guidance" },
      { role: "user", content: "Fix parser" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function" as const,
            function: { name: "Read", arguments: "{\"path\":\"src/parser.ts\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
      { role: "system", content: "late recovery hint" },
    ];

    const out = normalizeSystemMessageOrdering(input);
    expect(out[0]?.role).toBe("system");
    expect(out[1]?.role).toBe("system");
    const assistantIdx = out.findIndex((m) => m.role === "assistant");
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(out[assistantIdx + 1]?.role).toBe("tool");
    expect((out[assistantIdx + 1] as { tool_call_id?: string }).tool_call_id).toBe("call_1");
  });

  it("keeps ACP/OpenAI request ordering consistent after repeated policy appends", () => {
    const base = [
      { role: "system", content: "workspace context" },
      { role: "user", content: "Run tests and summarize" },
    ];
    const once = appendSystemMessageAndNormalize(base, "phase-required retry prompt");
    const twice = appendSystemMessageAndNormalize(once, "fallback prompt");
    expect(twice[0]?.role).toBe("system");
    expect(twice[1]?.role).toBe("system");
    expect(twice[2]?.role).toBe("system");
    expect(twice[3]?.role).toBe("user");
  });
});
