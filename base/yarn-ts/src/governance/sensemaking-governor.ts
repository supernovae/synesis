/**
 * Sensemaking Governor — Cynefin-aware execution governance.
 *
 * Replaces the binary rule-matching governor with a continuous signal
 * accumulation system that classifies situations into Cynefin domains
 * and produces graduated responses.
 *
 * Design principles:
 * - Signals accumulate friction; no single signal can trigger hard intervention
 * - Productive momentum is a first-class counterweight, not a patch
 * - Domain boundaries determine response intensity, not individual rules
 * - Chaotic intervention reserved for genuine runaway loops
 * - Shadow mode: runs alongside the existing governor for comparison
 */

import type {
  CommandEvent,
  GovernorInputMessage,
  SessionPhase,
  ExecutionGovernorDecision,
  ExecutionGovernorOptions,
} from "./execution-governor.js";

// ---------------------------------------------------------------------------
// Signal definitions
// ---------------------------------------------------------------------------

export type SignalDomain = "advisory" | "complicated" | "chaotic";

export interface SignalDefinition {
  readonly name: string;
  /** Base weight when signal fires. Range 0.0–1.0. */
  readonly weight: number;
  /** Cynefin domain tier — determines which response bracket this contributes to. */
  readonly domain: SignalDomain;
  /**
   * Per-turn decay multiplier. A signal that fired 3 turns ago has
   * effective weight = weight × decayRate^3. Range 0.0–1.0.
   */
  readonly decayRate: number;
  /**
   * How much each productive event in the recent window reduces this
   * signal's contribution. 0 = immune to productive counterweight,
   * 1.0 = fully cancelable by one productive event.
   */
  readonly productiveCounterweight: number;
}

/** A signal that actually fired in this evaluation. */
export interface FiredSignal {
  readonly name: string;
  readonly definition: SignalDefinition;
  /** How many times this signal has fired (repetition amplifier). */
  readonly count: number;
  /** Raw contribution before decay/counterweight. */
  readonly rawContribution: number;
  /** Final contribution after decay and counterweight. */
  readonly effectiveContribution: number;
}

// ---------------------------------------------------------------------------
// Domain classification and response
// ---------------------------------------------------------------------------

export type CynefinDomain = "complex" | "complicated_low" | "complicated_high" | "chaotic";

export type ResponseLevel = "allow" | "nudge" | "guide" | "intervene";

export interface SensemakingDecision {
  /** The classified Cynefin domain. */
  domain: CynefinDomain;
  /** Graduated response level. */
  responseLevel: ResponseLevel;
  /** Continuous friction score 0.0–1.0. */
  frictionScore: number;
  /** Human-readable short reason. */
  reason: string;
  /** Optional guidance text for nudge/guide responses (injected as system hint). */
  guidance?: string;
  /** Signals that fired in this evaluation, sorted by effective contribution descending. */
  firedSignals: FiredSignal[];
  /** Whether this decision would match the legacy governor's pause decision. */
  legacyWouldPause?: boolean;
  /** Productive momentum score (0.0–1.0). */
  productiveMomentum: number;
  /** Detected session phase (from legacy governor). */
  phase: SessionPhase;
}

// ---------------------------------------------------------------------------
// Signal catalog
// ---------------------------------------------------------------------------

