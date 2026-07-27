import type { ChatState } from "./chat-state.js";
import type {
  ExecutionGovernorDecision,
  TransitionGuard,
} from "./execution-governor.js";

function recoveryBlockText(value: unknown, maxChars = 1000): string {
  return replaceRecoveryControlChars(String(value ?? ""))
    .replace(/[<>"'`&]/g, "_")
    .replace(/=/g, ":")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
    .trim();
}

function replaceRecoveryControlChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? " " : value[i];
  }
  return out;
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
      step1 = "Use the failure output directly. If it includes a compiler-suggested fix command such as `cargo fix --lib -p <package>`, run that exact targeted fix once; otherwise read the failing file at the error location.";
      step2 = "Make one concrete code fix at the reported symbol/location. Do NOT re-run the same broad build/test first.";
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
    `matched_rules: ${decision.matchedRules.map((rule) => recoveryBlockText(rule, 120)).filter(Boolean).join(",") || "none"}`,
    `reason: ${recoveryBlockText(reason, 160) || "unknown"}`,
    `step1: ${recoveryBlockText(step1, 1000)}`,
    `step2: ${recoveryBlockText(step2, 1000)}`,
    `step3: ${recoveryBlockText(step3, 1000)}`,
    `next_action: ${recoveryBlockText(decision.suggestedNextStep ?? "run one narrow verification step", 1000)}`,
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
    nudge: "Run exactly one narrow test/build command for the changed component, or make a single code edit first—then continue from the real output.",
  },
  verbal_intent_without_action: {
    what: "The assistant kept opening with 'I'll' / 'let me' style phrases without an edit, task update, verification command, or other progress signal in recent history.",
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
    nudge: "Do not answer by repeating 'continue'. Pick one failing traceback/assertion line, edit the implicated file once, then run one narrow verification command.",
  },
  verification_same_failure_signature_replay: {
    what: "The same build or compile failure repeated without a code change, so another test/build run will produce the same output.",
    nudge: "Use the compiler output directly: run one suggested fix command such as `cargo fix` when present, or edit the reported file/symbol once before any retest.",
  },
  verification_fail_repeat_block: {
    what: "The same failing verification repeated without an intervening fix.",
    nudge: "Stop running tests/builds. Apply one focused edit or one compiler-suggested fix command, then run one narrow verification.",
  },
  verification_truncated_output: {
    what: "Verification output was truncated or repeated without enough new signal to justify another full run.",
    nudge: "Capture once to a stable file or inspect the known failing location, then make one fix before re-running verification.",
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
  const preferred = matchedRules.find((rule) =>
    rule === "verification_same_failure_signature_replay"
    || rule === "verification_fail_repeat_block"
    || rule === "verification_churn_no_edit"
    || rule === "verification_truncated_output"
  );
  const primary = (preferred ?? matchedRules[0] ?? "unknown").trim() || "unknown";
  const row = HARD_STOP_PLAIN[primary] ?? HARD_STOP_PLAIN_DEFAULT;
  return { what: row.what, nudge: row.nudge, primary };
}

