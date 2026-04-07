import { describe, expect, it } from "vitest";
import { openAIToolsToSDK, sanitizeToolCalls } from "../src/tool-mapping.js";
import { stableJsonStringify } from "../src/compat/sorted-tools.js";

describe("prefix stability regressions", () => {
  it("builds SDK tools deterministically regardless of input order", () => {
    const a = openAIToolsToSDK([
      { type: "function", function: { name: "Write", parameters: { type: "object", properties: { path: { type: "string" } } } } },
      { type: "function", function: { name: "Bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
    ]);
    const b = openAIToolsToSDK([
      { type: "function", function: { name: "Bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
      { type: "function", function: { name: "Write", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    ]);
    expect(stableJsonStringify(a)).toBe(stableJsonStringify(b));
  });

  it("uses deterministic synthetic tool-call ids without timestamps", () => {
    const sanitized = sanitizeToolCalls([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "", type: "function", function: { name: "Bash", arguments: "{}" } }],
      },
      { role: "tool", content: "ok", tool_call_id: "" },
    ] as never);

    const generated = sanitized[0].tool_calls?.[0]?.id ?? "";
    expect(generated).toMatch(/^call_synth_\d+$/);
    expect(generated.split("_")).toHaveLength(3);
  });
});

