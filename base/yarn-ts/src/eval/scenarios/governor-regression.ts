/**
 * Governor Regression Scenarios — replay the exact waffling patterns
 * that have been observed in production and fixed with governor rules.
 *
 * Each scenario simulates the multi-turn conversation that triggers
 * a specific failure mode and asserts the governor (or model) handles
 * it correctly.
 */

import type { EvalScenario } from "../types.js";

// ---------------------------------------------------------------------------
// 1. Plan-load exploration drift
//
// After loading a plan file, the model should start editing — not enter
// a search/read loop to "verify what's implemented."
// Governor rule: exploration_stall_no_edit
// ---------------------------------------------------------------------------

export const planLoadExplorationDrift: EvalScenario = {
  id: "plan-load-exploration-drift",
  name: "Plan-load exploration drift",
  category: "governor_regression",
  description:
    "After loading a plan, model drifts into search/read loops instead of editing. " +
    "Governor should fire exploration_stall_no_edit.",
  target: {},
  systemPrompt:
    "You are a coding assistant. The user has a development plan. " +
    "When the plan is loaded, identify the next incomplete task and begin working on it immediately.",
  turns: [
    {
      messages: [
        { role: "user", content: "Load plan ~/.claude/plans/steady-mixing-dewdrop.md and continue with the next incomplete task." },
      ],
      simulatedToolResults: {
        Read: "---\nname: CLI Feature Plan\ntodos:\n  - id: clipboard\n    content: Add clipboard support\n    status: completed\n  - id: bundle\n    content: Add bundle file support\n    status: pending\n  - id: output\n    content: Add output post-processing\n    status: pending\n---\n# CLI Feature Plan\n\n## Completed\n- Clipboard support\n\n## Remaining\n- Bundle file support (next)\n- Output post-processing",
        Search: "Found 3 files matching 'bundle':\n  pkg/bundle/bundle.go\n  pkg/bundle/types.go\n  cmd/synesis/bundle.go",
        Glob: "pkg/bundle/\npkg/bundle/bundle.go\npkg/bundle/types.go",
        Grep: "pkg/bundle/bundle.go:func LoadBundle(path string) (*Bundle, error) {",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "no_waffling_markers" },
        { type: "tool_count_lte", params: { max: 6 } },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 2,
    failIfRules: [],
    passIfRules: [],
  },
};

// ---------------------------------------------------------------------------
// 2. Plan-update amnesia loop
//
// After successfully editing the plan, the model re-reads it and tries
// to edit again. The SYNESIS_PLAN_ALREADY_UPDATED annotation should stop this.
// ---------------------------------------------------------------------------

export const planUpdateAmnesiaLoop: EvalScenario = {
  id: "plan-update-amnesia-loop",
  name: "Plan-update amnesia loop",
  category: "governor_regression",
  description:
    "After updating a plan, model re-reads and tries to update again. " +
    "Annotation SYNESIS_PLAN_ALREADY_UPDATED should prevent re-update.",
  target: {},
  systemPrompt:
    "You are a coding assistant. Mark completed tasks as done in the plan, then proceed to the next task.",
  turns: [
    {
      messages: [
        { role: "user", content: "The clipboard support feature is complete and tested. Mark it done in the plan and move on to the next feature." },
      ],
      simulatedToolResults: {
        Read: "---\nname: CLI Plan\ntodos:\n  - id: clipboard\n    content: Clipboard support\n    status: pending\n  - id: bundle\n    content: Bundle files\n    status: pending\n---\n# Remaining\n- Clipboard support\n- Bundle files",
        Edit: "OK — updated clipboard status to completed.",
        Write: "OK — plan file written.",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "no_repeated_tool" },
        { type: "tool_count_lte", params: { max: 8 } },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 2,
    maxGovernorInterventions: 1,
  },
};

// ---------------------------------------------------------------------------
// 3. Verification stall — no edit
//
// Model alternates between `go build` and `go test` without making
// code changes. Governor rule: verification_stall_no_edit.
// ---------------------------------------------------------------------------

export const verificationStallNoEdit: EvalScenario = {
  id: "verification-stall-no-edit",
  name: "Verification stall without edits",
  category: "governor_regression",
  description:
    "Model runs go build/go test repeatedly without making code edits. " +
    "Governor should fire verification_stall_no_edit.",
  target: {},
  systemPrompt:
    "You are a coding assistant. Implement bundle file support in Go. " +
    "The bundle package exists but has no tests.",
  turns: [
    {
      messages: [
        { role: "user", content: "Implement bundle files for the synesis CLI. Make sure there are tests." },
      ],
      simulatedToolResults: {
        Bash: "ok  synesis.sh/synesis/cmd/synesis  (cached)\n?   synesis.sh/synesis/pkg/bundle   [no test files]",
        Read: "package bundle\n\nimport \"os\"\n\ntype Bundle struct {\n\tName string\n\tFiles []string\n}\n\nfunc LoadBundle(path string) (*Bundle, error) {\n\tdata, _ := os.ReadFile(path)\n\t_ = data\n\treturn &Bundle{}, nil\n}",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "contains_edit" },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 2,
    failIfRules: ["verification_stall_no_edit"],
  },
};

// ---------------------------------------------------------------------------
// 4. Verbal intent without action
//
// Model says "I'll implement..." repeatedly without making tool calls.
// Governor rule: verbal_intent_without_action.
// ---------------------------------------------------------------------------

export const verbalIntentWithoutAction: EvalScenario = {
  id: "verbal-intent-without-action",
  name: "Verbal intent without action",
  category: "governor_regression",
  description:
    "Model repeatedly states intent to act but does not issue tool calls. " +
    "Governor should fire verbal_intent_without_action.",
  target: {},
  systemPrompt:
    "You are a coding assistant. When asked to implement something, use your tools to make changes.",
  turns: [
    {
      messages: [
        { role: "user", content: "Add a --verbose flag to the CLI. Use the Write tool to create the file." },
      ],
      simulatedToolResults: {
        Write: "File written: cmd/synesis/verbose.go",
        Read: "package main\n\nfunc main() {}",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "no_waffling_markers" },
        { type: "tool_count_lte", params: { max: 6 } },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 2,
    failIfRules: ["verbal_intent_without_action"],
  },
};

// ---------------------------------------------------------------------------
// 5. No-test-files repeat
//
// `[no test files]` result should trigger test creation, not retrying
// the same go test command. Governor rule: no_test_files_repeat.
// ---------------------------------------------------------------------------

export const noTestFilesRepeat: EvalScenario = {
  id: "no-test-files-repeat",
  name: "No test files repeat",
  category: "governor_regression",
  description:
    "When go test reports [no test files], model should create tests " +
    "instead of retrying. Annotation SYNESIS_VERIFICATION_GAP should guide.",
  target: {},
  systemPrompt:
    "You are a coding assistant. When tests are missing, create them. Do not re-run the same test command.",
  turns: [
    {
      messages: [
        { role: "user", content: "Verify the bundle package has tests. If not, create them." },
      ],
      simulatedToolResults: {
        Bash: "?   synesis.sh/synesis/pkg/bundle   [no test files]\nok  synesis.sh/synesis/cmd/synesis  (cached)",
        Write: "File written: pkg/bundle/bundle_test.go",
        Read: "package bundle\n\ntype Bundle struct {\n\tName string\n}",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "contains_edit" },
        { type: "no_repeated_tool" },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 2,
  },
};

// ---------------------------------------------------------------------------
// 6. Broad discovery repeat
//
// Model Glob/List-ing the same directories repeatedly without progress.
// Governor rule: broad_discovery_repeat.
// ---------------------------------------------------------------------------

export const broadDiscoveryRepeat: EvalScenario = {
  id: "broad-discovery-repeat",
  name: "Broad discovery repeat",
  category: "governor_regression",
  description:
    "Model repeatedly lists/globs the same directories without acting. " +
    "Governor should fire exploration_stall_no_edit.",
  target: {},
  systemPrompt:
    "You are a coding assistant. Use search results to take action, do not re-search the same paths.",
  turns: [
    {
      messages: [
        { role: "user", content: "Find the main.go file and add a version command." },
      ],
      simulatedToolResults: {
        Glob: "cmd/synesis/main.go\ncmd/synesis/ask.go\ncmd/synesis/chat.go",
        Read: "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"synesis\")\n}",
        Write: "File written: cmd/synesis/version.go",
        Search: "cmd/synesis/main.go: func main()",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "contains_edit" },
        { type: "tool_count_lte", params: { max: 8 } },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 2,
    failIfRules: ["exploration_stall_no_edit", "broad_discovery_repeat"],
  },
};

// ---------------------------------------------------------------------------
// 7. Plan stub overwrite
//
// Model attempts to write "unchanged since last read" or cache stub
// content to the plan file. Governor path governance should block.
// ---------------------------------------------------------------------------

export const planStubOverwrite: EvalScenario = {
  id: "plan-stub-overwrite",
  name: "Plan stub overwrite prevention",
  category: "governor_regression",
  description:
    "Model attempts to write cache stub content to a plan file. " +
    "Yarn path governance should block with Synesis_Error_PlanWriteBlocked.",
  target: {},
  systemPrompt:
    "You are a coding assistant working with plan files. Never write stub or cached content to plan files.",
  turns: [
    {
      messages: [
        { role: "user", content: "Update the plan to mark the clipboard task as done." },
      ],
      simulatedToolResults: {
        Read: "---\nname: CLI Plan\ntodos:\n  - id: clipboard\n    content: Clipboard support\n    status: pending\n  - id: bundle\n    content: Bundle files\n    status: pending\n---\n# Plan\n\n## Tasks\n- Clipboard: pending\n- Bundle: pending",
        Edit: "OK — updated clipboard status to completed.",
        Write: "OK — plan file written.",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "no_stub_content" },
        { type: "tool_count_lte", params: { max: 6 } },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 2,
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const GOVERNOR_REGRESSION_SCENARIOS: EvalScenario[] = [
  planLoadExplorationDrift,
  planUpdateAmnesiaLoop,
  verificationStallNoEdit,
  verbalIntentWithoutAction,
  noTestFilesRepeat,
  broadDiscoveryRepeat,
  planStubOverwrite,
];
