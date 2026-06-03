import {
  evaluateExecutionGovernor,
  extractCommandEvents,
  type ExecutionGovernorDecision,
  type ExecutionGovernorOptions,
  type GovernorInputMessage,
} from "../governance/execution-governor.js";

export type HarnessProfileId =
  | "claude-code"
  | "opencode"
  | "codex-cli"
  | "pi"
  | "cursor"
  | "generic-openai";

export type HarnessFlowType =
  | "greenfield-build"
  | "bugfix"
  | "plan-then-build"
  | "repair-after-failure"
  | "verify-and-finalize"
  | "auth-and-chat";

export type HarnessFlowSignal =
  | "governor_pause"
  | "path_confusion"
  | "duplicate_cwd_path"
  | "claude_leakage"
  | "opencode_leakage"
  | "missing_expected_tool"
  | "forbidden_rule";

export interface HarnessProfile {
  id: HarnessProfileId;
  nativeTaskTools: readonly string[];
  nativePlanTools: readonly string[];
  allowedPrivatePaths: readonly string[];
  forbiddenToolNames: readonly string[];
}

export interface HarnessFlowStep {
  id: string;
  messages: GovernorInputMessage[];
  governorOptions?: ExecutionGovernorOptions;
  allowPause?: boolean;
  expectedPhase?: ExecutionGovernorDecision["telemetry"]["phase"];
  expectedRulesInclude?: readonly string[];
  expectedRulesExclude?: readonly string[];
}

export interface HarnessFlowSpec {
  id: string;
  description: string;
  profile: HarnessProfileId;
  flowType: HarnessFlowType;
  steps: HarnessFlowStep[];
  governorOptions?: ExecutionGovernorOptions;
  expectedTools?: readonly string[];
  forbiddenRules?: readonly string[];
  forbiddenSignals?: readonly HarnessFlowSignal[];
}

export interface HarnessFlowStepResult {
  stepId: string;
  decision: ExecutionGovernorDecision;
  signals: HarnessFlowSignal[];
}

export interface HarnessFlowResult {
  specId: string;
  profile: HarnessProfileId;
  flowType: HarnessFlowType;
  passed: boolean;
  stepResults: HarnessFlowStepResult[];
  missingTools: string[];
  forbiddenRules: string[];
  signals: HarnessFlowSignal[];
}

export const HARNESS_PROFILES: Record<HarnessProfileId, HarnessProfile> = {
  "claude-code": {
    id: "claude-code",
    nativeTaskTools: ["TaskCreate", "TaskUpdate"],
    nativePlanTools: ["EnterPlanMode", "ExitPlanMode", "Write"],
    allowedPrivatePaths: ["/.claude/plans/"],
    forbiddenToolNames: ["TodoWrite"],
  },
  opencode: {
    id: "opencode",
    nativeTaskTools: ["TodoWrite"],
    nativePlanTools: [],
    allowedPrivatePaths: [],
    forbiddenToolNames: ["TaskCreate", "TaskUpdate", "ExitPlanMode"],
  },
  "codex-cli": {
    id: "codex-cli",
    nativeTaskTools: [],
    nativePlanTools: [],
    allowedPrivatePaths: [],
    forbiddenToolNames: ["TaskCreate", "TaskUpdate", "TodoWrite", "ExitPlanMode"],
  },
  pi: {
    id: "pi",
    nativeTaskTools: [],
    nativePlanTools: [],
    allowedPrivatePaths: [],
    forbiddenToolNames: ["TaskCreate", "TaskUpdate", "TodoWrite", "ExitPlanMode"],
  },
  cursor: {
    id: "cursor",
    nativeTaskTools: [],
    nativePlanTools: [],
    allowedPrivatePaths: [],
    forbiddenToolNames: ["TaskCreate", "TaskUpdate", "TodoWrite", "ExitPlanMode"],
  },
  "generic-openai": {
    id: "generic-openai",
    nativeTaskTools: [],
    nativePlanTools: [],
    allowedPrivatePaths: [],
    forbiddenToolNames: ["TaskCreate", "TaskUpdate", "TodoWrite", "ExitPlanMode"],
  },
};

