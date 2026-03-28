import { describe, it, expect } from "vitest";

/**
 * Tests the Claude system-merge logic (equivalent to claudeSystemToMessage
 * in index.ts). Since that's an inline function, we reimplement the same
 * logic here for unit coverage.
 */

function claudeSystemToMessage(system: unknown): { role: "system"; content: string } | null {
  if (!system) return null;
  if (typeof system === "string") {
    return system.length > 0 ? { role: "system", content: system } : null;
  }
  if (Array.isArray(system)) {
    const textParts = system
      .filter((b: unknown) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text")
      .map((b: unknown) => String((b as Record<string, unknown>).text ?? ""));
    const joined = textParts.join("\n");
    return joined.length > 0 ? { role: "system", content: joined } : null;
  }
  return null;
}

describe("claudeSystemToMessage", () => {
  it("returns null for undefined/null", () => {
    expect(claudeSystemToMessage(undefined)).toBeNull();
    expect(claudeSystemToMessage(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(claudeSystemToMessage("")).toBeNull();
  });

  it("converts plain string to system message", () => {
    const result = claudeSystemToMessage("You are a helpful assistant.");
    expect(result).toEqual({ role: "system", content: "You are a helpful assistant." });
  });

  it("converts content-block array to system message", () => {
    const blocks = [
      { type: "text", text: "First instruction." },
      { type: "text", text: "Second instruction." },
    ];
    const result = claudeSystemToMessage(blocks);
    expect(result).toEqual({
      role: "system",
      content: "First instruction.\nSecond instruction.",
    });
  });

  it("ignores non-text blocks in array", () => {
    const blocks = [
      { type: "text", text: "Hello." },
      { type: "image", source: {} },
    ];
    const result = claudeSystemToMessage(blocks);
    expect(result).toEqual({ role: "system", content: "Hello." });
  });

  it("returns null for array with no text blocks", () => {
    const blocks = [{ type: "image", source: {} }];
    expect(claudeSystemToMessage(blocks)).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(claudeSystemToMessage([])).toBeNull();
  });

  describe("integration: system + messages merge", () => {
    it("prepends system message to converted OpenAI messages", () => {
      const system = "You are a coding assistant.";
      const systemMsg = claudeSystemToMessage(system);
      const convertedMsgs = [{ role: "user", content: "Hello" }];
      const merged = systemMsg ? [systemMsg, ...convertedMsgs] : convertedMsgs;
      expect(merged).toHaveLength(2);
      expect(merged[0].role).toBe("system");
      expect(merged[0].content).toBe("You are a coding assistant.");
      expect(merged[1].role).toBe("user");
    });

    it("skips prepend when system is absent", () => {
      const systemMsg = claudeSystemToMessage(undefined);
      const convertedMsgs = [{ role: "user", content: "Hello" }];
      const merged = systemMsg ? [systemMsg, ...convertedMsgs] : convertedMsgs;
      expect(merged).toHaveLength(1);
    });
  });
});
