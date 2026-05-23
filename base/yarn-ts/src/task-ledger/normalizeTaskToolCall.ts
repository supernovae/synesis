import type { ClientTaskCapabilities, HarnessTask, TaskSource, TaskStatus } from "./types.js";
import { extractTasksFromText } from "./extractTasksFromText.js";

interface ToolCallInput {
  toolName: string;
  args: Record<string, unknown>;
  turn: number;
}

const STATUS_MAP: Record<string, TaskStatus> = {
  pending: "pending",
  in_progress: "in_progress",
  inprogress: "in_progress",
  "in progress": "in_progress",
  completed: "completed",
  complete: "completed",
  done: "completed",
  blocked: "blocked",
  obsolete: "obsolete",
  cancelled: "obsolete",
  canceled: "obsolete",
  deleted: "obsolete",
  delete: "obsolete",
  removed: "obsolete",
  unknown: "unknown",
};

function normalizeStatus(raw: unknown): TaskStatus {
  if (typeof raw !== "string") return "unknown";
  return STATUS_MAP[raw.trim().toLowerCase()] ?? "unknown";
}

function normalize(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/-/g, "_");
}

function resolveSourceForTool(normalizedName: string, capabilities: ClientTaskCapabilities): TaskSource {
  if (capabilities.detectedSource !== "unknown") {
    return capabilities.detectedSource;
  }
  if (normalizedName.includes("todowrite") || normalizedName.includes("todo_write")) {
    return "opencode_todowrite";
  }
  if (normalizedName.includes("task_create") || normalizedName.includes("task_update")) {
    return "claude_todowrite";
  }
  return "unknown";
}

const TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "todowrite", "todo_write", "update_todo",
  "task_update", "taskcreate", "task_create",
  "taskdelete", "task_delete",
  "plan_update", "createplan", "create_plan",
  "enterplanmode", "enter_plan_mode", "exitplanmode", "exit_plan_mode",
]);

const READ_ONLY_TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "todoread", "todo_read", "tasklist", "task_list", "taskget", "task_get",
]);

export function isTaskToolCall(toolName: string): boolean {
  const n = normalize(toolName);
  return TASK_TOOL_NAMES.has(n) || READ_ONLY_TASK_TOOL_NAMES.has(n);
}

/**
 * Normalize a todo/task tool call into HarnessTask[].
 * Handles OpenCode todowrite, Claude TodoWrite, Cursor TodoWrite,
 * and generic task_update/update_todo shapes.
 */
export function normalizeTaskToolCall(
  input: ToolCallInput,
  capabilities: ClientTaskCapabilities,
): HarnessTask[] {
  const n = normalize(input.toolName);
  const source = resolveSourceForTool(n, capabilities);

  if (n === "todowrite" || n === "todo_write") {
    return normalizeTodoWriteCall(input, source);
  }
  if (n === "task_update" || n === "update_todo" || n === "taskcreate" || n === "task_create" || n === "taskdelete" || n === "task_delete") {
    return normalizeGenericTaskCall(input, source);
  }
  if (n === "plan_update" || n === "createplan" || n === "create_plan" || n === "exitplanmode" || n === "exit_plan_mode") {
    return normalizePlanUpdateCall(input, source);
  }
  return [];
}

/**
 * OpenCode / Claude / Cursor TodoWrite shape:
 * { todos: [{ id, content, status, priority? }], merge?: boolean }
 */
function normalizeTodoWriteCall(input: ToolCallInput, source: TaskSource): HarnessTask[] {
  const todos = Array.isArray(input.args.todos) ? input.args.todos : [];
  const results: HarnessTask[] = [];

  for (const todo of todos) {
    if (!todo || typeof todo !== "object") continue;
    const t = todo as Record<string, unknown>;
    const id = typeof t.id === "string" ? t.id : `auto_${results.length}`;
    const title = typeof t.content === "string"
      ? t.content
      : typeof t.title === "string"
        ? t.title
        : "";
    if (!title) continue;

    results.push({
      id,
      title,
      status: normalizeStatus(t.status),
      source,
      clientTaskId: id,
      evidence: [],
      lastUpdatedTurn: input.turn,
      createdTurn: input.turn,
      confidence: 1.0,
    });
  }
  return results;
}

/**
 * Generic task_update / update_todo: single task per call.
 * { id, title/content, status }
 */
function normalizeGenericTaskCall(input: ToolCallInput, source: TaskSource): HarnessTask[] {
  const n = normalize(input.toolName);
  const args = nestedTaskArgs(input.args);
  const deleted = truthyArg(args.deleted)
    || truthyArg(args.delete)
    || truthyArg(args.obsolete)
    || truthyArg(args.cancelled)
    || truthyArg(args.canceled)
    || n === "taskdelete"
    || n === "task_delete";
  const id = stringArg(args.id)
    ?? stringArg(args.task_id)
    ?? stringArg(args.taskId)
    ?? stringArg(args.uuid)
    ?? `auto_0`;
  const title = stringArg(args.title)
    ?? stringArg(args.content)
    ?? stringArg(args.description)
    ?? stringArg(args.summary)
    ?? stringArg(args.name)
    ?? (id !== "auto_0" ? `Task ${id}` : "");
  if (!title) return [];

  const rawStatus = deleted === true
    ? "obsolete"
    : args.status ?? (n === "taskcreate" || n === "task_create" ? "pending" : "unknown");
  const evidence = [
    typeof args.activeForm === "string" ? `activeForm: ${args.activeForm}` : "",
    typeof args.details === "string" ? `details: ${args.details}` : "",
    typeof args.dependencies === "string" ? `dependencies: ${args.dependencies}` : "",
  ].filter((v) => v.length > 0);

  return [{
    id,
    title,
    status: normalizeStatus(rawStatus),
    source,
    clientTaskId: id,
    evidence,
    lastUpdatedTurn: input.turn,
    createdTurn: input.turn,
    confidence: 1.0,
  }];
}

/**
 * Plan update / create plan: may carry a list of steps or items.
 */
function normalizePlanUpdateCall(input: ToolCallInput, source: TaskSource): HarnessTask[] {
  const planText = stringArg(input.args.plan)
    ?? stringArg(input.args.content)
    ?? stringArg(input.args.description)
    ?? stringArg(input.args.markdown);
  if (planText) {
    const fromText = extractTasksFromText(planText, source, input.turn);
    if (fromText.length > 0) return fromText;
  }

  const items = Array.isArray(input.args.steps)
    ? input.args.steps
    : Array.isArray(input.args.items)
      ? input.args.items
      : Array.isArray(input.args.todos)
        ? input.args.todos
        : [];

  const results: HarnessTask[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    const id = typeof t.id === "string" ? t.id : `plan_${results.length}`;
    const title = typeof t.title === "string"
      ? t.title
      : typeof t.content === "string"
        ? t.content
        : typeof t.description === "string"
          ? t.description
          : "";
    if (!title) continue;

    results.push({
      id,
      title,
      status: normalizeStatus(t.status ?? "pending"),
      source,
      clientTaskId: id,
      evidence: [],
      lastUpdatedTurn: input.turn,
      createdTurn: input.turn,
      confidence: 0.9,
    });
  }
  return results;
}

function nestedTaskArgs(args: Record<string, unknown>): Record<string, unknown> {
  const task = args.task;
  if (task && typeof task === "object" && !Array.isArray(task)) {
    return { ...args, ...(task as Record<string, unknown>) };
  }
  return args;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truthyArg(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return false;
  return /^(true|1|yes|delete|deleted|obsolete|cancelled|canceled)$/i.test(value.trim());
}
