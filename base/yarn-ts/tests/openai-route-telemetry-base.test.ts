import { describe, expect, it, vi } from "vitest";

import { createOpenAIChatRouteTelemetryBase } from "../src/pipeline/openai-route-inputs.js";

describe("createOpenAIChatRouteTelemetryBase", () => {
  it("keeps shared OpenAI telemetry route fields without adding runtime scope fields", () => {
    const countMessageRoles = vi.fn(() => ({
      systemMessageCount: 1,
      userMessageCount: 2,
      toolMessageCount: 3,
      totalInputChars: 4,
    }));
    const pushDiagnostic = vi.fn();

    const base = createOpenAIChatRouteTelemetryBase({
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
      reducedToolResults: 2,
      orchestration: { decisionPath: "test", escalated: false } as never,
      policyMatchedRules: ["rule-a"],
      evidencePrefetched: true,
      evidenceConfidence: 0.8,
      evidenceAuthoritative: false,
      evidencePrefetchLatencyMs: 12,
      evidenceQuality: { source: "unit" },
      sensemakingTriggered: true,
      sensemakingReason: "reason",
      governorDecision: { decision: "allow" } as never,
      governorChatStateSummary: { phase: "edit" },
      governorFileStateSummary: { files: 1 },
      normalizedMessages: [{ role: "user", content: "hello" }],
      inferVerificationSteps: (toolNames) => toolNames,
      trajectoryDiagnostics: { ok: true },
      toolDefinitionCount: 4,
      artifactToolInjected: true,
      knowledgeToolInjected: false,
      promptProfileIds: [1],
      promptProfileHashes: ["hash"],
      prefixHash: "prefix",
      prefixChangeReasons: ["changed"],
      requirementChecklistMust: 5,
      requirementChecklistShould: 6,
      contextAdmission: {
        decision: "warn",
        reason: "large",
        estimatedTokens: 100,
        estimatedChars: 400,
      },
      countMessageRoles,
      pushDiagnostic,
    });

    expect(base).toMatchObject({
      clientRequestedModel: "client-model",
      reducedToolResults: 2,
      policyMatchedRules: ["rule-a"],
      contextAdmission: {
        decision: "warn",
        reason: "large",
        estimatedTokens: 100,
        estimatedChars: 400,
      },
    });
    expect("scope" in base).toBe(false);
    expect("startedAtMs" in base).toBe(false);
    expect("resolvedModelId" in base).toBe(false);
    expect(base.countMessageRoles([{ role: "user", content: "x" }])).toEqual({
      systemMessageCount: 1,
      userMessageCount: 2,
      toolMessageCount: 3,
      totalInputChars: 4,
    });
    base.pushDiagnostic({ ok: true });
    expect(pushDiagnostic).toHaveBeenCalledWith({ ok: true });
  });
});
