import { suggestScopedVerificationCommand } from "../verification/test-scope-selector.js";
import type { WorkflowPhase } from "../orchestration/phase-model-orchestrator.js";
import type { ChatState } from "./chat-state.js";
import type { FileState } from "./file-state.js";

export interface GovernorInputMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: unknown };
    name?: string;
    input?: unknown;
  }>;
}

export interface ExecutionGovernorDecision {
  pause: boolean;
  reason: string;
  suggestedNextStep?: string;
  matchedRules: string[];
  telemetry: {
    phase: SessionPhase;
    repeatedTestCommands: number;
    repeatedAskUserPrompts?: number;
    repeatedReadSearchCalls: number;
    repeatedBroadDiscoveryCalls: number;
    totalBroadDiscoveryCalls: number;
    broadTestRepeat: boolean;
    noEditEvidence: boolean;
    trailingVerificationRunLength: number;
    trailingExplorationRunLength?: number;
    trailingProductiveCount?: number;
    hasPlanInContext?: boolean;
    hasPlanEdit?: boolean;
    planReadCount?: number;
    planCachedRereadCount?: number;
    activeGuards?: TransitionGuard[];
    /** Consecutive assistant messages whose opening paragraph matched the previous (duplicate narration). */
    repeatedAssistantIntroEdges?: number;
    /** Whether plan recovery discovery grace is active for this evaluation. */
    planRecoveryDiscoveryGraceActive?: boolean;
  };
}

export interface CommandEvent {
  command: string;
  toolName: string;
  resultSignature: string;
  argsObject?: Record<string, unknown> | null;
}

export type SessionPhase = "explore" | "edit" | "verify" | "report" | "finalize";

export type TransitionGuard =
  | "needs_fresh_read"
  | "partial_context"
  | "needs_relevant_verification"
  | "false_green_suspected"
  | "completion_blocked";

type ArtifactShadowView = ReadonlyMap<string, { stale: boolean; completeness: "full" | "partial"; readReturnedContent: boolean }>;

function artifactViewFromFileState(fileState: FileState | undefined): ArtifactShadowView | undefined {
  if (!fileState || !fileState.filesByPath) return undefined;
  const out = new Map<string, { stale: boolean; completeness: "full" | "partial"; readReturnedContent: boolean }>();
  for (const [path, entry] of Object.entries(fileState.filesByPath)) {
    out.set(path, {
      stale: entry.staleSinceEdit || entry.status === "stale",
      completeness: entry.status === "partial" ? "partial" : "full",
      readReturnedContent: entry.readReturnedContent,
    });
  }
  return out;
}

/**
 * Compute active transition guards from artifact shadows and verification scope.
 */
export function computeTransitionGuards(
  changedFiles: readonly string[],
  verificationCommands: readonly CommandEvent[],
  sawVerificationSuccess: boolean,
  sawVerificationFailure: boolean,
  artifactShadows?: ArtifactShadowView,
): TransitionGuard[] {
  const guards: TransitionGuard[] = [];
  if (!artifactShadows || artifactShadows.size === 0) return guards;

  for (const f of changedFiles) {
    const normalized = f.replace(/\\/g, "/");
    for (const [path, shadow] of artifactShadows) {
      if (path.endsWith(normalized) || normalized.endsWith(path.split("/").pop() ?? "\0")) {
        if (shadow.stale) guards.push("needs_fresh_read");
        if (shadow.completeness === "partial") guards.push("partial_context");
        break;
      }
    }
  }

  if (changedFiles.length > 0 && sawVerificationSuccess && !sawVerificationFailure) {
    const lastVerif = verificationCommands.length > 0
      ? verificationCommands[verificationCommands.length - 1]
      : null;
    if (lastVerif && !verificationScopeCoversChangedFiles(lastVerif.command, changedFiles)) {
      guards.push("needs_relevant_verification");
      guards.push("false_green_suspected");
    }
  }

  if (guards.length > 0) {
    const hasBlocker = guards.includes("needs_fresh_read")
      || guards.includes("false_green_suspected");
    if (hasBlocker) guards.push("completion_blocked");
  }

  return [...new Set(guards)];
}

/**
 * Check whether a verification command's scope covers the changed files.
 * Heuristic: extract the package/directory scope from common test runners
 * and check for path-prefix intersection.
 */
function verificationScopeCoversChangedFiles(
  command: string,
  changedFiles: readonly string[],
): boolean {
  if (changedFiles.length === 0) return true;
  const scopeMatch = command.match(
    /(?:go\s+test|pytest|vitest|jest|npm\s+test|cargo\s+test)\s+(\S+)/i,
  );
  if (!scopeMatch) return true;
  let scope = scopeMatch[1].replace(/^\.\//, "").replace(/\/\.\.\.$/, "");
  if (scope === "." || scope === "./..." || scope === "...") return true;
  scope = scope.replace(/\\/g, "/");
  return changedFiles.some((f) => {
    const n = f.replace(/\\/g, "/");
    return n.includes(scope) || scope.includes(n.replace(/\/[^/]+$/, ""));
  });
}

/**
 * Single source of truth for command patterns that count as "verification"
 * across both the phase FSM and the rules engine. Kept as a function rather
 * than a regex constant so both callers can pass toolName as well.
 */
function isVerificationLike(toolName: string, command: string): boolean {
  const tool = (typeof toolName === "string" ? toolName : "").trim().toLowerCase();
  const cmd = (typeof command === "string" ? command : "").trim().toLowerCase();
  return tool.includes("run_test")
    // Standard test runners
    || /\b(go test|go build|go vet|cargo test|cargo clippy|cargo check|dotnet test|ctest|mvn (test|verify)|gradle test|swift test|xcodebuild test|phpunit|rspec|pytest|npm test|pnpm test|yarn test|eslint|ruff|golangci-lint)\b/.test(cmd)
    // JS: jest, vitest (this repo), npx variants
    || /\b(jest|vitest|npx jest|npx vitest)\b/.test(cmd)
    // JS: npm/pnpm/yarn script aliases
    || /\bnpm\s+run\s+(test|check|lint|build|typecheck)\b/.test(cmd)
    // Python: python -m pytest / poetry run / tox
    || /\bpython3?\s+-m\s+(pytest|mypy|ruff)\b/.test(cmd)
    || /\b(poetry|pipenv)\s+run\s+\S/.test(cmd)
    || /\btox\b/.test(cmd)
    // uv run (Python services in this repo)
    || /\buv\s+run\s+(pytest|ruff|mypy|coverage)\b/.test(cmd)
    // TypeScript compiler as lint/typecheck
    || /\btsc(\s+--noEmit)?\b/.test(cmd)
    // CLI binary invocations: ./binary or /path/to/binary (build-then-run pattern)
    || /(?:(?:^|[&|;])\s*)(?:\.\/|\/\w[\w/.-]*\/)\w[\w.-]*/.test(cmd)
    // git inspection commands count as verification evidence in the rules engine
    || /\bgit\s+(diff|status|log|show)\b/.test(cmd);
}

/**
 * Subset of isVerificationLike for the phase FSM (edit → verify transition).
 * Excludes git inspection commands (git diff/status/log) because those are
 * review steps, not test executions. A stray `git status` after an edit must
 * not advance the phase to "verify" — only an actual build or test should.
 */
function isStrongVerificationCommand(toolName: string, command: string): boolean {
  const tool = (typeof toolName === "string" ? toolName : "").trim().toLowerCase();
  const cmd = (typeof command === "string" ? command : "").trim().toLowerCase();
  return tool.includes("run_test")
    || /\b(go test|go build|go vet|cargo test|cargo clippy|cargo check|dotnet test|ctest|mvn (test|verify)|gradle test|swift test|xcodebuild test|phpunit|rspec|pytest|npm test|pnpm test|yarn test|eslint|ruff|golangci-lint)\b/.test(cmd)
    || /\b(jest|vitest|npx jest|npx vitest)\b/.test(cmd)
    || /\bnpm\s+run\s+(test|check|lint|build|typecheck)\b/.test(cmd)
    || /\bpython3?\s+-m\s+(pytest|mypy|ruff)\b/.test(cmd)
    || /\buv\s+run\s+(pytest|ruff|mypy|coverage)\b/.test(cmd)
    || /\b(poetry|pipenv)\s+run\s+\S/.test(cmd)
    || /\btox\b/.test(cmd)
    || /\btsc(\s+--noEmit)?\b/.test(cmd)
    || /(?:(?:^|[&|;])\s*)(?:\.\/|\/\w[\w/.-]*\/)\w[\w.-]*/.test(cmd);
}

function isExecutionVerificationCommand(toolName: string, command: string): boolean {
  return isStrongVerificationCommand(toolName, command);
}

/**
 * Detect the current session phase from the event stream.
 *
 * Transitions are deterministic — based on tool calls, not LLM text:
 *   [start] -> Explore (default)
 *   Explore -> Edit (first successful file edit)
 *   Edit    -> Verify (build/test after edit)
 *   Verify  -> Edit (another file edit)
 *   any     -> Report (completion claim with no subsequent edit/explore)
 *
 * Walks events forward so the LAST transition wins (most recent phase).
 *
 * @param orchestratorWorkflowPhase When `"implementation"` (from working frame / `x-synesis-orchestrator-phase`),
 *   we do **not** treat read-only investigation verbs ("review the codebase", "audit", …) as locking the FSM
 *   into `explore`. That keeps `governorPhaseToWorkflowPhase` aligned with Claude Code / client "coding" mode
 *   while leaving investigation-only heuristics (`isReadOnlyInvestigationIntent` elsewhere) unchanged.
 */
export function detectSessionPhase(
  events: CommandEvent[],
  userText: string,
  changedFiles: string[],
  hasCompletionClaim: boolean,
  orchestratorWorkflowPhase?: WorkflowPhase,
): SessionPhase {
  const investigationLocksExplore =
    isReadOnlyInvestigationIntent(userText) && orchestratorWorkflowPhase !== "implementation";

  // Investigation intent with no events → explore
  if (events.length === 0) return investigationLocksExplore ? "explore" : "edit";

  // Default: "edit" allows all rules (backward-compatible).
  // "explore" is only entered when investigation intent is confirmed.
  let phase: SessionPhase = investigationLocksExplore ? "explore" : "edit";
  let hasEdited = false;
  let sawVerificationFailure = false;
  let sawVerificationSuccess = false;
  let sawEditFailure = false;

  for (const e of events) {
    const c = e.command;
    const isEdit = isEditCommand(c);
    if (isEdit && hasEditFailureSignature(e.resultSignature)) {
      sawEditFailure = true;
    }
    const isSuccessfulEdit = isEdit
      && !(e.resultSignature && (e.resultSignature.includes("error") || e.resultSignature.includes("failed") || e.resultSignature.includes("no match")));

    if (isSuccessfulEdit) {
      phase = "edit";
      hasEdited = true;
      continue;
    }

    if ((hasEdited || hasCompletionClaim) && isExecutionVerificationCommand(e.toolName, c)) {
      phase = "verify";
      if (hasFailureSignature(e.resultSignature)) {
        sawVerificationFailure = true;
      } else if (hasSuccessSignature(e.resultSignature) || !e.resultSignature) {
        sawVerificationSuccess = true;
      }
      continue;
    }

    // Additional edit after verification cycles back
    if (phase === "verify" && isEdit) {
      phase = "edit";
      continue;
    }
  }

  // Finalize: completion claim + green verification should lock to completion actions.
  if (hasCompletionClaim && sawVerificationSuccess && !sawVerificationFailure && phase === "verify") {
    phase = "finalize";
  }

  // Report: completion claim with no subsequent edit pushes to report (fallback when no green verify seen).
  // Only transition when the model has done meaningful work (at least one edit or verification).
  // Pure exploration sessions (all reads/searches) stay in edit — the completion claim is
  // likely an observation from prior context summary, not a real claim. This prevents
  // locking the model out of exploration tools when it's still discovering the codebase.
  const hasNonExplorationWork = hasEdited || sawVerificationSuccess || sawVerificationFailure;
  if (
    phase !== "finalize"
    && hasCompletionClaim
    && !sawVerificationFailure
    && !sawEditFailure
    && (phase !== "edit" || !sawVerificationSuccess)
    && hasNonExplorationWork
  ) {
    const lastEventIdx = events.length - 1;
    const lastCmd = events[lastEventIdx].command;
    const lastIsEdit = isEditCommand(lastCmd);
    if (!lastIsEdit) {
      phase = "report";
    }
  }

  // Investigation intent keeps us in explore even if tests ran, as long as no edits —
  // unless we already have failure-driven verification/edit failures: then the model
  // must act, not stay in read-only explore.
  if (investigationLocksExplore && !hasEdited) {
    const hasFailureDrivenSignals = sawVerificationFailure
      || sawEditFailure
      || events.some(
        (e) => isVerificationCommand(e.toolName, e.command) && isCompileLikeFailureSignature(e.resultSignature),
      );
    if (!hasFailureDrivenSignals) {
      phase = "explore";
    }
  }

  return phase;
}

function findLastGenuineUserPromptIndex(messages: GovernorInputMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = contentToText(m.content).trim();
    if (!text) continue;
    if (
      Array.isArray(m.content)
      && (m.content as Array<{ type?: string }>).length > 0
      && (m.content as Array<{ type?: string }>).every(
        (b) => b && typeof b === "object" && b.type === "tool_result",
      )
    ) continue;
    return i;
  }
  return -1;
}

export function inferGovernorPhaseFromMessages(messages: GovernorInputMessage[]): SessionPhase {
  const lastUserPromptIdx = findLastGenuineUserPromptIndex(messages);
  const turnMessages = lastUserPromptIdx >= 0 ? messages.slice(lastUserPromptIdx + 1) : messages;
  const events = extractCommandEvents(turnMessages);
  const changedFiles = extractEditedFileHints(events);
  const latestUserText = extractLatestUserText(messages);
  const hasCompletionClaim = hasActiveCompletionClaim(messages);
  return detectSessionPhase(events, latestUserText, changedFiles, hasCompletionClaim);
}

export function governorPhaseToWorkflowPhase(
  phase: SessionPhase,
): "explore" | "planning" | "implementation" | "validation" {
  switch (phase) {
    case "explore":
      return "explore";
    case "edit":
      return "implementation";
    case "verify":
      return "validation";
    case "report":
    case "finalize":
    default:
      return "validation";
  }
}

/**
 * Rules partitioned by which phases they are allowed to fire in.
 * A rule not listed for a phase is silently suppressed.
 */
const PHASE_ALLOWED_RULES: Record<SessionPhase, Set<string>> = {
  explore: new Set([
    // Exploration stalls — redundant re-reads and cycling without progress
    "broad_discovery_repeat",
    "bounded_exploration_budget",
    "plan_reread_loop",
    "source_file_stale_reread",
    "discovery_churn_nudge",
    "exploration_stall_no_edit",
    // Progress / intent loops — even in explore, the model shouldn't narrate
    // "I'll explore..." 18 times without producing a result.
    "no_progress_loop",
    "identical_tool_repeat",
    "repeated_assistant_intro",
    "verbal_intent_without_action",
    // Concrete failures always fire — even during investigation, if a verification
    // command keeps failing without edits the model must stop cycling.
    "verification_churn_no_edit",
    "verification_fail_repeat_block",
    "no_test_files_repeat",
    "dependency_install_replay",
    "test_entry_contract",
    "cleanup_todo_harvest",
  ]),
  edit: new Set([
    // Edit-specific
    "edit_failure_replay",
    "consecutive_edit_failures",
    "edit_before_retest",
    "no_repeat_without_change",
    "declaration_followthrough_required",
    // Exploration stalls
    "exploration_stall_no_edit",
    "broad_discovery_repeat",
    "bounded_exploration_budget",
    "plan_reread_loop",
    "source_file_stale_reread",
    "discovery_churn_nudge",
    // Verification stalls
    "verification_stall_no_edit",
    "verification_churn_no_edit",
    "verification_after_completion_claim",
    "verification_fail_repeat_block",
    "verification_same_failure_signature_replay",
    "verification_truncated_output",
    "no_test_files_repeat",
    "verification_done_report",
    "verification_no_signal_repeat",
    "verification_already_green",
    "verification_green_repeat_block",
    "broad_to_narrow_verification",
    // Progress / workflow
    "no_progress_loop",
    "identical_tool_repeat",
    "repeated_assistant_intro",
    "verbal_intent_without_action",
    "verification_intent_without_action",
    "repeat_user_prompt_loop",
    "completion_claim_requires_task_update",
    "git_commit_followthrough",
    "dependency_install_replay",
    "test_entry_contract",
    "cleanup_todo_harvest",
    "task_creation_replay",
  ]),
  verify: new Set([
    // Verification stalls
    "verification_stall_no_edit",
    "verification_churn_no_edit",
    "verification_after_completion_claim",
    "verification_fail_repeat_block",
    "verification_same_failure_signature_replay",
    "verification_truncated_output",
    "verification_done_report",
    "verification_no_signal_repeat",
    "verification_already_green",
    "verification_green_repeat_block",
    "no_test_files_repeat",
    "broad_to_narrow_verification",
    "edit_before_retest",
    "no_repeat_without_change",
    // Transition guards
    "false_green_suspected",
    // Progress / workflow
    "no_progress_loop",
    "identical_tool_repeat",
    "repeated_assistant_intro",
    "verbal_intent_without_action",
    "verification_intent_without_action",
    "repeat_user_prompt_loop",
    "completion_claim_requires_task_update",
    "git_commit_followthrough",
    "dependency_install_replay",
    "plan_reread_loop",
    "source_file_stale_reread",
    "discovery_churn_nudge",
    "task_creation_replay",
  ]),
  report: new Set([
    // Report phase: almost everything fires — model should be done
    "verification_after_completion_claim",
    "verification_stall_no_edit",
    "verification_churn_no_edit",
    "discovery_churn_nudge",
    "exploration_stall_no_edit",
    "no_progress_loop",
    "identical_tool_repeat",
    "repeated_assistant_intro",
    "verbal_intent_without_action",
    "verification_intent_without_action",
    "repeat_user_prompt_loop",
    "completion_claim_requires_task_update",
    "no_test_files_repeat",
    "dependency_install_replay",
    "broad_to_narrow_verification",
    "git_commit_followthrough",
    "plan_reread_loop",
  ]),
  finalize: new Set([
    // Finalization-only: enforce completion/report actions, no more exploration loops.
    "finalize_action_required",
    "verification_after_completion_claim",
    "verification_done_report",
    "verification_already_green",
    "verification_green_repeat_block",
    "verification_no_signal_repeat",
    "completion_claim_requires_task_update",
    "git_commit_followthrough",
    "repeat_user_prompt_loop",
    "identical_tool_repeat",
    "repeated_assistant_intro",
    // Transition guards
    "false_green_suspected",
  ]),
};

