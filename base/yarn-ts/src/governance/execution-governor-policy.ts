import type { SessionPhase } from "./execution-governor.js";

/**
 * Rules partitioned by which phases they are allowed to fire in.
 * A rule not listed for a phase is silently suppressed.
 */
const PHASE_ALLOWED_RULES: Record<SessionPhase, Set<string>> = {
  explore: new Set([
    "broad_discovery_repeat",
    "bounded_exploration_budget",
    "plan_reread_loop",
    "source_file_stale_reread",
    "discovery_churn_nudge",
    "exploration_stall_no_edit",
    "no_progress_loop",
    "identical_tool_repeat",
    "repeated_assistant_intro",
    "verbal_intent_without_action",
    "verification_churn_no_edit",
    "verification_fail_repeat_block",
    "no_test_files_repeat",
    "dependency_install_replay",
    "test_entry_contract",
    "cleanup_todo_harvest",
  ]),
  edit: new Set([
    "edit_failure_replay",
    "consecutive_edit_failures",
    "edit_before_retest",
    "no_repeat_without_change",
    "declaration_followthrough_required",
    "exploration_stall_no_edit",
    "broad_discovery_repeat",
    "bounded_exploration_budget",
    "plan_reread_loop",
    "source_file_stale_reread",
    "discovery_churn_nudge",
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
    "false_green_suspected",
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
    "false_green_suspected",
  ]),
};

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

export function isRuleAllowedInPhase(rule: string, phase: SessionPhase): boolean {
  return PHASE_ALLOWED_RULES[phase].has(rule);
}

export function prioritizeMatchedRules(rules: string[]): string[] {
  const unique = [...new Set(rules)];
  unique.sort((a, b) => {
    const pa = RULE_PRIORITY_MAP.get(a) ?? 0;
    const pb = RULE_PRIORITY_MAP.get(b) ?? 0;
    if (pa !== pb) return pb - pa;
    return a.localeCompare(b);
  });
  return unique;
}

export function focusRulesForEditReplay(rules: string[]): string[] {
  const hasEditReplayTerminal =
    rules.includes("edit_failure_replay") || rules.includes("consecutive_edit_failures");
  if (!hasEditReplayTerminal) return rules;
  const focused = rules.filter((rule) => !EDIT_REPLAY_NOISE_RULES.has(rule));
  return focused.length > 0 ? focused : rules;
}
