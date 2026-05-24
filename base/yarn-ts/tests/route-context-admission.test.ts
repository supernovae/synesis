import { describe, expect, it, vi } from "vitest";

import { runRouteContextAdmission } from "../src/pipeline/route-context-admission.js";

function baseInput(overrides: Partial<Parameters<typeof runRouteContextAdmission>[0]> = {}) {
  const stats = { checked: 0, warned: 0, rejected: 0, byPath: { openai: 0, claude: 0 } };
  return {
    surface: "openai" as const,
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    sessionKey: "session_1",
    logRequestId: "req_1",
    metadata: {},
    chatState: {
      activeObjective: null,
      phase: "interpret",
      unresolvedCorrections: [],
      resolvedCorrections: [],
      lastAttemptSummary: null,
      lastVerificationOutcome: "unknown",
      blockers: [],
      currentFocusPaths: [],
      transcriptSummary: "",
      narrationResidueSummary: null,
      pendingUserDirective: null,
      completionStatus: "in_progress",
    },
    fileState: { filesByPath: {}, fileCount: 0 },
    artifactStore: {} as never,
    contextBudgetEnabled: false,
    budgetCeilingTokens: 100,
    outputReserveTokens: 10,
    admissionMode: "hybrid" as const,
    admissionWarnTokens: 80,
    admissionHardTokens: 100,
    compactionMode: "minimal" as const,
    cachePolicyRecord: { enabled: true },
    upperHarnessContext: { surface: "openai", modelId: "test-model" },
    stats,
    transcriptPruning: { emergencyPrune: vi.fn((messages) => ({ messages, pruned: false, charsBefore: 0, charsAfter: 0 })) },
    logger: { warn: vi.fn(), info: vi.fn() },
    recordSessionEvent: vi.fn(),
    recordUpperHarnessDecision: vi.fn(),
    forceCheckpoint: vi.fn(),
    ...overrides,
  };
}

describe("runRouteContextAdmission", () => {
  it("records allow decisions without pruning", () => {
    const input = baseInput();

    const result = runRouteContextAdmission(input);

    expect(result.rejected).toBe(false);
    expect(result.contextAdmission.decision).toBe("allow");
    expect(input.stats).toMatchObject({ checked: 1, warned: 0, rejected: 0, byPath: { openai: 1 } });
    expect(input.recordUpperHarnessDecision).toHaveBeenCalledWith(
      "upper-harness:openai-budget",
      expect.objectContaining({ action: expect.any(String) }),
      { recordAllow: true },
    );
    expect(input.transcriptPruning.emergencyPrune).not.toHaveBeenCalled();
  });

  it("runs emergency pruning on warn when budget manager did not compact", () => {
    const input = baseInput({
      messages: [{ role: "user", content: "x".repeat(40) }],
      admissionWarnTokens: 5,
      admissionHardTokens: 20,
      transcriptPruning: {
        emergencyPrune: vi.fn(() => ({
          messages: [{ role: "user", content: "trimmed" }],
          pruned: true,
          charsBefore: 40,
          charsAfter: 7,
        })),
      },
    });

    const result = runRouteContextAdmission(input);

    expect(result.contextAdmission.decision).toBe("warn");
    expect(result.messages).toEqual([{ role: "user", content: "trimmed" }]);
    expect(input.stats).toMatchObject({ checked: 1, warned: 1, rejected: 0 });
    expect(input.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req_1", estimatedTokens: 10 }),
      "context_admission_warn_openai",
    );
    expect(input.recordSessionEvent).toHaveBeenCalledWith(
      "emergency_context_prune",
      "context-admission",
      expect.stringContaining("Pruned 33 chars"),
    );
    expect(input.forceCheckpoint).toHaveBeenCalled();
  });

  it("marks rejected contexts and leaves response formatting to the route", () => {
    const input = baseInput({
      surface: "claude",
      messages: [{ role: "user", content: "x".repeat(84) }],
      admissionWarnTokens: 0,
      admissionHardTokens: 20,
    });

    const result = runRouteContextAdmission(input);

    expect(result.rejected).toBe(true);
    expect(result.contextAdmission).toMatchObject({
      decision: "reject",
      estimatedTokens: 21,
      estimatedChars: 84,
    });
    expect(input.stats).toMatchObject({ checked: 1, warned: 0, rejected: 1, byPath: { claude: 1 } });
    expect(input.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req_1", estimatedTokens: 21 }),
      "context_admission_reject_claude",
    );
  });
});
