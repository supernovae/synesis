import { describe, expect, it, vi } from "vitest";
import {
  createClaudeStreamFinalizationHandlers,
  finalizeClaudeStreamCompletion,
} from "../src/streaming/claude-stream-finalizer.js";
import { ClaudeStreamState } from "../src/streaming/claude-stream-state.js";

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

  it("finalizes pending text, writes final SSE footer, scrubs history text, and returns usage", async () => {
    const streamState = new ClaudeStreamState();
    streamState.appendTextDelta("pending text");
    const gate = {
      applied: false,
      missingMust: 0,
      missingShould: 0,
      blockedVerification: false,
      criticBlocked: false,
    };
    const writeFinalText = vi.fn();
    const writeMessageDelta = vi.fn();
    const endStream = vi.fn();
    const stopHeartbeat = vi.fn();
    const onHistoryText = vi.fn();
    const onHistoryTextScrubbed = vi.fn();

    const result = await finalizeClaudeStreamCompletion({
      streamState,
      gate,
      stopReason: "end_turn",
      streamed: {
        totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 3 }),
        text: Promise.resolve("history\n\n<synesis_task_ledger>{\"tasks\":[]}</synesis_task_ledger>"),
      },
      readUsage: () => ({
        inputTokens: 10,
        outputTokens: 3,
        cachedTokens: 1,
        cacheCreationTokens: 0,
        costUsd: 0,
      }),
      finalizeRequestForensics: (usage) => ({ usage }),
      handlers: {
        finalizePendingText: vi.fn(async () => ({
          finalText: "final pending",
          applied: true,
          missingMust: 1,
          missingShould: 2,
          blockedByVerification: true,
          criticBlocked: true,
        })),
        finalizeHistoryText: vi.fn(() => ({
          finalText: "history\n\n<synesis_task_ledger>{\"tasks\":[]}</synesis_task_ledger>",
          missingMust: 3,
          missingShould: 4,
          blockedByVerification: false,
        })),
      },
      writeFinalText,
      closeTextBlock: vi.fn(),
      writeMessageDelta,
      endStream,
      stopHeartbeat,
      onHistoryText,
      onHistoryTextScrubbed,
    });

    expect(writeFinalText).toHaveBeenCalledWith("final pending");
    expect(writeMessageDelta).toHaveBeenCalledWith(result.usage);
    expect(endStream).toHaveBeenCalledOnce();
    expect(stopHeartbeat).toHaveBeenCalledOnce();
    expect(onHistoryTextScrubbed).toHaveBeenCalledOnce();
    expect(onHistoryText).toHaveBeenCalledWith("history");
    expect(gate).toMatchObject({
      applied: true,
      missingMust: 3,
      missingShould: 4,
      blockedVerification: false,
      criticBlocked: true,
    });
    expect(result.usage.inputTokens).toBe(10);
    expect(result.requestForensicsDone).toEqual({ usage: result.usage });
  });
});
