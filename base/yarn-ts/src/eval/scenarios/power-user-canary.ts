/**
 * Power-user canary scenarios
 *
 * These scenarios model long-session, multi-file, convention-heavy flows
 * that often expose harness regressions before simpler tests do.
 */

import type { EvalScenario } from "../types.js";

export const canaryLongSessionMultifile: EvalScenario = {
  id: "canary-long-session-multifile",
  name: "Canary long-session multi-file follow-through",
  category: "power_user_canary",
  description:
    "Exercises a multi-turn coding session requiring discovery, edits, and verification across multiple files.",
  target: {},
  systemPrompt:
    "You are a coding assistant. Work in a research-first manner, keep edits focused, and verify before finalizing.",
  turns: [
    {
      messages: [
        { role: "user", content: "Continue the bundle task: inspect current code, update implementation in ask.go and bundle.go, then report progress." },
      ],
      simulatedToolResults: {
        Read: "cmd/synesis/ask.go: runAsk currently ignores --verbose.\npkg/bundle/bundle.go: LoadBundle parses manifest but not optional metadata.",
        Search: "Found call sites in cmd/synesis/main.go and pkg/bundle/bundle.go",
        Edit: "Applied patch to cmd/synesis/ask.go and pkg/bundle/bundle.go",
      },
      maxToolRounds: 4,
      assertions: [
        { type: "contains_edit" },
        { type: "no_repeated_tool" },
      ],
    },
    {
      messages: [
        { role: "user", content: "Add/adjust tests and run verification before you conclude." },
      ],
      simulatedToolResults: {
        Write: "File written: pkg/bundle/bundle_test.go",
        Bash: "ok  synesis.sh/synesis/pkg/bundle  0.318s\nok  synesis.sh/synesis/cmd/synesis  0.404s",
      },
      maxToolRounds: 4,
      assertions: [
        { type: "tool_name_present", params: { name: "Bash" } },
        { type: "contains_edit" },
      ],
    },
    {
      messages: [
        { role: "user", content: "Finalize with clear status and do not ask for extra permission to proceed." },
      ],
      simulatedToolResults: {
        TodoWrite: "updated todos: bundle implementation completed; verification completed",
      },
      maxToolRounds: 2,
      assertions: [
        { type: "no_waffling_markers" },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 3,
    requireVerificationEvidence: true,
    requiredToolActions: ["Read", "Edit", "Bash"],
    failIfRules: ["verbal_intent_without_action", "completion_claim_requires_task_update"],
  },
};

export const canaryConventionHeavyRefactor: EvalScenario = {
  id: "canary-convention-heavy-refactor",
  name: "Canary convention-heavy refactor discipline",
  category: "power_user_canary",
  description:
    "Checks whether the agent preserves repository conventions through read/edit/verify flow in a refactor-style task.",
  target: {},
  systemPrompt:
    "Follow existing repository conventions. Avoid whole-file rewrites when targeted edits are sufficient.",
  turns: [
    {
      messages: [
        { role: "user", content: "Refactor argument parsing in cmd/synesis/main.go and cmd/synesis/ask.go to follow existing naming conventions." },
      ],
      simulatedToolResults: {
        Read: "cmd/synesis/main.go uses parseFlags(), cmd/synesis/ask.go uses legacy parse_args().",
        Glob: "cmd/synesis/main.go\ncmd/synesis/ask.go\ncmd/synesis/root.go",
        Edit: "Applied patch to cmd/synesis/main.go and cmd/synesis/ask.go with convention-aligned names.",
      },
      maxToolRounds: 4,
      assertions: [
        { type: "contains_edit" },
        { type: "tool_count_lte", params: { max: 10 } },
      ],
    },
    {
      messages: [
        { role: "user", content: "Run lint and tests to confirm the refactor is clean." },
      ],
      simulatedToolResults: {
        Bash: "npm run lint\nAll files pass lint.\nnpm test -- cmd/synesis\n0 failed",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "tool_name_present", params: { name: "Bash" } },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 2,
    requireVerificationEvidence: true,
    requiredToolActions: ["Read", "Edit", "Bash"],
  },
};

export const canaryAutonomousFollowthrough: EvalScenario = {
  id: "canary-autonomous-followthrough",
  name: "Canary autonomous follow-through",
  category: "power_user_canary",
  description:
    "Detects permission-seeking loops by expecting concrete action and completion updates when scope is already clear.",
  target: {},
  systemPrompt:
    "When instructions are explicit, execute directly with concrete tool actions and provide a final state update.",
  turns: [
    {
      messages: [
        { role: "user", content: "Implement verbose output in cmd/synesis/main.go and update the task list when done." },
      ],
      simulatedToolResults: {
        Read: "cmd/synesis/main.go currently supports --json and --quiet flags only.",
        Write: "File written: cmd/synesis/main.go",
        Bash: "go test ./cmd/synesis/... \nok  synesis.sh/synesis/cmd/synesis  0.510s",
        TodoWrite: "updated todos: verbose-output status=completed",
      },
      maxToolRounds: 4,
      assertions: [
        { type: "no_waffling_markers" },
        { type: "tool_name_present", params: { name: "Write" } },
      ],
    },
    {
      messages: [
        { role: "user", content: "Confirm completion and move on without asking for another proceed/permission prompt." },
      ],
      simulatedToolResults: {
        TodoWrite: "updated todos: completion confirmed",
      },
      maxToolRounds: 2,
      assertions: [
        { type: "no_waffling_markers" },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 2,
    requireVerificationEvidence: true,
    requiredToolActions: ["Write", "Bash"],
    failIfRules: ["verbal_intent_without_action", "completion_claim_requires_task_update"],
  },
};

export const POWER_USER_CANARY_SCENARIOS: EvalScenario[] = [
  canaryLongSessionMultifile,
  canaryConventionHeavyRefactor,
  canaryAutonomousFollowthrough,
];