const SIGNAL_CATALOG: ReadonlyMap<string, SignalDefinition> = new Map<string, SignalDefinition>([
  // === Advisory signals (Complex domain) ===
  // These are observations that *might* indicate drift but are often benign.
  // They contribute friction slowly and are easily countered by productive work.
  ["exploration_stall_no_edit", {
    name: "exploration_stall_no_edit",
    weight: 0.10,
    domain: "advisory",
    decayRate: 0.7,
    productiveCounterweight: 0.8,
  }],
  ["broad_discovery_repeat", {
    name: "broad_discovery_repeat",
    weight: 0.08,
    domain: "advisory",
    decayRate: 0.6,
    productiveCounterweight: 0.9,
  }],
  ["bounded_exploration_budget", {
    name: "bounded_exploration_budget",
    weight: 0.08,
    domain: "advisory",
    decayRate: 0.6,
    productiveCounterweight: 0.9,
  }],
  ["verbal_intent_without_action", {
    name: "verbal_intent_without_action",
    weight: 0.06,
    domain: "advisory",
    decayRate: 0.5,
    productiveCounterweight: 1.0,
  }],
  ["repeated_assistant_intro", {
    name: "repeated_assistant_intro",
    weight: 0.07,
    domain: "advisory",
    decayRate: 0.5,
    productiveCounterweight: 1.0,
  }],
  ["broad_to_narrow_verification", {
    name: "broad_to_narrow_verification",
    weight: 0.08,
    domain: "advisory",
    decayRate: 0.7,
    productiveCounterweight: 0.7,
  }],
  ["plan_reread_loop", {
    name: "plan_reread_loop",
    weight: 0.10,
    domain: "advisory",
    decayRate: 0.8,
    productiveCounterweight: 0.6,
  }],
  ["source_file_stale_reread", {
    name: "source_file_stale_reread",
    weight: 0.09,
    domain: "advisory",
    decayRate: 0.7,
    productiveCounterweight: 0.7,
  }],
  ["git_commit_followthrough", {
    name: "git_commit_followthrough",
    weight: 0.06,
    domain: "advisory",
    decayRate: 0.5,
    productiveCounterweight: 0.8,
  }],
  ["cleanup_todo_harvest", {
    name: "cleanup_todo_harvest",
    weight: 0.04,
    domain: "advisory",
    decayRate: 0.4,
    productiveCounterweight: 1.0,
  }],
  ["test_entry_contract", {
    name: "test_entry_contract",
    weight: 0.05,
    domain: "advisory",
    decayRate: 0.5,
    productiveCounterweight: 0.9,
  }],
  ["task_creation_replay", {
    name: "task_creation_replay",
    weight: 0.07,
    domain: "advisory",
    decayRate: 0.6,
    productiveCounterweight: 0.8,
  }],

  // === Complicated signals ===
  // Clear patterns of waste or stall. Require expert guidance but not
  // necessarily hard stops. These build friction faster and resist
  // productive counterweight more.
  ["verification_churn_no_edit", {
    name: "verification_churn_no_edit",
    weight: 0.18,
    domain: "complicated",
    decayRate: 0.85,
    productiveCounterweight: 0.4,
  }],
  ["verification_stall_no_edit", {
    name: "verification_stall_no_edit",
    weight: 0.16,
    domain: "complicated",
    decayRate: 0.85,
    productiveCounterweight: 0.4,
  }],
  ["no_progress_loop", {
    name: "no_progress_loop",
    weight: 0.20,
    domain: "complicated",
    decayRate: 0.9,
    productiveCounterweight: 0.3,
  }],
  ["verification_after_completion_claim", {
    name: "verification_after_completion_claim",
    weight: 0.18,
    domain: "complicated",
    decayRate: 0.8,
    productiveCounterweight: 0.3,
  }],
  ["completion_claim_requires_task_update", {
    name: "completion_claim_requires_task_update",
    weight: 0.14,
    domain: "complicated",
    decayRate: 0.8,
    productiveCounterweight: 0.4,
  }],
  ["verification_intent_without_action", {
    name: "verification_intent_without_action",
    weight: 0.12,
    domain: "complicated",
    decayRate: 0.7,
    productiveCounterweight: 0.5,
  }],
  ["edit_before_retest", {
    name: "edit_before_retest",
    weight: 0.14,
    domain: "complicated",
    decayRate: 0.85,
    productiveCounterweight: 0.3,
  }],
  ["no_repeat_without_change", {
    name: "no_repeat_without_change",
    weight: 0.14,
    domain: "complicated",
    decayRate: 0.85,
    productiveCounterweight: 0.3,
  }],
  ["dependency_install_replay", {
    name: "dependency_install_replay",
    weight: 0.15,
    domain: "complicated",
    decayRate: 0.8,
    productiveCounterweight: 0.3,
  }],
  ["verification_done_report", {
    name: "verification_done_report",
    weight: 0.12,
    domain: "complicated",
    decayRate: 0.8,
    productiveCounterweight: 0.4,
  }],
  ["no_test_files_repeat", {
    name: "no_test_files_repeat",
    weight: 0.14,
    domain: "complicated",
    decayRate: 0.85,
    productiveCounterweight: 0.4,
  }],
  ["verification_no_signal_repeat", {
    name: "verification_no_signal_repeat",
    weight: 0.12,
    domain: "complicated",
    decayRate: 0.8,
    productiveCounterweight: 0.4,
  }],
  ["verification_truncated_output", {
    name: "verification_truncated_output",
    weight: 0.10,
    domain: "complicated",
    decayRate: 0.75,
    productiveCounterweight: 0.5,
  }],
  ["repeat_user_prompt_loop", {
    name: "repeat_user_prompt_loop",
    weight: 0.16,
    domain: "complicated",
    decayRate: 0.85,
    productiveCounterweight: 0.3,
  }],
  ["declaration_followthrough_required", {
    name: "declaration_followthrough_required",
    weight: 0.12,
    domain: "complicated",
    decayRate: 0.8,
    productiveCounterweight: 0.4,
  }],
  ["verification_already_green", {
    name: "verification_already_green",
    weight: 0.10,
    domain: "complicated",
    decayRate: 0.75,
    productiveCounterweight: 0.5,
  }],

  // === Chaotic signals ===
  // Genuine danger: runaway loops, repeated failures with no adaptation,
  // false-green conditions. These build friction very fast, decay slowly,
  // and are barely countered by productive momentum.
  ["consecutive_edit_failures", {
    name: "consecutive_edit_failures",
    weight: 0.30,
    domain: "chaotic",
    decayRate: 0.95,
    productiveCounterweight: 0.1,
  }],
  ["edit_failure_replay", {
    name: "edit_failure_replay",
    weight: 0.25,
    domain: "chaotic",
    decayRate: 0.95,
    productiveCounterweight: 0.1,
  }],
  ["verification_fail_repeat_block", {
    name: "verification_fail_repeat_block",
    weight: 0.28,
    domain: "chaotic",
    decayRate: 0.95,
    productiveCounterweight: 0.1,
  }],
  ["verification_same_failure_signature_replay", {
    name: "verification_same_failure_signature_replay",
    weight: 0.25,
    domain: "chaotic",
    decayRate: 0.9,
    productiveCounterweight: 0.15,
  }],
  ["verification_green_repeat_block", {
    name: "verification_green_repeat_block",
    weight: 0.22,
    domain: "chaotic",
    decayRate: 0.9,
    productiveCounterweight: 0.2,
  }],
  ["false_green_suspected", {
    name: "false_green_suspected",
    weight: 0.28,
    domain: "chaotic",
    decayRate: 0.95,
    productiveCounterweight: 0.1,
  }],
  ["finalize_action_required", {
    name: "finalize_action_required",
    weight: 0.20,
    domain: "chaotic",
    decayRate: 0.9,
    productiveCounterweight: 0.2,
  }],
]);

