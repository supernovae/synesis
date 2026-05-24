import { describe, expect, it, vi } from "vitest";

import { applyRoutePhasePolicy } from "../src/pipeline/route-phase-policy.js";

function tool(name: string): unknown {
  return { type: "function", function: { name } };
}

const defaults = {
  adapterFamily: "qwen3-coder",
  basePolicyEnabled: true,
  policyEnabledByMatrix: true,
  enabledFamilies: ["qwen3-coder"],
  phase: "verify" as const,
  matchedRules: ["verification_churn_no_edit"],
  stream: false,
  effectiveTools: [tool("Read"), tool("Bash"), tool("Write")],
  editMissForceReadPending: false,
  forceReadRecovery: false,
  consecutiveEditContextMisses: 0,
  stateRegroundRequired: false,
  clientToolInventory: [tool("Read"), tool("Write")],
  recordSessionEvent: vi.fn(),
  applyEditContextMissReadGate: vi.fn((tools: unknown[] | undefined) => ({
    tools,
    removed: [],
    forcedReadToolName: undefined,
  })),
  findPreferredReadToolName: vi.fn(() => "Read"),
  ensureReadToolAvailability: vi.fn((tools: unknown[] | undefined) => ({
    tools,
    readToolName: "Read",
    rehydrated: false,
    available: true,
  })),
};

describe("applyRoutePhasePolicy", () => {
  it("derives phase policy and filters tools without route-specific state", () => {
    const result = applyRoutePhasePolicy({
      ...defaults,
      recordSessionEvent: vi.fn(),
    });

    expect(result.phasePolicy.active).toBe(true);
    expect(result.effectiveToolChoice).toBe("required");
    expect(result.phaseFiltered.removed).toEqual(["Bash"]);
    expect(result.effectiveTools.map((candidate) => (candidate as { function: { name: string } }).function.name))
      .toEqual(["Read", "Write"]);
  });

  it("forces phase policy for qwen recovery rules when base policy is disabled", () => {
    const recordSessionEvent = vi.fn();
    const result = applyRoutePhasePolicy({
      ...defaults,
      basePolicyEnabled: false,
      matchedRules: ["source_file_stale_reread"],
      phase: "implementation",
      recordSessionEvent,
    });

    expect(result.forcePhasePolicy).toBe(true);
    expect(result.phasePolicy.active).toBe(true);
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "phase_execution_policy_forced",
      "execution-governor",
      expect.stringContaining("source_file_stale_reread"),
      expect.objectContaining({ matched_rules: ["source_file_stale_reread"] }),
    );
  });

  it("applies edit-miss read gate and forces the read tool choice", () => {
    const recordSessionEvent = vi.fn();
    const applyEditContextMissReadGate = vi.fn(() => ({
      tools: [tool("Read")],
      removed: ["Write"],
      forcedReadToolName: "Read",
    }));

    const result = applyRoutePhasePolicy({
      ...defaults,
      phase: "implementation",
      matchedRules: ["edit_failure_replay"],
      forceReadRecovery: true,
      editMissForceReadPending: true,
      editMissGuard: { active: true, filePath: "src/app.ts", missCount: 2 },
      recordSessionEvent,
      applyEditContextMissReadGate,
    });

    expect(result.effectiveToolChoice).toEqual({ type: "tool", toolName: "Read" });
    expect(result.effectiveTools.map((candidate) => (candidate as { function: { name: string } }).function.name))
      .toEqual(["Read"]);
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "edit_context_miss_guard_enforced",
      "execution-governor",
      expect.stringContaining("forced_read_recovery"),
      expect.objectContaining({
        filePath: "src/app.ts",
        removed_tools: ["Write"],
        forced_read_tool: "Read",
      }),
    );
  });

  it("rehydrates read from client inventory when phase filtering removed it", () => {
    const recordSessionEvent = vi.fn();
    const ensureReadToolAvailability = vi.fn(() => ({
      tools: [tool("Write"), tool("Read")],
      readToolName: "Read",
      rehydrated: true,
      available: true,
    }));

    const result = applyRoutePhasePolicy({
      ...defaults,
      editMissGuard: { active: true, filePath: "src/app.ts", missCount: 1 },
      recordSessionEvent,
      findPreferredReadToolName: vi.fn(() => undefined),
      ensureReadToolAvailability,
    });

    expect(result.effectiveToolChoice).toEqual({ type: "tool", toolName: "Read" });
    expect(recordSessionEvent).toHaveBeenCalledWith(
      "edit_context_miss_guard_rehydrated_read",
      "execution-governor",
      expect.stringContaining("src/app.ts"),
      expect.objectContaining({ read_tool: "Read" }),
    );
  });
});
