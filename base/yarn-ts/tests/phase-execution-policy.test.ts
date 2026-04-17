import { describe, expect, it } from "vitest";
import {
  buildRequiredRepairPrompt,
  derivePhaseExecutionPolicy,
  filterToolsByPhasePolicy,
  resolvePhaseToolChoice,
  validateRequiredToolCalls,
} from "../src/governance/phase-execution-policy.js";

describe("phase execution policy", () => {
  it("activates required mode for qwen verify phase", () => {
    const policy = derivePhaseExecutionPolicy({
      enabled: true,
      adapterFamily: "qwen3-coder",
      enabledFamilies: ["qwen3-coder"],
      phase: "verify",
      matchedRules: [],
      stream: false,
    });
    expect(policy.active).toBe(true);
    expect(policy.toolChoice).toBe("required");
    expect(policy.allowedCanonicalTools).toEqual(["Bash"]);
    expect(policy.maxToolCalls).toBe(1);
  });

  it("keeps required mode and requests non-stream kickoff on streaming turns", () => {
    const policy = derivePhaseExecutionPolicy({
      enabled: true,
      adapterFamily: "qwen3-coder",
      enabledFamilies: ["qwen3-coder"],
      phase: "verify",
      matchedRules: [],
      stream: true,
    });
    expect(policy.active).toBe(true);
    expect(policy.toolChoice).toBe("required");
    expect(policy.enforceNonStreaming).toBe(true);
    expect(policy.reason).toBe("verify_phase_non_stream_kickoff");
  });

  it("forces edit/write tools when verify is churning without edits", () => {
    const policy = derivePhaseExecutionPolicy({
      enabled: true,
      adapterFamily: "qwen3-coder",
      enabledFamilies: ["qwen3-coder"],
      phase: "verify",
      matchedRules: ["verification_churn_no_edit", "verification_stall_no_edit"],
      stream: false,
    });
    expect(policy.active).toBe(true);
    expect(policy.toolChoice).toBe("required");
    expect(policy.allowedCanonicalTools).toEqual(["Read", "Edit", "Write", "Update"]);
    expect(policy.reason).toBe("verify_phase_fix_required_action");
  });

  it("activates required edit/write mode from edit phase on replayed verification failures", () => {
    const policy = derivePhaseExecutionPolicy({
      enabled: true,
      adapterFamily: "qwen3-coder",
      enabledFamilies: ["qwen3-coder"],
      phase: "edit",
      matchedRules: ["verification_same_failure_signature_replay", "verbal_intent_without_action"],
      stream: false,
    });
    expect(policy.active).toBe(true);
    expect(policy.toolChoice).toBe("required");
    expect(policy.allowedCanonicalTools).toEqual(["Read", "Edit", "Write", "Update"]);
    expect(policy.reason).toBe("verify_phase_fix_required_action");
  });

  it("forces edit/write tools when source file stale reread is detected", () => {
    const policy = derivePhaseExecutionPolicy({
      enabled: true,
      adapterFamily: "qwen3-coder",
      enabledFamilies: ["qwen3-coder"],
      phase: "edit",
      matchedRules: ["source_file_stale_reread", "exploration_stall_no_edit"],
      stream: false,
    });
    expect(policy.active).toBe(true);
    expect(policy.toolChoice).toBe("required");
    expect(policy.allowedCanonicalTools).toEqual(["Edit", "Write", "Update"]);
    expect(policy.reason).toBe("stale_source_required_action");
  });

  it.each([
    ["qwen3-coder", true],
    ["generic", false],
  ])("regression matrix: stale reread policy activation for %s", (family, active) => {
    const policy = derivePhaseExecutionPolicy({
      enabled: true,
      adapterFamily: family,
      enabledFamilies: ["qwen3-coder"],
      phase: "edit",
      matchedRules: ["source_file_stale_reread"],
      stream: false,
    });
    expect(policy.active).toBe(active);
  });

  it("keeps Read available during fix-required mode for context refresh", () => {
    const policy = derivePhaseExecutionPolicy({
      enabled: true,
      adapterFamily: "qwen3-coder",
      enabledFamilies: ["qwen3-coder"],
      phase: "edit",
      matchedRules: ["verification_churn_no_edit"],
      stream: false,
    });
    const filtered = filterToolsByPhasePolicy([
      { type: "function", function: { name: "Read", parameters: { type: "object" } } },
      { type: "function", function: { name: "Edit", parameters: { type: "object" } } },
      { type: "function", function: { name: "Bash", parameters: { type: "object" } } },
    ], policy);
    expect(filtered.tools).toHaveLength(2);
    expect(filtered.removed).toEqual(["Bash"]);
  });

  it("keeps client tool choice precedence", () => {
    const policy = derivePhaseExecutionPolicy({
      enabled: true,
      adapterFamily: "qwen3-coder",
      enabledFamilies: ["qwen3-coder"],
      phase: "verify",
      matchedRules: [],
      stream: false,
    });
    expect(resolvePhaseToolChoice("none", policy)).toBe("none");
    expect(resolvePhaseToolChoice(undefined, policy)).toBe("required");
  });

  it("filters required mode tools down to allowed set", () => {
    const policy = derivePhaseExecutionPolicy({
      enabled: true,
      adapterFamily: "qwen3-coder",
      enabledFamilies: ["qwen3-coder"],
      phase: "verify",
      matchedRules: [],
      stream: false,
    });
    const filtered = filterToolsByPhasePolicy([
      { type: "function", function: { name: "Bash", parameters: { type: "object" } } },
      { type: "function", function: { name: "Read", parameters: { type: "object" } } },
    ], policy);
    expect(filtered.filtered).toBe(true);
    expect(filtered.removed).toEqual(["Read"]);
    expect(filtered.tools).toHaveLength(1);
  });

  it("validates required tool-call postconditions", () => {
    const policy = derivePhaseExecutionPolicy({
      enabled: true,
      adapterFamily: "qwen3-coder",
      enabledFamilies: ["qwen3-coder"],
      phase: "verify",
      matchedRules: [],
      stream: false,
    });
    const bad = validateRequiredToolCalls([], policy);
    expect(bad.valid).toBe(false);
    expect(bad.reasons).toContain("missing_tool_call");

    const wrongTool = validateRequiredToolCalls([{ toolName: "Read", input: { file_path: "a.ts" } }], policy);
    expect(wrongTool.valid).toBe(false);
    expect(wrongTool.reasons.some((r) => r.startsWith("disallowed_tool:"))).toBe(true);

    const ok = validateRequiredToolCalls([{ toolName: "Bash", input: { command: "npm test" } }], policy);
    expect(ok.valid).toBe(true);
  });

  it("builds explicit repair prompt", () => {
    const prompt = buildRequiredRepairPrompt("verify", ["Bash"]);
    expect(prompt).toContain("VERIFY");
    expect(prompt).toContain("exactly one tool call");
    expect(prompt).toContain("Allowed canonical tools: Bash.");
  });
});
