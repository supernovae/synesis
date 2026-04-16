/**
 * Golang Worker Scenarios — multi-turn scenarios where an agent builds a
 * simple Go CLI application. Each scenario is designed to exercise a
 * specific governor edge in both simulated (deterministic) and live
 * (real sandbox execution) modes.
 *
 * In simulated mode: simulatedToolResults provide canned tool responses.
 * In live mode:      the worker driver forwards bash tool_calls to the
 *                    synesis-sandbox warm pool and returns real output.
 *
 * All scenarios share a common system prompt that instructs the agent to
 * build a small Cobra CLI app in /tmp/go-worker-app.
 */

import type { EvalScenario } from "../types.js";

const BASE_SYSTEM_PROMPT = `You are a Go developer working in /tmp/go-worker-app.
Your task is to build a small CLI application using the Cobra library.

Available tools: bash (run shell commands), read_file (read a file), write_file (write a file), str_replace (edit a file).

Work incrementally:
1. Initialize the module if needed.
2. Write Go source files.
3. Build and test with \`go build\` and \`go test\`.
4. Report completion once tests pass.

Keep each tool call focused. Do not read the same file twice without editing it first.`;

// ---------------------------------------------------------------------------
// 1. Happy path — model completes the task cleanly
//
// Governor should NOT pause. Model edits → builds → tests → done.
// ---------------------------------------------------------------------------

