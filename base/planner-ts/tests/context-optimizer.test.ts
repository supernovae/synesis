import { describe, expect, it } from "vitest";
import { optimizeContext } from "../src/optimization/context-optimizer.js";

describe("context optimizer", () => {
  it("keeps latest user message near front after system", () => {
    const result = optimizeContext(
      [
        { role: "system", content: "policy" },
        { role: "user", content: "first user" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "latest user" }
      ],
      { maxCharsPerMessage: 200, recentMessageLimit: 10 }
    );
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[1]?.role).toBe("user");
    expect(result.messages[1]?.content).toBe("latest user");
  });

  it("reduces oversized messages with envelope", () => {
    const big = "A".repeat(300);
    const result = optimizeContext([{ role: "tool", content: big }], {
      maxCharsPerMessage: 120,
      recentMessageLimit: 10
    });
    expect(result.stats.reducedCount).toBe(1);
    expect(result.messages[0]?.content).toContain("<TOOL_RESULT_SUMMARY");
  });
});