function isRuleAllowedInPhase(rule: string, phase: SessionPhase): boolean {
  return PHASE_ALLOWED_RULES[phase].has(rule);
}

// Explicit precedence for multi-rule matches. Highest priority appears first.
const RULE_PRIORITY_ORDER = [
  "false_green_suspected",
  "finalize_action_required",
  "verification_after_completion_claim",
  "completion_claim_requires_task_update",
  "consecutive_edit_failures",
  "edit_failure_replay",
  "verification_fail_repeat_block",
  "verification_same_failure_signature_replay",
  "verification_churn_no_edit",
  "verification_stall_no_edit",
  "verification_truncated_output",
  "verification_no_signal_repeat",
  "verification_done_report",
  "no_test_files_repeat",
  "source_file_stale_reread",
  "plan_reread_loop",
  "identical_tool_repeat",
  "no_progress_loop",
  "repeated_assistant_intro",
  "discovery_churn_nudge",
  "exploration_stall_no_edit",
  "declaration_followthrough_required",
  "task_creation_replay",
  "repeat_user_prompt_loop",
  "verification_intent_without_action",
  "verbal_intent_without_action",
  "dependency_install_replay",
  "git_commit_followthrough",
  "broad_to_narrow_verification",
  "edit_before_retest",
  "no_repeat_without_change",
  "verification_green_repeat_block",
  "verification_already_green",
  "test_entry_contract",
  "cleanup_todo_harvest",
  "bounded_exploration_budget",
  "broad_discovery_repeat",
] as const;

const RULE_PRIORITY_MAP = new Map<string, number>(
  RULE_PRIORITY_ORDER.map((rule, index) => [rule, RULE_PRIORITY_ORDER.length - index]),
);

const EDIT_REPLAY_NOISE_RULES = new Set([
  "broad_to_narrow_verification",
  "edit_before_retest",
  "no_repeat_without_change",
  "verification_already_green",
  "verification_green_repeat_block",
  "bounded_exploration_budget",
  "broad_discovery_repeat",
]);

function prioritizeMatchedRules(rules: string[]): string[] {
  const unique = [...new Set(rules)];
  unique.sort((a, b) => {
    const pa = RULE_PRIORITY_MAP.get(a) ?? 0;
    const pb = RULE_PRIORITY_MAP.get(b) ?? 0;
    if (pa !== pb) return pb - pa;
    return a.localeCompare(b);
  });
  return unique;
}

function focusRulesForEditReplay(rules: string[]): string[] {
  const hasEditReplayTerminal =
    rules.includes("edit_failure_replay") || rules.includes("consecutive_edit_failures");
  if (!hasEditReplayTerminal) return rules;
  const focused = rules.filter((rule) => !EDIT_REPLAY_NOISE_RULES.has(rule));
  return focused.length > 0 ? focused : rules;
}

export type GovernanceProfileName = "safety_strict" | "balanced_completion" | "strict_control";

interface GovernorThresholds {
  repeatedTestPauseThreshold: number;
  repeatedReadSearchPauseThreshold: number;
  totalBroadDiscoveryPauseThreshold: number;
  repeatedBroadDiscoveryPauseThreshold: number;
  broadVerificationNoticeThreshold: number;
  broadVerificationBlockThreshold: number;
  verificationStallThreshold: number;
  explorationStallThreshold: number;
}

const BALANCED_THRESHOLDS: GovernorThresholds = {
  repeatedTestPauseThreshold: 3,
  repeatedReadSearchPauseThreshold: 5,
  totalBroadDiscoveryPauseThreshold: 6,
  repeatedBroadDiscoveryPauseThreshold: 3,
  broadVerificationNoticeThreshold: 4,
  broadVerificationBlockThreshold: 6,
  verificationStallThreshold: 6,
  explorationStallThreshold: 8,
};

function thresholdsForProfile(profile: GovernanceProfileName): GovernorThresholds {
  if (profile === "safety_strict") {
    return {
      ...BALANCED_THRESHOLDS,
      // Safety-first profile: keep hard runaway controls, reduce behavioral policing.
      repeatedTestPauseThreshold: 4,
      repeatedReadSearchPauseThreshold: 8,
      totalBroadDiscoveryPauseThreshold: 8,
      repeatedBroadDiscoveryPauseThreshold: 4,
      broadVerificationNoticeThreshold: 6,
      broadVerificationBlockThreshold: 8,
      verificationStallThreshold: 10,
      explorationStallThreshold: 8,
    };
  }
  if (profile === "strict_control") {
    return {
      ...BALANCED_THRESHOLDS,
      // Debug/forensics profile: nudge earlier and harder.
      repeatedTestPauseThreshold: 1,
      repeatedReadSearchPauseThreshold: 3,
      totalBroadDiscoveryPauseThreshold: 3,
      repeatedBroadDiscoveryPauseThreshold: 1,
      broadVerificationNoticeThreshold: 2,
      broadVerificationBlockThreshold: 3,
      verificationStallThreshold: 4,
      explorationStallThreshold: 3,
    };
  }
  return BALANCED_THRESHOLDS;
}

function normalizeString(v: unknown): string {
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  return "";
}

const EDIT_COMMAND_PREFIXES = ["edit:", "write:", "filewrite:", "applypatch:", "update:"];

function isEditCommand(command: string): boolean {
  const normalized = normalizeString(command).toLowerCase();
  if (!normalized) return false;
  if (normalized === "edit" || normalized === "write" || normalized === "filewrite" || normalized === "applypatch" || normalized === "update") {
    return true;
  }
  return EDIT_COMMAND_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isTaskLifecycleCommand(command: string): boolean {
  const normalized = normalizeString(command).toLowerCase();
  if (!normalized) return false;
  return normalized === "taskcreate"
    || normalized === "taskupdate"
    || normalized === "todowrite"
    || normalized.startsWith("taskcreate:")
    || normalized.startsWith("taskupdate:")
    || normalized.startsWith("todowrite:");
}

function extractCommandTarget(command: string): string {
  const normalized = normalizeString(command);
  const idx = normalized.indexOf(":");
  if (idx < 0) return "";
  return normalized.slice(idx + 1).trim();
}

function extractPathLikeArg(row: Record<string, unknown>): string {
  return normalizeString(
    row.filePath
    ?? row.file_path
    ?? row.path
    ?? row.target_file
    ?? row.directory
    ?? row.dir,
  );
}

function todoWriteCommandSignature(row: Record<string, unknown>): string {
  const todos = Array.isArray(row.todos) ? row.todos : [];
  if (todos.length === 0) return "todowrite";

  const entries: string[] = [];
  for (const [idx, todo] of todos.entries()) {
    if (!todo || typeof todo !== "object") {
      entries.push(`${idx}:unknown`);
      continue;
    }
    const item = todo as Record<string, unknown>;
    const content = normalizeString(item.content ?? item.title ?? item.task ?? item.id)
      .toLowerCase()
      .slice(0, 80);
    const status = normalizeString(item.status).toLowerCase() || "unknown";
    entries.push(`${idx}:${status}:${content}`);
  }

  return `todowrite:${entries.join("|").slice(0, 700)}`;
}

/**
 * Extract text from a message content payload.
 * Supports plain strings, Claude-style text blocks, and nested tool_result blocks.
 */
function contentToText(content: unknown): string {
  const chunks: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const text = value.trim();
      if (text) chunks.push(text);
      return;
    }
    if (Array.isArray(value)) {
      for (const part of value) visit(part);
      return;
    }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (text) chunks.push(text);
    for (const key of ["error", "message", "output"]) {
      const candidate = row[key];
      if (typeof candidate === "string" && candidate.trim()) {
        chunks.push(candidate.trim());
      }
    }
    const nested = row.content;
    if (nested !== undefined) visit(nested);
  };
  visit(content);
  return chunks.join("\n");
}

function parseArgsToCommand(toolName: string, args: unknown): string {
  if (typeof args === "string") {
    const t = args.trim();
    if (t.startsWith("{")) {
      try {
        const row = JSON.parse(t) as Record<string, unknown>;
        return parseArgsToCommand(toolName, row);
      } catch {
        return normalizeString(args);
      }
    }
    return normalizeString(args);
  }
  if (!args || typeof args !== "object") return "";
  const row = args as Record<string, unknown>;
  if (typeof row.preset === "string" && normalizeString(toolName).toLowerCase().includes("run_test")) {
    return `run_test:${normalizeString(row.preset)}`;
  }
  for (const k of ["command", "cmd", "script"]) {
    if (typeof row[k] === "string") return normalizeString(row[k]);
  }
  const tool = normalizeString(toolName).toLowerCase();
  if (tool.includes("glob")) {
    const pattern = normalizeString(row.glob_pattern ?? row.pattern ?? row.glob);
    return pattern ? `glob:${pattern}` : "glob:*";
  }
  if (tool.includes("inspect_repo") || tool.includes("synesis_inspect_repo")) {
    const query = normalizeString(row.query ?? row.pattern ?? row.search ?? row.search_code);
    if (query) return `search:${query}`;
    const pattern = normalizeString(row.glob_pattern ?? row.glob);
    if (pattern) return `glob:${pattern}`;
    const path = normalizeString(row.list_dir ?? row.path ?? row.dir ?? row.directory);
    return path ? `list:${path}` : "list:.";
  }
  if (tool.includes("read_file") || tool === "read") {
    const p = extractPathLikeArg(row);
    if (p) return `read:${p}`;
  }
  const filePath = extractPathLikeArg(row);
  const isWriteTool = tool === "write"
    || tool === "filewrite"
    || tool.includes("write_file")
    || tool === "writefile";
  if (isWriteTool) {
    if (filePath) return `write:${filePath}`;
    return "write";
  }
  const isEditTool = tool === "edit"
    || tool === "update"
    || tool === "applypatch"
    || tool.includes("apply_patch")
    || tool === "strreplace"
    || tool.includes("str_replace")
    || tool === "multi_edit"
    || tool === "multiedit";
  if (isEditTool) {
    if (filePath) return `edit:${filePath}`;
    return "edit";
  }
  if (
    tool.includes("list_files")
    || tool.includes("read_dir")
    || tool.includes("read_directory")
    || tool === "list_dir"
    || tool.includes("listdir")
  ) {
    const path = normalizeString(row.list_dir || row.path || row.dir || row.directory);
    return path ? `list:${path}` : "list:.";
  }
  if (tool.includes("search") || tool.includes("grep")) {
    const query = normalizeString(row.query || row.pattern || row.search || row.search_code);
    if (query) return `search:${query}`;
  }
  if (USER_FACING_TOOL_RE.test(tool)) {
    const questions = normalizeString(row.questions || row.question || row.prompt || row.text);
    return questions ? `askuser:${questions}` : "askuser";
  }
  if (tool === "taskcreate" || tool === "task_create" || tool.includes("taskcreate")) {
    const title = normalizeString(row.title || row.name || row.content || row.task);
    return title ? `taskcreate:${title}` : "taskcreate";
  }
  if (tool === "taskupdate" || tool === "task_update" || tool.includes("taskupdate")) {
    const title = normalizeString(row.title || row.name || row.content || row.task || row.id);
    return title ? `taskupdate:${title}` : "taskupdate";
  }
  if (tool === "todowrite" || tool.includes("todowrite")) {
    return todoWriteCommandSignature(row);
  }
  const fallbackCommand = normalizeString(
    row.command
    ?? row.cmd
    ?? row.script
    ?? row.query
    ?? row.pattern
    ?? row.search
    ?? row.search_code
    ?? row.title
    ?? row.name
    ?? row.content
    ?? filePath,
  );
  const suffix = fallbackCommand ? `:${fallbackCommand.slice(0, 120)}` : "";
  return `tool:${tool || "unknown"}${suffix}`;
}

function parseArgsToObject(args: unknown): Record<string, unknown> | null {
  if (!args) return null;
  if (typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args !== "string") return null;
  const t = args.trim();
  if (!t.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(t);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

function normalizeResultSignature(content: unknown): string {
  const text = contentToText(content);
  if (!text.trim()) return "";
  return text
    .toLowerCase()
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b\d+(\.\d+)?\s*(ms|s|sec|seconds|m)\b/g, "<t>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export function extractCommandEvents(messages: GovernorInputMessage[]): CommandEvent[] {
  const callById = new Map<string, { command: string; toolName: string; argsObject?: Record<string, unknown> | null }>();
  const out: CommandEvent[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          const id = normalizeString(call.id);
          if (!id) continue;
          const toolName = normalizeString(call.function?.name ?? call.name).toLowerCase();
          const rawArgs = call.function?.arguments ?? call.input;
          const command = parseArgsToCommand(toolName, rawArgs) || `tool:${toolName || "unknown"}`;
          callById.set(id, { command, toolName, argsObject: parseArgsToObject(rawArgs) });
        }
      }
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (p.type !== "tool_use") continue;
          const id = normalizeString(p.id);
          if (!id) continue;
          const toolName = normalizeString(p.name).toLowerCase();
          const rawArgs = p.input;
          const command = parseArgsToCommand(toolName, rawArgs) || `tool:${toolName || "unknown"}`;
          callById.set(id, { command, toolName, argsObject: parseArgsToObject(rawArgs) });
        }
      }
      continue;
    }
    if (msg.role !== "tool" && msg.role !== "tool_result") continue;
    const id = normalizeString(msg.tool_call_id);
    let item = id ? callById.get(id) : undefined;
    if (!item) {
      const fallbackToolName = normalizeString(msg.name).toLowerCase();
      if (!fallbackToolName) continue;
      const fallbackCommand = parseArgsToCommand(fallbackToolName, {}) || `tool:${fallbackToolName || "unknown"}`;
      item = {
        command: fallbackCommand,
        toolName: fallbackToolName,
        argsObject: null,
      };
    }
    if (!item) continue;
    out.push({
      ...item,
      resultSignature: normalizeResultSignature(msg.content),
    });
  }
  return out;
}

function isBroadDiscoveryCommand(toolName: string, command: string): boolean {
  const tool = normalizeString(toolName).toLowerCase();
  const cmd = normalizeString(command).toLowerCase();
  if (tool.includes("glob")) {
    return cmd === "glob:*" || cmd === "glob:**/*" || cmd.startsWith("glob:**/");
  }
  if (
    tool.includes("list_files")
    || tool.includes("read_dir")
    || tool.includes("read_directory")
    || tool === "list_dir"
    || tool.includes("listdir")
    || tool.includes("inspect_repo")
  ) {
    return cmd === "list:." || cmd === "list:/" || cmd === "list:";
  }
  return false;
}

export function extractEditedFileHints(events: CommandEvent[]): string[] {
  const hints = new Set<string>();
  for (const e of events) {
    const c = normalizeString(e.command);
    if (isEditCommand(c)) {
      const file = extractCommandTarget(c);
      if (file) {
        hints.add(file);
        if (hints.size >= 20) break;
      }
    }
  }
  return [...hints];
}

function hasFailureSignature(sig: string): boolean {
  if (!sig) return false;
  return /\bfail(ed|ure)?\b|\berror\b|\bpanic\b|\btraceback\b|not\s+ok\b|expected statement\b|undefined:\b|exit\s+code(\s+<n>|\s+[1-9]\d*)\b|exit(ed)?\s+status\s+[1-9]\d*\b|exited\s+with\s+code\s+(?:<n>|[1-9]\d*)/.test(sig);
}

