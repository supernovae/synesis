import type { ClientTaskCapabilities, TaskSource } from "./types.js";

interface ToolDefinition {
  name?: string;
  function?: { name?: string };
  [key: string]: unknown;
}

/**
 * Canonical todo/task tool names mapped to their inferred source.
 * Keys are lowercase + underscore-normalized.
 */
const TODO_TOOL_SOURCE_MAP: ReadonlyMap<string, TaskSource> = new Map([
  ["todowrite", "unknown"],
  ["todo_write", "unknown"],
  ["update_todo", "unknown"],
  ["task_update", "unknown"],
  ["plan_update", "unknown"],
  ["taskcreate", "unknown"],
  ["task_create", "unknown"],
]);

const PLAN_MODE_TOOLS: ReadonlySet<string> = new Set([
  "createplan",
  "create_plan",
  "switchmode",
  "switch_mode",
]);

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

function resolveSource(normalizedName: string, clientKind: string): TaskSource {
  if (clientKind === "opencode" || clientKind === "opencode-agent") {
    return "opencode_todowrite";
  }
  if (clientKind === "claude-code" || clientKind === "claude_code") {
    return "claude_todowrite";
  }
  if (clientKind === "cursor" || clientKind === "cursor-agent") {
    return "cursor_plan";
  }
  if (clientKind.includes("cline") || clientKind.includes("roo")) {
    return "cline_plan";
  }

  if (normalizedName.includes("todowrite") || normalizedName.includes("todo_write")) {
    return "opencode_todowrite";
  }
  return "unknown";
}

export function detectClientTaskCapabilities(
  tools: ToolDefinition[] | undefined | null,
  clientKind: string,
): ClientTaskCapabilities {
  let hasExplicitTodoTool = false;
  let hasExplicitPlanMode = false;
  let todoToolName: string | null = null;
  let detectedSource: TaskSource = "unknown";

  if (tools && Array.isArray(tools)) {
    for (const tool of tools) {
      const rawName = tool.name ?? tool.function?.name ?? "";
      if (!rawName) continue;
      const n = normalize(rawName);

      if (TODO_TOOL_SOURCE_MAP.has(n)) {
        hasExplicitTodoTool = true;
        todoToolName = rawName;
        detectedSource = resolveSource(n, clientKind);
      }
      if (PLAN_MODE_TOOLS.has(n)) {
        hasExplicitPlanMode = true;
        if (!hasExplicitTodoTool) {
          detectedSource = resolveSource(n, clientKind);
        }
      }
    }
  }

  if (!hasExplicitTodoTool && !hasExplicitPlanMode && clientKind) {
    const lk = clientKind.toLowerCase();
    if (lk.includes("cline") || lk.includes("roo")) {
      detectedSource = "cline_plan";
    } else if (lk.includes("cursor")) {
      detectedSource = "cursor_plan";
    }
  }

  return { hasExplicitTodoTool, hasExplicitPlanMode, todoToolName, detectedSource };
}