export function getSignalDefinition(name: string): SignalDefinition | undefined {
  return SIGNAL_CATALOG.get(name);
}

// ---------------------------------------------------------------------------
// Domain thresholds
// ---------------------------------------------------------------------------

const DOMAIN_THRESHOLDS = {
  complex_max: 0.25,
  complicated_low_max: 0.55,
  complicated_high_max: 0.80,
} as const;

function classifyDomain(frictionScore: number): CynefinDomain {
  if (frictionScore < DOMAIN_THRESHOLDS.complex_max) return "complex";
  if (frictionScore < DOMAIN_THRESHOLDS.complicated_low_max) return "complicated_low";
  if (frictionScore < DOMAIN_THRESHOLDS.complicated_high_max) return "complicated_high";
  return "chaotic";
}

function responseForDomain(domain: CynefinDomain): ResponseLevel {
  switch (domain) {
    case "complex": return "allow";
    case "complicated_low": return "nudge";
    case "complicated_high": return "guide";
    case "chaotic": return "intervene";
  }
}

// ---------------------------------------------------------------------------
// Productive momentum
// ---------------------------------------------------------------------------

/**
 * Compute productive momentum from recent events.
 * Returns 0.0 (no momentum) to 1.0 (strong momentum).
 */
export function computeProductiveMomentum(
  events: readonly CommandEvent[],
  windowSize = 5,
): number {
  if (events.length === 0) return 0;
  const window = events.slice(-windowSize);
  let score = 0;
  for (const e of window) {
    if (isProductive(e)) {
      score += 1;
    } else if (isNeutral(e)) {
      score += 0.3;
    }
    // non-productive events add 0
  }
  return Math.min(1.0, score / windowSize);
}

