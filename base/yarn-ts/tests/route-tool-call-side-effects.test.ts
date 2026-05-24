import { describe, expect, it, vi } from "vitest";
import type { GovernedToolCall, PlanWriteAuditRecord } from "../src/path-governance/tool-call-governance.js";
import { createRouteToolCallSideEffects } from "../src/streaming/route-tool-call-side-effects.js";

function governedToolCall(): GovernedToolCall {
  return {
    toolName: "Read",
    input: { file_path: "README.md" },
    normalizedPath: false,
    constrainedToRoot: false,
    envelopeUnwrapped: false,
    envelopeSource: null,
    blockedUnsafeShell: false,
    blockedWriteCapable: false,
    blockedBashDrift: false,
    validationMissing: [],
  };
}

describe("createRouteToolCallSideEffects", () => {
  it("binds route identity and session state to tool-call side effects", () => {
    const session = { record: { requestCount: 7 } };
    const logger = { info: vi.fn() };
    const strictGovernanceStats = { strictGovernanceRewrites: 1 };
    const updateDiffAccumulator = vi.fn();
    const maybeUpdateTaskLedgerFromToolCall = vi.fn();
    const emitPlanWriteAuditEvent = vi.fn();
    const maybeLogEnvelopeUnwrapSample = vi.fn();
    const recordUpperHarnessDecision = vi.fn();

    const sideEffects = createRouteToolCallSideEffects({
      session,
      sessionKey: "session_1",
      userId: "user_1",
      orgId: "org_1",
      requestId: "req_1",
      clientKind: "claude-code",
      upperHarnessComponent: "upper-harness:claude",
      logger,
      strictGovernanceStats,
      updateDiffAccumulator,
      maybeUpdateTaskLedgerFromToolCall,
      emitPlanWriteAuditEvent,
      maybeLogEnvelopeUnwrapSample,
      recordUpperHarnessDecision,
    });

    const governed = governedToolCall();
    const audit: PlanWriteAuditRecord = { allowed: false, path: "README.md" };
    const decision = { action: "allow" } as never;

    sideEffects.updateDiffAccumulator(governed);
    sideEffects.maybeUpdateTaskLedgerFromToolCall("Read", { file_path: "README.md" }, 3);
    sideEffects.emitPlanWriteAuditEvent(audit);
    sideEffects.maybeLogEnvelopeUnwrapSample("Read", governed, "tool_1");
    sideEffects.recordUpperHarnessDecision(decision);
    sideEffects.incrementStrictGovernanceRewrites(4);

    expect(updateDiffAccumulator).toHaveBeenCalledWith(session, governed);
    expect(maybeUpdateTaskLedgerFromToolCall).toHaveBeenCalledWith(
      session,
      "Read",
      { file_path: "README.md" },
      3,
    );
    expect(emitPlanWriteAuditEvent).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "req_1",
      audit,
    );
    expect(maybeLogEnvelopeUnwrapSample).toHaveBeenCalledWith(
      logger,
      "req_1",
      "Read",
      "claude-code",
      governed,
      "tool_1",
    );
    expect(recordUpperHarnessDecision).toHaveBeenCalledWith(
      "session_1",
      "user_1",
      "org_1",
      "req_1",
      "upper-harness:claude",
      decision,
    );
    expect(strictGovernanceStats.strictGovernanceRewrites).toBe(5);
  });
});
