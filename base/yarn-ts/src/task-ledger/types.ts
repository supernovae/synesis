export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "obsolete"
  | "unknown";

export type TaskSource =
  | "opencode_todowrite"
  | "claude_todowrite"
  | "cline_plan"
  | "cursor_plan"
  | "markdown_task_list"
  | "model_plan_text"
  | "harness_inferred"
  | "unknown";

export interface HarnessTask {
  id: string;
  title: string;
  status: TaskStatus;
  source: TaskSource;
  clientTaskId?: string;
  evidence: string[];
  lastUpdatedTurn: number;
  createdTurn: number;
  confidence: number;
}

export interface TaskLedger {
  sessionId: string;
  tasks: HarnessTask[];
  lastReconciledTurn?: number;
  hasExplicitClientTodoTool: boolean;
  hasExplicitPlanMode: boolean;
  reconciliationAttempts: number;
}

export interface ClientTaskCapabilities {
  hasExplicitTodoTool: boolean;
  hasExplicitPlanMode: boolean;
  todoToolName: string | null;
  detectedSource: TaskSource;
}

export interface TaskCompletionGateResult {
  allow: boolean;
  severity: "none" | "soft";
  reason?: string;
  nudge?: string;
}

export interface EvidenceSignal {
  kind: "file_edit" | "test_pass" | "test_fail" | "build_pass" | "build_fail" | "lint_pass" | "lint_fail" | "command_success";
  detail: string;
  turn: number;
}