export function assistantCall(id: string, name: string, args: unknown): GovernorInputMessage {
  return { role: "assistant", content: "", tool_calls: [{ id, function: { name, arguments: args } }] };
}

export function toolResult(id: string, content: string): GovernorInputMessage {
  return { role: "tool", tool_call_id: id, content };
}

export function assistantText(content: string): GovernorInputMessage {
  return { role: "assistant", content };
}

export function userText(content: string): GovernorInputMessage {
  return { role: "user", content };
}

export function evaluateHarnessFlow(spec: HarnessFlowSpec): HarnessFlowResult {
  const profile = HARNESS_PROFILES[spec.profile];
  const transcript: GovernorInputMessage[] = [];
  const stepResults: HarnessFlowStepResult[] = [];

  for (const step of spec.steps) {
    transcript.push(...step.messages);
    const decision = evaluateExecutionGovernor(transcript, {
      ...(spec.governorOptions ?? {}),
      ...(step.governorOptions ?? {}),
    });
    const signals = signalsForStep(spec, profile, transcript, step, decision);
    stepResults.push({ stepId: step.id, decision, signals });
  }

  const allEvents = extractCommandEvents(transcript);
  const toolNames = new Set(allEvents.map((event) => event.toolName.toLowerCase()));
  const missingTools = (spec.expectedTools ?? [])
    .filter((tool) => !toolNames.has(tool.toLowerCase()));
  const forbiddenRules = [...new Set(stepResults.flatMap((step) =>
    step.decision.matchedRules.filter((rule) => spec.forbiddenRules?.includes(rule)),
  ))];
  const signals = [...new Set([
    ...stepResults.flatMap((step) => step.signals),
    ...(missingTools.length > 0 ? ["missing_expected_tool" as const] : []),
    ...(forbiddenRules.length > 0 ? ["forbidden_rule" as const] : []),
  ])];
  const forbiddenSignals = spec.forbiddenSignals ?? [
    "governor_pause",
    "path_confusion",
    "duplicate_cwd_path",
    "claude_leakage",
    "opencode_leakage",
    "missing_expected_tool",
    "forbidden_rule",
  ];
  const passed = signals.every((signal) => !forbiddenSignals.includes(signal));

  return {
    specId: spec.id,
    profile: spec.profile,
    flowType: spec.flowType,
    passed,
    stepResults,
    missingTools,
    forbiddenRules,
    signals,
  };
}

function signalsForStep(
  spec: HarnessFlowSpec,
  profile: HarnessProfile,
  transcript: GovernorInputMessage[],
  step: HarnessFlowStep,
  decision: ExecutionGovernorDecision,
): HarnessFlowSignal[] {
  const signals: HarnessFlowSignal[] = [];
  if (decision.pause && step.allowPause !== true) signals.push("governor_pause");
  if (step.expectedPhase && decision.telemetry.phase !== step.expectedPhase) signals.push("forbidden_rule");
  for (const rule of step.expectedRulesInclude ?? []) {
    if (!decision.matchedRules.includes(rule)) signals.push("forbidden_rule");
  }
  for (const rule of step.expectedRulesExclude ?? []) {
    if (decision.matchedRules.includes(rule)) signals.push("forbidden_rule");
  }

  const text = transcript.map((message) => messageToText(message)).join("\n");
  if (/\/(?:[^/\s]+\/)*src\/test\/src\/test\b/.test(text) || /\\src\\test\\src\\test\b/i.test(text)) {
    signals.push("duplicate_cwd_path");
  }
  if (/\b(?:file|path|directory)\s+not\s+found\b/i.test(text)) {
    signals.push("path_confusion");
  }

  const events = extractCommandEvents(transcript);
  const eventToolNames = events.map((event) => event.toolName.toLowerCase());
  const forbidden = profile.forbiddenToolNames.map((tool) => tool.toLowerCase());
  if (spec.profile !== "claude-code" && text.includes("/.claude/plans/")) {
    signals.push("claude_leakage");
  }
  if (spec.profile !== "opencode" && eventToolNames.includes("todowrite")) {
    signals.push("opencode_leakage");
  }
  if (eventToolNames.some((tool) => forbidden.includes(tool))) {
    if (forbidden.includes("todowrite") && eventToolNames.includes("todowrite")) signals.push("opencode_leakage");
    if (forbidden.some((tool) => tool === "taskcreate" || tool === "taskupdate" || tool === "exitplanmode")) {
      signals.push("claude_leakage");
    }
  }

  return [...new Set(signals)];
}

