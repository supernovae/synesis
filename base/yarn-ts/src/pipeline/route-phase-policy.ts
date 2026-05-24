import type { SessionPhase } from "../governance/execution-governor.js";
import {
  derivePhaseExecutionPolicy,
  filterToolsByPhasePolicy,
  resolvePhaseToolChoice,
  type PhaseAwareToolChoice,
  type PhaseExecutionPolicyDecision,
  type PhaseToolFilterResult,
} from "../governance/phase-execution-policy.js";

export interface RouteEditMissGuard {
  active?: boolean;
  filePath?: string | null;
  missCount?: number | null;
}

export interface RoutePhasePolicyReadGateResult {
  tools: unknown[] | undefined;
  removed: string[];
  forcedReadToolName?: string;
}

export interface RoutePhasePolicyReadAvailabilityResult {
  tools: unknown[] | undefined;
  readToolName?: string;
  rehydrated: boolean;
  available: boolean;
}

export interface RoutePhasePolicyInput {
  adapterFamily: string;
  basePolicyEnabled: boolean;
  policyEnabledByMatrix: boolean;
  enabledFamilies: string[];
  phase: SessionPhase;
  matchedRules: string[];
  stream: boolean;
  effectiveTools: unknown[];
  clientToolChoice?: PhaseAwareToolChoice;
  editMissGuard?: RouteEditMissGuard | null;
  editMissForceReadPending: boolean;
  forceReadRecovery: boolean;
  consecutiveEditContextMisses: number;
  stateRegroundRequired: boolean;
  stateRegroundReadPath?: string | null;
  clientToolInventory: unknown[];
  recordSessionEvent(eventKind: string, component: string, detail: string, metadataJson?: Record<string, unknown>): void;
  applyEditContextMissReadGate(tools: unknown[] | undefined): RoutePhasePolicyReadGateResult;
  findPreferredReadToolName(tools: unknown[]): string | undefined;
  ensureReadToolAvailability(
    tools: unknown[] | undefined,
    fallbackTools: unknown[] | undefined,
  ): RoutePhasePolicyReadAvailabilityResult;
}

export interface RoutePhasePolicyResult {
  forcePhasePolicy: boolean;
  forceStateRegroundPolicy: boolean;
  phasePolicy: PhaseExecutionPolicyDecision;
  phaseFiltered: PhaseToolFilterResult;
  effectiveTools: unknown[];
  effectiveToolChoice?: PhaseAwareToolChoice;
}

export const QWEN_FORCED_PHASE_POLICY_RULES = new Set([
  "edit_before_retest",
  "source_file_stale_reread",
  "verification_churn_no_edit",
  "verification_fail_repeat_block",
  "verification_same_failure_signature_replay",
  "verification_stall_no_edit",
  "edit_failure_replay",
]);

export function applyRoutePhasePolicy(input: RoutePhasePolicyInput): RoutePhasePolicyResult {
  const forcePhasePolicy =
    !input.basePolicyEnabled
    && input.policyEnabledByMatrix
    && input.adapterFamily === "qwen3-coder"
    && (
      input.editMissForceReadPending
      || input.editMissGuard?.active === true
      || input.matchedRules.some((rule) => QWEN_FORCED_PHASE_POLICY_RULES.has(rule))
    );
  const forceStateRegroundPolicy = input.stateRegroundRequired;
  const phasePolicy = derivePhaseExecutionPolicy({
    enabled: input.basePolicyEnabled || forcePhasePolicy || forceStateRegroundPolicy,
    adapterFamily: input.adapterFamily,
    enabledFamilies: input.enabledFamilies,
    phase: input.phase,
    matchedRules: input.matchedRules,
    stream: input.stream,
    editContextMissActive: input.editMissGuard?.active === true || input.editMissForceReadPending,
    stateRegroundRequired: input.stateRegroundRequired,
    stateRegroundReadPath: input.stateRegroundReadPath,
  });

  if ((forcePhasePolicy || forceStateRegroundPolicy) && phasePolicy.active) {
    input.recordSessionEvent(
      "phase_execution_policy_forced",
      "execution-governor",
      `Forced phase policy phase=${input.phase} rules=${input.matchedRules.join(",") || "none"} reground=${input.stateRegroundRequired}`,
      {
        phase: input.phase,
        matched_rules: input.matchedRules,
        state_confidence_reground: input.stateRegroundRequired,
      },
    );
  }

  const phaseFiltered = filterToolsByPhasePolicy(input.effectiveTools, phasePolicy);
  let effectiveTools = phaseFiltered.tools;
  let effectiveToolChoice = resolvePhaseToolChoice(input.clientToolChoice, phasePolicy);

  if (input.editMissGuard?.active || input.forceReadRecovery) {
    const guardFilePath = input.editMissGuard?.filePath ?? "";
    const guardMissCount = input.editMissGuard?.missCount ?? input.consecutiveEditContextMisses;
    const guardMode = input.forceReadRecovery
      ? "forced_read_recovery"
      : (phasePolicy.active ? "alongside_phase_policy" : "standalone");
    const gated = guardMode === "standalone" || guardMode === "forced_read_recovery"
      ? input.applyEditContextMissReadGate(effectiveTools)
      : {
          tools: effectiveTools,
          removed: [] as string[],
          forcedReadToolName: input.findPreferredReadToolName(effectiveTools),
        };
    if (guardMode === "standalone" || guardMode === "forced_read_recovery") {
      effectiveTools = gated.tools ?? effectiveTools;
    }

    let forcedReadToolName = gated.forcedReadToolName;
    const ensuredRead = input.ensureReadToolAvailability(
      effectiveTools,
      input.clientToolInventory,
    );
    effectiveTools = ensuredRead.tools ?? effectiveTools;
    if (!forcedReadToolName && ensuredRead.readToolName) {
      forcedReadToolName = ensuredRead.readToolName;
    }

    if (ensuredRead.rehydrated) {
      input.recordSessionEvent(
        "edit_context_miss_guard_rehydrated_read",
        "execution-governor",
        `Reintroduced read tool for edit-context recovery file=${guardFilePath || "<unknown>"}`,
        {
          filePath: guardFilePath || null,
          read_tool: ensuredRead.readToolName ?? null,
        },
      );
    }

    if (!ensuredRead.available) {
      input.recordSessionEvent(
        "edit_context_miss_guard_read_missing",
        "execution-governor",
        `Invariant violation: no read-capable tool available while edit-context guard is active for ${guardFilePath || "<unknown>"}`,
        {
          filePath: guardFilePath || null,
          matched_rules: input.matchedRules,
          phase: input.phase,
        },
      );
    }

    if (gated.removed.length > 0 || forcedReadToolName || ensuredRead.rehydrated || !ensuredRead.available) {
      input.recordSessionEvent(
        "edit_context_miss_guard_enforced",
        "execution-governor",
        `mode=${guardMode} removed_tools=${gated.removed.length} file=${guardFilePath || "<unknown>"}`,
        {
          filePath: guardFilePath || null,
          missCount: guardMissCount,
          removed_tools: gated.removed,
          forced_read_tool: forcedReadToolName ?? null,
          guard_mode: guardMode,
          read_rehydrated: ensuredRead.rehydrated,
          read_available: ensuredRead.available,
        },
      );
    }

    if (forcedReadToolName) {
      effectiveToolChoice = { type: "tool", toolName: forcedReadToolName };
    }
  }

  return {
    forcePhasePolicy,
    forceStateRegroundPolicy,
    phasePolicy,
    phaseFiltered,
    effectiveTools,
    effectiveToolChoice,
  };
}
