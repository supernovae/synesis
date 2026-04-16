import { canonicalValidationToolName } from "../tool-aliases.js";
import type { SessionPhase } from "./execution-governor.js";

export type PhaseAwareToolChoice = "auto" | "none" | "required" | { type: "tool"; toolName: string };

export interface PhaseExecutionPolicyInput {
  enabled: boolean;
  adapterFamily: string;
  enabledFamilies: string[];
  phase: SessionPhase;
  matchedRules: string[];
  stream: boolean;
}

export interface PhaseExecutionPolicyDecision {
  active: boolean;
  reason?: string;
  toolChoice?: "auto" | "none" | "required";
  allowedCanonicalTools?: string[];
  enforceNonStreaming?: boolean;
  maxToolCalls?: number;
  downgradedForStreaming?: boolean;
}

export interface PhaseToolFilterResult {
  tools: unknown[];
  removed: string[];
  filtered: boolean;
}

export interface PhaseRequiredValidationResult {
  valid: boolean;
  reasons: string[];
}

export interface SDKToolCallLike {
  toolName: string;
  input: unknown;
}

export function derivePhaseExecutionPolicy(input: PhaseExecutionPolicyInput): PhaseExecutionPolicyDecision {
  if (!input.enabled) return { active: false };
  const families = new Set((input.enabledFamilies ?? []).map((f) => String(f).trim().toLowerCase()).filter(Boolean));
  if (families.size > 0 && !families.has(input.adapterFamily.toLowerCase())) {
    return { active: false };
  }

  const matched = new Set(input.matchedRules);
  const forceVerifyAction = input.phase === "verify"
    || matched.has("verification_intent_without_action")
    || matched.has("verification_same_failure_signature_replay")
    || matched.has("verification_fail_repeat_block")
    || matched.has("verification_churn_no_edit")
    || matched.has("verification_stall_no_edit");
  if (!forceVerifyAction) return { active: false };
  const verifyFixRequired = matched.has("verification_churn_no_edit")
    || matched.has("verification_stall_no_edit")
    || matched.has("verification_fail_repeat_block")
    || matched.has("verification_same_failure_signature_replay");
  const allowedCanonicalTools = verifyFixRequired
    ? ["Edit", "Write", "Update"]
    : ["Bash"];

  return {
    active: true,
    reason: input.stream
      ? (verifyFixRequired
        ? "verify_phase_fix_non_stream_kickoff"
        : (input.phase === "verify" ? "verify_phase_non_stream_kickoff" : "verification_intent_non_stream_kickoff"))
      : (verifyFixRequired
        ? "verify_phase_fix_required_action"
        : (input.phase === "verify" ? "verify_phase_required_action" : "verification_intent_required_action")),
    toolChoice: "required",
    allowedCanonicalTools,
    enforceNonStreaming: input.stream,
    maxToolCalls: 1,
  };
}

export function resolvePhaseToolChoice(
  clientChoice: PhaseAwareToolChoice | undefined,
  decision: PhaseExecutionPolicyDecision,
): PhaseAwareToolChoice | undefined {
  if (clientChoice !== undefined) return clientChoice;
  return decision.toolChoice;
}

export function filterToolsByPhasePolicy(
  tools: unknown[] | undefined,
  decision: PhaseExecutionPolicyDecision,
): PhaseToolFilterResult {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { tools: [], removed: [], filtered: false };
  }
  if (!decision.active || decision.toolChoice !== "required" || !decision.allowedCanonicalTools?.length) {
    return { tools, removed: [], filtered: false };
  }
  const allowed = new Set(decision.allowedCanonicalTools);
  const removed: string[] = [];
  const kept = tools.filter((tool) => {
    const rawName = getToolName(tool);
    if (!rawName) return true;
    const canonical = canonicalValidationToolName(rawName);
    if (allowed.has(canonical)) return true;
    removed.push(rawName);
    return false;
  });
  return { tools: kept, removed, filtered: removed.length > 0 };
}

export function validateRequiredToolCalls(
  calls: SDKToolCallLike[],
  decision: PhaseExecutionPolicyDecision,
): PhaseRequiredValidationResult {
  if (!decision.active || decision.toolChoice !== "required") return { valid: true, reasons: [] };
  const reasons: string[] = [];
  if (calls.length < 1) reasons.push("missing_tool_call");
  if (decision.maxToolCalls && calls.length > decision.maxToolCalls) reasons.push("too_many_tool_calls");
  const allowed = decision.allowedCanonicalTools?.length ? new Set(decision.allowedCanonicalTools) : null;
  for (const call of calls) {
    if (allowed) {
      const canonical = canonicalValidationToolName(String(call.toolName ?? ""));
      if (!allowed.has(canonical)) reasons.push(`disallowed_tool:${call.toolName}`);
    }
    if (!call.input || typeof call.input !== "object" || Array.isArray(call.input)) {
      reasons.push(`invalid_arguments:${call.toolName}`);
    }
  }
  return { valid: reasons.length === 0, reasons };
}

export function buildRequiredRepairPrompt(phase: SessionPhase, allowedCanonicalTools: string[] | undefined): string {
  const allowed = (allowedCanonicalTools ?? []).join(", ") || "Bash";
  return [
    `You are in ${phase.toUpperCase()} phase.`,
    "Valid output for this turn is exactly one tool call.",
    `Allowed canonical tools: ${allowed}.`,
    "Do not explain, summarize, or restate intent.",
    "Emit exactly one tool call now.",
  ].join("\n");
}

function getToolName(tool: unknown): string | null {
  if (!tool || typeof tool !== "object") return null;
  const row = tool as Record<string, unknown>;
  const nested = row.function && typeof row.function === "object" ? (row.function as Record<string, unknown>) : null;
  const raw = (typeof row.name === "string" ? row.name : "")
    || (nested && typeof nested.name === "string" ? nested.name : "");
  return raw.trim() || null;
}