function isProductive(e: CommandEvent): boolean {
  const sig = e.resultSignature.toLowerCase();
  const cmd = e.command.toLowerCase();
  if (/\b(build|test|vet|lint|check|compile)\b/.test(cmd) && !hasFailurePattern(sig)) return true;
  if (/\bgit\s+(commit|push|add)\b/.test(cmd)) return true;
  if (isSuccessfulEdit(e)) return true;
  return false;
}

function isNeutral(e: CommandEvent): boolean {
  const cmd = e.command.toLowerCase();
  if (cmd.startsWith("read:")) return true;
  if (/\bgit\s+(status|diff|log|show)\b/.test(cmd)) return true;
  if (/\b(grep|search|find|glob|list)\b/.test(cmd)) return true;
  return false;
}

function isSuccessfulEdit(e: CommandEvent): boolean {
  const cmd = e.command.toLowerCase();
  if (!/\b(edit|write|strrreplace|update|patch)\b/.test(cmd) && !cmd.startsWith("edit:") && !cmd.startsWith("write:")) return false;
  const sig = e.resultSignature.toLowerCase();
  return !(/\bfail|error|not found|no match\b/.test(sig));
}

function hasFailurePattern(sig: string): boolean {
  return /\bfail(ed|ure)?|error|panic|traceback|exit\s+code\s+[1-9]/.test(sig.toLowerCase());
}

// ---------------------------------------------------------------------------
// Friction score computation
// ---------------------------------------------------------------------------

export interface FrictionInput {
  /** Signals that matched from the legacy governor's rule detection. */
  matchedRules: readonly string[];
  /** Recent command events for momentum computation. */
  events: readonly CommandEvent[];
  /** Session phase for context. */
  phase: SessionPhase;
  /** How many turns since the last user message (for decay). */
  turnsSinceUserPrompt: number;
  /** Number of files changed in this turn. */
  changedFileCount: number;
  /** Whether plan recovery discovery grace is active. */
  planRecoveryGraceActive: boolean;
}

export interface FrictionResult {
  score: number;
  domain: CynefinDomain;
  responseLevel: ResponseLevel;
  firedSignals: FiredSignal[];
  productiveMomentum: number;
}

/**
 * Core friction score computation.
 *
 * Takes matched rule names from the existing governor's detection logic
 * (reusing all 35 signal detectors) and converts them into a continuous
 * friction score with productive momentum counterweight.
 */
