import { describe, expect, it } from "vitest";
import { createOpenAIStreamRouteTelemetryInputBuilder } from "../src/pipeline/openai-stream-route-telemetry.js";

describe("createOpenAIStreamRouteTelemetryInputBuilder", () => {
  it("composes route scope, component cache data, and stream tool names", () => {
    const builder = createOpenAIStreamRouteTelemetryInputBuilder({
      routeBase: {
        scope: {
          sessionKey: "session-1",
          userId: "user-1",
          orgId: "org-1",
          requestId: "req-1",
        },
        startedAtMs: 10,
        resolvedModelId: "model-1",
        clientRequestedModel: "client-model",
        reductions: {
          toolResultReduction: {
            getPerRequestDelta: () => 0,
            getPerRequestGuidedTruncationDelta: () => 0,
            getPerRequestTaskPrunedDelta: () => 0,
            getLastRecallDecision: () => null,
            getVerificationTracker: () => ({ getState: () => null }),
          },
          validationNormalization: { getPerRequestDelta: () => 0 },
        },
        reducedToolResults: 0,
        orchestration: {} as never,
        policyMatchedRules: [],
        normalizedMessages: [],
        inferVerificationSteps: (tools) => tools,
        toolDefinitionCount: 1,
        artifactToolInjected: false,
        knowledgeToolInjected: false,
        countMessageRoles: () => ({
          systemMessageCount: 0,
          userMessageCount: 0,
          toolMessageCount: 0,
          totalInputChars: 0,
        }),
        pushDiagnostic: () => undefined,
      },
      components: {
        cacheStrategy: "none",
        prefixFingerprint: "prefix-1",
        streamState: { toolNames: () => ["Read"] },
      } as never,
      optimizationLedger: {
        setUpstreamCachedTokens: () => undefined,
        recordFinal: () => undefined,
        finalize: () => ({}),
        toLogRecord: () => ({}),
      },
      finalizeRequestForensics: () => ({ summary: "ok" }),
      recordSessionEvent: () => undefined,
      persistDecisionTelemetry: () => undefined,
      logOptimizationLedger: () => undefined,
    });

    const telemetry = builder({
      finishReason: "stop",
      finalized: {
        usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
        streamedText: "done",
        gateApplied: false,
        missingMust: 0,
        missingShould: 0,
        gateBlockedVerification: false,
        criticBlocked: false,
      },
    });

    expect(telemetry.requestId).toBe("req-1");
    expect(telemetry.toolNames).toEqual(["Read"]);
    expect(telemetry.cacheStrategy).toBeUndefined();
    expect(telemetry.prefixFingerprint).toBe("prefix-1");
  });
});
