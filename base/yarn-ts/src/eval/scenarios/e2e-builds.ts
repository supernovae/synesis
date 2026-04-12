/**
 * End-to-end build scenarios — exercise real coding tasks through the
 * full Yarn pipeline to validate the developer experience.
 */

import type { EvalScenario } from "../types.js";

// ---------------------------------------------------------------------------
// 1. Fresh Python app — build a simple Flask app from scratch
// ---------------------------------------------------------------------------

export const freshPythonApp: EvalScenario = {
  id: "fresh-python-app",
  name: "Build a fresh Python Flask app",
  category: "e2e_build",
  description:
    "Ask the model to create a simple Flask REST API from scratch. " +
    "Validates that the model produces file edits, runs tests, and completes.",
  target: {},
  systemPrompt:
    "You are a coding assistant. Create files using the Write tool, " +
    "run commands using the Bash tool. Be concise and efficient.",
  turns: [
    {
      messages: [
        {
          role: "user",
          content:
            "Create a simple Flask REST API with:\n" +
            "- GET /health returning {\"status\": \"ok\"}\n" +
            "- GET /items returning a list of items from an in-memory store\n" +
            "- POST /items to add a new item\n" +
            "Include requirements.txt and a test file using pytest.",
        },
      ],
      simulatedToolResults: {
        Write: "File written successfully.",
        Bash: "===== test session starts =====\ntest_health PASSED\ntest_get_items PASSED\ntest_post_item PASSED\n===== 3 passed =====",
        Read: "",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "contains_edit" },
        { type: "no_waffling_markers" },
        { type: "tool_count_lte", params: { max: 12 } },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 3,
    maxGovernorInterventions: 0,
  },
};

// ---------------------------------------------------------------------------
// 2. Fresh Go CLI — build a Go command-line tool
// ---------------------------------------------------------------------------

export const freshGoCli: EvalScenario = {
  id: "fresh-go-cli",
  name: "Build a fresh Go CLI tool",
  category: "e2e_build",
  description:
    "Ask the model to create a Go CLI with subcommands. " +
    "Validates file creation, build success, and test existence.",
  target: {},
  systemPrompt:
    "You are a coding assistant specializing in Go. " +
    "Use Write for file creation and Bash for builds/tests.",
  turns: [
    {
      messages: [
        {
          role: "user",
          content:
            "Create a Go CLI tool called 'taskctl' with:\n" +
            "- `taskctl list` — lists tasks from a JSON file\n" +
            "- `taskctl add <name>` — adds a task\n" +
            "- `taskctl done <id>` — marks a task complete\n" +
            "Use the standard library flag package. Include tests.",
        },
      ],
      simulatedToolResults: {
        Write: "File written successfully.",
        Bash: "ok  taskctl/cmd  0.012s\nok  taskctl/task  0.008s\nBuild successful.",
        Read: "",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "contains_edit" },
        { type: "no_waffling_markers" },
        { type: "no_repeated_tool" },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 3,
    maxGovernorInterventions: 0,
  },
};

// ---------------------------------------------------------------------------
// 3. Plan-driven multi-phase — load a plan, complete a phase, update, start next
// ---------------------------------------------------------------------------

export const planDrivenMultiPhase: EvalScenario = {
  id: "plan-driven-multi-phase",
  name: "Plan-driven multi-phase development",
  category: "plan_management",
  description:
    "Load a plan, complete the next phase, update the plan, and start " +
    "the following phase. Tests plan awareness and task progression.",
  target: {},
  systemPrompt:
    "You are a coding assistant working with a development plan. " +
    "Complete tasks in order, mark them done, and proceed to the next.",
  turns: [
    {
      messages: [
        {
          role: "user",
          content:
            "Load the plan and complete the next incomplete task. " +
            "Once verified, mark it done and tell me what's next.",
        },
      ],
      simulatedToolResults: {
        Read: "---\nname: Web API Plan\ntodos:\n  - id: auth\n    content: Add JWT authentication\n    status: completed\n  - id: rate-limit\n    content: Add rate limiting middleware\n    status: pending\n  - id: logging\n    content: Add structured logging\n    status: pending\n---\n# Web API Plan\n\n## Completed\n- JWT authentication\n\n## Next\n- Rate limiting middleware\n- Structured logging",
        Write: "File written successfully.",
        Edit: "OK — updated rate-limit status to completed.",
        Bash: "PASS\nok  api/middleware  0.015s",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "contains_edit" },
        { type: "no_waffling_markers" },
        { type: "tool_count_lte", params: { max: 10 } },
      ],
    },
    {
      messages: [
        {
          role: "user",
          content: "Good. Now proceed with the next task from the plan.",
        },
      ],
      simulatedToolResults: {
        Read: "---\nname: Web API Plan\ntodos:\n  - id: auth\n    content: Add JWT authentication\n    status: completed\n  - id: rate-limit\n    content: Add rate limiting middleware\n    status: completed\n  - id: logging\n    content: Add structured logging\n    status: pending\n---\n# Updated plan",
        Write: "File written successfully.",
        Edit: "OK — updated logging status to completed.",
        Bash: "PASS\nok  api/logging  0.009s",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "contains_edit" },
        { type: "no_repeated_tool" },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 4,
    maxGovernorInterventions: 0,
  },
};

// ---------------------------------------------------------------------------
// 4. Session recovery — resume from continuity data
// ---------------------------------------------------------------------------

export const sessionRecovery: EvalScenario = {
  id: "session-recovery",
  name: "Session recovery from continuity",
  category: "recovery",
  description:
    "Simulate a session restart where continuity data carries forward. " +
    "Model should pick up from where it left off without re-exploring.",
  target: {},
  systemPrompt:
    "You are a coding assistant. The user's previous session was working on " +
    "adding structured logging to a Go service. The auth and rate-limit " +
    "features are complete. Resume from where the last session left off.",
  turns: [
    {
      messages: [
        {
          role: "user",
          content:
            "I compacted the history from our last session. We were working on " +
            "structured logging for the API. Auth and rate-limiting are done. " +
            "Please continue.",
        },
      ],
      simulatedToolResults: {
        Read: "package main\n\nimport (\n\t\"net/http\"\n\t\"log\"\n)\n\nfunc main() {\n\thttp.HandleFunc(\"/health\", healthHandler)\n\tlog.Fatal(http.ListenAndServe(\":8080\", nil))\n}",
        Write: "File written successfully.",
        Bash: "PASS\nok  api/logging  0.011s",
      },
      maxToolRounds: 3,
      assertions: [
        { type: "contains_edit" },
        { type: "no_waffling_markers" },
        { type: "tool_count_lte", params: { max: 8 } },
      ],
    },
  ],
  scoring: {
    maxTotalTurns: 2,
    maxGovernorInterventions: 0,
    failIfRules: ["exploration_stall_no_edit"],
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const E2E_BUILD_SCENARIOS: EvalScenario[] = [
  freshPythonApp,
  freshGoCli,
  planDrivenMultiPhase,
  sessionRecovery,
];
