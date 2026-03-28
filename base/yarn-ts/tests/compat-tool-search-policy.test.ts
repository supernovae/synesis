import { describe, it, expect } from "vitest";
import { applyToolSearchPolicy } from "../src/compat/tool-search-policy.js";

describe("applyToolSearchPolicy", () => {
  it("returns undefined tools unchanged", () => {
    const { tools, strippedDeferredCount } = applyToolSearchPolicy(undefined);
    expect(tools).toBeUndefined();
    expect(strippedDeferredCount).toBe(0);
  });

  it("returns empty array unchanged", () => {
    const { tools } = applyToolSearchPolicy([]);
    expect(tools).toEqual([]);
  });

  describe("disable mode (default)", () => {
    it("strips defer_loading from tools", () => {
      const input = [
        { name: "read_file", defer_loading: true, input_schema: {} },
        { name: "write_file", input_schema: {} },
      ];
      const { tools, strippedDeferredCount } = applyToolSearchPolicy(input, "disable");
      expect(strippedDeferredCount).toBe(1);
      expect(tools![0]).not.toHaveProperty("defer_loading");
      expect(tools![1]).toEqual({ name: "write_file", input_schema: {} });
    });

    it("strips tool_reference content blocks", () => {
      const input = [
        {
          name: "search",
          content: [
            { type: "text", text: "hello" },
            { type: "tool_reference", tool_name: "bash" },
          ],
        },
      ];
      const { tools } = applyToolSearchPolicy(input, "disable");
      const content = tools![0].content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("text");
    });

    it("does not mutate the original array", () => {
      const input = [{ name: "bash", defer_loading: true }];
      applyToolSearchPolicy(input, "disable");
      expect(input[0].defer_loading).toBe(true);
    });
  });

  describe("passthrough mode", () => {
    it("preserves all fields including defer_loading", () => {
      const input = [
        { name: "read_file", defer_loading: true, input_schema: {} },
      ];
      const { tools, strippedDeferredCount } = applyToolSearchPolicy(input, "passthrough");
      expect(strippedDeferredCount).toBe(0);
      expect(tools).toBe(input);
      expect(tools![0].defer_loading).toBe(true);
    });
  });
});
