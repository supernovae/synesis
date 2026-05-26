import { describe, it, expect } from "vitest";
import {
  detectClientTaskCapabilities,
  normalizeTaskToolCall,
  isTaskToolCall,
  extractTasksFromText,
  bridgePlanTodoEntries,
  reconcileFromToolCall,
  reconcileFromText,
  reconcileFromEvidence,
  decayStaleTaskConfidence,
  createEmptyLedger,
  serializeTaskLedger,
  deserializeTaskLedger,
  buildTaskLedgerSummary,
  buildTaskLedgerNudge,
  buildTaskLedgerGovernanceBlock,
  scrubTaskLedgerOutput,
  evaluateTaskCompletionGate,
  incrementReconciliationAttempts,
  type HarnessTask,
  type TaskLedger,
  type ClientTaskCapabilities,
  type EvidenceSignal,
} from "../src/task-ledger/index.js";

function makeLedger(overrides?: Partial<TaskLedger>): TaskLedger {
  return {
    sessionId: "test-session",
    tasks: [],
    hasExplicitClientTodoTool: false,
    hasExplicitPlanMode: false,
    reconciliationAttempts: 0,
    ...overrides,
  };
}

function makeTask(overrides?: Partial<HarnessTask>): HarnessTask {
  return {
    id: "t1",
    title: "Implement API normalization",
    status: "pending",
    source: "opencode_todowrite",
    evidence: [],
    lastUpdatedTurn: 1,
    createdTurn: 1,
    confidence: 1.0,
    ...overrides,
  };
}

function makeCapabilities(overrides?: Partial<ClientTaskCapabilities>): ClientTaskCapabilities {
  return {
    hasExplicitTodoTool: false,
    hasExplicitPlanMode: false,
    todoToolName: null,
    detectedSource: "unknown",
    ...overrides,
  };
}

