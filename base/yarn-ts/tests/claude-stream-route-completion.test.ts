import { describe, expect, it, vi } from "vitest";

import { ClaudeStreamState } from "../src/streaming/claude-stream-state.js";
import { completeClaudeStreamRoute } from "../src/streaming/claude-stream-route-completion.js";
import type { StreamTokenUsage } from "../src/streaming/openai-stream-finalizer.js";

const usage: StreamTokenUsage = {
  inputTokens: 11,
  outputTokens: 13,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

function reductions() {
  return {
    toolResultReduction: {
      getPerRequestDelta: () => 2,
      getPerRequestGuidedTruncationDelta: () => 0,
      getPerRequestTaskPrunedDelta: () => 0,
      getLastRecallDecision: () => null,
      getVerificationTracker: () => ({
        getState: () => ({
          round: 0,
          findings: [],
          stalled: false,
        }),
      }),
    },
    validationNormalization: {
      getPerRequestDelta: () => 3,
    },
  };
}

describe("completeClaudeStreamRoute", () => {
  it("finalizes the stream and records telemetry from the finalized result", async () => {
    const sentEvents: Array<{ event: string; data: unknown }> = [];
    const persisted = vi.fn();
    const pushed = vi.fn();
    const ended = vi.fn();
    const stoppedHeartbeat = vi.fn();

    const result = await completeClaudeStreamRoute({
      finalizerInput: {
        streamState: new ClaudeStreamState(),
        gate: {
          applied: false,
          missingMust: 0,
          missingShould: 0,
          blockedVerification: false,
          criticBlocked: false,
        },
        stopReason: "end_turn",
        streamed: {
          totalUsage: Promise.resolve({}),
          text: Promise.resolve("hello"),
        },
        session: {
          history: [],
          record: { requestCount: 1, sessionKey: "session_1" },
          taskCapabilities: null,
          taskLedger: null,
        },
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        requestId: "req_1",
        readUsage: () => usage,
        finalizeRequestForensics: () => ({ summary: "stable-prefix" }),
        handlers: {
          finalizePendingText: vi.fn(),
          finalizeHistoryText: (streamedText) => ({
            finalText: streamedText,
            applied: false,
            missingMust: 0,
            missingShould: 0,
            blockedByVerification: false,
            criticBlocked: false,
          }),
        },
        writeFinalText: vi.fn(),
        closeTextBlock: vi.fn(),
        sendSse: (event, data) => {
          sentEvents.push({ event, data });
          return true;
        },
        endStream: ended,
        stopHeartbeat: stoppedHeartbeat,
        recordSessionEvent: vi.fn(),
      },
      telemetryBase: {
        requestId: "req_1",
        sessionKey: "session_1",
        userId: "user_1",
        orgId: "org_1",
        startedAtMs: Date.now(),
        resolvedModelId: "claude-test",
        clientRequestedModel: "claude-test",
        reductions: reductions(),
        reducedToolResults: 0,
        orchestration: { decisionPath: "direct", escalated: false },
        policyMatchedRules: [],
        normalizedMessages: [{ role: "user", content: "hi" }],
        inferVerificationSteps: (toolNames) => toolNames,
        toolDefinitionCount: 0,
        artifactToolInjected: false,
        knowledgeToolInjected: false,
        recordSessionEvent: vi.fn(),
        persistDecisionTelemetry: persisted,
        countMessageRoles: () => ({
          systemMessageCount: 0,
          userMessageCount: 1,
          toolMessageCount: 0,
          totalInputChars: 2,
        }),
        pushDiagnostic: pushed,
      },
      toolNames: ["Edit"],
    });

    expect(result.finalized).toMatchObject({
      usage,
      requestForensicsDone: { summary: "stable-prefix" },
      streamedText: "hello",
    });
    expect(sentEvents.map((entry) => entry.event)).toEqual(["message_delta", "message_stop"]);
    expect(ended).toHaveBeenCalledOnce();
    expect(stoppedHeartbeat).toHaveBeenCalledOnce();
    expect(persisted).toHaveBeenCalledWith(expect.objectContaining({
      usage,
      finishReason: "end_turn",
      tokensSavedByReduction: 5,
      trajectory: expect.objectContaining({
        toolSequence: ["Edit"],
        verificationSteps: ["Edit"],
      }),
    }));
    expect(pushed).toHaveBeenCalledWith(expect.objectContaining({
      requestForensicsSummary: "stable-prefix",
      tokensIn: 11,
      tokensOut: 13,
    }));
  });
});