export function computeFriction(input: FrictionInput): FrictionResult {
  const momentum = computeProductiveMomentum(input.events);

  const firedSignals: FiredSignal[] = [];
  let totalFriction = 0;

  // Count occurrences for repetition amplification
  const ruleCounts = new Map<string, number>();
  for (const rule of input.matchedRules) {
    ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1);
  }

  for (const [rule, count] of ruleCounts) {
    const def = SIGNAL_CATALOG.get(rule);
    if (!def) continue;

    // Repetition amplifier: log-scaled, so 3 fires ≈ 1.5× weight
    const repetitionMultiplier = 1 + Math.log2(Math.max(1, count));

    // Decay based on turns elapsed (signals from earlier are less relevant)
    const decay = Math.pow(def.decayRate, Math.max(0, input.turnsSinceUserPrompt - 1));

    // Productive counterweight: momentum × how cancelable this signal is
    const counterweight = 1 - (momentum * def.productiveCounterweight);

    // Plan recovery grace reduces advisory signals substantially
    const graceMultiplier = input.planRecoveryGraceActive && def.domain === "advisory"
      ? 0.3
      : input.planRecoveryGraceActive && def.domain === "complicated"
        ? 0.6
        : 1.0;

    const rawContribution = def.weight * repetitionMultiplier;
    const effectiveContribution = Math.max(0, rawContribution * decay * counterweight * graceMultiplier);

    firedSignals.push({
      name: rule,
      definition: def,
      count,
      rawContribution,
      effectiveContribution,
    });

    totalFriction += effectiveContribution;
  }

  // Clamp to 0.0–1.0
  const score = Math.min(1.0, Math.max(0, totalFriction));

  // Sort by contribution descending
  firedSignals.sort((a, b) => b.effectiveContribution - a.effectiveContribution);

  const domain = classifyDomain(score);
  const responseLevel = responseForDomain(domain);

  return { score, domain, responseLevel, firedSignals, productiveMomentum: momentum };
}

// ---------------------------------------------------------------------------
// Graduated guidance generation
// ---------------------------------------------------------------------------

function generateGuidance(friction: FrictionResult, phase: SessionPhase): string | undefined {
  if (friction.responseLevel === "allow") return undefined;

  const topSignals = friction.firedSignals.slice(0, 3);
  if (topSignals.length === 0) return undefined;

  const topSignalName = topSignals[0].name;

  if (friction.responseLevel === "nudge") {
    return generateNudge(topSignalName, phase);
  }

  if (friction.responseLevel === "guide") {
    return generateGuide(topSignals, phase);
  }

  // intervene — strong directive
  return generateIntervention(topSignals, phase);
}

function generateNudge(signalName: string, _phase: SessionPhase): string {
  const nudges: Record<string, string> = {
    exploration_stall_no_edit: "Consider making a concrete edit soon — you've been reading without changes for a while.",
    verification_churn_no_edit: "Your verification loop hasn't led to edits yet. Consider reading the error location and making a targeted fix.",
    no_progress_loop: "Progress seems stalled. Try a different approach or ask the user for clarification.",
    plan_reread_loop: "You've read the plan multiple times. Pick the next incomplete item and start working on it.",
    broad_to_narrow_verification: "Consider running a more targeted test instead of a broad suite.",
    completion_claim_requires_task_update: "If work is done, update the plan/task status. If not, make the next edit.",
    verification_after_completion_claim: "You've said the work is done — commit or update the plan instead of re-verifying.",
  };
  return nudges[signalName] ?? "Consider taking a more focused action.";
}

function generateGuide(signals: FiredSignal[], _phase: SessionPhase): string {
  const top = signals[0].name;
  const guides: Record<string, string> = {
    consecutive_edit_failures: "STOP retrying edits. Run `git diff` to check if changes already exist. If they do, the work is done — update the task status.",
    verification_fail_repeat_block: "STOP re-running failing tests. Read the error location, make ONE focused fix, then run ONE narrow test.",
    no_progress_loop: "You are in a stall loop. Take ONE concrete action: either make an edit, ask the user, or commit what you have.",
    verification_churn_no_edit: "Verification without edits is not progressing. Read the failing file and make a targeted code change.",
    edit_failure_replay: "The same edit keeps failing. The file may already contain changes. Check with `git diff` before retrying.",
    verification_same_failure_signature_replay: "Same build failure repeating. Make a concrete code fix at the reported location before re-running.",
  };
  return guides[top] ?? `Multiple concerns detected (${signals.map((s) => s.name).join(", ")}). Focus on one concrete action.`;
}