function messageToText(message: GovernorInputMessage): string {
  const chunks: string[] = [];
  if (typeof message.content === "string") chunks.push(message.content);
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      chunks.push(String(call.function?.name ?? call.name ?? ""));
      chunks.push(JSON.stringify(call.function?.arguments ?? call.input ?? {}));
    }
  }
  if (typeof message.content === "object" && message.content !== null) {
    chunks.push(JSON.stringify(message.content));
  }
  return chunks.join("\n");
}

export function standardHarnessFlowSpecs(): HarnessFlowSpec[] {
  return [
    claudePlanThenBuildFlow(),
    opencodeGreenfieldBuildFlow(),
    codexCliBugfixFlow(),
    piAuthAndChatFlow(),
    cursorBugfixFlow(),
    genericOpenAiFlow(),
  ];
}

export function criticalHarnessTransitionSpecs(): HarnessFlowSpec[] {
  return [
    claudePlanApprovalTransitionFlow({
      id: "claude-plan-approval-normal-then-task-setup",
      description: "Claude Code should move from approved ExitPlanMode to native task setup and the first edit.",
      approvalMessages: [
        assistantCall("normal-exit", "ExitPlanMode", { plan: "Rust workspace implementation plan" }),
        toolResult("normal-exit", "User has approved your plan. You can now start coding."),
      ],
      clientPlanModeRequestedAfterApproval: true,
    }),
    claudePlanApprovalTransitionFlow({
      id: "claude-plan-approval-cleared-flag-then-task-setup",
      description: "Claude Code should still allow task setup after route prep clears the plan-mode flag on approval.",
      approvalMessages: [
        toolResult("cleared-approval", "User has approved your plan. You can now start coding."),
      ],
      clientPlanModeRequestedAfterApproval: false,
    }),
    claudePlanApprovalTransitionFlow({
      id: "claude-plan-approved-exit-error-then-task-setup",
      description: "Claude Code should treat an already-approved ExitPlanMode error as an implementation transition.",
      approvalMessages: [
        assistantCall("approved-error-exit", "ExitPlanMode", { plan: "Rust workspace implementation plan" }),
        toolResult(
          "approved-error-exit",
          "Error: You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.",
        ),
      ],
      clientPlanModeRequestedAfterApproval: false,
    }),
    claudePlanApprovalTransitionFlow({
      id: "claude-plan-approval-stale-reminder-then-task-setup",
      description: "Claude Code should recover when a stale plan-mode reminder causes one redundant ExitPlanMode call.",
      approvalMessages: [
        assistantCall("stale-exit", "ExitPlanMode", { plan: "Rust workspace implementation plan" }),
        toolResult("stale-exit", "User has approved your plan. You can now start coding."),
        assistantText("A stale reminder says plan mode is active, so I will exit plan mode again."),
        assistantCall("stale-exit-again", "ExitPlanMode", { plan: "Rust workspace implementation plan" }),
        toolResult(
          "stale-exit-again",
          "Error: You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.",
        ),
      ],
      clientPlanModeRequestedAfterApproval: false,
    }),
  ];
}

