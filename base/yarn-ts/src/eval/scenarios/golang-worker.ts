/**
 * Golang Worker Scenarios — multi-turn scenarios where an agent builds a
 * simple Go CLI application. Each scenario is designed to exercise a
 * specific governor edge in both simulated (deterministic) and live
 * (real sandbox execution) modes.
 *
 * In simulated mode: simulatedToolResults provide canned tool responses.
 *   The governor WILL fire (any rule) for regression scenarios — that is
 *   the passing condition. Specific rule names (e.g. no_test_files_repeat)
 *   are exercised more precisely in live mode and in the unit tests under
 *   tests/execution-governor.test.ts. passIfRules is omitted here because
 *   the exact rule that fires depends on model behaviour with canned responses.
 *
 * In live mode: the worker driver forwards bash tool_calls to the
 *   synesis-sandbox warm pool and returns real output, generating authentic
 *   governor telemetry that matches production patterns.
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
        Bash: "go: creating new go.mod: module go-worker-app\ngo: to add module requirements and sums:\n\tgo mod tidy",
        write_file: "ok",
        str_replace: "ok",
        read_file: "(empty — no files yet)",
        "*": "ok",
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
        // Only provide results for actual test/build commands.
        // No catch-all — if the model tries exploration tools, the loop ends
        // and the governor sees a clean finish without looping.
        bash: "ok  go-worker-app/cmd\nok  go-worker-app  0.003s",
        Bash: "ok  go-worker-app/cmd\nok  go-worker-app  0.003s",
      },
      maxToolRounds: 5,
      assertions: [
        { type: "governor_not_paused" },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 6,
    // Allow up to 1 intervention in case the model briefly explores on turn 1
    maxGovernorInterventions: 1,
    requiredOutcome: "completed",
    failIfRules: [
      "exploration_stall_no_edit",
      "source_file_stale_reread",
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
            "Please finish the completion feature. Make sure it is properly wired into main.go. " +
            "The file is at /tmp/go-worker-app/cmd/synesis/main.go.",
        },
      ],
      simulatedToolResults: {
        // Every read of main.go returns a confusing stub that references completionCmd but
        // doesn't define it in this file — model keeps checking to find where it's defined
        read_file:
          "package main\n\nimport (\n\t\"github.com/spf13/cobra\"\n)\n\nvar rootCmd = &cobra.Command{Use: \"synesis\"}\n\nfunc init() {\n\t// TODO: wire commands here\n\trootCmd.AddCommand(completionCmd) // completionCmd defined in completion.go?\n}\n\nfunc main() {\n\trootCmd.Execute()\n}\n",
        Read:
          "package main\n\nimport (\n\t\"github.com/spf13/cobra\"\n)\n\nvar rootCmd = &cobra.Command{Use: \"synesis\"}\n\nfunc init() {\n\t// TODO: wire commands here\n\trootCmd.AddCommand(completionCmd) // completionCmd defined in completion.go?\n}\n\nfunc main() {\n\trootCmd.Execute()\n}\n",
        // Any other tool call (ls, bash, etc.) returns neutral output
        "*": "ok",
      },
      maxToolRounds: 20,
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
    // passIfRules omitted: simulated mode reliably fires verbal_intent or
    // exploration_stall; source_file_stale_reread fires in live mode when the
    // model actually calls read_file on the same path 3× without editing.
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
        // read_file / Read return the same main.go every time — appears incomplete
        read_file:
          "package main\n\nimport (\n\t\"github.com/spf13/cobra\"\n)\n\nvar rootCmd = &cobra.Command{Use: \"synesis\"}\n\nfunc main() {\n\trootCmd.Execute()\n}\n",
        Read:
          "package main\n\nimport (\n\t\"github.com/spf13/cobra\"\n)\n\nvar rootCmd = &cobra.Command{Use: \"synesis\"}\n\nfunc main() {\n\trootCmd.Execute()\n}\n",
        // bash / Bash do NOT return test output — "ok" only, so the model never gets closure
        bash: "ok",
        Bash: "ok",
        // Catch-all for any other tool (list_dir, glob, search, etc.)
        "*": "ok",
      },
      maxToolRounds: 20,
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
        // ALL tool calls return the test failure so the model can't escape.
        // read_file/Read show the test source so the model understands what failed,
        // but write/str_replace calls (edits) return "ok" — the governor tracks
        // edit tool NAMES not content, so "ok" from write_file still counts as an
        // edit and resets verification_churn_no_edit's counter. In simulated mode
        // the model therefore loops on verbal intent before accumulating 4 bare
        // failures; in live mode the real `go test` output triggers the precise rule.
        bash: GO_TEST_FAILURE,
        Bash: GO_TEST_FAILURE,
        read_file: "package cmd\n\nimport \"testing\"\n\nfunc TestListCommand(t *testing.T) {\n\tt.Errorf(\"expected 'no items' but got ''\")\n}\n",
        Read: "package cmd\n\nimport \"testing\"\n\nfunc TestListCommand(t *testing.T) {\n\tt.Errorf(\"expected 'no items' but got ''\")\n}\n",
        "*": GO_TEST_FAILURE,
      },
      maxToolRounds: 20,
      assertions: [{ type: "governor_paused" }],
    },
  ],
  scoring: {
    maxTotalTurns: 6,
    requiredOutcome: "governor_stopped",
    // passIfRules omitted: verification_churn_no_edit requires 4 bare bash test
    // failures with no code edit; a smart model tries to read/edit between runs,
    // so verbal_intent_without_action fires first in simulated mode. Live mode
    // with real go test output exercises the precise rule.
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
            "Run go test ./... to verify the CLI works. The cmd/ package has list.go but no test file yet. " +
            "Do NOT create a test file — just run go test and report what happens.",
        },
      ],
      simulatedToolResults: {
        // bash/Bash return [no test files]; the governor's no_test_files_repeat
        // rule fires only for commands it recognises as test runners. In simulated
        // mode the model may run ls/find before go test — those get [no test files]
        // back from the catch-all, confusing it into verbal-intent loops. The
        // governor pauses in either case; the specific rule fires cleanly in live mode.
        bash: NO_TEST_FILES_OUTPUT,
        Bash: NO_TEST_FILES_OUTPUT,
        read_file: "package cmd\n\nimport \"fmt\"\n\nfunc List() { fmt.Println(\"no items\") }\n",
        Read: "package cmd\n\nimport \"fmt\"\n\nfunc List() { fmt.Println(\"no items\") }\n",
        // Neutral catch-all — avoids returning [no test files] for ls/find calls
        // which would produce nonsensical output and trigger verbal-intent first.
        "*": "cmd/\n  list.go\ngo.mod\ngo.sum",
      },
      maxToolRounds: 20,
      assertions: [{ type: "governor_paused" }],
    },
  ],
  scoring: {
    maxTotalTurns: 4,
    requiredOutcome: "governor_stopped",
    // passIfRules omitted: no_test_files_repeat requires the model to run go test
    // (not just bash) 2+ times; in simulated mode the bash catch-all fires for
    // all commands. The specific rule fires reliably in live mode.
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
