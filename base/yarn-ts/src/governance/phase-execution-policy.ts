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
  /** When true, the model has recently failed repeated edits due to stale anchors.
   *  This overrides the source_file_stale_reread restriction to allow Read alongside writes. */
  editContextMissActive?: boolean;
  /** Deterministic re-grounding gate when state confidence is low. */
  stateRegroundRequired?: boolean;
  stateRegroundReadPath?: string | null;
}

export interface PhaseExecutionPolicyDecision {
  active: boolean;
  reason?: string;
  toolChoice?: "auto" | "none" | "required";
  allowedCanonicalTools?: string[];
  enforceNonStreaming?: boolean;
  maxToolCalls?: number;
  downgradedForStreaming?: boolean;
  requiredReadPath?: string;
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
  if (input.stateRegroundRequired) {
    return {
      active: true,
      reason: input.stream ? "state_reground_non_stream_kickoff" : "state_reground_required_action",
      toolChoice: "required",
      allowedCanonicalTools: ["Read"],
      enforceNonStreaming: input.stream,
      maxToolCalls: 1,
      requiredReadPath: typeof input.stateRegroundReadPath === "string" && input.stateRegroundReadPath.trim()
        ? input.stateRegroundReadPath.trim()
        : undefined,
    };
  }
  const families = new Set((input.enabledFamilies ?? []).map((f) => String(f).trim().toLowerCase()).filter(Boolean));
  if (families.size > 0 && !families.has(input.adapterFamily.toLowerCase())) {
    return { active: false };
  }

  const matched = new Set(input.matchedRules);
  const sourceStaleRereadFixRequired = matched.has("source_file_stale_reread");
  const forceVerifyAction = sourceStaleRereadFixRequired
    || input.phase === "verify"
    || matched.has("verification_intent_without_action")
    || matched.has("verification_same_failure_signature_replay")
    || matched.has("verification_fail_repeat_block")
    || matched.has("verification_churn_no_edit")
    || matched.has("verification_stall_no_edit");
  if (!forceVerifyAction) return { active: false };
  const verifyFixRequired = sourceStaleRereadFixRequired
    || matched.has("verification_churn_no_edit")
    || matched.has("verification_stall_no_edit")
    || matched.has("verification_fail_repeat_block")
    || matched.has("verification_same_failure_signature_replay");
  // When the model has been failing edits due to stale anchors, it needs to re-read
  // the file before it can successfully edit. Override the source_file_stale_reread
  // restriction (which normally bans Read) to allow Read alongside write tools.
  const allowRead = input.editContextMissActive === true;
  const allowedCanonicalTools = sourceStaleRereadFixRequired
    ? (allowRead ? ["Read", "Edit", "Write", "Update"] : ["Edit", "Write", "Update"])
    : (verifyFixRequired ? ["Read", "Edit", "Write", "Update"] : ["Bash"]);

  return {
    active: true,
    reason: input.stream
      ? (sourceStaleRereadFixRequired
        ? "stale_source_required_non_stream_kickoff"
        : (verifyFixRequired
        ? "verify_phase_fix_non_stream_kickoff"
        : (input.phase === "verify" ? "verify_phase_non_stream_kickoff" : "verification_intent_non_stream_kickoff")))
      : (sourceStaleRereadFixRequired
        ? "stale_source_required_action"
        : (verifyFixRequired
        ? "verify_phase_fix_required_action"
        : (input.phase === "verify" ? "verify_phase_required_action" : "verification_intent_required_action"))),
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
    const canonical = canonicalValidationToolName(String(call.toolName ?? ""));
    if (allowed) {
      if (!allowed.has(canonical)) reasons.push(`disallowed_tool:${call.toolName}`);
    }
    if (!call.input || typeof call.input !== "object" || Array.isArray(call.input)) {
      reasons.push(`invalid_arguments:${call.toolName}`);
      continue;
    }
    if (decision.requiredReadPath && canonical === "Read") {
      const path = extractPathFromToolInput(call.input);
      if (!path) {
        reasons.push("missing_read_path");
      } else if (!isPathCompatible(decision.requiredReadPath, path)) {
        reasons.push("unexpected_read_path");
      }
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

function extractPathFromToolInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const row = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "target_path", "targetPath"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/");
}

function basename(value: string): string {
  const normalized = normalizePath(value);
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

function isPathCompatible(expectedPath: string, actualPath: string): boolean {
  const expected = normalizePath(expectedPath);
  const actual = normalizePath(actualPath);
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  if (actual.endsWith(expected) || expected.endsWith(actual)) return true;
  const expectedBase = basename(expected);
  const actualBase = basename(actual);
  return expectedBase.length > 0 && expectedBase === actualBase;
}