function claudePlanApprovalTransitionFlow(opts: {
  id: string;
  description: string;
  approvalMessages: GovernorInputMessage[];
  clientPlanModeRequestedAfterApproval: boolean;
}): HarnessFlowSpec {
  const baseOptions = {
    orchestratorWorkflowPhase: "implementation" as const,
    activePlanStage: "implement" as const,
    taskLedgerOpenCount: 6,
    taskLedgerExplicitOpenCount: 6,
    chatState: { completionStatus: "blocked" as const, lastVerificationOutcome: "fail" as const },
  };

  return {
    id: opts.id,
    description: opts.description,
    profile: "claude-code",
    flowType: "plan-then-build",
    expectedTools: ["Write", "TaskCreate"],
    forbiddenRules: ["completion_claim_requires_task_update", "identical_tool_repeat", "task_creation_replay", "no_progress_loop"],
    steps: [
      {
        id: "plan-file-written",
        messages: [
          userText("/plan Build a complete Rust workspace application."),
          assistantCall(`${opts.id}-plan`, "Write", {
            file_path: ".claude/plans/rust-workspace-plan.md",
            content: "Plan: Rust workspace application\n\n- Create workspace manifest\n- Create core and cli crates\n",
          }),
          toolResult(`${opts.id}-plan`, "Updated plan"),
          assistantText("Claude has written up a plan and is ready to execute. Would you like to proceed?"),
        ],
        governorOptions: {
          clientPlanModeRequested: true,
          orchestratorWorkflowPhase: "planning",
          activePlanStage: "plan",
          taskLedgerOpenCount: 0,
          taskLedgerExplicitOpenCount: 0,
          chatState: { completionStatus: "blocked" },
        },
        expectedRulesExclude: ["completion_claim_requires_task_update", "identical_tool_repeat", "task_creation_replay", "no_progress_loop"],
      },
      {
        id: "plan-approved",
        messages: opts.approvalMessages,
        governorOptions: {
          ...baseOptions,
          clientPlanModeRequested: opts.clientPlanModeRequestedAfterApproval,
        },
        expectedRulesExclude: ["completion_claim_requires_task_update", "identical_tool_repeat", "task_creation_replay", "no_progress_loop"],
      },
      {
        id: "native-task-setup",
        messages: [
          assistantText("The plan is approved. I'll create the implementation task list and start with the workspace manifest."),
          assistantCall(`${opts.id}-task-1`, "TaskCreate", { title: "Create workspace Cargo.toml" }),
          toolResult(`${opts.id}-task-1`, "task created"),
          assistantCall(`${opts.id}-task-2`, "TaskCreate", { title: "Create workspace Cargo.toml" }),
          toolResult(`${opts.id}-task-2`, "task created"),
          assistantCall(`${opts.id}-task-3`, "TaskCreate", { title: "Create workspace Cargo.toml" }),
          toolResult(`${opts.id}-task-3`, "task created"),
        ],
        governorOptions: {
          ...baseOptions,
          clientPlanModeRequested: opts.clientPlanModeRequestedAfterApproval,
        },
        expectedRulesExclude: ["completion_claim_requires_task_update", "identical_tool_repeat", "task_creation_replay", "no_progress_loop"],
      },
      {
        id: "first-implementation-edit",
        messages: [
          assistantCall(`${opts.id}-write-cargo`, "Write", {
            file_path: "Cargo.toml",
            content: "// FILE: Cargo.toml\n[workspace]\nresolver = \"2\"\nmembers = [\"core\", \"cli\"]\n",
          }),
          toolResult(`${opts.id}-write-cargo`, "Wrote Cargo.toml"),
        ],
        governorOptions: {
          ...baseOptions,
          clientPlanModeRequested: opts.clientPlanModeRequestedAfterApproval,
        },
        expectedRulesExclude: ["completion_claim_requires_task_update", "identical_tool_repeat", "task_creation_replay", "no_progress_loop"],
      },
    ],
  };
}

