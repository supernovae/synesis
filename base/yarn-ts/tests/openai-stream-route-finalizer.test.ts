import { describe, expect, it } from "vitest";
import { createOpenAIStreamRouteFinalizerInput } from "../src/pipeline/openai-stream-route-finalizer.js";

describe("createOpenAIStreamRouteFinalizerInput", () => {
  it("wires route scope and task-ledger scrub events into the finalizer", () => {
    const events: unknown[] = [];
    const history: Array<{ role: "assistant"; content: string }> = [];
    const finalizer = createOpenAIStreamRouteFinalizerInput({
      scope: {
        sessionKey: "session-1",
        userId: "user-1",
        orgId: "org-1",
        requestId: "req-1",
      },
      components: {
        writer: {} as never,
        scrubAndFlushText: () => undefined,
      },
      streamed: {
        totalUsage: Promise.resolve({}),
        text: Promise.resolve(""),
      },
      streamOptions: undefined,
      readUsage: () => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 }),
      session: {
        history,
        record: { requestCount: 1, sessionKey: "session-1" },
        taskCapabilities: null,
        taskLedger: null,
      },
      checklist: null,
      traceRootPrompt: "root",
      latestUserPrompt: "latest",
      verification: {},
      recentToolNames: [],
      planGraph: null,
      responseStyleMode: "default",
      applyMarkdownGuardrail: (text) => text,
      finalizeCompletionText: async (input) => ({
        finalText: `${input.requestId}:${input.sessionKey}:${input.userId}:${input.orgId}`,
        missingMust: 0,
        missingShould: 0,
        blockedByVerification: false,
      }),
      finalizePostStreamText: () => ({
        finalText: "post",
        missingMust: 0,
        missingShould: 0,
        blockedByVerification: false,
      }),
      endStream: () => undefined,
      stopHeartbeat: () => undefined,
      recordSessionEvent: (event) => events.push(event),
    });

    finalizer.onHistoryTextScrubbed?.();
    finalizer.onHistoryText("stored");

    expect(events).toEqual([{
      eventKind: "task_ledger_output_scrubbed",
      component: "task-ledger",
      detail: "Removed internal task-ledger governance from streamed OpenAI history",
    }]);
    expect(history).toEqual([{ role: "assistant", content: "stored" }]);
  });
});