function isCompileLikeFailureSignature(sig: string): boolean {
  if (!sig) return false;
  return /imported and not used|declared and not used|declared but its value is never read|unused (variable|import|binding)|undefined\b|cannot find symbol|unresolved reference|type mismatch|syntax error|expected .* found|failed to compile|compilation failed|build failed|no required module provides package/.test(sig);
}

function hasSuccessSignature(sig: string): boolean {
  if (!sig) return false;
  return /\bok\b|\bpass(ed)?\b|\bbuild successful\b|\bsuccess\b|\bno test files\b/.test(sig);
}

function hasNoTestFilesSignature(sig: string): boolean {
  if (!sig) return false;
  return /\bno test files\b/.test(sig);
}

function hasEditFailureSignature(sig: string): boolean {
  if (!sig) return false;
  if (hasIdempotentEditSignature(sig)) return false;
  return /error editing file|old[_\s-]?string.*not found|string to replace.*not found|not found in file|failed to find context|exactly once|replace_all is false|found (?:<n>|\d+) matches.*replace_all.*false|uniquely identify the instance|failed to apply patch|did not match file content/.test(sig);
}

/** Index of the most recent failed edit/apply event, or -1. */
function lastEditFailureEventIndex(
  events: Array<{ command: string; resultSignature: string }>,
): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const c = normalizeString(events[i].command);
    if (isEditCommand(c) && hasEditFailureSignature(events[i].resultSignature)) return i;
  }
  return -1;
}

function hasIdempotentEditSignature(sig: string): boolean {
  if (!sig) return false;
  return /already\s+(?:replaced|exists|present)|already\s+contains|no changes (?:made|needed)|nothing to (?:replace|update)/.test(sig);
}

function matchesCompletionClaimPattern(text: string): boolean {
  return /\bi('| a)?ve?\s+(completed|finished|done|implemented)\b/.test(text)
    || /\b(task|feature|clipboard|implementation|integration)\s+(is\s+)?(complete|done)\b/.test(text)
    || /\balready\s+(done|implemented|complete|integrated|finished)\b/.test(text)
    || /\b(is|was)\s+already\s+(done|implemented|complete|integrated)\b/.test(text)
    || /\bfrom\s+the\s+previous\s+session\b/.test(text);
}

function hasCompletionClaimInAssistantText(messages: GovernorInputMessage[]): boolean {
  const assistantText = messages
    .filter((m) => m.role === "assistant")
    .map((m) => contentToText(m.content).toLowerCase())
    .join("\n");
  if (!assistantText.trim()) return false;
  return matchesCompletionClaimPattern(assistantText);
}

/**
 * Like hasCompletionClaimInAssistantText but only considers claims that appear
 * AFTER the latest user redirect (user message or user-facing tool result).
 * Stale claims from before the user's latest intent are ignored.
 */
function hasActiveCompletionClaim(messages: GovernorInputMessage[]): boolean {
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const id = normalizeString(call.id);
        const name = normalizeString(call.function?.name ?? call.name).toLowerCase();
        if (id && name) toolNameById.set(id, name);
      }
    }
  }

  // Find the index of the latest user redirect
  let latestUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === "user") { latestUserIdx = i; break; }
    if ((m.role === "tool" || m.role === "tool_result") && m.tool_call_id) {
      const toolName = toolNameById.get(normalizeString(m.tool_call_id));
      if (toolName && USER_FACING_TOOL_RE.test(toolName)) {
        const content = contentToText(m.content);
        if (content.trim()) { latestUserIdx = i; break; }
      }
    }
  }

  // Only check assistant messages after the latest user redirect
  const startIdx = latestUserIdx >= 0 ? latestUserIdx + 1 : 0;
  const assistantText = messages
    .slice(startIdx)
    .filter((m) => m.role === "assistant")
    .map((m) => contentToText(m.content).toLowerCase())
    .join("\n");
  if (!assistantText.trim()) return false;
  return matchesCompletionClaimPattern(assistantText);
}

function hasTaskMentionInTurnText(messages: GovernorInputMessage[]): boolean {
  const text = messages
    .filter((m) => m.role === "assistant" || m.role === "user")
    .map((m) => contentToText(m.content).toLowerCase())
    .join("\n");
  return /\b(tasks?|todos?|task list|open tasks|pending tasks|duplicate tasks|remaining tasks|clean\s*up.*tasks)\b/.test(text);
}

/**
 * Count assistant messages that contain verbal intent declarations
 * ("I'll ...", "Let me ...") without intervening edits or task updates.
 * Returns the max consecutive streak of intent-only assistant messages.
 */
function countVerbalIntentStreak(messages: GovernorInputMessage[], events: CommandEvent[]): number {
  // Reset only on meaningful progress actions, not on read/search churn.
  // This keeps the rule sensitive to loops like:
  // "I'll verify/rebase..." + repeated Read/List/Search with no actual progress.
  const hasProgressAction = events.some((e) =>
    isVerificationCommand(e.toolName, e.command)
    || isEditCommand(e.command)
    || isTaskLifecycleCommand(e.command),
  );
  if (hasProgressAction) return 0;

  let streak = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const text = contentToText(m.content).trim().toLowerCase();
    if (!text) continue;
    if (/\b(i'll|i will|let me|let's)\s+\w/.test(text)) {
      streak += 1;
    }
  }
  return streak;
}

/**
 * Count assistant messages that explicitly promise to run tests/verification
 * but never issue an actual verification command in this turn.
 */
function countVerificationIntentWithoutAction(messages: GovernorInputMessage[], events: CommandEvent[]): number {
  const hasAnyVerificationCommand = events.some((e) => isVerificationCommand(e.toolName, e.command));
  if (hasAnyVerificationCommand) return 0;

  const hasRealEditOrTaskAction = events.some((e) =>
    isEditCommand(e.command)
    || isTaskLifecycleCommand(e.command),
  );
  if (hasRealEditOrTaskAction) return 0;

  let streak = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const text = contentToText(m.content).trim().toLowerCase();
    if (!text) continue;
    if (
      /\b(let me|i'?ll|i will)\b.{0,40}\b(run|rerun|execute|check|see)\b.{0,25}\b(test|tests|completion tests?|build|verify|verification)\b/.test(text)
      || /\b(let me|i'?ll|i will)\b.{0,40}\bsee what'?s failing\b/.test(text)
      // "let me check if X is wired / integrated / connected" — exploration framing for a
      // verification intent (e.g. the main.go repeated-read loop)
      || /\b(let me|i'?ll|i will)\b.{0,40}\b(check|verify|confirm)\b.{0,40}\b(wired|integrated|connected|registered|works|working|complete|done|passes?)\b/.test(text)
      // "check if X is integrated, and (then) run tests"
      || /\b(check|verify|confirm)\b.{0,60}\band\s+(then\s+)?\b(run|execute)\b.{0,25}\b(test|build)\b/.test(text)
    ) {
      streak += 1;
    }
  }
  return streak;
}

/**
 * Count consecutive assistant messages whose first paragraph (normalized) matches
 * the previous assistant's opening. Catches "I'll continue fixing…" repeated across
 * turns even when tools run (verbal_intent_without_action only counts "I'll" without
 * concrete progress actions in events, which reads/edits satisfy).
 */
/** Exported for unit tests; same logic as verbal-loop detection. */
export function countRepeatedAssistantIntroEdges(messages: GovernorInputMessage[]): number {
  const MIN_INTRO_LEN = 60;
  let lastOpening: string | null = null;
  let edges = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const text = contentToText(m.content).trim();
    if (!text) continue;
    // Split first paragraph BEFORE collapsing whitespace — otherwise "\n\n" becomes spaces
    // and the "first paragraph" incorrectly includes suffix lines like "(read tool returned)".
    const firstParaRaw = text.split(/\n\n+/)[0] ?? text;
    const opening = firstParaRaw.toLowerCase().replace(/\s+/g, " ").slice(0, 400);
    if (opening.length < MIN_INTRO_LEN) {
      lastOpening = opening;
      continue;
    }
    if (lastOpening !== null && opening === lastOpening) {
      edges += 1;
    }
    lastOpening = opening;
  }
  return edges;
}

/**
 * Count repeated assistant acknowledgment openings ("I understand", "Understood", etc.).
 * This captures sycophantic replay where wording changes slightly, so exact intro matching
 * does not trigger. Returns edge-count (streak length - 1).
 */
function countDirectiveAcknowledgementEdges(messages: GovernorInputMessage[]): number {
  const ACK_OPENING_RE =
    /^(i understand|understood|got it|acknowledged|sounds good|will do|ok(?:ay)?\b|thanks,?\s+understood)\b/i;
  let streak = 0;
  let maxEdges = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const text = contentToText(m.content).trim();
    if (!text) continue;
    const firstParaRaw = text.split(/\n\n+/)[0] ?? text;
    const opening = firstParaRaw.toLowerCase().replace(/\s+/g, " ").trim();
    if (ACK_OPENING_RE.test(opening)) {
      streak += 1;
      if (streak >= 2) {
        maxEdges = Math.max(maxEdges, streak - 1);
      }
    } else {
      streak = 0;
    }
  }
  return maxEdges;
}

function hasTaskDoneStatusUpdate(events: CommandEvent[]): boolean {
  for (const e of events) {
    const tool = normalizeString(e.toolName).toLowerCase();
    const args = e.argsObject ?? {};
    if (tool.includes("taskupdate")) {
      const status = normalizeString(args.status).toLowerCase();
      if (status === "done" || status === "completed") return true;
    }
    if (tool.includes("todowrite")) {
      const todos = Array.isArray(args.todos) ? args.todos : [];
      for (const todo of todos) {
        if (!todo || typeof todo !== "object") continue;
        const status = normalizeString((todo as Record<string, unknown>).status).toLowerCase();
        if (status === "done" || status === "completed") return true;
      }
    }
  }
  return false;
}

function isDeclarationOnlyEditResultSignature(sig: string): boolean {
  if (!sig) return false;
  const looksSmallEdit = /added <n> line|added <n> lines|removed <n> line|removed <n> lines/.test(sig);
  const declarationMarker =
    /\bimport\b/.test(sig)
    || /\bflag\b/.test(sig)
    || /\brequire\b/.test(sig)
    || /\binclude\b/.test(sig)
    || /\buse\b/.test(sig)
    || /\busing\b/.test(sig)
    || /\bextern\b/.test(sig);
  return looksSmallEdit && declarationMarker;
}

function extractUserText(messages: GovernorInputMessage[]): string {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => contentToText(m.content))
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

const USER_FACING_TOOL_RE = /askuser|ask_user|user_question|askquestion|useranswer|user_input/i;

function needsTestEntryGate(userText: string): boolean {
  return /\b(add|write|create|build).{0,30}\btests?\b/.test(userText)
    || /\bcomprehensive test suite\b/.test(userText);
}

function needsCleanupGate(userText: string): boolean {
  return /\b(clean ?up|technical debt|dead code|todo|fixme|debug logging|polish)\b/.test(userText)
    || /\brefactor\b/.test(userText);
}

function shouldSkipCleanupHarvest(userText: string): boolean {
  return /\b(do not|don't|skip|without)\b.{0,30}\b(todo|fixme|debug)\b.{0,20}\b(harvest|search)\b/.test(userText)
    || /\b(do not|don't|skip|without)\b.{0,40}\bcleanup[_ -]?todo[_ -]?harvest\b/.test(userText);
}

function hasTestConfigDiscovery(events: Array<{ command: string; toolName: string }>): boolean {
  return events.some((e) =>
    /search:.*(jest\.config|vitest|pytest\.ini|pyproject\.toml|package\.json|go\.mod)/i.test(e.command)
    || /read:.*(jest\.config|vitest|pytest\.ini|pyproject\.toml|package\.json|go\.mod)/i.test(e.command),
  );
}

type TestRuntime =
  | "go"
  | "rust"
  | "js_ts"
  | "python"
  | "java"
  | "kotlin"
  | "dotnet"
  | "cpp"
  | "ruby"
  | "php"
  | "swift"
  | "unknown";

function inferTestRuntime(
  events: Array<{ command: string; toolName: string }>,
  userText: string,
): TestRuntime {
  const joined = `${userText}\n${events.map((e) => `${e.toolName} ${e.command}`).join("\n")}`.toLowerCase();
  if (/\bcargo test\b|\.rs\b|cargo\.toml\b/.test(joined)) return "rust";
  if (/\bgo test\b|\.go\b|_test\.go\b|\bgo\.mod\b/.test(joined)) return "go";
  if (/\bmvn test\b|\bgradle test\b|\.java\b|pom\.xml\b/.test(joined)) return "java";
  if (/\bgradle test\b|\.kt\b|build\.gradle\.kts\b/.test(joined)) return "kotlin";
  if (/\bdotnet test\b|\.cs\b|\.sln\b|\.csproj\b/.test(joined)) return "dotnet";
  if (/\bctest\b|\bcmake\b|\.cpp\b|\.cc\b|\.cxx\b|\.c\b|\.h\b|\.hpp\b|cmakelists\.txt\b/.test(joined)) return "cpp";
  if (/\brspec\b|\.rb\b|gemfile\b/.test(joined)) return "ruby";
  if (/\bphpunit\b|\.php\b|composer\.json\b/.test(joined)) return "php";
  if (/\bxcodebuild test\b|swift test\b|\.swift\b|package\.swift\b/.test(joined)) return "swift";
  if (/\bvitest\b|\bjest\b|\bpnpm test\b|\bnpm test\b|\byarn test\b|\.tsx?\b|package\.json\b/.test(joined)) return "js_ts";
  if (/\bpytest\b|pyproject\.toml|pytest\.ini|\.py\b/.test(joined)) return "python";
  return "unknown";
}

function requiresTestConfigDiscovery(runtime: TestRuntime): boolean {
  return runtime === "js_ts" || runtime === "python";
}

function hasTodoHarvest(events: Array<{ command: string; toolName: string }>): boolean {
  return events.some((e) => /search:.*(todo|fixme|debug)/i.test(e.command));
}

function isBroadVerificationCommand(command: string): boolean {
  const cmd = normalizeString(command).toLowerCase();
  if (!cmd) return false;
  return /\bgo\s+test\s+\.\/\.\.\./.test(cmd)
    || /\bgo\s+build\s+\.\/\.\.\./.test(cmd)
    || /\bgo\s+vet\s+\.\/\.\.\./.test(cmd)
    || /\bnpm\s+test\b/.test(cmd)
    || /\bpnpm\s+test\b/.test(cmd)
    || /\byarn\s+test\b/.test(cmd);
}

function isVerificationCommand(toolName: string, command: string): boolean {
  return isVerificationLike(toolName, command);
}

/**
 * Detect commands that represent genuine productive work (not just
 * exploration). A successful build, binary execution, or passing test
 * means the model is verifying real results — the governor should give
 * it more runway before triggering a hard stop.
 */
function isProductiveCommand(command: string, resultSignature: string | undefined): boolean {
  const cmd = normalizeString(command).toLowerCase();
  const sig = normalizeString(resultSignature ?? "").toLowerCase();
  // "0 errors", "0 failed", "no errors" are NOT failures despite containing those words.
  const zeroErrorOutput =
    /\b0\s+errors?\b/.test(sig)
    || /\bno\s+errors?\b/.test(sig)
    || /\b0\s+(test\s+)?fail(ed|ures?)?\b/.test(sig);
  const isFailed = !zeroErrorOutput && (
    sig.includes("error")
    || sig.includes("failed")
    || sig.includes("fatal")
    || /exit\s+code(\s+<n>|\s+[1-9]\d*)\b/.test(sig)
    || /exit(ed)?\s+status\s+<n>\b/.test(sig)
  );
  if (isFailed) return false;
  // Build commands
  if (/\b(go build|go install|cargo build|npm run build|make\b|cmake|dotnet build|mvn (compile|package)|gradle build|tsc)\b/.test(cmd)) return true;
  // Test runners — comprehensive cross-ecosystem
  if (/\b(go test|cargo test|cargo clippy|cargo check|npm test|pnpm test|yarn test|pytest|jest|vitest|rspec|phpunit|dotnet test|mvn test|gradle test)\b/.test(cmd)) return true;
  if (/\bnpm\s+run\s+(test|check|lint|build|typecheck)\b/.test(cmd)) return true;
  if (/\bpython3?\s+-m\s+(pytest|mypy|ruff)\b/.test(cmd)) return true;
  if (/\buv\s+run\s+(pytest|ruff|mypy)\b/.test(cmd)) return true;
  // CLI binary invocations (build-then-run pattern)
  if (/^bash:.*\.\/\w+/.test(cmd) || /^bash:.*--help/.test(cmd) || /^bash:.*--version/.test(cmd)) return true;
  if (/\bgit\s+(add|commit|push)\b/.test(cmd)) return true;
  return false;
}

function isGitAddWithoutCommit(events: CommandEvent[]): boolean {
  let sawGitAdd = false;
  let sawGitCommit = false;
  const tail = events.slice(-6);
  for (const e of tail) {
    const cmd = normalizeString(e.command).toLowerCase();
    if (/\bgit\s+add\b/.test(cmd)) sawGitAdd = true;
    if (/\bgit\s+commit\b/.test(cmd)) sawGitCommit = true;
  }
  return sawGitAdd && !sawGitCommit;
}

function isDependencyInstallReplay(events: CommandEvent[]): boolean {
  const depCmds = new Map<string, number>();
  for (const e of events) {
    const cmd = normalizeString(e.command).toLowerCase();
    const isDepInstall =
      /\bnpm\s+install\b/.test(cmd)
      || /\bpnpm\s+install\b/.test(cmd)
      || /\byarn\s+install\b/.test(cmd)
      || /\bgo\s+mod\s+tidy\b/.test(cmd)
      || /\bpip\s+install\b/.test(cmd)
      || /\buv\s+pip\s+install\b/.test(cmd)
      || /\bcargo\s+build\b/.test(cmd);
    if (!isDepInstall) continue;
    const key = cmd.slice(0, 60);
    depCmds.set(key, (depCmds.get(key) ?? 0) + 1);
  }
  for (const count of depCmds.values()) {
    if (count >= 2) return true;
  }
  return false;
}

function isReadOnlyInvestigationIntent(userText: string): boolean {
  const text = userText.toLowerCase();
  // Strong investigation verbs — unambiguous read-only intent
  const strongInvestigation = /\b(explain|what does|how does|show me|describe|analyze|understand|review|scan|audit|examine|inspect|survey|summarize|catalogue|inventory|what is|where is|list all|status of)\b/.test(text);
  // Weak investigation verbs — only count when combined with completeness/state checks
  const weakInvestigation = /\b(verify|validate|check|assess|ensure|evaluate|look at|make sure)\b/.test(text);
  // "complete" as adjective ("is it complete") vs verb ("complete the task") is ambiguous;
  // require it to appear after "is/are/been" or before a noun, not standalone as a verb.
  const completenessQualifier = /\b(every|all|each|implemented|working|correct|present|exist|missing|feature)\b/.test(text)
    || /\b(is|are|been|fully)\s+complete\b/.test(text);
  const hasInvestigationVerb = strongInvestigation || (weakInvestigation && completenessQualifier);
  if (!hasInvestigationVerb) return false;
  const hasEditVerb = /\b(fix|add|create|change|edit|update|write|refactor|delete|remove|migrate|convert|replace|rewrite|move|rename)\b/.test(text);
  if (!hasEditVerb) return true;
  // "make sure X is implemented" / "ensure X is complete" / "verify X is working" are
  // investigation even though they contain edit-adjacent words in subordinate clauses.
  const investigationDominant = /\b(make sure|ensure|verify|validate|check|scan)\b.{0,40}\b(is |are |was |were |has been|have been|implemented|complete|working|correct|present|exist)\b/.test(text);
  return investigationDominant;
}

export function isPlanRecoveryDiscoveryIntent(userText: string): boolean {
  const text = userText.toLowerCase();
  if (!/\bplan\b/.test(text)) return false;
  const resumeCue = /\b(continue|resume|pick up|pick-up|pick it up|where we left off|last stuck session|prior run|previous run|continue with plan|continue with completing|please continue)\b/.test(text);
  const uncertaintyCue = /\b(crash|crashed|stuck|stalled|unknown|not sure|unsure|lost state|left off|what remains|what's left|incomplete|remaining)\b/.test(text);
  // "continue with plan" is a strong enough signal on its own — the model needs
  // orientation time even without an explicit crash/stuck mention.
  const strongResumeCue = /\b(continue with (?:completing |the )?plan|resume (?:the )?plan|pick up (?:the |where )?plan)\b/.test(text);
  return strongResumeCue || (resumeCue && uncertaintyCue);
}

export type GovernanceUserTextSource = "user_message" | "askuser_tool_result" | "empty";

/**
 * Latest user *directive* for governance phase / investigation heuristics.
 * Prefer the most recent `role=user` text (aligned with the working frame).
 * When that text is read-only investigation, newer AskUser-style answers after
 * that user message override the cue (implementation redirect from a choice).
 * Otherwise AskUser payloads cannot override a substantive fix/implement user line.
 */
export function resolveGovernanceUserCue(messages: GovernorInputMessage[]): {
  text: string;
  source: GovernanceUserTextSource;
} {
  let lastUserIdx = -1;
  let lastUserRaw = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== "user") continue;
    lastUserIdx = i;
    lastUserRaw = contentToText(m.content).trim();
    break;
  }

  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const id = normalizeString(call.id);
        const name = normalizeString(call.function?.name ?? call.name).toLowerCase();
        if (id && name) toolNameById.set(id, name);
      }
    }
  }

  if (lastUserIdx >= 0 && lastUserRaw) {
    const lastLower = lastUserRaw.toLowerCase();
    if (isReadOnlyInvestigationIntent(lastLower)) {
      for (let i = messages.length - 1; i > lastUserIdx; i -= 1) {
        const m = messages[i];
        if ((m.role !== "tool" && m.role !== "tool_result") || !m.tool_call_id) continue;
        const toolName = toolNameById.get(normalizeString(m.tool_call_id));
        if (!toolName || !USER_FACING_TOOL_RE.test(toolName)) continue;
        const t = contentToText(m.content).trim();
        if (t) return { text: t.toLowerCase(), source: "askuser_tool_result" };
      }
    }
    return { text: lastLower, source: "user_message" };
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if ((m.role !== "tool" && m.role !== "tool_result") || !m.tool_call_id) continue;
    const toolName = toolNameById.get(normalizeString(m.tool_call_id));
    if (!toolName || !USER_FACING_TOOL_RE.test(toolName)) continue;
    const text = contentToText(m.content).trim();
    if (text) return { text: text.toLowerCase(), source: "askuser_tool_result" };
  }
  return { text: "", source: "empty" };
}