function claudePlanThenBuildFlow(): HarnessFlowSpec {
  return {
    id: "claude-plan-build-rust",
    description: "Claude Code plan mode should allow plan file creation, ExitPlanMode, native task setup, first edit, repair, and finalization.",
    profile: "claude-code",
    flowType: "plan-then-build",
    governorOptions: { clientPlanModeRequested: true, orchestratorWorkflowPhase: "planning" },
    expectedTools: ["Write", "ExitPlanMode", "TaskCreate", "TaskUpdate", "Bash"],
    forbiddenRules: ["completion_claim_requires_task_update", "task_creation_replay", "identical_tool_repeat"],
    steps: [
      {
        id: "intake-and-explore",
        messages: [
          userText("Generate a complete Rust CLI plus library workspace application."),
          assistantCall("c1", "Read", { file_path: "CLAUDE.md" }),
          toolResult("c1", "No local instructions."),
        ],
        governorOptions: { clientPlanModeRequested: true },
      },
      {
        id: "write-plan-file",
        messages: [
          assistantCall("c2", "Write", {
            file_path: ".claude/plans/rust-task-manager.md",
            content: "# Plan\n- Create workspace\n- Implement core\n- Implement cli\n- Verify",
          }),
          toolResult("c2", "Wrote .claude/plans/rust-task-manager.md"),
          assistantText("The plan is ready for review. I've designed a production-ready Rust application plan."),
        ],
        governorOptions: { clientPlanModeRequested: true },
      },
      {
        id: "exit-plan-mode",
        messages: [
          assistantCall("c3", "ExitPlanMode", { plan: "Rust Task Manager implementation plan" }),
          toolResult("c3", "User has approved your plan. You can now start coding."),
        ],
        governorOptions: { clientPlanModeRequested: true, orchestratorWorkflowPhase: "implementation" },
      },
      {
        id: "first-scaffold-command-after-plan-exit",
        messages: [
          assistantText("I'll implement the complete Rust File Indexer application. Starting with workspace setup."),
          assistantCall("c3b", "Bash", { command: "mkdir -p core/src cli/src config tests" }),
          toolResult("c3b", "Done"),
        ],
        governorOptions: {
          clientPlanModeRequested: true,
          orchestratorWorkflowPhase: "implementation",
          activePlanStage: "implement",
          taskLedgerOpenCount: 1,
          taskLedgerExplicitOpenCount: 1,
          chatState: { completionStatus: "ready_to_finalize" },
        },
      },
      {
        id: "native-task-setup",
        messages: [
          assistantCall("c4", "TaskCreate", { title: "Create workspace and manifests" }),
          toolResult("c4", "Created task"),
          assistantCall("c5", "TaskCreate", { title: "Implement core models and service" }),
          toolResult("c5", "Created task"),
          assistantCall("c6", "TaskCreate", { title: "Implement CLI and tests" }),
          toolResult("c6", "Created task"),
        ],
        governorOptions: { clientPlanModeRequested: true, orchestratorWorkflowPhase: "implementation" },
      },
      {
        id: "first-edit",
        messages: [
          assistantCall("c7", "Write", { file_path: "Cargo.toml", content: "[workspace]\nmembers = [\"core\", \"cli\"]\n" }),
          toolResult("c7", "Wrote Cargo.toml"),
        ],
        governorOptions: { clientPlanModeRequested: true, orchestratorWorkflowPhase: "implementation" },
      },
      {
        id: "failing-verification",
        messages: [
          assistantCall("c8", "Bash", { command: "cargo test --workspace" }),
          toolResult("c8", "error: failed to load manifest for workspace member `core`"),
        ],
        governorOptions: { clientPlanModeRequested: true, orchestratorWorkflowPhase: "implementation" },
      },
      {
        id: "repair-edit",
        messages: [
          assistantCall("c9", "Write", { file_path: "core/Cargo.toml", content: "[package]\nname = \"task-core\"\nversion = \"0.1.0\"\nedition = \"2021\"\n" }),
          toolResult("c9", "Wrote core/Cargo.toml"),
        ],
        governorOptions: { clientPlanModeRequested: true, orchestratorWorkflowPhase: "implementation" },
      },
      {
        id: "green-verification-and-task-update",
        messages: [
          assistantCall("c10", "Bash", { command: "cargo test --workspace" }),
          toolResult("c10", "test result: ok. 8 passed; 0 failed"),
          assistantCall("c11", "TaskUpdate", { title: "Create workspace and manifests", status: "done" }),
          toolResult("c11", "Updated task"),
        ],
        governorOptions: { clientPlanModeRequested: true, orchestratorWorkflowPhase: "implementation" },
      },
    ],
  };
}