describe("task-ledger", () => {
  describe("detectClientTaskCapabilities", () => {
    it("detects OpenCode todowrite tool", () => {
      const caps = detectClientTaskCapabilities(
        [{ name: "todowrite" }, { name: "Read" }],
        "opencode",
      );
      expect(caps.hasExplicitTodoTool).toBe(true);
      expect(caps.todoToolName).toBe("todowrite");
      expect(caps.detectedSource).toBe("opencode_todowrite");
    });

    it("detects Claude TodoWrite tool", () => {
      const caps = detectClientTaskCapabilities(
        [{ name: "TodoWrite" }, { name: "Bash" }],
        "claude-code",
      );
      expect(caps.hasExplicitTodoTool).toBe(true);
      expect(caps.detectedSource).toBe("claude_todowrite");
    });

    it("detects Claude interactive task tools with camel-case names", () => {
      const caps = detectClientTaskCapabilities(
        [{ name: "TaskCreate" }, { name: "TaskUpdate" }, { name: "TaskGet" }],
        "claude-code",
      );
      expect(caps.hasExplicitTodoTool).toBe(true);
      expect(caps.todoToolName).toBe("TaskUpdate");
      expect(caps.detectedSource).toBe("claude_todowrite");
    });

    it("detects Claude plan mode tools", () => {
      const caps = detectClientTaskCapabilities(
        [{ name: "EnterPlanMode" }, { name: "ExitPlanMode" }],
        "claude-code",
      );
      expect(caps.hasExplicitTodoTool).toBe(false);
      expect(caps.hasExplicitPlanMode).toBe(true);
      expect(caps.detectedSource).toBe("claude_todowrite");
    });

    it("recognizes read-only task tools for capability detection without a write tool name", () => {
      const caps = detectClientTaskCapabilities(
        [{ name: "TodoRead" }, { name: "Bash" }],
        "claude-code",
      );
      expect(caps.hasExplicitTodoTool).toBe(false);
      expect(caps.hasExplicitPlanMode).toBe(true);
      expect(caps.todoToolName).toBeNull();
      expect(caps.detectedSource).toBe("claude_todowrite");
    });

    it("detects Cursor CreatePlan as plan mode", () => {
      const caps = detectClientTaskCapabilities(
        [{ name: "CreatePlan" }, { name: "SwitchMode" }],
        "cursor",
      );
      expect(caps.hasExplicitPlanMode).toBe(true);
      expect(caps.detectedSource).toBe("cursor_plan");
    });

    it("handles case-insensitive tool names", () => {
      const caps = detectClientTaskCapabilities(
        [{ name: "TODO_WRITE" }],
        "unknown",
      );
      expect(caps.hasExplicitTodoTool).toBe(true);
    });

    it("detects cline client kind without tools", () => {
      const caps = detectClientTaskCapabilities([], "cline-v3");
      expect(caps.hasExplicitTodoTool).toBe(false);
      expect(caps.detectedSource).toBe("cline_plan");
    });

    it("returns unknown for generic clients without todo tools", () => {
      const caps = detectClientTaskCapabilities(
        [{ name: "Read" }, { name: "Write" }],
        "generic",
      );
      expect(caps.hasExplicitTodoTool).toBe(false);
      expect(caps.hasExplicitPlanMode).toBe(false);
      expect(caps.detectedSource).toBe("unknown");
    });

    it("handles null/undefined tools gracefully", () => {
      const caps = detectClientTaskCapabilities(null, "generic");
      expect(caps.hasExplicitTodoTool).toBe(false);
    });

    it("supports function-style tool definitions", () => {
      const caps = detectClientTaskCapabilities(
        [{ function: { name: "todowrite" } }],
        "opencode",
      );
      expect(caps.hasExplicitTodoTool).toBe(true);
    });
  });

  describe("normalizeTaskToolCall", () => {
    it("normalizes OpenCode todowrite with multiple todos", () => {
      const caps = makeCapabilities({
        hasExplicitTodoTool: true,
        detectedSource: "opencode_todowrite",
      });
      const tasks = normalizeTaskToolCall(
        {
          toolName: "todowrite",
          args: {
            todos: [
              { id: "a", content: "Implement auth", status: "pending" },
              { id: "b", content: "Add tests", status: "in_progress" },
              { id: "c", content: "Deploy", status: "completed" },
            ],
          },
          turn: 5,
        },
        caps,
      );
      expect(tasks).toHaveLength(3);
      expect(tasks[0].title).toBe("Implement auth");
      expect(tasks[0].status).toBe("pending");
      expect(tasks[0].source).toBe("opencode_todowrite");
      expect(tasks[1].status).toBe("in_progress");
      expect(tasks[2].status).toBe("completed");
    });

    it("normalizes Claude TodoWrite", () => {
      const caps = makeCapabilities({
        hasExplicitTodoTool: true,
        detectedSource: "claude_todowrite",
      });
      const tasks = normalizeTaskToolCall(
        {
          toolName: "TodoWrite",
          args: {
            todos: [
              { id: "x", content: "Fix bug", status: "done" },
            ],
          },
          turn: 3,
        },
        caps,
      );
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe("completed");
      expect(tasks[0].source).toBe("claude_todowrite");
    });

    it("normalizes generic task_update", () => {
      const caps = makeCapabilities({ detectedSource: "unknown" });
      const tasks = normalizeTaskToolCall(
        {
          toolName: "task_update",
          args: { id: "t1", title: "Fix thing", status: "blocked" },
          turn: 2,
        },
        caps,
      );
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe("blocked");
    });

    it("normalizes Claude TaskCreate and TaskUpdate argument shapes", () => {
      const caps = makeCapabilities({
        hasExplicitTodoTool: true,
        detectedSource: "claude_todowrite",
      });
      const created = normalizeTaskToolCall(
        {
          toolName: "TaskCreate",
          args: { id: "c1", description: "Wire Claude task events", status: "in progress", activeForm: "wiring events" },
          turn: 4,
        },
        caps,
      );
      const updated = normalizeTaskToolCall(
        {
          toolName: "task_update",
          args: { id: "c1", content: "Wire Claude task events", obsolete: true },
          turn: 5,
        },
        caps,
      );
      expect(created).toHaveLength(1);
      expect(created[0].title).toBe("Wire Claude task events");
      expect(created[0].status).toBe("in_progress");
      expect(created[0].source).toBe("claude_todowrite");
      expect(created[0].evidence).toContain("activeForm: wiring events");
      expect(updated[0].status).toBe("obsolete");
    });

    it("normalizes Claude TaskUpdate status-only updates by client task id", () => {
      const caps = makeCapabilities({
        hasExplicitTodoTool: true,
        detectedSource: "claude_todowrite",
      });
      const tasks = normalizeTaskToolCall(
        {
          toolName: "TaskUpdate",
          args: { task_id: "c1", status: "completed" },
          turn: 6,
        },
        caps,
      );
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("c1");
      expect(tasks[0].clientTaskId).toBe("c1");
      expect(tasks[0].title).toBe("Task c1");
      expect(tasks[0].status).toBe("completed");
    });

    it("extracts Claude ExitPlanMode checklist tasks", () => {
      const caps = makeCapabilities({
        hasExplicitPlanMode: true,
        detectedSource: "claude_todowrite",
      });
      const tasks = normalizeTaskToolCall(
        {
          toolName: "ExitPlanMode",
          args: {
            plan: [
              "- [ ] Add Claude Code capability detection",
              "- [ ] Normalize task updates",
              "- [ ] Verify focused tests",
            ].join("\n"),
          },
          turn: 7,
        },
        caps,
      );
      expect(tasks).toHaveLength(3);
      expect(tasks[0].source).toBe("claude_todowrite");
      expect(tasks[0].title).toBe("Add Claude Code capability detection");
    });

    it("skips empty title", () => {
      const caps = makeCapabilities({ detectedSource: "unknown" });
      const tasks = normalizeTaskToolCall(
        {
          toolName: "todowrite",
          args: { todos: [{ id: "x", content: "", status: "pending" }] },
          turn: 1,
        },
        caps,
      );
      expect(tasks).toHaveLength(0);
    });

    it("isTaskToolCall identifies task tools", () => {
      expect(isTaskToolCall("todowrite")).toBe(true);
      expect(isTaskToolCall("TodoWrite")).toBe(true);
      expect(isTaskToolCall("TODO_WRITE")).toBe(true);
      expect(isTaskToolCall("task_update")).toBe(true);
      expect(isTaskToolCall("TaskUpdate")).toBe(true);
      expect(isTaskToolCall("TaskList")).toBe(true);
      expect(isTaskToolCall("plan_update")).toBe(true);
      expect(isTaskToolCall("Read")).toBe(false);
      expect(isTaskToolCall("Bash")).toBe(false);
    });
  });

  describe("extractTasksFromText", () => {
    it("extracts markdown checklist tasks", () => {
      const text = [
        "Here's my plan:",
        "- [ ] Implement the API layer",
        "- [x] Set up the database schema",
        "- [ ] Write integration tests",
        "- [ ] Deploy to staging",
      ].join("\n");
      const tasks = extractTasksFromText(text, "unknown", 5);
      expect(tasks).toHaveLength(4);
      expect(tasks[0].title).toBe("Implement the API layer");
      expect(tasks[0].status).toBe("pending");
      expect(tasks[1].title).toBe("Set up the database schema");
      expect(tasks[1].status).toBe("completed");
      expect(tasks[0].source).toBe("markdown_task_list");
    });

    it("extracts numbered plan with actionable verbs", () => {
      const text = [
        "Implementation plan:",
        "1. Create the auth middleware",
        "2. Add token validation logic",
        "3. Write unit tests for auth flow",
        "4. Configure rate limiting",
      ].join("\n");
      const tasks = extractTasksFromText(text, "unknown", 3);
      expect(tasks.length).toBeGreaterThanOrEqual(2);
      expect(tasks[0].source).toBe("model_plan_text");
      expect(tasks[0].confidence).toBe(0.7);
    });

    it("ignores vague numbered lists without actionable verbs", () => {
      const text = [
        "Key considerations:",
        "1. The system needs good performance",
        "2. Security is important here",
        "3. Users expect fast response times",
      ].join("\n");
      const tasks = extractTasksFromText(text, "unknown", 1);
      expect(tasks).toHaveLength(0);
    });

    it("ignores short text", () => {
      expect(extractTasksFromText("Hi", "unknown", 1)).toHaveLength(0);
    });

    it("requires at least 2 checklist items", () => {
      const text = "- [ ] Only one item here for the plan";
      expect(extractTasksFromText(text, "unknown", 1)).toHaveLength(0);
    });

    it("bridges PlanTodoEntry into HarnessTask", () => {
      const entries = [
        { id: "p1", content: "Implement feature X", status: "completed" as const },
        { id: "p2", content: "Add tests for X", status: "pending" as const },
      ];
      const tasks = bridgePlanTodoEntries(entries, 4);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe("plantodo_p1");
      expect(tasks[0].status).toBe("completed");
      expect(tasks[0].source).toBe("cursor_plan");
      expect(tasks[1].status).toBe("pending");
    });
  });

  describe("reconcileTaskLedger", () => {
    it("adds new tasks from tool calls", () => {
      const ledger = makeLedger();
      const tasks = [makeTask({ id: "a", title: "Task A" }), makeTask({ id: "b", title: "Task B" })];
      const result = reconcileFromToolCall(ledger, tasks, 2);
      expect(result.tasks).toHaveLength(2);
      expect(result.lastReconciledTurn).toBe(2);
    });

    it("updates existing task status from tool calls", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ id: "a", title: "Task A", status: "pending" })],
      });
      const updated = [makeTask({ id: "a", title: "Task A", status: "completed", evidence: ["tests passed"] })];
      const result = reconcileFromToolCall(ledger, updated, 5);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].status).toBe("completed");
      expect(result.tasks[0].evidence).toContain("tests passed");
      expect(result.tasks[0].lastUpdatedTurn).toBe(5);
    });

    it("does not regress terminal tool tasks when a model replays an all-pending todo list", () => {
      const completedTasks = [
        makeTask({ id: "todo_1", title: "Create project structure", status: "completed", confidence: 1.0 }),
        makeTask({ id: "todo_2", title: "Implement SQLite storage layer", status: "completed", confidence: 1.0 }),
        makeTask({ id: "todo_3", title: "Run tests", status: "completed", confidence: 1.0 }),
      ];
      const ledger = makeLedger({ tasks: completedTasks });
      const replayedPending = completedTasks.map((task) => ({
        ...task,
        status: "pending" as const,
        evidence: [],
      }));

      const result = reconcileFromToolCall(ledger, replayedPending, 12);

      expect(result.tasks.map((task) => task.status)).toEqual(["completed", "completed", "completed"]);
      expect(result.tasks[1].evidence).toContain("task_ledger_regression_suppressed: terminal status preserved");
      expect(result.tasks[1].lastUpdatedTurn).toBe(12);
    });

    it("allows terminal tool tasks to move to another terminal status", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ id: "a", title: "Task A", status: "completed" })],
      });
      const incoming = [makeTask({ id: "a", title: "Task A", status: "obsolete" })];
      const result = reconcileFromToolCall(ledger, incoming, 6);
      expect(result.tasks[0].status).toBe("obsolete");
    });

    it("text reconciliation does not overwrite terminal status", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ id: "a", status: "completed", confidence: 1.0 })],
      });
      const textTasks = [makeTask({ id: "a", status: "pending", confidence: 0.7 })];
      const result = reconcileFromText(ledger, textTasks, 10);
      expect(result.tasks[0].status).toBe("completed");
    });

    it("text reconciliation does not overwrite higher-confidence tasks", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ id: "a", status: "in_progress", confidence: 1.0 })],
      });
      const textTasks = [makeTask({ id: "a", status: "pending", confidence: 0.7 })];
      const result = reconcileFromText(ledger, textTasks, 10);
      expect(result.tasks[0].status).toBe("in_progress");
    });

    it("matches tasks by title prefix when IDs differ", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ id: "old_id", title: "Implement the authentication middleware layer" })],
      });
      const incoming = [makeTask({ id: "new_id", title: "Implement the authentication middleware layer", status: "completed" })];
      const result = reconcileFromToolCall(ledger, incoming, 5);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].status).toBe("completed");
    });
  });

  describe("reconcileFromEvidence", () => {
    it("bumps confidence on matching file edit evidence", () => {
      const ledger = makeLedger({
        tasks: [makeTask({
          id: "auth",
          title: "Implement authentication middleware",
          status: "in_progress",
          confidence: 0.5,
        })],
      });
      const signals: EvidenceSignal[] = [
        { kind: "file_edit", detail: "edited src/authentication/middleware.ts", turn: 5 },
      ];
      const result = reconcileFromEvidence(ledger, signals);
      expect(result.tasks[0].confidence).toBeGreaterThan(0.5);
      expect(result.tasks[0].evidence).toHaveLength(1);
    });

    it("bumps confidence on test pass evidence", () => {
      const ledger = makeLedger({
        tasks: [makeTask({
          id: "tests",
          title: "Write unit tests for auth module",
          status: "in_progress",
          confidence: 0.5,
        })],
      });
      const signals: EvidenceSignal[] = [
        { kind: "test_pass", detail: "auth tests passed: 12 tests, 0 failures", turn: 8 },
      ];
      const result = reconcileFromEvidence(ledger, signals);
      expect(result.tasks[0].confidence).toBeGreaterThan(0.5);
    });

    it("does not bump confidence without keyword overlap", () => {
      const ledger = makeLedger({
        tasks: [makeTask({
          id: "deploy",
          title: "Deploy to staging environment",
          confidence: 0.5,
        })],
      });
      const signals: EvidenceSignal[] = [
        { kind: "file_edit", detail: "edited src/auth.ts", turn: 5 },
      ];
      const result = reconcileFromEvidence(ledger, signals);
      expect(result.tasks[0].confidence).toBe(0.5);
    });

    it("skips reconciliation when ledger is empty", () => {
      const ledger = makeLedger();
      const result = reconcileFromEvidence(ledger, [{ kind: "file_edit", detail: "foo", turn: 1 }]);
      expect(result).toBe(ledger);
    });

    it("auto-promotes task to completed when confidence >= 0.85 and evidence >= 2", () => {
      const ledger = makeLedger({
        tasks: [makeTask({
          id: "hugo",
          title: "Install Hugo extended version for site",
          status: "in_progress",
          confidence: 0.75,
          evidence: ["command_success: hugo version v0.139.0+extended"],
        })],
      });
      const signals: EvidenceSignal[] = [
        { kind: "command_success", detail: "hugo new site mysite — created", turn: 6 },
      ];
      const result = reconcileFromEvidence(ledger, signals);
      expect(result.tasks[0].confidence).toBeGreaterThanOrEqual(0.85);
      expect(result.tasks[0].status).toBe("completed");
      expect(result.tasks[0].evidence).toHaveLength(2);
    });

    it("does not auto-promote when confidence is high but evidence count is below threshold", () => {
      const ledger = makeLedger({
        tasks: [makeTask({
          id: "theme",
          title: "Choose and install a modern lightweight theme",
          status: "pending",
          confidence: 0.8,
          evidence: [],
        })],
      });
      const signals: EvidenceSignal[] = [
        { kind: "file_edit", detail: "edited config for theme installation", turn: 4 },
      ];
      const result = reconcileFromEvidence(ledger, signals);
      expect(result.tasks[0].confidence).toBe(0.9);
      expect(result.tasks[0].evidence).toHaveLength(1);
      expect(result.tasks[0].status).toBe("pending");
    });

    it("does not auto-promote already-terminal tasks", () => {
      const ledger = makeLedger({
        tasks: [makeTask({
          id: "done",
          title: "Deploy the application to staging",
          status: "obsolete",
          confidence: 0.5,
          evidence: ["command_success: deploy skipped"],
        })],
      });
      const signals: EvidenceSignal[] = [
        { kind: "command_success", detail: "staging deploy completed", turn: 10 },
      ];
      const result = reconcileFromEvidence(ledger, signals);
      expect(result.tasks[0].status).toBe("obsolete");
    });

    it("auto-promotes pending task that crosses both thresholds in a single reconcile", () => {
      const ledger = makeLedger({
        tasks: [makeTask({
          id: "config",
          title: "Configure hugo.toml with site metadata",
          status: "pending",
          confidence: 0.5,
          evidence: [],
        })],
      });
      const signals: EvidenceSignal[] = [
        { kind: "file_edit", detail: "edited hugo.toml with site metadata config", turn: 3 },
        { kind: "command_success", detail: "hugo build succeeded for site with metadata", turn: 4 },
        { kind: "test_pass", detail: "hugo server started ok — site metadata renders correctly", turn: 5 },
      ];
      const result = reconcileFromEvidence(ledger, signals);
      expect(result.tasks[0].confidence).toBeGreaterThanOrEqual(0.85);
      expect(result.tasks[0].evidence.length).toBeGreaterThanOrEqual(2);
      expect(result.tasks[0].status).toBe("completed");
    });
  });

  describe("decayStaleTaskConfidence", () => {
    it("decays confidence for stale non-terminal tasks", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ status: "pending", confidence: 0.8, lastUpdatedTurn: 1 })],
      });
      const result = decayStaleTaskConfidence(ledger, 20, 10);
      expect(result.tasks[0].confidence).toBeLessThan(0.8);
    });

    it("does not decay completed tasks", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ status: "completed", confidence: 1.0, lastUpdatedTurn: 1 })],
      });
      const result = decayStaleTaskConfidence(ledger, 20, 10);
      expect(result.tasks[0].confidence).toBe(1.0);
    });

    it("does not decay recently updated tasks", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ status: "pending", confidence: 0.8, lastUpdatedTurn: 18 })],
      });
      const result = decayStaleTaskConfidence(ledger, 20, 10);
      expect(result.tasks[0].confidence).toBe(0.8);
    });
  });

  describe("completionGate", () => {
    it("allows when no ledger exists", () => {
      const result = evaluateTaskCompletionGate(null, null);
      expect(result.allow).toBe(true);
      expect(result.severity).toBe("none");
    });

    it("allows when ledger has no tasks", () => {
      const ledger = makeLedger();
      const result = evaluateTaskCompletionGate(ledger, null);
      expect(result.allow).toBe(true);
    });

    it("allows when all tasks are completed", () => {
      const ledger = makeLedger({
        tasks: [
          makeTask({ status: "completed" }),
          makeTask({ id: "t2", status: "obsolete" }),
          makeTask({ id: "t3", status: "blocked" }),
        ],
      });
      const result = evaluateTaskCompletionGate(ledger, null);
      expect(result.allow).toBe(true);
    });

    it("blocks when open tasks remain and attempts < 2", () => {
      const ledger = makeLedger({
        tasks: [
          makeTask({ status: "completed" }),
          makeTask({ id: "t2", status: "pending" }),
          makeTask({ id: "t3", status: "in_progress" }),
        ],
        reconciliationAttempts: 0,
      });
      const result = evaluateTaskCompletionGate(ledger, makeCapabilities());
      expect(result.allow).toBe(false);
      expect(result.severity).toBe("soft");
      expect(result.reason).toContain("2 task(s) remain open");
      expect(result.nudge).toBeTruthy();
    });

    it("allows after max reconciliation attempts (escape hatch)", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ status: "pending" })],
        reconciliationAttempts: 2,
      });
      const result = evaluateTaskCompletionGate(ledger, null);
      expect(result.allow).toBe(true);
    });

    it("incrementReconciliationAttempts advances counter", () => {
      const ledger = makeLedger({ reconciliationAttempts: 0 });
      const updated = incrementReconciliationAttempts(ledger);
      expect(updated.reconciliationAttempts).toBe(1);
      expect(updated).not.toBe(ledger);
    });
  });

  describe("OpenCode todowrite scenario: 10 tasks, 1 checked, gate blocks", () => {
    it("gates correctly through the full lifecycle", () => {
      const caps = makeCapabilities({
        hasExplicitTodoTool: true,
        todoToolName: "todowrite",
        detectedSource: "opencode_todowrite",
      });

      const todos = Array.from({ length: 10 }, (_, i) => ({
        id: `task_${i}`,
        content: `Implement feature ${i}`,
        status: "pending",
      }));

      const normalized = normalizeTaskToolCall(
        { toolName: "todowrite", args: { todos }, turn: 1 },
        caps,
      );
      expect(normalized).toHaveLength(10);

      let ledger = createEmptyLedger("session-1", true, false);
      ledger = reconcileFromToolCall(ledger, normalized, 1);
      expect(ledger.tasks).toHaveLength(10);

      const oneCompleted = normalizeTaskToolCall(
        {
          toolName: "todowrite",
          args: { todos: [{ id: "task_0", content: "Implement feature 0", status: "completed" }] },
          turn: 5,
        },
        caps,
      );
      ledger = reconcileFromToolCall(ledger, oneCompleted, 5);

      const gate1 = evaluateTaskCompletionGate(ledger, caps);
      expect(gate1.allow).toBe(false);
      expect(gate1.nudge).toContain("todowrite");

      ledger = incrementReconciliationAttempts(ledger);

      const allDone = Array.from({ length: 10 }, (_, i) => ({
        id: `task_${i}`,
        content: `Implement feature ${i}`,
        status: i < 7 ? "completed" : "obsolete",
      }));
      const allNormalized = normalizeTaskToolCall(
        { toolName: "todowrite", args: { todos: allDone }, turn: 6 },
        caps,
      );
      ledger = reconcileFromToolCall(ledger, allNormalized, 6);

      const gate2 = evaluateTaskCompletionGate(ledger, caps);
      expect(gate2.allow).toBe(true);
    });
  });

  describe("Claude TodoWrite normalization", () => {
    it("maps Claude TodoWrite into TaskLedger", () => {
      const caps = makeCapabilities({
        hasExplicitTodoTool: true,
        todoToolName: "TodoWrite",
        detectedSource: "claude_todowrite",
      });

      const tasks = normalizeTaskToolCall(
        {
          toolName: "TodoWrite",
          args: {
            todos: [
              { id: "ct1", content: "Refactor auth module", status: "in_progress" },
              { id: "ct2", content: "Update API docs", status: "pending" },
            ],
          },
          turn: 2,
        },
        caps,
      );

      let ledger = createEmptyLedger("claude-session", true, false);
      ledger = reconcileFromToolCall(ledger, tasks, 2);

      expect(ledger.tasks).toHaveLength(2);
      expect(ledger.tasks[0].source).toBe("claude_todowrite");
      expect(ledger.tasks[0].status).toBe("in_progress");
      expect(ledger.tasks[1].status).toBe("pending");
    });
  });

  describe("Cline-style markdown plan", () => {
    it("extracts checklist and recognizes completed items", () => {
      const text = [
        "## Implementation Plan",
        "",
        "- [x] Set up project structure",
        "- [x] Implement data model",
        "- [ ] Add REST endpoints",
        "- [ ] Write tests",
        "- [ ] Update documentation",
      ].join("\n");

      const tasks = extractTasksFromText(text, "cline_plan", 3);
      expect(tasks).toHaveLength(5);
      expect(tasks.filter((t) => t.status === "completed")).toHaveLength(2);
      expect(tasks.filter((t) => t.status === "pending")).toHaveLength(3);

      let ledger = createEmptyLedger("cline-session", false, false);
      ledger = reconcileFromText(ledger, tasks, 3);

      const gate = evaluateTaskCompletionGate(ledger, makeCapabilities({ detectedSource: "cline_plan" }));
      expect(gate.allow).toBe(false);
      expect(gate.reason).toContain("3 task(s) remain open");
    });
  });

  describe("generic numbered plan", () => {
    it("only actionable implementation steps become tasks", () => {
      const text = [
        "Here's what I'll do:",
        "1. Create the middleware handler for rate limiting",
        "2. Add configuration options for throttle thresholds",
        "3. Write unit tests for the new middleware",
        "Note: This follows the existing patterns in the codebase.",
      ].join("\n");

      const tasks = extractTasksFromText(text, "unknown", 1);
      expect(tasks.length).toBeGreaterThanOrEqual(2);
      for (const t of tasks) {
        expect(t.source).toBe("model_plan_text");
      }
    });

    it("vague commentary does not create tasks", () => {
      const text = [
        "Thoughts on the architecture:",
        "1. The system should be performant",
        "2. We need good error handling",
        "3. Documentation is important",
      ].join("\n");

      const tasks = extractTasksFromText(text, "unknown", 1);
      expect(tasks).toHaveLength(0);
    });
  });

  describe("bad todo case: obsolete task", () => {
    it("model can mark irrelevant tasks obsolete", () => {
      const caps = makeCapabilities({
        hasExplicitTodoTool: true,
        detectedSource: "opencode_todowrite",
      });

      let ledger = createEmptyLedger("s1", true, false);
      const initial = normalizeTaskToolCall(
        {
          toolName: "todowrite",
          args: {
            todos: [
              { id: "old", content: "Migrate to deprecated API", status: "pending" },
              { id: "real", content: "Fix actual bug", status: "pending" },
            ],
          },
          turn: 1,
        },
        caps,
      );
      ledger = reconcileFromToolCall(ledger, initial, 1);

      const obsoleteUpdate = normalizeTaskToolCall(
        {
          toolName: "todowrite",
          args: {
            todos: [
              { id: "old", content: "Migrate to deprecated API", status: "cancelled" },
              { id: "real", content: "Fix actual bug", status: "completed" },
            ],
          },
          turn: 5,
        },
        caps,
      );
      ledger = reconcileFromToolCall(ledger, obsoleteUpdate, 5);

      expect(ledger.tasks[0].status).toBe("obsolete");
      expect(ledger.tasks[1].status).toBe("completed");

      const gate = evaluateTaskCompletionGate(ledger, caps);
      expect(gate.allow).toBe(true);
    });
  });

  describe("no explicit todo tool", () => {
    it("allows final response when no task ledger exists", () => {
      const gate = evaluateTaskCompletionGate(null, makeCapabilities());
      expect(gate.allow).toBe(true);
    });

    it("no nudges for simple one-shot questions", () => {
      const block = buildTaskLedgerGovernanceBlock(null, null);
      expect(block).toBe("");
    });

    it("empty ledger produces no governance block", () => {
      const ledger = makeLedger();
      const block = buildTaskLedgerGovernanceBlock(ledger, makeCapabilities());
      expect(block).toBe("");
    });
  });

  describe("nudge builder", () => {
    it("mentions todo tool name when client has one", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ status: "pending" })],
      });
      const caps = makeCapabilities({
        hasExplicitTodoTool: true,
        todoToolName: "todowrite",
      });
      const nudge = buildTaskLedgerNudge(ledger, caps);
      expect(nudge).toContain("todowrite");
      expect(nudge).toContain("task ledger");
      expect(nudge).toContain("as each component finishes");
    });

    it("asks for checklist summary when no todo tool", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ status: "pending" })],
      });
      const caps = makeCapabilities();
      const nudge = buildTaskLedgerNudge(ledger, caps);
      expect(nudge).toContain("reconciled task summary");
    });

    it("does not tell Cursor sessions to call todowrite without an explicit todo tool", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ status: "pending", source: "cursor_plan" })],
      });
      const caps = makeCapabilities({ detectedSource: "cursor_plan" });
      const nudge = buildTaskLedgerNudge(ledger, caps);
      expect(nudge).not.toContain("todowrite");
      expect(nudge).not.toContain("TodoWrite");
    });

    it("returns empty when no open tasks", () => {
      const ledger = makeLedger({
        tasks: [makeTask({ status: "completed" })],
      });
      const nudge = buildTaskLedgerNudge(ledger, makeCapabilities());
      expect(nudge).toBe("");
    });
  });

  describe("summary builder", () => {
    it("formats a compact summary", () => {
      const ledger = makeLedger({
        tasks: [
          makeTask({ title: "Implement API", status: "completed", evidence: ["edited models.ts"] }),
          makeTask({ id: "t2", title: "Add tests", status: "pending" }),
        ],
      });
      const summary = buildTaskLedgerSummary(ledger);
      expect(summary).toContain("synesis_task_ledger");
      expect(summary).toContain("[completed]");
      expect(summary).toContain("[pending]");
      expect(summary).toContain("Implement API");
    });
  });

  describe("output scrubber", () => {
    it("removes leaked ledger blocks and reconciliation instructions while preserving natural text", () => {
      const leaked = [
        "Would you like me to implement a fix?",
        "<synesis_task_ledger>",
        "Current task ledger:",
        "- [pending] Patch finalizer - no evidence yet",
        "</synesis_task_ledger>",
        "Before final response, reconcile the task ledger. 1 task(s) remain open. Do not claim all work is complete while open tasks remain.",
      ].join("\n");
      const scrubbed = scrubTaskLedgerOutput(leaked);
      expect(scrubbed.scrubbed).toBe(true);
      expect(scrubbed.text).toBe("Would you like me to implement a fix?");
      expect(scrubbed.text).not.toContain("synesis_task_ledger");
      expect(scrubbed.text).not.toContain("Before final response");
    });
  });

  describe("serialization", () => {
    it("round-trips through serialize/deserialize", () => {
      const ledger = makeLedger({
        tasks: [
          makeTask({ id: "a", status: "completed", evidence: ["tests passed"], confidence: 0.95 }),
          makeTask({ id: "b", title: "Task B", status: "pending" }),
        ],
        lastReconciledTurn: 5,
        reconciliationAttempts: 1,
        hasExplicitClientTodoTool: true,
      });

      const serialized = serializeTaskLedger(ledger);
      const deserialized = deserializeTaskLedger(serialized);

      expect(deserialized).not.toBeNull();
      expect(deserialized!.sessionId).toBe("test-session");
      expect(deserialized!.tasks).toHaveLength(2);
      expect(deserialized!.tasks[0].status).toBe("completed");
      expect(deserialized!.tasks[0].evidence).toContain("tests passed");
      expect(deserialized!.tasks[0].confidence).toBe(0.95);
      expect(deserialized!.lastReconciledTurn).toBe(5);
      expect(deserialized!.reconciliationAttempts).toBe(1);
      expect(deserialized!.hasExplicitClientTodoTool).toBe(true);
    });

    it("returns null for invalid data", () => {
      expect(deserializeTaskLedger(null)).toBeNull();
      expect(deserializeTaskLedger({})).toBeNull();
      expect(deserializeTaskLedger("string")).toBeNull();
    });
  });

  describe("OpenCode Hugo scenario: evidence auto-promotes forgotten tasks", () => {
    it("tasks auto-complete from evidence even when model never calls todowrite again", () => {
      const caps = makeCapabilities({
        hasExplicitTodoTool: true,
        todoToolName: "todowrite",
        detectedSource: "opencode_todowrite",
      });

      const initial = normalizeTaskToolCall(
        {
          toolName: "todowrite",
          args: {
            todos: [
              { id: "install", content: "Install Hugo extended version", status: "in_progress" },
              { id: "site", content: "Create new Hugo site structure", status: "pending" },
              { id: "theme", content: "Choose and install a modern theme", status: "pending" },
              { id: "config", content: "Configure hugo.toml with metadata", status: "pending" },
              { id: "content", content: "Create single-page homepage content", status: "pending" },
              { id: "links", content: "Add GitHub repo links to homepage", status: "pending" },
              { id: "build", content: "Test build and verify compatibility", status: "pending" },
            ],
          },
          turn: 1,
        },
        caps,
      );

      let ledger = createEmptyLedger("hugo-session", true, false);
      ledger = reconcileFromToolCall(ledger, initial, 1);
      expect(ledger.tasks).toHaveLength(7);

      const gate0 = evaluateTaskCompletionGate(ledger, caps);
      expect(gate0.allow).toBe(false);

      ledger = reconcileFromEvidence(ledger, [
        { kind: "command_success", detail: "hugo version v0.139.0+extended installed", turn: 2 },
        { kind: "command_success", detail: "brew install hugo — install completed", turn: 2 },
      ]);
      expect(ledger.tasks[0].status).toBe("completed");

      ledger = reconcileFromEvidence(ledger, [
        { kind: "command_success", detail: "hugo new site mysite — site structure created", turn: 3 },
        { kind: "file_edit", detail: "created hugo site directory structure", turn: 3 },
      ]);
      expect(ledger.tasks[1].status).toBe("completed");

      ledger = reconcileFromEvidence(ledger, [
        { kind: "command_success", detail: "git submodule add modern PaperMod theme", turn: 4 },
        { kind: "file_edit", detail: "added theme config for modern PaperMod theme", turn: 4 },
      ]);
      expect(ledger.tasks[2].status).toBe("completed");

      ledger = reconcileFromEvidence(ledger, [
        { kind: "file_edit", detail: "edited hugo.toml with site metadata and params", turn: 5 },
        { kind: "file_edit", detail: "configured hugo.toml baseURL and metadata fields", turn: 5 },
      ]);
      expect(ledger.tasks[3].status).toBe("completed");

      ledger = reconcileFromEvidence(ledger, [
        { kind: "file_edit", detail: "created content/_index.md homepage content", turn: 6 },
        { kind: "file_edit", detail: "wrote single-page homepage layout content", turn: 6 },
      ]);
      expect(ledger.tasks[4].status).toBe("completed");

      ledger = reconcileFromEvidence(ledger, [
        { kind: "file_edit", detail: "added GitHub repo links to homepage layout", turn: 7 },
        { kind: "file_edit", detail: "configured links section with GitHub repos", turn: 7 },
      ]);
      expect(ledger.tasks[5].status).toBe("completed");

      ledger = reconcileFromEvidence(ledger, [
        { kind: "command_success", detail: "hugo build succeeded — verify output", turn: 8 },
        { kind: "test_pass", detail: "hugo server ok — verified build compatibility", turn: 8 },
      ]);
      expect(ledger.tasks[6].status).toBe("completed");

      const gateFinal = evaluateTaskCompletionGate(ledger, caps);
      expect(gateFinal.allow).toBe(true);
      expect(gateFinal.severity).toBe("none");
    });
  });
});