function extractLatestUserText(messages: GovernorInputMessage[]): string {
  return resolveGovernanceUserCue(messages).text;
}

function isTruncatedVerificationCommand(command: string): boolean {
  const cmd = normalizeString(command).toLowerCase();
  return /\|\s*head\b/.test(cmd)
    || /\|\s*tail\b/.test(cmd)
    || /\|\s*sed\s+-n\b/.test(cmd);
}

function hasFailureSignals(messages: GovernorInputMessage[]): boolean {
  // Only inspect tool/tool_result payloads. User/assistant narration can contain
  // words like "invalid tool parameters" that should not block green verification bypass.
  const joined = messages
    .filter((m) => m.role === "tool" || m.role === "tool_result")
    .map((m) => contentToText(m.content))
    .join("\n")
    .toLowerCase();
  if (!joined.trim()) return false;
  if (/validation_failed|invalid tool parameters|synesis_error/.test(joined)) return false;
  // Common success summaries can contain words like "failed" in zero-count contexts.
  const zeroFailureOnly =
    /\b0\s*failed\b/.test(joined)
    || /\bfailed\s*:\s*0\b/.test(joined)
    || /\b0\s*failures?\b/.test(joined)
    || /\bfailures?\s*:\s*0\b/.test(joined)
    || /\bno\s+failures?\b/.test(joined)
    || /\b0\s*errors?\b/.test(joined)
    || /\berrors?\s*:\s*0\b/.test(joined)
    || /\ball tests passed\b/.test(joined);
  if (zeroFailureOnly && !/\b(1|[2-9]\d*)\s+failed\b|\bpanic\b|\btraceback\b|\bexit\s+code\s+[1-9]/.test(joined)) return false;
  if (/\bexit\s+code\s+([1-9]\d*)\b/.test(joined)) return true;
  return /\bfail(ed|ure)?\b|\berror\b|\bpanic\b|\btraceback\b|not\s+ok\b/.test(joined);
}

export interface ExecutionGovernorOptions {
  profile?: GovernanceProfileName;
  activePlanStage?: string | null;
  editContextMissActive?: boolean;
  /** Per-file artifact shadows from FileSnapshotRegistry for stale/partial detection. */
  artifactShadows?: ReadonlyMap<string, { stale: boolean; completeness: "full" | "partial"; readReturnedContent: boolean }>;
  /** Optional derived ChatState cues (state-led overrides over transcript residue). */
  chatState?: Partial<Pick<ChatState, "activeObjective" | "pendingUserDirective" | "completionStatus" | "narrationResidueSummary" | "lastVerificationOutcome">>;
  /** Optional derived FileState adapter for guard computation fallback. */
  fileState?: FileState;
  /**
   * Client / working-frame workflow phase. When `implementation`, session phase is not forced to `explore`
   * from investigation-only user wording, so governor workflow telemetry matches "coding" expectations.
   */
  orchestratorWorkflowPhase?: WorkflowPhase;
  /**
   * Number of open tasks in the normalized task ledger.
   * When > 0 and a completion claim is active, strengthens the
   * `completion_claim_requires_task_update` signal even without
   * explicit taskcreate/todowrite events in the transcript.
   */
  taskLedgerOpenCount?: number;
}