function opencodeGreenfieldBuildFlow(): HarnessFlowSpec {
  return {
    id: "opencode-greenfield-python",
    description: "OpenCode greenfield flow should use workspace handshake, TodoWrite, edits, verification, repair, and completion without path confusion.",
    profile: "opencode",
    flowType: "greenfield-build",
    expectedTools: ["Bash", "TodoWrite", "Write", "Edit"],
    forbiddenRules: ["completion_claim_requires_task_update", "task_creation_replay", "identical_tool_repeat"],
    steps: [
      {
        id: "workspace-handshake",
        messages: [
          userText("Build a complete Python FastAPI application in the current empty workspace."),
          assistantCall("o1", "Bash", {
            command: "pwd && printf 'SYNESIS_WORKSPACE_CONTEXT_V1\\ncwd=%s\\nproject_root=%s\\n' \"$PWD\" \"$PWD\"",
          }),
          toolResult("o1", "SYNESIS_WORKSPACE_CONTEXT_V1\ncwd=/home/byron/src/test\nproject_root=/home/byron/src/test"),
        ],
      },
      {
        id: "native-todo-setup",
        messages: [
          assistantCall("o2", "TodoWrite", {
            todos: [
              { content: "Create project structure", status: "in_progress" },
              { content: "Implement API and storage", status: "pending" },
              { content: "Run tests", status: "pending" },
            ],
          }),
          toolResult("o2", "Todos updated"),
        ],
      },
      {
        id: "scaffold-edit",
        messages: [
          assistantCall("o3", "Write", { file_path: "taskpulse/app/main.py", content: "from fastapi import FastAPI\napp = FastAPI()\n" }),
          toolResult("o3", "Wrote taskpulse/app/main.py"),
        ],
      },
      {
        id: "first-failing-test",
        messages: [
          assistantCall("o4", "Bash", { command: "python -m pytest taskpulse/tests -q" }),
          toolResult("o4", "FAILED tests/test_tasks.py::test_create_task - ModuleNotFoundError: taskpulse.app.models"),
        ],
      },
      {
        id: "repair-after-failure",
        messages: [
          assistantCall("o5", "Edit", {
            file_path: "taskpulse/app/main.py",
            old_string: "app = FastAPI()",
            new_string: "app = FastAPI(title=\"TaskPulse\")",
          }),
          toolResult("o5", "Applied edit"),
        ],
      },
      {
        id: "green-and-complete",
        messages: [
          assistantCall("o6", "Bash", { command: "python -m pytest taskpulse/tests -q" }),
          toolResult("o6", "31 passed in 0.42s"),
          assistantCall("o7", "TodoWrite", {
            todos: [
              { content: "Create project structure", status: "completed" },
              { content: "Implement API and storage", status: "completed" },
              { content: "Run tests", status: "completed" },
            ],
          }),
          toolResult("o7", "Todos updated"),
          assistantText("All tasks are complete and tests pass."),
        ],
        governorOptions: { activePlanStage: "finalize" },
      },
    ],
  };
}

