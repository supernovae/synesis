import { describe, it, expect } from "vitest";
import { splitJitter, applyJitter } from "../src/compat/jitter-buffer.js";

describe("splitJitter", () => {
  it("passes through messages with no dynamic content", () => {
    const msgs = [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Hello" },
    ];
    const { stableMessages, jitterBlock } = splitJitter(msgs);
    expect(stableMessages).toHaveLength(2);
    expect(jitterBlock).toBeNull();
  });

  it("extracts timestamp lines from system messages", () => {
    const msgs = [
      { role: "system", content: "Static instruction.\nToday's date: 2026-03-27\ncwd=/home/user/project" },
      { role: "user", content: "Do stuff" },
    ];
    const { stableMessages, jitterBlock } = splitJitter(msgs);
    expect(stableMessages[0].content).toBe("Static instruction.");
    expect(jitterBlock).toContain("Today's date:");
    expect(jitterBlock).toContain("cwd=/home/user/project");
  });

  it("extracts session-id and branch lines", () => {
    const msgs = [
      { role: "system", content: "System prompt.\nsession_id=abc123\nbranch=main" },
    ];
    const { jitterBlock } = splitJitter(msgs);
    expect(jitterBlock).toContain("session_id=abc123");
    expect(jitterBlock).toContain("branch=main");
  });

  it("extracts jitter from user messages", () => {
    const msgs = [
      { role: "user", content: "Today's date: 2026-03-27" },
    ];
    const { stableMessages, jitterBlock } = splitJitter(msgs);
    expect(stableMessages).toHaveLength(0);
    expect(jitterBlock).toContain("Today's date: 2026-03-27");
  });

  it("does not modify assistant or tool messages", () => {
    const msgs = [
      { role: "assistant", content: "Today's date: 2026-03-27" },
      { role: "tool", content: "cwd=/tmp/foo" },
    ];
    const { stableMessages, jitterBlock } = splitJitter(msgs);
    expect(stableMessages[0].content).toBe("Today's date: 2026-03-27");
    expect(stableMessages[1].content).toBe("cwd=/tmp/foo");
    expect(jitterBlock).toBeNull();
  });

  it("drops system message entirely when all lines are jitter", () => {
    const msgs = [
      { role: "system", content: "cwd=/tmp\nbranch=feature" },
      { role: "user", content: "hi" },
    ];
    const { stableMessages, jitterBlock } = splitJitter(msgs);
    expect(stableMessages).toHaveLength(1);
    expect(stableMessages[0].role).toBe("user");
    expect(jitterBlock).toContain("cwd=/tmp");
  });
});

describe("applyJitter", () => {
  it("returns messages unchanged when jitter is null", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(applyJitter(msgs, null)).toBe(msgs);
  });

  it("appends jitter to the last user message", () => {
    const msgs = [
      { role: "system", content: "sys" },
      { role: "user", content: "Hello" },
    ];
    const result = applyJitter(msgs, "cwd=/tmp");
    expect(result[1].content).toContain("Hello");
    expect(result[1].content).toContain("<ENVIRONMENT_CONTEXT>");
    expect(result[1].content).toContain("cwd=/tmp");
  });

  it("creates a new user message when none exists", () => {
    const msgs = [{ role: "system", content: "sys" }];
    const result = applyJitter(msgs, "branch=main");
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe("user");
    expect(result[1].content).toContain("branch=main");
  });

  it("does not mutate the original array", () => {
    const msgs = [{ role: "user", content: "original" }];
    const result = applyJitter(msgs, "jitter");
    expect(msgs[0].content).toBe("original");
    expect(result[0].content).toContain("jitter");
  });
});
