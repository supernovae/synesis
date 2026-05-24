import { describe, expect, it, vi } from "vitest";
import { createClaudeStreamFinalizationHandlers } from "../src/streaming/claude-stream-finalizer.js";

function makeSession() {
  return {
    history: [],
    record: {
      requestCount: 3,
      sessionKey: "session-a",
    },
    taskCapabilities: {
      hasExplicitTodoTool: false,
      hasExplicitPlanMode: false,
      todoToolName: null,
      detectedSource: "model_plan_text" as const,
    },
    taskLedger: null,
  };
}

describe("createClaudeStreamFinalizationHandlers", () => {
  it("reconciles pending text tasks and applies markdown guardrail to finalized text", async () => {
    const session = makeSession();
    const finalizeCompletionText = vi.fn(async () => ({
      finalText: "final pending",
      applied: true,
      missingMust: 1,
      missingShould: 2,
      blockedByVerification: false,
      criticBlocked: false,
    }));
    const applyMarkdownGuardrail = vi.fn((text: string) => `guarded:${text}`);

    const handlers = createClaudeStreamFinalizationHandlers({
      session,
      pendingRequestId: "trace-1",
      historyRequestId: "req-1",
      sessionKey: "session-a",
      userId: "user-a",
      orgId: "org-a",
      checklist: { must: [] },
      traceRootPrompt: "root",
      latestUserPrompt: "latest",
      verification: { ok: true },
      recentToolNames: ["Read"],
      planGraph: { id: "plan-a" },
      responseStyleMode: "plain",
      applyMarkdownGuardrail,
      finalizeCompletionText,
      finalizePostStreamText: vi.fn(),
    });

    const result = await handlers.finalizePendingText("1. Create API\n2. Add tests");

    expect(session.taskLedger?.tasks.map((task) => task.title)).toEqual(["Create API", "Add tests"]);
    expect(finalizeCompletionText).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "trace-1",
      sessionKey: "session-a",
      assistantText: "1. Create API\n2. Add tests",
      nonActionableEventDetail: "claude stream stop had non-actionable text; emitted deterministic fallback",
      session,
    }));
    expect(applyMarkdownGuardrail).toHaveBeenCalledWith("final pending", "plain");
    expect(result.finalText).toBe("guarded:final pending");
  });

  it("finalizes history text with Claude tool-use stop reason semantics", () => {
    const session = makeSession();
    const finalizePostStreamText = vi.fn(() => ({
      finalText: "history",
      missingMust: 0,
      missingShould: 0,
      blockedByVerification: false,
    }));

    const handlers = createClaudeStreamFinalizationHandlers({
      session,
      pendingRequestId: "trace-1",
      historyRequestId: "req-1",
      sessionKey: "session-a",
      userId: "user-a",
      orgId: "org-a",
      checklist: null,
      traceRootPrompt: "root",
      latestUserPrompt: "latest",
      verification: { ok: true },
      recentToolNames: [],
      responseStyleMode: "plain",
      applyMarkdownGuardrail: (text) => text,
      finalizeCompletionText: vi.fn(),
      finalizePostStreamText,
    });

    const result = handlers.finalizeHistoryText("history", "tool_use", true);

    expect(finalizePostStreamText).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "req-1",
      assistantText: "history",
      applyGate: true,
      toolStopReason: true,
      nonActionableEventDetail: "claude streamed text was non-actionable; emitted deterministic fallback",
    }));
    expect(result.finalText).toBe("history");
  });
});