export function buildExecutionGovernorHardStopUserMessage(params: {
  consecutiveRecoveryFires: number;
  matchedRules: string[];
  questionToolName?: string | null;
  taskContext?: GovernorPauseTaskContext;
}): string {
  const { consecutiveRecoveryFires, matchedRules, questionToolName, taskContext } = params;
  const { what, nudge, primary: primaryRule } = hardStopPlainCopy(matchedRules);
  const needsDirectionChoice = matchedRules.some((r) =>
    r === "verification_intent_without_action"
    || r === "verbal_intent_without_action"
    || r === "no_progress_loop",
  );
  const verificationChurn = matchedRules.some((r) =>
    r === "verification_churn_no_edit"
    || r === "verification_same_failure_signature_replay"
    || r === "verification_fail_repeat_block"
    || r === "verification_truncated_output",
  );
  const taskNudge = taskContext?.recommended_next_step
    ? taskContext.recommended_next_step
    : taskContext?.current_task
      ? `Continue the current task: ${taskContext.current_task}.`
      : null;

  const lead = [
    what,
    "",
    ...(taskContext?.current_task
      ? [`Current task: ${taskContext.current_task}`, ""]
      : []),
    `Suggested next move: ${taskNudge ?? nudge}`,
    "",
  ];

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

  const options = verificationChurn
    ? [
        "Choose the next action by replying with one option:",
        "1) Inspect one failing traceback/assertion and edit the implicated file",
        "2) Run one narrow verification command after that edit",
        "3) Stop and summarize the current blocker",
      ]
    : taskContext?.current_task
    ? [
        "Choose the next action by replying with one option:",
        "1) Continue the current task now",
        "2) Run one targeted verification for the current task",
        "3) Stop and summarize current status",
      ]
    : needsDirectionChoice
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
    ...(questionToolName
      ? [`Interactive clients may present these options through the ${questionToolName} question tool.`]
      : []),
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

export interface GovernorPauseTaskContext {
  current_task: string | null;
  current_task_status: string | null;
  open_task_count: number;
  recommended_next_step?: string | null;
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
  task_context?: GovernorPauseTaskContext;
  interactive_question?: {
    tool_name: string;
    prompt: string;
    options: Array<{
      id: string;
      label: string;
      description: string;
    }>;
  };
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
  taskContext?: GovernorPauseTaskContext;
  questionToolName?: string | null;
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
    taskContext,
    questionToolName,
  } = params;
  const pauseReason = matchedRules[0] ?? "unknown";
  const plain = hardStopPlainCopy(matchedRules);
  const isIntentLoop = matchedRules.some((r) =>
    r === "verification_intent_without_action"
    || r === "verbal_intent_without_action"
    || r === "no_progress_loop",
  );
  const isVerificationChurn = matchedRules.some((r) =>
    r === "verification_churn_no_edit"
    || r === "verification_same_failure_signature_replay"
    || r === "verification_fail_repeat_block"
    || r === "verification_truncated_output",
  );

  const hasCurrentTask = typeof taskContext?.current_task === "string" && taskContext.current_task.trim().length > 0;
  const currentTask = hasCurrentTask ? taskContext!.current_task!.trim() : "";
  const nextActions: GovernorPauseAction[] = hasCurrentTask
    ? [
        {
          id: "continue_current_task",
          label: isVerificationChurn ? "Fix current failure" : "Continue current task",
          description: isVerificationChurn
            ? `Inspect one failing line for current task and edit the implicated file: ${currentTask}`
            : `Continue: ${currentTask}`,
          requires_user_input: false,
          can_auto_execute: true,
          expected_arguments: ["file_path", "change_summary"],
        },
        {
          id: "verify_current_task",
          label: isVerificationChurn ? "Verify after fix" : "Verify current task",
          description: isVerificationChurn
            ? "Run one narrow verification command only after the targeted fix is applied."
            : "Run one narrow verification command for the current task, then use the result.",
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
      ]
    : isIntentLoop
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
          label: isVerificationChurn ? "Inspect failure and edit" : "Continue with one focused fix",
          description: isVerificationChurn
            ? "Pick one failing traceback/assertion line and make one targeted edit."
            : "Make one targeted fix and then verify once.",
          requires_user_input: true,
          can_auto_execute: true,
          expected_arguments: ["file_path", "change_summary"],
        },
        {
          id: "continue_with_verification",
          label: isVerificationChurn ? "Verify after edit" : "Run one targeted verification command",
          description: isVerificationChurn
            ? "Run one narrow verification command only after the edit."
            : "Run one narrow verification command only.",
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

  const defaultAction = hasCurrentTask ? "continue_current_task" : isIntentLoop ? "apply_one_edit" : "continue_with_fix";
  const concreteNudge = taskContext?.recommended_next_step?.trim()
    || (hasCurrentTask ? `Continue the current task: ${currentTask}.` : plain.nudge);
  const interactiveQuestionTool = typeof questionToolName === "string" && questionToolName.trim()
    ? questionToolName.trim()
    : null;

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
    task_context: taskContext,
    interactive_question: interactiveQuestionTool
      ? {
          tool_name: interactiveQuestionTool,
          prompt: hasCurrentTask
            ? `Governor paused repeated progress. Current task: ${currentTask}. Choose the next concrete action.`
            : "Governor paused repeated progress. Choose the safest recovery action.",
          options: nextActions.map((action) => ({
            id: action.id,
            label: action.label,
            description: action.description,
          })),
        }
      : undefined,
    concrete_nudge: concreteNudge,
    resume_hint: [
      concreteNudge,
      "",
      hasCurrentTask
        ? "Or reply with an action id and arguments, e.g. verify_current_task command=\"<targeted verification command>\""
        : "Or reply with an action id and arguments, e.g. run_targeted_test command=\"<targeted test command>\"",
    ].join("\n"),
  };
}
