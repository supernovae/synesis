import { describe, expect, it, vi } from "vitest";
import { GovernorService } from "../src/governance/governor-service.js";
import type { ExecutionGovernorDecision } from "../src/governance/execution-governor.js";
import type { PipelineContext } from "../src/pipeline/types.js";

const ctx: PipelineContext = {
  requestId: "req-1",
  mode: "governed",
  userId: "u1",
  orgId: "o1",
  clientKind: "test",
  conversationId: "c1",
  sessionKey: "s1",
  startedAt: 1,
};

function decision(overrides: Partial<ExecutionGovernorDecision> = {}): ExecutionGovernorDecision {
  return {
    pause: false,
    reason: "allow",
    matchedRules: ["allow"],
    telemetry: {
      phase: "edit",
      repeatedTestCommands: 0,
      repeatedReadSearchCalls: 0,
      repeatedBroadDiscoveryCalls: 0,
      totalBroadDiscoveryCalls: 0,
      broadTestRepeat: false,
      noEditEvidence: false,
      trailingVerificationRunLength: 0,
    },
    ...overrides,
  };
}

describe("GovernorService", () => {
  it("returns a pass decision when governance is disabled", async () => {
    const evaluate = vi.fn();
    const service = new GovernorService({ enabled: false, evaluate });

    const out = await service.beforeProviderCall(ctx, { messages: [] });

    expect(out.action).toBe("pass");
    expect(out.matchedRules).toEqual(["disabled"]);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("delegates to the execution governor without HTTP context", async () => {
    const evaluate = vi.fn(() => decision({ matchedRules: ["verification_already_green"] }));
    const service = new GovernorService({ enabled: true, evaluate });

    const out = await service.beforeProviderCall(ctx, {
      messages: [{ role: "user", content: "test" }],
      options: { activePlanStage: "finalize" },
    });

    expect(evaluate).toHaveBeenCalledWith(
      [{ role: "user", content: "test" }],
      expect.objectContaining({ activePlanStage: "finalize", profile: "balanced_completion" }),
    );
    expect(out.action).toBe("pass");
    expect(out.matchedRules).toEqual(["verification_already_green"]);
  });

  it("maps pause decisions to a stable pause action", async () => {
    const evaluate = vi.fn(() => decision({
      pause: true,
      reason: "identical_tool_repeat",
      matchedRules: ["identical_tool_repeat"],
    }));
    const service = new GovernorService({ enabled: true, evaluate });

    const out = await service.beforeProviderCall(ctx, { messages: [] });

    expect(out.action).toBe("pause");
    expect(out.reason).toBe("identical_tool_repeat");
    expect(out.execution?.pause).toBe(true);
  });

  it("implements the optional step-governor stage hook", async () => {
    const evaluate = vi.fn(() => decision({ matchedRules: ["stage_governed"] }));
    const service = new GovernorService({ enabled: true, evaluate });

    const out = await service.beforeStage({
      stage: "governor",
      ctx,
      payload: {
        messages: [{ role: "user", content: "continue" }],
        options: { activePlanStage: "tests" },
      },
    });

    expect(evaluate).toHaveBeenCalledWith(
      [{ role: "user", content: "continue" }],
      expect.objectContaining({ activePlanStage: "tests", profile: "balanced_completion" }),
    );
    expect(out.action).toBe("pass");
    expect(out.matchedRules).toEqual(["stage_governed"]);
  });

  it("passes through stages that are not governed yet", async () => {
    const evaluate = vi.fn();
    const service = new GovernorService({ enabled: true, evaluate });

    const out = await service.beforeStage({ stage: "provider_call", ctx });

    expect(out.action).toBe("pass");
    expect(out.reason).toBe("stage_not_governed");
    expect(evaluate).not.toHaveBeenCalled();
  });
});