function codexCliBugfixFlow(): HarnessFlowSpec {
  return {
    id: "codex-cli-bugfix",
    description: "Codex CLI flow should not assume Claude/OpenCode task tools and should allow one failing test followed by an edit and green verification.",
    profile: "codex-cli",
    flowType: "bugfix",
    expectedTools: ["read_file", "apply_patch", "bash"],
    forbiddenRules: ["dependency_install_replay", "identical_tool_repeat"],
    steps: [
      {
        id: "read-target",
        messages: [
          userText("Fix the failing math test."),
          assistantCall("x1", "read_file", { path: "src/math.ts" }),
          toolResult("x1", "export const add = (a:number,b:number)=>a-b;"),
        ],
      },
      {
        id: "edit-target",
        messages: [
          assistantCall("x2", "apply_patch", { file_path: "src/math.ts", patch: "-a-b\n+a+b" }),
          toolResult("x2", "Applied patch"),
        ],
      },
      {
        id: "verify",
        messages: [
          assistantCall("x3", "bash", { command: "npm test -- --runInBand" }),
          toolResult("x3", "PASS tests/math.test.ts"),
          assistantText("Fixed the bug and verified the targeted test."),
        ],
      },
    ],
  };
}

function piAuthAndChatFlow(): HarnessFlowSpec {
  return {
    id: "pi-auth-and-basic-chat",
    description: "Pi/OIDC-compatible client smoke should not inherit coding-harness task assumptions during basic authenticated chat.",
    profile: "pi",
    flowType: "auth-and-chat",
    steps: [
      {
        id: "authenticated-chat",
        messages: [
          userText("ping"),
          assistantText("pong"),
        ],
        expectedPhase: "edit",
      },
    ],
  };
}

function cursorBugfixFlow(): HarnessFlowSpec {
  return {
    id: "cursor-bugfix-no-native-task-tools",
    description: "Cursor-style OpenAI-compatible coding flow should allow normal read/edit/test progress without Claude/OpenCode native-task assumptions.",
    profile: "cursor",
    flowType: "bugfix",
    expectedTools: ["read_file", "edit", "bash"],
    forbiddenRules: ["task_creation_replay", "completion_claim_requires_task_update"],
    steps: [
      {
        id: "read",
        messages: [
          userText("Fix the failing unit test in the current workspace."),
          assistantCall("r1", "read_file", { path: "src/index.ts" }),
          toolResult("r1", "export function enabled() { return false; }\n"),
        ],
      },
      {
        id: "edit",
        messages: [
          assistantCall("r2", "edit", {
            file_path: "src/index.ts",
            old_string: "return false",
            new_string: "return true",
          }),
          toolResult("r2", "Applied edit"),
        ],
      },
      {
        id: "verify",
        messages: [
          assistantCall("r3", "bash", { command: "npm test -- --runInBand src/index.test.ts" }),
          toolResult("r3", "PASS src/index.test.ts"),
          assistantText("Fixed the failing test and verified it."),
        ],
      },
    ],
  };
}

function genericOpenAiFlow(): HarnessFlowSpec {
  return {
    id: "generic-openai-no-native-task-tools",
    description: "Generic OpenAI-compatible clients should not receive Claude/OpenCode-specific task or plan tool assumptions.",
    profile: "generic-openai",
    flowType: "bugfix",
    expectedTools: ["read_file", "str_replace", "bash"],
    steps: [
      {
        id: "read",
        messages: [
          userText("Fix the broken helper and verify it."),
          assistantCall("g1", "read_file", { path: "src/helper.py" }),
          toolResult("g1", "def ok():\n    return False\n"),
        ],
      },
      {
        id: "edit",
        messages: [
          assistantCall("g2", "str_replace", {
            file_path: "src/helper.py",
            old_string: "return False",
            new_string: "return True",
          }),
          toolResult("g2", "Applied edit"),
        ],
      },
      {
        id: "verify",
        messages: [
          assistantCall("g3", "bash", { command: "pytest tests/test_helper.py -q" }),
          toolResult("g3", "1 passed"),
          assistantText("The helper is fixed and the targeted test passes."),
        ],
      },
    ],
  };
}