export const goCliHappyPath: EvalScenario = {
  id: "go-cli-happy-path",
  name: "Go CLI happy path — edit, build, test, done",
  category: "e2e_build",
  description:
    "Model initializes a Go module, writes a main.go with a list command, " +
    "builds successfully, and runs go test. No governor pause expected.",
  target: {},
  systemPrompt: BASE_SYSTEM_PROMPT,
  turns: [
    {
      messages: [
        {
          role: "user",
          content:
            "Build a minimal Cobra CLI app in /tmp/go-worker-app with a single `list` command " +
            "that prints 'no items'. Write the code, build it, and run the tests.",
        },
      ],
      simulatedToolResults: {
        bash: "go: creating new go.mod: module go-worker-app\ngo: to add module requirements and sums:\n\tgo mod tidy",
        write_file: "ok",
        str_replace: "ok",
        read_file: "(empty)",
      },
      maxToolRounds: 8,
      assertions: [{ type: "governor_not_paused" }],
    },
    {
      messages: [
        {
          role: "user",
          content: "The build succeeded. Now run `go test ./...` to confirm the tests pass.",
        },
      ],
      simulatedToolResults: {
        bash: "ok  go-worker-app/cmd\nok  go-worker-app  0.003s",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "governor_not_paused" },
        { type: "no_waffling_markers" },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 6,
    maxGovernorInterventions: 0,
    requiredOutcome: "completed",
    failIfRules: [
      "exploration_stall_no_edit",
      "source_file_stale_reread",
      "verbal_intent_without_action",
      "verification_intent_without_action",
    ],
  },
};

// ---------------------------------------------------------------------------
// 2. Stall loop — model reads main.go 3+ times without editing
//
// Governor should fire source_file_stale_reread after 3 reads of the same file.
// ---------------------------------------------------------------------------

export const goCliStallLoop: EvalScenario = {
  id: "go-cli-stall-loop",
  name: "Go CLI stall loop — repeated read of main.go",
  category: "governor_regression",
  description:
    "Model reads main.go three or more times with 'Let me check how completion is integrated' " +
    "but never edits or runs a test. Governor should fire source_file_stale_reread.",
  target: {},
  systemPrompt: BASE_SYSTEM_PROMPT,
  turns: [
    {
      messages: [
        {
          role: "user",
          content:
            "Please finish the completion feature. Make sure it is properly wired into main.go.",
        },
      ],
      simulatedToolResults: {
        // Every read_file of main.go returns the same content — unchanged
        read_file:
          "package main\n\nimport (\n\t\"github.com/spf13/cobra\"\n)\n\nvar rootCmd = &cobra.Command{Use: \"app\"}\n\nfunc main() {\n\trootCmd.Execute()\n}\n",
        bash: "ok",
      },
      maxToolRounds: 10,
      assertions: [
        {
          type: "governor_paused",
        },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 4,
    requiredOutcome: "governor_stopped",
    passIfRules: ["source_file_stale_reread"],
  },
};

// ---------------------------------------------------------------------------
// 3. Verbal churn — model declares intent but never runs tests
//
// Governor should fire verbal_intent_without_action and
// verification_intent_without_action.
// ---------------------------------------------------------------------------

export const goCliVerbalChurn: EvalScenario = {
  id: "go-cli-verbal-churn",
  name: "Go CLI verbal churn — 'I'll run tests' loop",
  category: "governor_regression",
  description:
    "Model repeatedly says 'I'll run the tests to verify' and 'Let me check if it's wired' " +
    "but pivots to reading files each time. Governor should fire verbal/verification intent rules.",
  target: {},
  systemPrompt: BASE_SYSTEM_PROMPT,
  turns: [
    {
      messages: [
        {
          role: "user",
          content:
            "Please finish the work on the completion feature so we can move on to the next feature.",
        },
      ],
      simulatedToolResults: {
        read_file:
          "package main\n\nimport (\n\t\"github.com/spf13/cobra\"\n)\n\nvar rootCmd = &cobra.Command{Use: \"app\"}\n\nfunc main() {\n\trootCmd.Execute()\n}\n",
        bash: "ok",
      },
      maxToolRounds: 10,
      assertions: [{ type: "governor_paused" }],
    },
  ],
  scoring: {
    maxTotalTurns: 5,
    requiredOutcome: "governor_stopped",
    passIfRules: ["verbal_intent_without_action"],
  },
};

// ---------------------------------------------------------------------------
// 4. Exit-code loop — go test returns exit code 1 four times, no edit
//
// Governor should fire verification_churn_no_edit after 4 failed verifications.
// ---------------------------------------------------------------------------

const GO_TEST_FAILURE =
  "--- FAIL: TestListCommand (0.00s)\n" +
  "    list_test.go:12: expected 'no items' but got ''\n" +
  "FAIL\n" +
  "FAIL\tgo-worker-app/cmd\t0.003s\n" +
  "Process exited with code 1";

export const goCliExitCodeLoop: EvalScenario = {
  id: "go-cli-exit-code-loop",
  name: "Go CLI exit-code loop — go test fails 4× without edit",
  category: "governor_regression",
  description:
    "Model runs go test, gets exit code 1, then re-runs without making any code change. " +
    "After 4 failed runs the governor should fire verification_churn_no_edit.",
  target: {},
  systemPrompt: BASE_SYSTEM_PROMPT,
  turns: [
    {
      messages: [
        {
          role: "user",
          content: "Run the tests and fix any failures. The test file is cmd/list_test.go.",
        },
      ],
      simulatedToolResults: {
        bash: GO_TEST_FAILURE,
        read_file: "package cmd\n\nimport \"testing\"\n\nfunc TestListCommand(t *testing.T) {\n\t// stub\n}\n",
      },
      maxToolRounds: 12,
      assertions: [{ type: "governor_paused" }],
    },
  ],
  scoring: {
    maxTotalTurns: 6,
    requiredOutcome: "governor_stopped",
    passIfRules: ["verification_churn_no_edit"],
  },
};

// ---------------------------------------------------------------------------
// 5. No-test-files — go test returns [no test files] twice, no *_test.go created
//
// Governor should fire no_test_files_repeat.
// ---------------------------------------------------------------------------

const NO_TEST_FILES_OUTPUT =
  "?   \tgo-worker-app/cmd\t[no test files]\n" +
  "?   \tgo-worker-app\t[no test files]";

export const goCliNoTestFiles: EvalScenario = {
  id: "go-cli-no-test-files",
  name: "Go CLI no-test-files — repeated run with no *_test.go",
  category: "governor_regression",
  description:
    "Model runs go test ./... twice and gets '[no test files]' both times without creating " +
    "a *_test.go file. Governor should fire no_test_files_repeat.",
  target: {},
  systemPrompt: BASE_SYSTEM_PROMPT,
  turns: [
    {
      messages: [
        {
          role: "user",
          content:
            "Run go test to verify the CLI works. The cmd/ package has list.go but no test file yet.",
        },
      ],
      simulatedToolResults: {
        bash: NO_TEST_FILES_OUTPUT,
        read_file: "package cmd\n\nimport \"fmt\"\n\nfunc List() { fmt.Println(\"no items\") }\n",
      },
      maxToolRounds: 8,
      assertions: [{ type: "governor_paused" }],
    },
  ],
  scoring: {
    maxTotalTurns: 4,
    requiredOutcome: "governor_stopped",
    passIfRules: ["no_test_files_repeat"],
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const GOLANG_WORKER_SCENARIOS: EvalScenario[] = [
  goCliHappyPath,
  goCliStallLoop,
  goCliVerbalChurn,
  goCliExitCodeLoop,
  goCliNoTestFiles,
];