function generateIntervention(signals: FiredSignal[], _phase: SessionPhase): string {
  const top = signals[0].name;
  const names = signals.slice(0, 3).map((s) => s.name).join(", ");
  const interventions: Record<string, string> = {
    consecutive_edit_failures: "Your edits are repeatedly failing. STOP. Use `git diff` to see current state. If changes exist, mark done. If not, re-read the file with Read (not cache) and construct exact old_string.",
    verification_fail_repeat_block: "Same test failure repeating without code changes. STOP testing. Make ONE edit to fix the root cause, then ONE narrow verification.",
    false_green_suspected: "Your tests passed but may not cover the files you changed. Run a targeted test on the changed files before claiming completion.",
  };
  return interventions[top] ?? `Critical: ${names}. Take ONE concrete action now (edit, commit, or ask user). Do not continue the current pattern.`;
}

// ---------------------------------------------------------------------------
// Main evaluation — shadow mode
// ---------------------------------------------------------------------------

/**
 * Evaluate the sensemaking governor alongside the legacy governor.
 *
 * In shadow mode, this produces a SensemakingDecision for telemetry
 * comparison without affecting the actual response to the client.
 */
export function evaluateSensemakingGovernor(
  legacyDecision: ExecutionGovernorDecision,
  events: readonly CommandEvent[],
  turnsSinceUserPrompt: number,
  changedFileCount: number,
  planRecoveryGraceActive: boolean,
): SensemakingDecision {
  const friction = computeFriction({
    matchedRules: legacyDecision.matchedRules.filter((r) => r !== "allow"),
    events,
    phase: legacyDecision.telemetry.phase,
    turnsSinceUserPrompt,
    changedFileCount,
    planRecoveryGraceActive,
  });

  const guidance = generateGuidance(friction, legacyDecision.telemetry.phase);

  return {
    domain: friction.domain,
    responseLevel: friction.responseLevel,
    frictionScore: friction.score,
    reason: friction.firedSignals.length === 0
      ? "ok"
      : `${friction.domain}: ${friction.firedSignals.slice(0, 3).map((s) => s.name).join(", ")}`,
    guidance,
    firedSignals: friction.firedSignals,
    legacyWouldPause: legacyDecision.pause,
    productiveMomentum: friction.productiveMomentum,
    phase: legacyDecision.telemetry.phase,
  };
}

/**
 * Compare legacy and sensemaking decisions for telemetry/logging.
 * Returns a compact diagnostic object.
 */
export function compareSensemakingWithLegacy(
  legacy: ExecutionGovernorDecision,
  sensemaking: SensemakingDecision,
): {
  agreement: boolean;
  legacyPause: boolean;
  sensemakingResponse: ResponseLevel;
  frictionScore: number;
  domain: CynefinDomain;
  topSignals: string[];
  productiveMomentum: number;
  /** true when sensemaking would have been MORE permissive (legacy paused, sensemaking wouldn't). */
  sensemakingMorePermissive: boolean;
  /** true when sensemaking would have been LESS permissive (legacy allowed, sensemaking would intervene). */
  sensemakingMoreRestrictive: boolean;
} {
  const legacyPause = legacy.pause;
  const smWouldPause = sensemaking.responseLevel === "intervene";

  return {
    agreement: legacyPause === smWouldPause,
    legacyPause,
    sensemakingResponse: sensemaking.responseLevel,
    frictionScore: Math.round(sensemaking.frictionScore * 1000) / 1000,
    domain: sensemaking.domain,
    topSignals: sensemaking.firedSignals.slice(0, 5).map((s) => `${s.name}(${Math.round(s.effectiveContribution * 100) / 100})`),
    productiveMomentum: Math.round(sensemaking.productiveMomentum * 100) / 100,
    sensemakingMorePermissive: legacyPause && !smWouldPause,
    sensemakingMoreRestrictive: !legacyPause && smWouldPause,
  };
}