export function evaluateExecutionGovernor(
  messages: GovernorInputMessage[],
  profileOrOptions: GovernanceProfileName | ExecutionGovernorOptions = "balanced_completion",
): ExecutionGovernorDecision {
  const opts: ExecutionGovernorOptions = typeof profileOrOptions === "string"
    ? { profile: profileOrOptions }
    : profileOrOptions;
  const profile = opts.profile ?? "balanced_completion";
  const activePlanStage = opts.activePlanStage ?? null;
  const editContextMissActive = opts.editContextMissActive === true;
  const taskLedgerOpenCount = opts.taskLedgerOpenCount;
  const thresholds = thresholdsForProfile(profile);
  const stateObjectiveCue = normalizeString(
    opts.chatState?.pendingUserDirective
      ?? opts.chatState?.activeObjective
      ?? "",
  );
  const artifactView = opts.artifactShadows ?? artifactViewFromFileState(opts.fileState);
  // Evaluate from the latest real user prompt (ignoring user-role tool_result wrappers).
  const lastUserPromptIdx = findLastGenuineUserPromptIndex(messages);
  const turnMessages = lastUserPromptIdx >= 0 ? messages.slice(lastUserPromptIdx + 1) : messages;
  const events = extractCommandEvents(turnMessages);
  const changedFiles = extractEditedFileHints(events);
  const userText = stateObjectiveCue || extractUserText(messages);
  const latestUserText = stateObjectiveCue || extractLatestUserText(messages);
  const stateVerificationOutcome = opts.chatState?.lastVerificationOutcome ?? "unknown";
  const hasFailures = stateVerificationOutcome === "fail" || hasFailureSignals(turnMessages);
  const testRuntime = inferTestRuntime(events, userText);
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const lastEventIsVerification = lastEvent
    ? isVerificationCommand(lastEvent.toolName, lastEvent.command)
    : false;
  let repeatedTestCommands = 0;
  let repeatedReadSearchCalls = 0;
  let repeatedBroadDiscoveryCalls = 0;
  let totalBroadDiscoveryCalls = 0;
  let broadVerificationCommands = 0;
  let broadTestRepeat = false;
  let repeatedFailingVerification = 0;
  let repeatedSuccessfulVerification = 0;
  let repeatedNoTestFilesVerification = 0;
  let repeatedNoSignalVerification = 0;
  let repeatedTruncatedVerification = 0;
  let repeatedCompileLikeFailureVerification = 0;
  let repeatedEditFailureReplay = 0;
  let repeatedTaskCreateReplay = 0;
  let declarationFollowthroughViolation = false;
  let completionClaimNeedsTaskUpdate = false;
  const noEditEvidence = changedFiles.length === 0;
  // Active claim: only claims after the latest user redirect (ignores stale claims)
  const hasCompletionClaim = (
    opts.chatState?.completionStatus === "complete_claimed"
    || opts.chatState?.completionStatus === "ready_to_finalize"
    || hasActiveCompletionClaim(messages)
  );
  // Full-turn claim: any completion text in the entire turn (for phase-independent rules)
  const hasTurnCompletionClaim = hasCompletionClaim
    || hasCompletionClaimInAssistantText(turnMessages);
  let sessionPhase = detectSessionPhase(
    events,
    latestUserText,
    changedFiles,
    hasCompletionClaim,
    opts.orchestratorWorkflowPhase,
  );
  const verificationEvents = events.filter((e) => isVerificationLike(e.toolName, e.command));
  const sawAnyVerificationSuccess = verificationEvents.some((e) => hasSuccessSignature(e.resultSignature) || !e.resultSignature);
  const sawAnyVerificationFailure = verificationEvents.some((e) => hasFailureSignature(e.resultSignature));
  const activeGuards = computeTransitionGuards(
    changedFiles, verificationEvents,
    sawAnyVerificationSuccess, sawAnyVerificationFailure,
    artifactView,
  );
  if (sessionPhase === "finalize" && activeGuards.includes("false_green_suspected")) {
    sessionPhase = "verify";
  }
  const matchedRules: string[] = [];
  const pushRule = (rule: string) => {
    if (isRuleAllowedInPhase(rule, sessionPhase)) matchedRules.push(rule);
  };
  const hasRunTest = events.some((e) => isVerificationLike(e.toolName, e.command));
  const hasEdit = events.some((e) => isEditCommand(e.command));

  const BROAD_DISCOVERY_WINDOW = 20;
  const windowStart = Math.max(0, events.length - BROAD_DISCOVERY_WINDOW);
  const editFailureReplay = new Map<string, number>();
  const taskCreateReplay = new Map<string, number>();
  const askUserReplay = new Map<string, number>();
  let repeatedAskUserPrompts = 0;

  for (let i = 0; i < events.length; i += 1) {
    const tool = events[i].toolName;
    const currentIsBroadVerification = isBroadVerificationCommand(events[i].command);
    if (i >= windowStart && isBroadDiscoveryCommand(tool, events[i].command)) {
      totalBroadDiscoveryCalls += 1;
    }
    if (i >= windowStart && currentIsBroadVerification) {
      broadVerificationCommands += 1;
    }
    if (i === 0) continue;
    const previousIsBroadVerification = isBroadVerificationCommand(events[i - 1].command);
    if (
      isVerificationCommand(tool, events[i].command)
      && isVerificationCommand(events[i - 1].toolName, events[i - 1].command)
      && (
        events[i].command === events[i - 1].command
        || (currentIsBroadVerification && previousIsBroadVerification)
      )
    ) {
      repeatedTestCommands += 1;
      if (currentIsBroadVerification || previousIsBroadVerification) broadTestRepeat = true;
      if (
        events[i].resultSignature
        && events[i - 1].resultSignature
        && events[i].resultSignature === events[i - 1].resultSignature
        && hasFailureSignature(events[i].resultSignature)
      ) {
        repeatedFailingVerification += 1;
        if (isCompileLikeFailureSignature(events[i].resultSignature)) {
          repeatedCompileLikeFailureVerification += 1;
        }
      }
      if (
        events[i].resultSignature
        && events[i - 1].resultSignature
        && events[i].resultSignature === events[i - 1].resultSignature
        && hasSuccessSignature(events[i].resultSignature)
      ) {
        repeatedSuccessfulVerification += 1;
        if (hasNoTestFilesSignature(events[i].resultSignature)) {
          repeatedNoTestFilesVerification += 1;
        }
      }
      if (!events[i].resultSignature && !events[i - 1].resultSignature) {
        repeatedNoSignalVerification += 1;
      }
    }
    if (
      isVerificationCommand(tool, events[i].command)
      && isVerificationCommand(events[i - 1].toolName, events[i - 1].command)
      && isTruncatedVerificationCommand(events[i].command)
      && isTruncatedVerificationCommand(events[i - 1].command)
    ) {
      repeatedTruncatedVerification += 1;
    }
    if (events[i].command !== events[i - 1].command) continue;
    if (i >= windowStart && (tool.includes("search") || tool.includes("read"))) {
      repeatedReadSearchCalls += 1;
    }
    if (isBroadDiscoveryCommand(tool, events[i].command)) {
      repeatedBroadDiscoveryCalls += 1;
    }
  }
  for (const e of events) {
    const c = normalizeString(e.command);
    if (!isEditCommand(c)) continue;
    if (hasEditFailureSignature(e.resultSignature)) {
      const key = `${c}|${e.resultSignature}`;
      const next = (editFailureReplay.get(key) ?? 0) + 1;
      editFailureReplay.set(key, next);
      if (next >= 2) repeatedEditFailureReplay += 1;
      continue;
    }
    // A successful edit indicates concrete progress. Reset replay counters so
    // stale failures from earlier in the same turn do not force terminal replay
    // once the model has already moved the file forward.
    editFailureReplay.clear();
    repeatedEditFailureReplay = 0;
  }
  for (const e of events) {
    const c = normalizeString(e.command);
    if (!(c.startsWith("taskcreate:") || c === "taskcreate" || c.startsWith("todowrite:") || c === "todowrite")) continue;
    const key = c;
    const next = (taskCreateReplay.get(key) ?? 0) + 1;
    taskCreateReplay.set(key, next);
    if (next >= 2) repeatedTaskCreateReplay += 1;
  }
  for (const e of events) {
    const c = normalizeString(e.command);
    if (!(c.startsWith("askuser:") || c === "askuser")) continue;
    const key = c;
    const next = (askUserReplay.get(key) ?? 0) + 1;
    askUserReplay.set(key, next);
    if (next >= 2) repeatedAskUserPrompts += 1;
  }

  // Count consecutive edit failures from the tail, regardless of file or signature.
  // Catches the pattern: Update(A) → error, Update(B) → error, Update(A) → error ...
  // where the model alternates targets so edit_failure_replay (same key) doesn't fire.
  let consecutiveEditFailures = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const c = normalizeString(events[i].command);
    if (isEditCommand(c)) {
      if (hasEditFailureSignature(events[i].resultSignature)) {
        consecutiveEditFailures += 1;
      } else {
        break;
      }
    } else if (c.startsWith("read:") || c.startsWith("search:") || c.startsWith("glob:") || c.startsWith("list:")
      || isVerificationCommand(events[i].toolName, events[i].command)) {
      // Non-edit commands between failed edits don't reset the counter — the model
      // interleaves reads/builds between failed edits as "checking" before retrying.
      continue;
    } else {
      break;
    }
  }

  // Detect consecutive identical tool calls from the tail (same command string).
  // Catches degenerate loops like `open http://localhost:1313/` repeated 10+ times.
  // Excludes verification/discovery commands — those have dedicated detectors.
  let identicalToolRepeatCount = 0;
  if (events.length >= 3) {
    const lastEvent = events[events.length - 1];
    const lastCmd = lastEvent.command;
    const lastIsVerification = isVerificationCommand(lastEvent.toolName, lastCmd)
      || isBroadDiscoveryCommand(lastEvent.toolName, lastCmd);
    if (!lastIsVerification) {
      for (let i = events.length - 2; i >= 0; i -= 1) {
        if (events[i].command === lastCmd) {
          identicalToolRepeatCount += 1;
        } else {
          break;
        }
      }
    }
  }

  // Count trailing verification commands from end of events, stopping at first edit.
  // Also track unique commands to distinguish legitimate multi-package verification
  // from the stall pattern (same 2-3 commands cycling: go build → go test → go build → ...).
  // Reads of already-seen files count as verification-adjacent: re-reading clipboard.go
  // five times without editing is the same signal as re-running "go test" five times.
  let trailingVerificationRunLength = 0;
  const trailingVerificationCommands = new Set<string>();
  let trailingRunHasVerification = false;
  const trailingReadPaths = new Map<string, number>();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const vc = events[i].command;
    if (isEditCommand(vc)) break;
    if (isVerificationCommand(events[i].toolName, vc)) {
      trailingVerificationRunLength += 1;
      trailingVerificationCommands.add(vc);
      trailingRunHasVerification = true;
    } else if (vc.startsWith("read:")) {
      const readPath = vc;
      trailingReadPaths.set(readPath, (trailingReadPaths.get(readPath) ?? 0) + 1);
    }
  }
  // Re-reads (same file read 2+ times without editing) contribute to the stall signal
  // only when verification commands are also present — pure exploration is not penalized.
  let trailingRereadCount = 0;
  if (trailingRunHasVerification) {
    for (const count of trailingReadPaths.values()) {
      if (count >= 2) trailingRereadCount += count - 1;
    }
    trailingVerificationRunLength += trailingRereadCount;
  }
  const trailingVerificationHasRepeats = trailingVerificationRunLength > trailingVerificationCommands.size;

  // Count trailing exploration commands (search/grep/glob/read) from end of events,
  // stopping at first edit. Parallel to verification stall but catches the model
  // searching/reading without making progress — the governor's blind spot for
  // post-plan-load waffling where the model keeps searching instead of editing.
  let trailingExplorationRunLength = 0;
  const trailingExplorationCommands = new Set<string>();
  const explorationReadPaths = new Map<string, number>();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ec = events[i].command;
    if (isEditCommand(ec)) break;
    if (isVerificationCommand(events[i].toolName, ec)) break;
    const cmd = ec;
    if (cmd.startsWith("search:") || cmd.startsWith("glob:") || cmd.startsWith("list:")) {
      trailingExplorationRunLength += 1;
      trailingExplorationCommands.add(cmd);
    } else if (cmd.startsWith("read:")) {
      const readPath = cmd;
      const sig = events[i].resultSignature;
      // Reads that returned "unchanged"/"cached"/"already read" gave the model no new
      // information. Don't count them towards exploration stall (they're no-ops).
      // source_file_stale_reread still catches same-file loops regardless.
      const isNoOpRead = sig && (/unchanged|cached|already.read|file_read_blocked|file_unchanged|ok\/unchanged_snapshot_still_visible/i.test(sig));
      explorationReadPaths.set(readPath, (explorationReadPaths.get(readPath) ?? 0) + 1);
      if (!isNoOpRead) {
        trailingExplorationRunLength += 1;
        trailingExplorationCommands.add(readPath);
      }
    }
  }
  // Re-reads of the same file inflate the exploration length (same signal as re-searching)
  for (const count of explorationReadPaths.values()) {
    if (count >= 2) trailingExplorationRunLength += count - 1;
  }
  const trailingExplorationHasRepeats = trailingExplorationRunLength > trailingExplorationCommands.size;

  // Detect if a plan file was read in these events (lowers exploration stall threshold)
  const hasPlanInContext = events.some((e) =>
    e.command.startsWith("read:") && e.command.includes("/.claude/plans/"),
  );

  // Count plan file re-reads: reads of .claude/plans/* where the result signals
  // "unchanged" / "cached" / SYNESIS_PLAN_LOADED cached. A single initial read is
  // fine; 2+ re-reads without an intervening plan edit is a hard stall signal.
  let planReadCount = 0;
  let planCachedRereadCount = 0;
  let hasPlanEdit = false;
  for (const e of events) {
    const c = e.command;
    const isPlanPath = c.includes("/.claude/plans/") || c.includes("/plan") || c.includes("plan.md");
    if ((isEditCommand(c) || c.startsWith("todowrite:") || c.startsWith("taskcreate:")) && isPlanPath) {
      hasPlanEdit = true; continue;
    }
    if (c.startsWith("read:") && c.includes("/.claude/plans/")) {
      planReadCount += 1;
      const sig = e.resultSignature;
      if (sig.includes("unchanged") || sig.includes("cached") || sig.includes("synesis_plan_loaded") || sig.includes("already read")
        || sig.includes("ok/unchanged_snapshot_still_visible")) {
        planCachedRereadCount += 1;
      }
    }
  }

  // Detect repeated reads of the same non-plan source file (same-read loop).
  // Different from planCachedRereadCount: fires on ANY source file read 3+ times
  // within the session without an intervening edit of that file, regardless of
  // whether the result says "unchanged" (not all clients surface that signal).
  // This catches "let me check main.go" × N loops.
  // Scan backward so that reads before the most recent write to a file are invisible to the
  // stale-reread rule.  Example: read×3 → write → read×2.  The forward scan would count 3
  // reads (the pre-write ones) and fire immediately; the backward scan counts only the 2
  // post-write reads, which is the semantically correct "reads since last edit" signal.
  const sourceFileReadCounts = new Map<string, number>();
  const sourceFileEditPaths = new Set<string>();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const c = events[i].command;
    if (isEditCommand(c) && !c.includes("/.claude/plans/")) {
      const path = extractCommandTarget(c);
      if (path) sourceFileEditPaths.add(path);
      // Reads already counted before we reached this write belong to a prior read-cycle;
      // discard them so only post-write reads contribute to the stale threshold.
      if (path) sourceFileReadCounts.delete(path);
    }
    if (c.startsWith("read:") && !c.includes("/.claude/plans/")) {
      const path = c.slice("read:".length);
      // Once a write is seen (backwards), ignore earlier reads for that file.
      if (!sourceFileEditPaths.has(path)) {
        sourceFileReadCounts.set(path, (sourceFileReadCounts.get(path) ?? 0) + 1);
      }
    }
  }
  let maxSourceFileRereadCount = 0;
  let maxSourceFileRereadPath = "";
  for (const [path, count] of sourceFileReadCounts) {
    if (count > maxSourceFileRereadCount) {
      maxSourceFileRereadCount = count;
      maxSourceFileRereadPath = path;
    }
  }
  const sourceFileStaleRereadThreshold = 3;

  // Combined no-progress counter: counts ALL non-edit events from the end, regardless of
  // whether they are verification (go build, git diff) or exploration (search, read, glob).
  // This catches the interleaving blind spot where the model alternates between verification
  // and exploration — neither individual counter reaches its threshold, but the combined
  // count reveals the model is making zero progress.
  //
  // Productive commands (successful builds, binary execution, passing tests) earn a
  // threshold bonus — these show the model is doing legitimate verification, not just
  // looping on reads/searches.
  let trailingNoProgressLength = 0;
  let trailingNoProgressHasRepeats = false;
  let trailingProductiveCount = 0;
  const trailingNoProgressCommands = new Set<string>();
  let editFailureCount = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const c = events[i].command;
    if (isEditCommand(c)
      || c.startsWith("taskcreate:") || c.startsWith("taskupdate:") || c.startsWith("todowrite:")) {
      const sig = events[i].resultSignature;
      if (sig && (sig.includes("error") || sig.includes("failed") || sig.includes("no match"))) {
        editFailureCount += 1;
        trailingNoProgressLength += 1;
        trailingNoProgressCommands.add(c);
        continue;
      }
      break;
    }
    if (isProductiveCommand(c, events[i].resultSignature)) {
      trailingProductiveCount += 1;
    }
    trailingNoProgressLength += 1;
    trailingNoProgressCommands.add(c);
  }
  if (trailingNoProgressLength > trailingNoProgressCommands.size) {
    trailingNoProgressHasRepeats = true;
  }

  // Enforce follow-through when a declaration-only edit is made: avoid read/search churn.
  let sawDeclarationOnlyEdit = false;
  let sawFollowupConcreteEdit = false;
  let nonActionAfterDeclarationEdit = 0;
  for (const e of events) {
    const c = normalizeString(e.command);
    if (isEditCommand(c)) {
      if (isDeclarationOnlyEditResultSignature(e.resultSignature)) {
        sawDeclarationOnlyEdit = true;
        sawFollowupConcreteEdit = false;
        nonActionAfterDeclarationEdit = 0;
        continue;
      }
      if (sawDeclarationOnlyEdit) {
        sawFollowupConcreteEdit = true;
      }
      continue;
    }
    if (!sawDeclarationOnlyEdit || sawFollowupConcreteEdit) continue;
    const t = normalizeString(e.toolName).toLowerCase();
    const isReadOrSearch =
      t.includes("read")
      || t.includes("search")
      || t.includes("grep")
      || t.includes("glob")
      || t === "list_dir"
      || t.includes("listdir")
      || t.includes("inspect_repo");
    if (isReadOrSearch) nonActionAfterDeclarationEdit += 1;
  }
  if (sawDeclarationOnlyEdit && !sawFollowupConcreteEdit && nonActionAfterDeclarationEdit >= 2) {
    declarationFollowthroughViolation = true;
  }
  // Scope task-completion enforcement to recent traffic to avoid stale historical
  // task operations forcing completion-claim pauses in unrelated later turns.
  const taskStatusScopeEvents = events.slice(Math.max(0, events.length - 24));
  const hasTaskLifecycleTraffic = taskStatusScopeEvents.some((e) => {
    const tool = normalizeString(e.toolName).toLowerCase();
    return tool.includes("taskcreate") || tool.includes("taskupdate") || tool.includes("todowrite");
  });
  const hasTaskDoneUpdateInScope = hasTaskDoneStatusUpdate(taskStatusScopeEvents);
  const claimButNoUpdate = hasTaskLifecycleTraffic && hasCompletionClaim && !hasTaskDoneUpdateInScope;
  const taskMentionedButNoUpdate = hasPlanInContext && hasTaskMentionInTurnText(turnMessages) && hasCompletionClaim && !hasTaskDoneUpdateInScope;
  const planNotFinalized = activePlanStage !== null && activePlanStage !== "finalize" && activePlanStage !== "done";
  if (claimButNoUpdate || taskMentionedButNoUpdate || (hasCompletionClaim && planNotFinalized)) {
    completionClaimNeedsTaskUpdate = true;
  }
  if (!completionClaimNeedsTaskUpdate && hasCompletionClaim && (taskLedgerOpenCount ?? 0) > 0) {
    completionClaimNeedsTaskUpdate = true;
  }

  // Detect "completion acknowledged but verification continues" — the model says "already done"
  // or "already implemented" and then keeps running builds/diffs/status instead of
  // updating the plan, committing, or moving on. Count verification+exploration events
  // after the last assistant message that contains a completion claim.
  let verificationAfterCompletionClaim = 0;
  let hasActiveRepairEvidenceAfterCompletionClaim = false;
  const hasAnyClaim = hasCompletionClaim;
  if (hasAnyClaim) {
    let lastClaimIdx = -1;
    for (let i = turnMessages.length - 1; i >= 0; i -= 1) {
      if (turnMessages[i].role === "assistant") {
        if (hasCompletionClaimInAssistantText([turnMessages[i]])) {
          lastClaimIdx = i;
          break;
        }
      }
    }
    if (lastClaimIdx >= 0) {
      const postClaimEvents = extractCommandEvents(turnMessages.slice(lastClaimIdx));
      for (const e of postClaimEvents) {
        const c = e.command;
        if (isEditCommand(c) && hasEditFailureSignature(e.resultSignature)) {
          hasActiveRepairEvidenceAfterCompletionClaim = true;
        }
        if (isEditCommand(c)
          || c.startsWith("taskcreate:") || c.startsWith("taskupdate:") || c.startsWith("todowrite:")) {
          break;
        }
        verificationAfterCompletionClaim += 1;
      }
    }
  }
  // Verbal/verification intent streaks look only at a recent window to avoid
  // reporting inflated counts ("115 times") in long-running sessions where the
  // model may have been productively working before getting stuck.
  const INTENT_RECENCY_MESSAGES = 40;
  const INTENT_RECENCY_EVENTS = 20;
  const recentMessagesForIntent = turnMessages.slice(-INTENT_RECENCY_MESSAGES);
  const recentEventsForIntent = events.slice(-INTENT_RECENCY_EVENTS);
  const verbalIntentStreak = countVerbalIntentStreak(recentMessagesForIntent, recentEventsForIntent);
  const verificationIntentStreak = countVerificationIntentWithoutAction(recentMessagesForIntent, recentEventsForIntent);
  const directiveAckReplayEdges = countDirectiveAcknowledgementEdges(recentMessagesForIntent);
  let repeatedAssistantIntroEdges = Math.max(
    countRepeatedAssistantIntroEdges(recentMessagesForIntent),
    directiveAckReplayEdges,
  );
  if (opts.chatState?.narrationResidueSummary) {
    // State-derived residue indicates repeated intent narration happened even if
    // the current transcript window has been compacted.
    repeatedAssistantIntroEdges = Math.max(repeatedAssistantIntroEdges, 2);
  }
  const hasCommitFinalizeAction = events.some((e) => /\bgit\s+(commit|push)\b/.test(normalizeString(e.command).toLowerCase()));
  const hasFinalizeAction = hasTaskDoneStatusUpdate(events) || hasCommitFinalizeAction;

  // Read-only investigation intent: based on the LATEST user message only,
  // so a follow-up "implement both" overrides an earlier "scan the repo" prompt.
  // If the turn contains actual failures, the model is no longer "just investigating"
  // — it must act (make an edit) to resolve the failure. Downgrade investigation-only
  // so that source_file_stale_reread, verbal_intent, and churn rules can fire.
  const isInvestigationOnly = isReadOnlyInvestigationIntent(latestUserText) && !hasFailures;
  const planRecoveryDiscoveryGraceActive =
    isPlanRecoveryDiscoveryIntent(latestUserText)
    && changedFiles.length === 0
    && events.length <= 30;

  if (!planRecoveryDiscoveryGraceActive && broadTestRepeat) pushRule("broad_to_narrow_verification");
  if (!isInvestigationOnly && isGitAddWithoutCommit(events) && events.length >= 4) pushRule("git_commit_followthrough");
  if (isDependencyInstallReplay(events)) pushRule("dependency_install_replay");
  const hasCompileLikeVerificationFailure = events.some((e) =>
    isVerificationCommand(e.toolName, e.command) && isCompileLikeFailureSignature(e.resultSignature),
  );
  const hasFailureDrivenVerificationLoop =
    hasFailures || repeatedFailingVerification > 0 || repeatedCompileLikeFailureVerification > 0 || hasCompileLikeVerificationFailure;
  if (!planRecoveryDiscoveryGraceActive && repeatedTestCommands >= thresholds.repeatedTestPauseThreshold && hasFailureDrivenVerificationLoop) {
    pushRule("edit_before_retest");
  }
  if (!planRecoveryDiscoveryGraceActive && broadTestRepeat && repeatedTestCommands >= 1 && noEditEvidence && hasFailureDrivenVerificationLoop) {
    pushRule("no_repeat_without_change");
  }
  const effectiveNoEditEvidence = noEditEvidence && !isInvestigationOnly && !planRecoveryDiscoveryGraceActive;
  const verificationChurnThreshold = Math.max(4, thresholds.verificationStallThreshold - 2);
  if (!planRecoveryDiscoveryGraceActive && hasFailureDrivenVerificationLoop && trailingVerificationRunLength >= verificationChurnThreshold) {
    pushRule("verification_churn_no_edit");
  }
  if (repeatedCompileLikeFailureVerification >= 1 && effectiveNoEditEvidence) pushRule("verification_same_failure_signature_replay");
  if (consecutiveEditFailures >= 3) pushRule("consecutive_edit_failures");
  if (repeatedEditFailureReplay >= 1) pushRule("edit_failure_replay");
  if (repeatedTaskCreateReplay >= 1) pushRule("task_creation_replay");
  if (!isInvestigationOnly && declarationFollowthroughViolation) pushRule("declaration_followthrough_required");
  if (!isInvestigationOnly && repeatedAskUserPrompts >= 1 && effectiveNoEditEvidence) pushRule("repeat_user_prompt_loop");
  // Only fire completion-claim enforcement when the model has done non-exploration work
  // (edits or verification). During pure exploration the model's text often references prior
  // context ("features are already implemented") as orientation — not a real claim that the
  // current task is finished.
  // Also suppressed during plan recovery grace: the model legitimately says "already done"
  // when describing prior plan progress during orientation.
  const hasNonExplorationEvents = changedFiles.length > 0
    || events.some((e) => isExecutionVerificationCommand(e.toolName, e.command));
  if (
    completionClaimNeedsTaskUpdate
    && hasNonExplorationEvents
    && !hasActiveRepairEvidenceAfterCompletionClaim
    && !editContextMissActive
    && !planRecoveryDiscoveryGraceActive
  ) {
    pushRule("completion_claim_requires_task_update");
  }
  if (
    !isInvestigationOnly
    && verificationAfterCompletionClaim >= 3
    && effectiveNoEditEvidence
    && hasNonExplorationEvents
    && !editContextMissActive
  ) {
    pushRule("verification_after_completion_claim");
  }
  if (repeatedFailingVerification >= 2 && effectiveNoEditEvidence) pushRule("verification_fail_repeat_block");
  if (repeatedTruncatedVerification >= 1 && effectiveNoEditEvidence) pushRule("verification_truncated_output");
  if (!broadTestRepeat && !hasFailures && repeatedSuccessfulVerification >= 1 && effectiveNoEditEvidence) pushRule("verification_done_report");
  // no_test_files_repeat fires even during investigation — "no test files" is a concrete
  // problem that needs a test file to be created, not suppressed by investigation mode.
  if (repeatedNoTestFilesVerification >= 1 && noEditEvidence) pushRule("no_test_files_repeat");
  if (!broadTestRepeat && !hasFailures && repeatedNoSignalVerification >= 1 && effectiveNoEditEvidence) pushRule("verification_no_signal_repeat");
  // Require noEditEvidence: after a successful Write/StrReplace, the trail is
  // "verify the fix" (Read/bash), not a stall with zero edits. Otherwise we
  // false-positive for every post-edit re-read + green build loop.
  if (!isInvestigationOnly && noEditEvidence && trailingVerificationRunLength >= thresholds.verificationStallThreshold && !hasFailures && trailingVerificationHasRepeats) {
    pushRule("verification_stall_no_edit");
  }
  const effectiveExplorationThreshold = hasPlanInContext
    ? Math.max(2, thresholds.explorationStallThreshold - 2)
    : thresholds.explorationStallThreshold;
  const trailingDiscoveryDuplicateTargets = Math.max(
    0,
    trailingExplorationRunLength - trailingExplorationCommands.size,
  );
  const discoveryChurnNudgeThreshold = effectiveExplorationThreshold;
  const discoveryChurnRunawayThreshold = Math.max(
    discoveryChurnNudgeThreshold + 4,
    thresholds.explorationStallThreshold + 4,
  );
  const repeatedDiscoverySignals = repeatedReadSearchCalls + repeatedBroadDiscoveryCalls;
  const discoveryChurnLikely =
    !isInvestigationOnly
    && effectiveNoEditEvidence
    && trailingExplorationHasRepeats
    && trailingExplorationRunLength >= discoveryChurnNudgeThreshold
    && trailingDiscoveryDuplicateTargets >= 2;
  const discoveryChurnRunaway =
    discoveryChurnLikely
    && (
      trailingExplorationRunLength >= discoveryChurnRunawayThreshold
      || repeatedReadSearchCalls >= thresholds.repeatedReadSearchPauseThreshold + 3
      || repeatedBroadDiscoveryCalls >= thresholds.repeatedBroadDiscoveryPauseThreshold + 1
      || totalBroadDiscoveryCalls >= thresholds.totalBroadDiscoveryPauseThreshold + 2
      || repeatedDiscoverySignals >= thresholds.repeatedReadSearchPauseThreshold + thresholds.repeatedBroadDiscoveryPauseThreshold + 2
    );
  if (discoveryChurnLikely) {
    pushRule("discovery_churn_nudge");
  }
  if (discoveryChurnRunaway) {
    pushRule("exploration_stall_no_edit");
  }
  if (sessionPhase === "finalize" && !hasFinalizeAction && (trailingVerificationRunLength >= 1 || trailingExplorationRunLength >= 1 || verbalIntentStreak >= 1)) {
    pushRule("finalize_action_required");
  }
  if (!isInvestigationOnly && verificationIntentStreak >= 2 && !hasRunTest && effectiveNoEditEvidence) {
    pushRule("verification_intent_without_action");
  }
  if (!isInvestigationOnly && verbalIntentStreak >= 3 && effectiveNoEditEvidence) {
    pushRule("verbal_intent_without_action");
  }
  // Failed edits still populate extractEditedFileHints, clearing noEditEvidence — but duplicate
  // narration + stale StrReplace is a distinct stall we still want to catch.
  const hasEditFailureInTurn = events.some(
    (e) => isEditCommand(e.command) && hasEditFailureSignature(e.resultSignature),
  );
  if (
    !isInvestigationOnly
    && repeatedAssistantIntroEdges >= 2
    && (noEditEvidence || hasEditFailureInTurn || directiveAckReplayEdges >= 2)
  ) {
    pushRule("repeated_assistant_intro");
  }
  // Combined no-progress: fires when verification + exploration interleaving hides the stall.
  // Productive commands (builds, tests, binary runs) earn +1 threshold each, up to +4,
  // because they indicate the model is doing legitimate verification work.
  const baseNoProgressThreshold = hasPlanInContext ? 5 : 8;
  const productiveBonus = Math.min(trailingProductiveCount, 4);
  const noProgressThreshold = baseNoProgressThreshold + productiveBonus;
  const noProgressDiscoveryOnly =
    trailingVerificationRunLength === 0
    && trailingProductiveCount === 0
    && discoveryChurnLikely
    && !discoveryChurnRunaway;
  if (
    !isInvestigationOnly
    && trailingNoProgressLength >= noProgressThreshold
    && effectiveNoEditEvidence
    && trailingNoProgressHasRepeats
    && !noProgressDiscoveryOnly
  ) {
    pushRule("no_progress_loop");
  }
  if (identicalToolRepeatCount >= 2) {
    pushRule("identical_tool_repeat");
  }
  const planRereadThreshold = planRecoveryDiscoveryGraceActive ? 4 : 2;
  if (!isInvestigationOnly && planCachedRereadCount >= planRereadThreshold && !hasPlanEdit) {
    pushRule("plan_reread_loop");
  }
  if (!isInvestigationOnly && maxSourceFileRereadCount >= sourceFileStaleRereadThreshold) {
    pushRule("source_file_stale_reread");
  }
  if (
    totalBroadDiscoveryCalls >= thresholds.totalBroadDiscoveryPauseThreshold
    || repeatedBroadDiscoveryCalls >= thresholds.repeatedBroadDiscoveryPauseThreshold
  ) pushRule("broad_discovery_repeat");
  // Failed edits are often followed by many consecutive re-reads of the same `read:<path>` to
  // rebuild exact `old_string` anchors. That drives repeatedReadSearchCalls and would otherwise
  // spuriously trip bounded_exploration_budget while the model is in legitimate recovery.
  const ANCHOR_RECOVERY_SINCE_FAIL_MAX = 64;
  const lastFailIdx = lastEditFailureEventIndex(events);
  const inAnchorReadRecovery =
    lastFailIdx >= 0 && (events.length - 1 - lastFailIdx) <= ANCHOR_RECOVERY_SINCE_FAIL_MAX;
  if (repeatedReadSearchCalls >= thresholds.repeatedReadSearchPauseThreshold) {
    if (!inAnchorReadRecovery) {
      pushRule("bounded_exploration_budget");
    }
  }
  if (needsTestEntryGate(userText) && hasRunTest && requiresTestConfigDiscovery(testRuntime) && !hasTestConfigDiscovery(events)) {
    pushRule("test_entry_contract");
  }
  const cleanupHarvestRequested = needsCleanupGate(userText) && !shouldSkipCleanupHarvest(userText);
  if (cleanupHarvestRequested && hasEdit && !hasTodoHarvest(events)) {
    pushRule("cleanup_todo_harvest");
  }

  const prioritized = focusRulesForEditReplay(prioritizeMatchedRules(matchedRules));
  matchedRules.length = 0;
  matchedRules.push(...prioritized);

  // Productive momentum: when 2+ of the last 3 events are productive (successful
  // build/test/commit), suppress advisory-only rules that would interrupt the flow.
  // Skip the bypass when green verification loops are active (those need their own path).
  const ADVISORY_MOMENTUM_RULES = new Set([
    "exploration_stall_no_edit",
    "discovery_churn_nudge",
    "broad_to_narrow_verification",
    "verbal_intent_without_action",
    "broad_discovery_repeat",
    "bounded_exploration_budget",
  ]);
  const recentEventWindow = events.slice(-3);
  const recentProductiveCount = recentEventWindow.filter(
    (e) => isProductiveCommand(e.command, e.resultSignature),
  ).length;
  const greenVerificationPending = broadTestRepeat && repeatedTestCommands >= 1 && !hasFailures;
  if (
    recentProductiveCount >= 2
    && matchedRules.every((r) => ADVISORY_MOMENTUM_RULES.has(r))
    && !greenVerificationPending
  ) {
    matchedRules.length = 0;
  }

  if (activeGuards.includes("false_green_suspected")) {
    pushRule("false_green_suspected");
  }

  if (matchedRules.length === 0) {
    return {
      pause: false,
      reason: "ok",
      matchedRules: ["allow"],
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
        trailingExplorationRunLength,
        hasPlanInContext,
        hasPlanEdit,
        activeGuards: activeGuards.length > 0 ? activeGuards : undefined,
      },
    };
  }

  if (matchedRules.includes("false_green_suspected")) {
    const changedList = changedFiles.slice(0, 5).join(", ");
    return {
      pause: true,
      reason: "false_green_suspected",
      suggestedNextStep:
        `Your verification passed but may not cover the files you changed (${changedList}). Run a targeted test that exercises the changed code before claiming completion.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
        activeGuards,
      },
    };
  }

  if (matchedRules.includes("dependency_install_replay")) {
    return {
      pause: true,
      reason: "dependency_install_replay",
      suggestedNextStep:
        "You are repeating the same dependency install command without code changes. If the install succeeded, move on to the next code edit. If it failed, investigate the specific error rather than re-running.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verification_same_failure_signature_replay")) {
    return {
      pause: true,
      reason: "verification_same_failure_signature_replay",
      suggestedNextStep:
        "You are replaying the same compile/build failure signature without edits. Stop rerunning broad verification. Make one concrete code fix at the reported symbol/location, then run one narrow package/file-level verification.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("consecutive_edit_failures")) {
    return {
      pause: true,
      reason: "consecutive_edit_failures",
      suggestedNextStep:
        `Your last ${consecutiveEditFailures} edit attempts ALL failed. STOP trying to edit. The files likely already contain the changes you are attempting. Evidence: git diff shows modifications to these files. Run \`git diff <file>\` to see what's already changed. If the changes are present, the work is DONE — update the plan or task status and move on. If the changes genuinely don't exist, use \`cat <file>\` to get the CURRENT file content (not a cached Read), then construct your edit with exact old_string from that output.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verification_after_completion_claim")) {
    return {
      pause: true,
      reason: "verification_after_completion_claim",
      suggestedNextStep:
        `You acknowledged the work is already done, then ran ${verificationAfterCompletionClaim} more verification commands (builds, tests, git status, diffs). STOP verifying. The work is complete. Take ONE of these actions NOW: (1) update the plan file to mark the task done, (2) run \`git add\` + \`git commit\` to commit the changes, (3) tell the user the task is complete. Do NOT run another build, test, diff, or status command.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("edit_failure_replay")) {
    return {
      pause: true,
      reason: "edit_failure_replay",
      suggestedNextStep:
        "You are replaying the same edit failure. The file may already contain the changes (stale Read cache). Run `git diff <file>` to check. If changes exist, do NOT retry — mark the task done. Otherwise, re-read the exact target section with `cat <file>` or Read with offset/limit, then issue one corrected edit with exact old_string matching the current file content.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("task_creation_replay")) {
    return {
      pause: true,
      reason: "task_creation_replay",
      suggestedNextStep:
        "You are recreating duplicate tasks. Stop creating new task entries for the same intent. Update existing task status and execute one concrete code action (Edit/Write/test) for the active task.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("declaration_followthrough_required")) {
    return {
      pause: true,
      reason: "declaration_followthrough_required",
      suggestedNextStep:
        "You made a declaration-only edit (for example import/flag) but did not complete a usage-site change. Stop additional read/search calls and apply one concrete follow-through edit that wires the new declaration into runtime behavior, then run narrow verification.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("completion_claim_requires_task_update")) {
    return {
      pause: true,
      reason: "completion_claim_requires_task_update",
      suggestedNextStep:
        "You claimed completion but task statuses were not marked done. If a task list exists, update entries to done (TaskUpdate/TodoWrite) now. If there is no task list, respond directly to the user with a concise summary of what was completed and verified. Do NOT run more tests.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verification_fail_repeat_block")) {
    return {
      pause: true,
      reason: "verification_fail_repeat_block",
      suggestedNextStep:
        "You are repeating the same failing verification output. STOP re-running tests/builds. Read the failing file/error location, apply exactly one focused Edit/Write to address that root cause, then run one narrow verification command.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("plan_reread_loop")) {
    return {
      pause: true,
      reason: "plan_reread_loop",
      suggestedNextStep:
        `You have re-read the plan file ${planCachedRereadCount} times and each time it was unchanged/cached. STOP reading the plan. You already have the plan content. Do NOT re-read it, do NOT re-summarize it, do NOT re-verify items marked complete. Take ONE concrete action now: (1) if a task needs marking done, call the plan Edit tool once, (2) if work is needed, make a code edit (Write/Edit), (3) if confused about next step, ask the user.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
        trailingExplorationRunLength,
        hasPlanInContext,
        hasPlanEdit,
        planReadCount,
        planCachedRereadCount,
      },
    };
  }

  if (matchedRules.includes("source_file_stale_reread")) {
    const shortPath = maxSourceFileRereadPath.split("/").slice(-2).join("/");
    return {
      pause: true,
      reason: "source_file_stale_reread",
      suggestedNextStep:
        `You have read \`${shortPath}\` ${maxSourceFileRereadCount} times without editing it. "Unchanged since last read" means the file content is ALREADY in your conversation from an earlier read — it has NOT changed. You have the full content. Do NOT try to read it again. Make your code edit NOW using the content you already have (Write/StrReplace), or run ONE test if you need verification.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
        trailingExplorationRunLength,
        hasPlanInContext,
        hasPlanEdit,
        planReadCount,
        planCachedRereadCount,
      },
    };
  }

  if (matchedRules.includes("no_progress_loop")) {
    const planJustWritten = hasPlanEdit;
    return {
      pause: true,
      reason: "no_progress_loop",
      suggestedNextStep: planJustWritten
        ? "You just created/updated a plan. STOP verifying and re-scanning. Present the plan to the user NOW as a TEXT summary (no tool calls) and ask which item to work on next. Do NOT re-read files or re-search — you already have all the information. END your turn after presenting the plan."
        : `You have run ${trailingNoProgressLength} commands (${trailingProductiveCount} productive) without a code edit. ${trailingProductiveCount > 0 ? "Your builds/tests ran successfully — that means the code is working." : "You are cycling through the same discovery commands. You already have the information you need from prior reads and tool results."} STOP looping. Your ONLY options: (1) Present your summary to the user and END your turn — do NOT call any more tools after your summary text, (2) make exactly ONE code edit if something needs changing. Do NOT re-read files, re-list directories, or re-search after summarizing. If you have already summarized, propose next steps and STOP.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
        trailingExplorationRunLength,
        trailingProductiveCount,
        hasPlanInContext,
        hasPlanEdit,
      },
    };
  }

  if (matchedRules.includes("identical_tool_repeat")) {
    return {
      pause: true,
      reason: "identical_tool_repeat",
      suggestedNextStep:
        `You have called the exact same tool with the same arguments ${identicalToolRepeatCount + 1} times in a row. This is a degenerate loop — the tool result is not changing between calls. STOP repeating this call. Either (1) try a completely different approach, (2) report that the action cannot be completed in this environment, or (3) move on to the next task.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
        trailingExplorationRunLength,
      },
    };
  }

  if (matchedRules.includes("repeated_assistant_intro")) {
    return {
      pause: true,
      reason: "repeated_assistant_intro",
      suggestedNextStep:
        `You are repeating acknowledgment/opening narration (${repeatedAssistantIntroEdges + 1} repeated assistant openings) without landing new forward progress. Do NOT restate "understood"/"I understand" again. Apply the user's directive silently: either (1) make exactly one focused code/test fix now, then run one targeted verification, (2) if the fix already exists, show concrete evidence (diff or failing line) and move on, or (3) state one blocker in a single sentence.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
        repeatedAssistantIntroEdges,
      },
    };
  }

  if (matchedRules.includes("verification_intent_without_action")) {
    return {
      pause: true,
      reason: "verification_intent_without_action",
      suggestedNextStep:
        `You have declared test/verification intent ${verificationIntentStreak} times without running any actual test command. Stop narrating. Your NEXT response must be a tool call: either (A) run exactly ONE targeted test command now (for example: \`go test ./cmd/synesis -run TestRunCompletion -v\`) or (B) make one concrete code edit now. After that single action, use the result to either fix once more or report completion.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("finalize_action_required")) {
    return {
      pause: true,
      reason: "finalize_action_required",
      suggestedNextStep:
        "You are in finalize phase after green verification. Do NOT run more tests or read commands — they are already passing. Take one completion action NOW: (1) write a direct summary to the user confirming what was verified and completed, (2) mark tasks done via TaskUpdate/TodoWrite if a task list exists, or (3) run git add+commit/push if that was requested.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verbal_intent_without_action")) {
    return {
      pause: true,
      reason: "verbal_intent_without_action",
      suggestedNextStep:
        `You have declared intent to act ${verbalIntentStreak} times ("I'll ...", "Let me ...") without taking a concrete action. Stop narrating and do ONE of: (1) run ONE test/build command with Bash now, (2) make one code edit (Write/Edit/Write), or (3) call TaskUpdate/TodoWrite to mark completed tasks done.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("repeat_user_prompt_loop")) {
    return {
      pause: true,
      reason: "repeat_user_prompt_loop",
      suggestedNextStep:
        "The user already answered your focus question. Do not ask the same question again. Execute one concrete implementation step now (for example add shell completion or add missing tests), then run one targeted verification command.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedAskUserPrompts,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verification_stall_no_edit")) {
    return {
      pause: true,
      reason: "verification_stall_no_edit",
      suggestedNextStep:
        `You have run ${trailingVerificationRunLength} verification/read commands without making any code edits${trailingRereadCount > 0 ? ` (including ${trailingRereadCount} redundant re-reads)` : ""}. Builds and tests are passing — there is nothing left to verify. Stop running build/test/read commands. If a task is done, update the plan or mark it complete NOW. Otherwise pick the next unfinished task item, make one concrete code edit (Write/Edit), then run one narrow verification.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
        trailingExplorationRunLength,
        hasPlanInContext,
        hasPlanEdit,
      },
    };
  }

  if (matchedRules.includes("verification_churn_no_edit")) {
    return {
      pause: true,
      reason: "verification_churn_no_edit",
      suggestedNextStep:
        `You have run ${trailingVerificationRunLength} verification/read commands with failing signals and no code edits. Stop cycling build/test/read. Read the failing location once, make exactly one targeted edit, then run one narrow verification command.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedAskUserPrompts,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
        trailingExplorationRunLength,
        hasPlanInContext,
        hasPlanEdit,
      },
    };
  }

  if (matchedRules.includes("exploration_stall_no_edit")) {
    return {
      pause: true,
      reason: "exploration_stall_no_edit",
      suggestedNextStep: hasPlanEdit
        ? "You just created/updated a plan. STOP scanning. Present the plan to the user NOW as TEXT (no tool calls) and ask which item to work on next. Do NOT re-read or re-search. END your turn after presenting."
        : `You have run ${trailingExplorationRunLength} search/read/list commands without making any code edits${hasPlanInContext ? " (a plan file is loaded)" : ""}. Stop exploring.${hasPlanInContext ? " Trust the plan's status markers — do NOT re-verify items marked complete." : ""} Identify one concrete task to work on, make one code edit (Write/Edit), then run one narrow verification.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
        trailingExplorationRunLength,
        hasPlanInContext,
        hasPlanEdit,
      },
    };
  }

  if (matchedRules.includes("verification_truncated_output")) {
    return {
      pause: true,
      reason: "verification_truncated_output",
      suggestedNextStep:
        "Verification output was truncated (for example via | head/tail), so failures may be hidden. Run one narrow verification command without output truncation, capture full result, then apply one focused edit if needed.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("git_commit_followthrough")) {
    return {
      pause: false,
      reason: "git_commit_followthrough",
      suggestedNextStep:
        "You ran git add but did not follow through with git commit. If changes are ready, run git commit now. If not, continue editing — do not loop on git status/diff.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("no_test_files_repeat")) {
    return {
      pause: true,
      reason: "no_test_files_repeat",
      suggestedNextStep:
        "The test command returned '[no test files]' multiple times. Re-running the same test will not produce test files. You MUST create a test file (e.g. *_test.go) with test functions, then run the test command once to verify. Do NOT re-run the test command until you have written a test file.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verification_done_report")) {
    return {
      pause: true,
      reason: "verification_done_report",
      suggestedNextStep:
        "Tests are already passing and no edits were made since the last run. Running the same passing test again adds no new information. Your NEXT action MUST be one of: (A) write a direct summary to the user confirming what was verified, or (B) proceed to the next task in the plan. Do NOT run any more test or build commands.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  if (matchedRules.includes("verification_no_signal_repeat")) {
    return {
      pause: false,
      reason: "verification_no_signal_repeat",
      suggestedNextStep:
        "Repeated verification produced no new output and no edits were made. Treat the last successful exit as sufficient; continue with the next requested non-verification action and report completion (or make one concrete edit before any further verification).",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  const verificationLoopRules = new Set([
    "broad_to_narrow_verification",
    "edit_before_retest",
    "no_repeat_without_change",
  ]);
  const hasOnlyVerificationLoopRules = matchedRules.every((r) => verificationLoopRules.has(r));
  if (!lastEventIsVerification && hasOnlyVerificationLoopRules) {
    return {
      pause: false,
      reason: "verification_loop_advisory_after_pivot",
      suggestedNextStep:
        "Verification reruns were detected earlier, but you have already pivoted to a non-verification action. Continue that action (for example updating plan status or applying the next edit) instead of running more tests now.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  // Avoid trapping the model in repeated broad verification when output is already green.
  if (broadVerificationCommands >= thresholds.broadVerificationNoticeThreshold) {
    broadTestRepeat = true;
    if (!matchedRules.includes("broad_to_narrow_verification")) pushRule("broad_to_narrow_verification");
  }

  if (broadTestRepeat && repeatedTestCommands >= 1 && !hasFailures) {
    pushRule("verification_already_green");
    const shouldPause = broadVerificationCommands >= thresholds.broadVerificationBlockThreshold;
    if (shouldPause) pushRule("verification_green_repeat_block");
    return {
      pause: shouldPause,
      reason: shouldPause
        ? "verification_green_repeat_block"
        : "verification_already_green",
      suggestedNextStep: shouldPause
        ? "Verification is already green. Stop broad go test/go build checks now. Make exactly one concrete code edit for the next requested feature, then run one narrow verification command."
        : "Verification is already passing. Stop re-running broad go vet/go test checks and continue implementing the next requested feature.",
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
      },
    };
  }

  const latestTest = [...events]
    .reverse()
    .find((e) => /\b(go test|npm test|pnpm test|yarn test)\b/i.test(e.command));
  const scoped = latestTest
    ? suggestScopedVerificationCommand(latestTest.command, changedFiles)
    : { suggestedCommand: null };
  let suggestedNextStep = scoped.suggestedCommand
    ?? (noEditEvidence
      ? "Apply one focused code change for a single root-cause hypothesis, then run one narrow verification command."
      : "State one root-cause hypothesis and run one narrow verification command.");
  if (totalBroadDiscoveryCalls >= 4 || repeatedBroadDiscoveryCalls >= 2) {
    suggestedNextStep = "Run one targeted repo summary (for example synesis_inspect_repo), then read only 1-3 likely files; do not repeat Glob(\"*\") again.";
  } else if (matchedRules.includes("test_entry_contract")) {
    suggestedNextStep =
      testRuntime === "python"
        ? "Before running tests, inspect existing test conventions: search_code for pytest.ini/pyproject.toml and read the nearest existing test file."
        : "Before running tests, inspect existing test conventions: search_code for jest.config/vitest/package.json and read the nearest existing test file.";
  } else if (matchedRules.includes("cleanup_todo_harvest")) {
    suggestedNextStep = "Before edits, run one targeted search_code for TODO|FIXME|DEBUG and rank top cleanup candidates, then patch highest-impact files only.";
  } else if (matchedRules.includes("bounded_exploration_budget")) {
    suggestedNextStep = "State one root-cause hypothesis, then read at most 3 files directly tied to it before applying a patch.";
  }

  const onlyCleanupHarvest =
    matchedRules.length === 1 && matchedRules[0] === "cleanup_todo_harvest";
  if (onlyCleanupHarvest) {
    return {
      pause: false,
      reason: "cleanup_todo_harvest advisory only",
      suggestedNextStep,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
        trailingExplorationRunLength,
        hasPlanInContext,
        hasPlanEdit,
      },
    };
  }

  const discoveryNudgeOnly = matchedRules.length > 0 && matchedRules.every((r) => r === "discovery_churn_nudge");
  if (discoveryNudgeOnly) {
    return {
      pause: false,
      reason: "discovery_churn_nudge",
      suggestedNextStep:
        `Discovery churn detected (${trailingExplorationRunLength} exploration calls, ${trailingDiscoveryDuplicateTargets} duplicate targets, no edits). Stop broad scanning and pick one likely file to edit now. If uncertain, provide a brief summary of findings and ask the user for the next focus area.`,
      matchedRules,
      telemetry: {
        phase: sessionPhase,
        repeatedTestCommands,
        repeatedReadSearchCalls,
        repeatedBroadDiscoveryCalls,
        totalBroadDiscoveryCalls,
        broadTestRepeat,
        noEditEvidence,
        trailingVerificationRunLength,
        trailingExplorationRunLength,
        hasPlanInContext,
        hasPlanEdit,
      },
    };
  }

  return {
    pause: true,
    reason: "Execution governor detected low-yield repetition. Pivot to a narrower, hypothesis-driven step.",
    suggestedNextStep,
    matchedRules,
    telemetry: {
      phase: sessionPhase,
      repeatedTestCommands,
      repeatedReadSearchCalls,
      repeatedBroadDiscoveryCalls,
      totalBroadDiscoveryCalls,
      broadTestRepeat,
      noEditEvidence,
      trailingVerificationRunLength,
      trailingExplorationRunLength,
      hasPlanInContext,
      hasPlanEdit,
    },
  };
}

export function executionGovernorRecoveryRewriteBlock(decision: ExecutionGovernorDecision): string {
  const reason = decision.reason;
  let step1: string;
  let step2: string;
  let step3: string;

  switch (reason) {
    case "plan_reread_loop":
      step1 = "STOP re-reading the plan file. You have already loaded it and each re-read returned unchanged/cached. You have the plan content.";
      step2 = "Do NOT summarize the plan again. Do NOT search/grep to verify completed items. Pick the NEXT incomplete task from what you already read.";
      step3 = "Take one concrete action: Edit the plan to mark a task done, OR make a code edit (Write/Edit) for the next task, OR ask the user.";
      break;
    case "source_file_stale_reread":
      step1 = "STOP. 'Unchanged since last read' means the file content is ALREADY in your conversation history from an earlier read. The file has NOT changed on disk. You have the FULL content — scroll up in your context to find it.";
      step2 = "Do NOT attempt to read this file again. The read tool will return 'Unchanged' every time because you already have the content. Re-reading will never give you new information.";
      step3 = "Write your code edit NOW using the file content already in your context. Use Write or StrReplace to add/modify the code. If you cannot find the content in your context, ask the user to paste the relevant section.";
      break;
    case "verification_after_completion_claim":
      step1 = "You ALREADY said the work is done. STOP running builds, tests, git status, and diffs. There is nothing to verify.";
      step2 = "Take ONE completion action: update the plan to mark the task done, OR run `git add` + `git commit`, OR tell the user the task is complete.";
      step3 = "Do NOT run another verification command. The build passes. The code is correct. Act on that knowledge.";
      break;
    case "no_progress_loop":
      if (decision.telemetry.hasPlanEdit) {
        step1 = "You just created or updated a plan file. The plan is DONE — do NOT re-verify its contents by scanning the codebase again.";
        step2 = "Present the plan to the user as TEXT (no tool calls): list what is implemented, what is missing, and proposed next steps. Use an interactive choice tool (AskFollowupQuestion) if available.";
        step3 = "END your turn after presenting. Do NOT re-read files, re-search, or re-list directories. Wait for the user to choose what to work on.";
      } else {
        step1 = "STOP cycling. You have run many commands without code edits. You already have ALL the information you need from prior tool results — do NOT call any more read/search/list tools.";
        step2 = "Present your findings to the user as a TEXT response (no tool calls). List what is done, what is missing, and propose next steps. Then END your turn — do NOT continue with more tool calls after the summary.";
        step3 = "If you already produced a summary, STOP. Do NOT re-verify or re-read. Ask the user what to work on next, or pick ONE missing item and make exactly ONE code edit.";
      }
      break;
    case "verbal_intent_without_action":
      step1 = "STOP declaring intent. You have said 'I'll...' or 'Let me...' multiple times without acting. Do NOT output another plan or narration.";
      step2 = "Take ONE concrete action now: (A) run ONE test/build Bash command, (B) make one code Edit/Write, or (C) call TaskUpdate/TodoWrite if all tasks are done.";
      step3 = "After that single action, use the result: fix if failing, or report completion if passing/done.";
      break;
    case "identical_tool_repeat":
      step1 = "STOP calling the same tool with the same arguments. You are in a degenerate loop — the result will not change no matter how many times you retry.";
      step2 = "Either (A) try a completely different tool or approach, (B) report to the user that this action cannot be completed in the current environment (e.g. sandboxed, no browser, no network), or (C) move on to the next task.";
      step3 = "Do NOT retry the same command. The environment has not changed between calls.";
      break;
    case "repeated_assistant_intro":
      step1 = "STOP repeating the same introductory paragraph. Your last several replies started with the same text — that is not progress.";
      step2 = "Do not restate the plan. Run `git diff` on the files you care about; if the fix is already applied, stop editing. If not, read the CURRENT file content once and issue ONE edit with an old_string that matches the file on disk today.";
      step3 = "If an edit tool says 'string not found', your snippet is stale: the file changed or you already applied the edit. Re-read, then replace a smaller unique span.";
      break;
    case "verification_intent_without_action":
      step1 = "STOP saying you will run tests. You repeated test intent without executing any real test command.";
      step2 = "Your NEXT response must be one tool call only: either run ONE targeted test command OR make ONE code edit (no narration first).";
      step3 = "Use that result immediately: if failing, make one concrete fix; if passing, report completion.";
      break;
    case "finalize_action_required":
      step1 = "You are in FINALIZE phase — tests are GREEN. DO NOT run any more test, build, or read commands.";
      step2 = "Your ONLY valid next action: write a direct user-facing summary of what was verified, OR mark tasks done (TaskUpdate/TodoWrite), OR run git commit/push if that was requested.";
      step3 = "Running passing tests again is not a completion action. Report done or move to the next task.";
      break;
    case "repeat_user_prompt_loop":
      step1 = "STOP asking the same focus question. The user already answered.";
      step2 = "Do NOT call AskUserQuestion again for this decision. Execute the selected path with one concrete code or test action now.";
      step3 = "After the action, run one narrow verification and report progress.";
      break;
    case "verification_stall_no_edit":
      step1 = "STOP running build, test, and read commands. Verification is already passing and files are unchanged — there is nothing to re-check.";
      step2 = "If the current task is verified and complete, update the plan file or call TaskUpdate/TodoWrite NOW to mark it done.";
      step3 = "If more work remains, make one concrete code edit (Write/Edit) for the next task item, then run one narrow verification.";
      break;
    case "verification_churn_no_edit":
      step1 = "STOP cycling build/test/read commands. Verification is failing repeatedly and no edits were made.";
      step2 = "Open the failing location once, make exactly ONE targeted code edit, then rerun a narrow verification command.";
      step3 = "Do not run another broad build/test command until that edit is applied.";
      break;
    case "exploration_stall_no_edit":
      if (decision.telemetry.hasPlanEdit) {
        step1 = "You just created or updated a plan. STOP exploring — the scan is complete.";
        step2 = "Present the plan summary to the user as TEXT (no tool calls). Use an interactive choice tool (AskFollowupQuestion) if available to let them pick the next task.";
        step3 = "END your turn. Do NOT re-read, re-search, or re-list anything.";
      } else {
        step1 = "STOP searching, reading, and listing files. You have been exploring without making any edits. Do NOT call any more read/search/list tools.";
        step2 = "If you already have a picture of what exists and what is missing, present it to the user as TEXT (no tool calls) and END your turn. If a plan file was loaded, trust its status markers.";
        step3 = "If you know what to build, pick ONE missing item and make exactly ONE code edit. Do NOT re-verify what you already checked.";
      }
      break;
    case "no_test_files_repeat":
      step1 = "STOP running the test command. '[no test files]' or similar means there are NO tests in that package/directory yet — re-running produces the same result.";
      step2 = "CREATE a test file first. Examples: `*_test.go` (Go), `*.test.ts` / `*.spec.ts` (TypeScript/Jest/Vitest), `test_*.py` / `*_test.py` (pytest), `*_spec.rb` (RSpec). Write at least one meaningful test function.";
      step3 = "After writing the test file, run the test command ONCE with a targeted filter (e.g. `-run TestFoo`, `--testNamePattern`, `-k test_foo`) to verify the new test is found and passes.";
      break;
    case "verification_fail_repeat_block":
    case "verification_same_failure_signature_replay":
    case "verification_truncated_output":
      step1 = "Read the failing file at the error location (use offset/limit). Do NOT re-read README or unrelated files.";
      step2 = "Make one concrete code fix at the reported symbol/location.";
      step3 = "Run one narrow file-level or package-level verification command (not a broad build).";
      break;
    case "consecutive_edit_failures":
      step1 = "STOP editing. Every recent edit attempt failed. The files almost certainly already contain your changes (git diff confirms modifications).";
      step2 = "Run `git diff <file>` for each file you tried to edit. If changes are present, the work is DONE. Update plan/task status.";
      step3 = "If you genuinely need to edit, use `cat <file>` (NOT Read) to get current content, then construct ONE edit with exact old_string from that output.";
      break;
    case "edit_failure_replay":
      step1 = "Run `git diff <file>` to check if the changes already exist. If they do, the work is done — do NOT retry the edit.";
      step2 = "If the changes do NOT exist, re-read the exact target section with `cat <file>` or Read (offset/limit) to get current content, and adjust old_string to match exactly.";
      step3 = "Apply one corrected Edit call. If it fails again, the file likely already has your changes. Mark the task done and move on.";
      break;
    case "task_creation_replay":
    case "completion_claim_requires_task_update":
      step1 = "Update existing task items to reflect current status. Do not create duplicate tasks.";
      step2 = "If claiming completion, ensure all task items are marked done first.";
      step3 = "Do not call file discovery tools — focus on task state and completion evidence.";
      break;
    case "dependency_install_replay":
      step1 = "Investigate the specific install error in the output. Do not re-run the same install command.";
      step2 = "If the install succeeded, move on to the next code edit.";
      step3 = "If it failed, fix the root cause (wrong package name, missing lockfile, version conflict) before retrying.";
      break;
    case "declaration_followthrough_required":
      step1 = "Apply one usage-site edit that references the declaration you just added (import, call, wire).";
      step2 = "Do not search for more context — you already have the information needed.";
      step3 = "After the usage edit, run one narrow verification to confirm integration.";
      break;
    case "git_commit_followthrough":
      step1 = "Run git commit with a clear message for the staged changes.";
      step2 = "If changes are not ready to commit, continue editing — do not loop on git status/diff.";
      step3 = "After committing, move on to the next task step.";
      break;
    default: {
      const rules = new Set(decision.matchedRules);
      const testFlow = rules.has("test_entry_contract");
      const explorationLoop = rules.has("bounded_exploration_budget") || rules.has("broad_discovery_repeat");
      step1 = testFlow
        ? "Use Grep first for test files/configs (_test, test_, jest.config, vitest, pytest.ini), then Read at most 3 highest-signal files."
        : "Read README.md or package.json, then use a scoped Glob (e.g. src/*) or Grep. Read at most 3 likely files and stop broad scanning.";
      step2 = explorationLoop
        ? "Do not call Glob(\"*\") or empty glob patterns. If glob is required, use scoped patterns such as src/* or pkg/**/*_test.go."
        : "Avoid broad discovery loops; each tool call must refine scope.";
      step3 = "Before any large read, state one concrete hypothesis and one verification command.";
      break;
    }
  }

  return [
    "<SYNESIS_EXECUTION_RECOVERY status=\"rewrite\" version=\"2\">",
    `matched_rules=${decision.matchedRules.join(",")}`,
    `reason=${reason}`,
    `step1=${step1}`,
    `step2=${step2}`,
    `step3=${step3}`,
    `next_action=${decision.suggestedNextStep ?? "run one narrow verification step"}`,
    "</SYNESIS_EXECUTION_RECOVERY>",
  ].join("\n");
}

/**
 * Plain-language + concrete nudge for hard stops. Keys are `matchedRules` ids; unknown rules
 * fall back so we never return an opaque "figure it out" to humans or the model.
 */
const HARD_STOP_PLAIN: Record<string, { what: string; nudge: string }> = {
  verification_intent_without_action: {
    what: "The assistant said it would run tests or check results several times, but there was no matching test or build command in the recent tool history.",
    nudge: "Run exactly one narrow command (for example one `go test` for the package you changed), or make a single code edit first—then continue from the real output.",
  },
  verbal_intent_without_action: {
    what: "The assistant kept opening with 'I'll' / 'let me' style phrases without the next real tool call actually happening, so the run was not making forward progress.",
    nudge: "Next turn: do exactly one of—one Bash test/build, one file edit, or one task/plan update—then stop and read the result before anything else.",
  },
  no_progress_loop: {
    what: "The assistant ran a long series of tool calls without a successful code change where one was needed, or without closing the loop with a clear summary or edit.",
    nudge: "Either make one small, targeted code change, or end with a short written summary of what is done and what is still missing—avoid more discovery in the same turn.",
  },
  identical_tool_repeat: {
    what: "The assistant called the exact same tool with identical arguments multiple times in a row—the result is not changing between calls.",
    nudge: "Do not retry this tool call. Try a different approach, report the limitation to the user, or move on to the next task.",
  },
  repeated_assistant_intro: {
    what: "The assistant repeated the same opening or plan text across multiple messages instead of new actions or a real test/build result.",
    nudge: "Read the file you need once, make one exact anchored edit, or run one `git diff` / one targeted test—skip re-stating the plan.",
  },
  task_creation_replay: {
    what: "The assistant recreated or rewrote the same task list instead of continuing from the existing task state.",
    nudge: "Reuse the current TodoWrite or task list, preserve completed items, update only the active item, then take one concrete next action.",
  },
  broad_to_narrow_verification: {
    what: "The same kind of very broad test or build command was re-run; scoped checks usually finish faster and make failures easier to fix.",
    nudge: "Re-run a single package or file-scoped test for the code you just touched, not the whole tree again.",
  },
  edit_before_retest: {
    what: "Tests or builds were re-run with an ongoing failure, but the assistant did not land a new code change between those runs.",
    nudge: "Change one file to address the failure, then one narrow re-test; avoid repeating the same command without a diff in between.",
  },
  no_repeat_without_change: {
    what: "The same or equally broad test command was repeated without a new code change, which only burns time when something is still red.",
    nudge: "Edit one file toward the error message, or narrow the test to the smallest failing package, then re-run once.",
  },
  verification_churn_no_edit: {
    what: "Many verification or build steps in a row did not add new signal and no edit was written to break the loop.",
    nudge: "Pick one failure line, one file, one small fix, then a single re-check—or stop and report what is blocked in two sentences.",
  },
  verification_stall_no_edit: {
    what: "Verification and exploration were repeated without a successful edit or a clear written conclusion.",
    nudge: "One concrete fix or a clear written summary: what passed, what failed, and the single next step.",
  },
  source_file_stale_reread: {
    what: "The same file was read over and over after an edit or anchor failure, without applying a new change using the content already in context.",
    nudge: "Use the file text already in the transcript, or read once, then one Write/StrReplace with an anchor that exists on disk right now.",
  },
  edit_failure_replay: {
    what: "Edits or patches failed and were re-tried in a way that did not move the anchor or approach toward success.",
    nudge: "Re-read the target file once, copy an exact `old_string` from current content, or apply a smaller patch; then re-run one small check if needed.",
  },
  plan_reread_loop: {
    what: "The project plan or task file was re-read or re-summarized many times without executing the next task or updating status.",
    nudge: "Update the plan's next line or make one direct code change for the next open item—no more plan re-hashing.",
  },
  broad_discovery_repeat: {
    what: "Very broad file search or list patterns were used repeatedly (for example `Glob` of the whole tree) without converging on a file to change.",
    nudge: "Name 1–3 likely file paths, read one of them, then one edit, or one targeted search in the smallest directory that matters.",
  },
  verification_after_completion_claim: {
    what: "The model already said the work was done but kept running more builds or tests or scans.",
    nudge: "Mark tasks complete, commit if requested, and write a one-paragraph handoff—do not re-verify the same green build.",
  },
  finalize_action_required: {
    what: "Tests or builds are already in a good state, but the turn did not finish with a clear user-facing wrap-up or task closure.",
    nudge: "Write a short 'done' summary, update tasks to completed, or run the exact git add/commit the user asked for—one completion action only.",
  },
};

const HARD_STOP_PLAIN_DEFAULT: { what: string; nudge: string } = {
  what: "The session tripped a loop guard: similar actions repeated without real progress (tests without edits, repeated narration, or the same command again).",
  nudge: "Take one of: a single focused test, a single file edit, or a short clear summary of status—then re-evaluate before doing more.",
};

function hardStopPlainCopy(matchedRules: string[]): { what: string; nudge: string; primary: string } {
  const primary = (matchedRules[0] ?? "unknown").trim() || "unknown";
  const row = HARD_STOP_PLAIN[primary] ?? HARD_STOP_PLAIN_DEFAULT;
  return { what: row.what, nudge: row.nudge, primary };
}

export function buildExecutionGovernorHardStopUserMessage(params: {
  consecutiveRecoveryFires: number;
  matchedRules: string[];
}): string {
  const { consecutiveRecoveryFires, matchedRules } = params;
  const { what, nudge, primary: primaryRule } = hardStopPlainCopy(matchedRules);
  const needsDirectionChoice = matchedRules.some((r) =>
    r === "verification_intent_without_action"
    || r === "verbal_intent_without_action"
    || r === "no_progress_loop",
  );

  const lead = [what, "", `Suggested next move: ${nudge}`, ""];

  const header = [
    ...lead,
    "GOVERNOR PAUSE: Agent progress is blocked by repeated loops.",
    `Recovery fired ${consecutiveRecoveryFires} consecutive times and was ignored.`,
    "The agent will not continue automatically from this response.",
    "",
    `Reason: ${primaryRule}`,
    `Matched rules: ${matchedRules.join(", ") || "none"}`,
    "",
  ];

  const options = needsDirectionChoice
    ? [
        "Choose the next action by replying with one option:",
        "1) Run one targeted test command now",
        "2) Make one focused code edit now",
        "3) Stop and summarize what is still missing",
      ]
    : [
        "Choose the next action by replying with one option:",
        "1) Continue with one focused fix",
        "2) Continue with one targeted verification command",
        "3) Stop and summarize current status",
      ];

  const guidance = [
    "",
    "Tip: provide the exact command or file to edit in your reply for fastest recovery.",
  ];

  return [...header, ...options, ...guidance].join("\n");
}

export interface GovernorPauseAction {
  id: string;
  label: string;
  description: string;
  requires_user_input: boolean;
  can_auto_execute: boolean;
  expected_arguments?: string[];
}

export interface GovernorPauseChatStateSummary {
  active_objective: string | null;
  pending_user_directive: string | null;
  completion_status: ChatState["completionStatus"];
  last_verification_outcome: ChatState["lastVerificationOutcome"];
  narration_residue_present: boolean;
}

export interface GovernorPauseFileStateSummary {
  files_total: number;
  status_counts: Record<string, number>;
  stale_files: string[];
  partial_files: string[];
  evicted_files: string[];
}

export interface GovernorPauseEnvelope {
  status: "paused";
  pause_reason: string;
  /** Rule id; see `user_facing_explanation` for plain language. */
  matched_rules: string[];
  required_user_action: true;
  recovery_attempts_used: number;
  hard_stop_threshold: number;
  next_automatic_step_allowed: false;
  next_actions: GovernorPauseAction[];
  default_recommended_action: string;
  /** Why the guard tripped, in full sentences (for UI + model nudge, not only opaque ids). */
  user_facing_explanation: string;
  /** One concrete “do this next” (maps to the primary matched rule). */
  concrete_nudge: string;
  evidence_delta?: "improved" | "changed" | "stalled" | "regressed" | "unknown";
  active_guards?: TransitionGuard[];
  artifact_context?: {
    stale_files: string[];
    partial_files: string[];
  };
  chat_state_summary?: GovernorPauseChatStateSummary;
  file_state_summary?: GovernorPauseFileStateSummary;
  resume_hint: string;
}

export function buildExecutionGovernorPauseEnvelope(params: {
  matchedRules: string[];
  consecutiveRecoveryFires: number;
  hardStopThreshold: number;
  evidenceDelta?: "improved" | "changed" | "stalled" | "regressed" | "unknown";
  activeGuards?: TransitionGuard[];
  artifactContext?: { staleFiles: string[]; partialFiles: string[] };
  chatStateSummary?: GovernorPauseChatStateSummary;
  fileStateSummary?: GovernorPauseFileStateSummary;
}): GovernorPauseEnvelope {
  const {
    matchedRules,
    consecutiveRecoveryFires,
    hardStopThreshold,
    evidenceDelta,
    activeGuards,
    artifactContext,
    chatStateSummary,
    fileStateSummary,
  } = params;
  const pauseReason = matchedRules[0] ?? "unknown";
  const plain = hardStopPlainCopy(matchedRules);
  const isIntentLoop = matchedRules.some((r) =>
    r === "verification_intent_without_action"
    || r === "verbal_intent_without_action"
    || r === "no_progress_loop",
  );

  const nextActions: GovernorPauseAction[] = isIntentLoop
    ? [
        {
          id: "run_targeted_test",
          label: "Run one targeted test",
          description: "Run one narrow test/build command only, then use the result.",
          requires_user_input: true,
          can_auto_execute: true,
          expected_arguments: ["command"],
        },
        {
          id: "apply_one_edit",
          label: "Apply one focused edit",
          description: "Make one concrete code edit before any additional verification.",
          requires_user_input: true,
          can_auto_execute: true,
          expected_arguments: ["file_path", "change_summary"],
        },
        {
          id: "summarize_and_stop",
          label: "Summarize and stop",
          description: "Stop execution and summarize what is missing or completed.",
          requires_user_input: false,
          can_auto_execute: true,
        },
      ]
    : [
        {
          id: "continue_with_fix",
          label: "Continue with one focused fix",
          description: "Make one targeted fix and then verify once.",
          requires_user_input: true,
          can_auto_execute: true,
          expected_arguments: ["file_path", "change_summary"],
        },
        {
          id: "continue_with_verification",
          label: "Run one targeted verification command",
          description: "Run one narrow verification command only.",
          requires_user_input: true,
          can_auto_execute: true,
          expected_arguments: ["command"],
        },
        {
          id: "summarize_and_stop",
          label: "Summarize and stop",
          description: "Stop execution and summarize current status.",
          requires_user_input: false,
          can_auto_execute: true,
        },
      ];

  const defaultAction = isIntentLoop ? "apply_one_edit" : "continue_with_fix";

  return {
    status: "paused",
    pause_reason: pauseReason,
    matched_rules: matchedRules,
    required_user_action: true,
    recovery_attempts_used: consecutiveRecoveryFires,
    hard_stop_threshold: hardStopThreshold,
    next_automatic_step_allowed: false,
    next_actions: nextActions,
    default_recommended_action: defaultAction,
    user_facing_explanation: plain.what,
    concrete_nudge: plain.nudge,
    evidence_delta: evidenceDelta,
    active_guards: activeGuards && activeGuards.length > 0 ? activeGuards : undefined,
    artifact_context: artifactContext
      ? {
          stale_files: artifactContext.staleFiles,
          partial_files: artifactContext.partialFiles,
        }
      : undefined,
    chat_state_summary: chatStateSummary,
    file_state_summary: fileStateSummary,
    resume_hint: [
      plain.nudge,
      "",
      "Or reply with an action id and arguments, e.g. run_targeted_test command=\"go test ./cmd/synesis -run TestRunCompletion -v\"",
    ].join("\n"),
  };
}
