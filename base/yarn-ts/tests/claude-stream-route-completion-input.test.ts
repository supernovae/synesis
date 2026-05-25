import { describe, expect, it, vi } from "vitest";
import { buildClaudeStreamRouteCompletionInput } from "../src/streaming/claude-stream-route-completion-input.js";

describe("buildClaudeStreamRouteCompletionInput", () => {
  it("fills scoped handler fields and checklist telemetry counts", () => {
    const completion = buildClaudeStreamRouteCompletionInput({
      scope: {
        pendingRequestId: "trace-1",
        historyRequestId: "req-1",
        sessionKey: "session-1",
        userId: "user-1",
        orgId: "org-1",
      },
      metadata: {
        source: {
          trace_root_prompt: "root prompt",
          latest_user_prompt: "latest prompt",
        },
        getString: (source, key) => String((source as Record<string, unknown>)[key] ?? ""),
      },
      recentMessages: [
        { role: "assistant", content: [{ type: "tool_use", name: "Read" }] },
      ],
      extractRecentToolNames: vi.fn(() => ["Read"]),
      checklist: {
        must: ["api"],
        should: ["tests", "docs"],
      },
      finalizer: {
        session: {} as never,
        readUsage: vi.fn(),
        finalizeRequestForensics: vi.fn(),
        handlerInput: {
          session: {} as never,
          verification: { ok: true },
          planGraph: { nodes: [] },
          responseStyleMode: "default",
          applyMarkdownGuardrail: (text: string) => text,
          finalizeCompletionText: vi.fn(),
          finalizePostStreamText: vi.fn(),
        },
        endStream: vi.fn(),
        recordSessionEvent: vi.fn(),
      } as never,
      telemetry: {
        clientRequestedModel: "claude-test",
        reductions: {} as never,
        reducedToolResults: 0,
        orchestration: {} as never,
        policyMatchedRules: [],
        normalizedMessages: [],
        inferVerificationSteps: vi.fn(),
        toolDefinitionCount: 0,
        artifactToolInjected: false,
        knowledgeToolInjected: false,
        countMessageRoles: vi.fn(),
        pushDiagnostic: vi.fn(),
        recordSessionEvent: vi.fn(),
        persistDecisionTelemetry: vi.fn(),
      } as never,
    });

    expect(completion.finalizer.handlerInput).toMatchObject({
      pendingRequestId: "trace-1",
      historyRequestId: "req-1",
      sessionKey: "session-1",
      userId: "user-1",
      orgId: "org-1",
      checklist: {
        must: ["api"],
        should: ["tests", "docs"],
      },
      traceRootPrompt: "root prompt",
      latestUserPrompt: "latest prompt",
      recentToolNames: ["Read"],
    });
    expect(completion.telemetry.requirementChecklistMust).toBe(1);
    expect(completion.telemetry.requirementChecklistShould).toBe(2);
  });
});
