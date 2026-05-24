import { describe, expect, it, vi } from "vitest";

import { createOpenAIChatRouteFinalizerBase } from "../src/pipeline/openai-route-inputs.js";

describe("createOpenAIChatRouteFinalizerBase", () => {
  it("keeps common OpenAI stream and non-stream finalizer fields together", async () => {
    const session = {
      history: [],
      record: { requestCount: 1, sessionKey: "session-1" },
      taskCapabilities: null,
      taskLedger: null,
    };
    const finalizeCompletionText = vi.fn(async (input) => ({
      finalText: `${input.requestId}:${input.latestUserPrompt}`,
      missingMust: 0,
      missingShould: 0,
      blockedByVerification: false,
    }));

    const base = createOpenAIChatRouteFinalizerBase({
      session,
      checklist: { must: [] },
      traceRootPrompt: "root",
      latestUserPrompt: "latest",
      verification: { ok: true },
      recentToolNames: ["Read"],
      planGraph: { id: "plan" },
      responseStyleMode: "default",
      applyMarkdownGuardrail: (text) => text.trim(),
      finalizeCompletionText,
    });

    expect(base).toMatchObject({
      session,
      checklist: { must: [] },
      traceRootPrompt: "root",
      latestUserPrompt: "latest",
      recentToolNames: ["Read"],
      responseStyleMode: "default",
    });
    expect(base.applyMarkdownGuardrail(" done ", "default")).toBe("done");
    await expect(base.finalizeCompletionText({
      requestId: "req-1",
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      assistantText: "done",
      checklist: base.checklist,
      traceRootPrompt: base.traceRootPrompt,
      latestUserPrompt: base.latestUserPrompt,
      verification: base.verification,
      recentToolNames: base.recentToolNames,
      nonActionableEventDetail: "fallback",
      planGraph: base.planGraph,
      session: base.session,
    })).resolves.toMatchObject({ finalText: "req-1:latest" });
    expect(finalizeCompletionText).toHaveBeenCalledOnce();
  });
});
