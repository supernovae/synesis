import { describe, expect, it } from "vitest";
import { applyIngressCapToToolMessages } from "../src/reduction/ingress-cap.js";

describe("applyIngressCapToToolMessages", () => {
  it("is a no-op when maxBytes is 0", () => {
    const messages = [{ role: "tool" as const, content: "x".repeat(10_000) }];
    const r = applyIngressCapToToolMessages(messages, 0);
    expect(r.cappedToolResults).toBe(0);
    expect(r.messages[0].content).toBe(messages[0].content);
  });

  it("replaces oversized tool strings with structured cap envelope", () => {
    const big = "y".repeat(5000);
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "tool" as const, name: "bash", content: big },
    ];
    const r = applyIngressCapToToolMessages(messages, 1000);
    expect(r.cappedToolResults).toBe(1);
    expect(r.bytesReclaimed).toBeGreaterThan(4000);
    const c = r.messages[1].content as string;
    expect(c).toContain("synesis_ingress_tool_cap");
    expect(c).toContain("tool_message_exceeded_max_bytes");
    expect(JSON.parse(c).max_bytes).toBe(1000);
  });
});
