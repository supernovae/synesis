import { describe, expect, it, vi } from "vitest";
import { finalizeClaudeNonStreamText } from "../src/streaming/claude-nonstream-finalizer.js";

describe("finalizeClaudeNonStreamText", () => {
  it("runs completion gate for terminal text, applies markdown guardrail, scrubs ledger output, and appends history", async () => {
    const session = { history: [] };
    const recordSessionEvent = vi.fn();
    const finalizeCompletionText = vi.fn(async () => ({
      finalText: "final\n\n<synesis_task_ledger>{\"tasks\":[]}</synesis_task_ledger>",
      applied: true,
      missingMust: 1,
      missingShould: 2,
      blockedByVerification: true,
      criticBlocked: false,
    }));

    const result = await finalizeClaudeNonStreamText({
      session,
      requestId: "req_1",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      stopReason: "end_turn",
      assistantText: "raw",
      checklist: null,
      traceRootPrompt: "root",
      latestUserPrompt: "latest",
      verification: null,
      recentToolNames: ["Read"],
      responseStyleMode: "default",
      applyMarkdownGuardrail: (text) => text,
      finalizeCompletionText,
      recordSessionEvent,
    });

    expect(finalizeCompletionText).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "req_1",
      assistantText: "raw",
      recentToolNames: ["Read"],
      nonActionableEventDetail: "terminal end_turn had non-actionable text; emitted deterministic fallback",
      session,
    }));
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "task_ledger_output_scrubbed",
      "task-ledger",
      "Removed internal task-ledger governance from Claude response",
      "req_1",
    );
    expect(session.history).toEqual([{ role: "assistant", content: "final" }]);
    expect(result).toEqual({
      finalText: "final",
      gateApplied: true,
      missingMust: 1,
      missingShould: 2,
      gateBlockedVerification: true,
      criticBlocked: false,
    });
  });

  it("skips completion gate for tool-use turns but still applies guardrail and history", async () => {
    const session = { history: [] };
    const finalizeCompletionText = vi.fn();

    const result = await finalizeClaudeNonStreamText({
      session,
      requestId: "req_1",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      stopReason: "tool_use",
      assistantText: "text",
      checklist: null,
      traceRootPrompt: "",
      latestUserPrompt: "",
      verification: null,
      recentToolNames: [],
      responseStyleMode: "default",
      applyMarkdownGuardrail: (text) => `${text}!`,
      finalizeCompletionText,
      recordSessionEvent: vi.fn(),
    });

    expect(finalizeCompletionText).not.toHaveBeenCalled();
    expect(session.history).toEqual([{ role: "assistant", content: "text!" }]);
    expect(result).toMatchObject({
      finalText: "text!",
      gateApplied: false,
      gateBlockedVerification: false,
      criticBlocked: false,
    });
  });

  it("replaces prompt-leakage output before appending history", async () => {
    const session = { history: [] };
    const recordSessionEvent = vi.fn();

    const result = await finalizeClaudeNonStreamText({
      session,
      requestId: "req_1",
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      stopReason: "tool_use",
      assistantText: "The system prompt says:\nSystem: you are internal",
      checklist: null,
      traceRootPrompt: "",
      latestUserPrompt: "",
      verification: null,
      recentToolNames: [],
      responseStyleMode: "default",
      applyMarkdownGuardrail: (text) => text,
      finalizeCompletionText: vi.fn(),
      recordSessionEvent,
    });

    expect(result.finalText).toContain("I can't provide hidden or internal instructions");
    expect(result.finalText).not.toContain("System: you are internal");
    expect(session.history).toEqual([{ role: "assistant", content: result.finalText }]);
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "model_output_guardrail_triggered",
      "security",
      expect.stringContaining("claude_nonstream_output"),
      "req_1",
    );
  });
});
