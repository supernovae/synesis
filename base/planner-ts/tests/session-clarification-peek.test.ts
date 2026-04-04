import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/context/session-store.js";
import { SessionManager } from "../src/context/session-manager.js";
import { isLikelyClarificationAnswer } from "../src/clarification/clarification-answer-heuristic.js";

describe("SessionManager clarification peek/clear", () => {
  it("keeps pending when get is used without clear", async () => {
    const store = new MemorySessionStore();
    const sm = new SessionManager({
      enabled: true,
      maxHistory: 20,
      checkpointEveryMessages: 100,
      ttlMs: 999_999_999,
      store,
    });
    const key = "conversation:test-peek";
    await sm.setPendingClarification(key, {
      question: "What stack?",
      options: [],
      assumptions: [],
      originalTaskDescription: "Build API",
    });
    const a = await sm.getPendingClarification(key);
    const b = await sm.getPendingClarification(key);
    expect(a?.originalTaskDescription).toBe("Build API");
    expect(b?.originalTaskDescription).toBe("Build API");
  });

  it("clears only after clearPendingClarification", async () => {
    const store = new MemorySessionStore();
    const sm = new SessionManager({
      enabled: true,
      maxHistory: 20,
      checkpointEveryMessages: 100,
      ttlMs: 999_999_999,
      store,
    });
    const key = "conversation:test-clear";
    await sm.setPendingClarification(key, {
      question: "Region?",
      options: [],
      assumptions: [],
      originalTaskDescription: "orig",
    });
    await sm.clearPendingClarification(key);
    expect(await sm.getPendingClarification(key)).toBeUndefined();
  });

  it("does not clear pending when clarification answer heuristic fails", async () => {
    const store = new MemorySessionStore();
    const sm = new SessionManager({
      enabled: true,
      maxHistory: 20,
      checkpointEveryMessages: 100,
      ttlMs: 999_999_999,
      store,
    });
    const key = "conversation:test-heuristic";
    const pend = {
      question: "What region?",
      options: ["opt"],
      assumptions: [],
      originalTaskDescription: "orig task",
    };
    await sm.setPendingClarification(key, pend);
    const peek = await sm.getPendingClarification(key);
    expect(peek).toBeDefined();
    const badAnswer = "x";
    expect(isLikelyClarificationAnswer(badAnswer, peek!)).toBe(false);
    // App would not call clear — pending must remain
    expect(await sm.getPendingClarification(key)).toBeDefined();
  });
});
