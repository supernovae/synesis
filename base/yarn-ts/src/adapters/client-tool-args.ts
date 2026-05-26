import { canonicalValidationToolName } from "../tool-aliases.js";

export interface ClientToolArgDefinition {
  name?: string;
  function?: {
    name?: string;
    parameters?: unknown;
  };
  input_schema?: unknown;
  [key: string]: unknown;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

function toolDefinitionName(tool: ClientToolArgDefinition): string {
  const direct = typeof tool.name === "string" ? tool.name.trim() : "";
  if (direct) return direct;
  const fn = tool.function;
  return typeof fn?.name === "string" ? fn.name.trim() : "";
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toolParameters(tool: ClientToolArgDefinition): Record<string, unknown> | null {
  const fnParams = toRecord(tool.function?.parameters);
  if (fnParams) return fnParams;
  return toRecord(tool.input_schema);
}

function findToolDefinition(
  tools: ClientToolArgDefinition[] | undefined,
  toolName: string,
): ClientToolArgDefinition | null {
  if (!Array.isArray(tools)) return null;
  const requested = normalizeName(toolName);
  const requestedCanonical = normalizeName(canonicalValidationToolName(toolName));
  for (const tool of tools) {
    const candidate = toolDefinitionName(tool);
    if (!candidate) continue;
    if (normalizeName(candidate) === requested) return tool;
    if (normalizeName(canonicalValidationToolName(candidate)) === requestedCanonical) return tool;
  }
  return null;
}

function propertiesOf(schema: Record<string, unknown> | null): Record<string, unknown> {
  return toRecord(schema?.properties) ?? {};
}

function requiredOf(schema: Record<string, unknown> | null): Set<string> {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  return new Set(required.filter((v): v is string => typeof v === "string"));
}

function hasUsable(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function moveArg(
  args: Record<string, unknown>,
  from: string,
  to: string,
  props: Record<string, unknown>,
): void {
  if (!(to in props) || !(from in args) || hasUsable(args[to])) return;
  args[to] = args[from];
  if (!(from in props)) delete args[from];
}

function restoreCommonArgsToSchema(
  args: Record<string, unknown>,
  props: Record<string, unknown>,
): void {
  moveArg(args, "glob_pattern", "pattern", props);
  moveArg(args, "pattern", "glob_pattern", props);
  moveArg(args, "target_directory", "path", props);
  moveArg(args, "target_directory", "directory", props);

  moveArg(args, "file_path", "filePath", props);
  moveArg(args, "filePath", "file_path", props);
  moveArg(args, "old_string", "oldString", props);
  moveArg(args, "oldString", "old_string", props);
  moveArg(args, "new_string", "newString", props);
  moveArg(args, "newString", "new_string", props);
  moveArg(args, "replace_all", "replaceAll", props);
  moveArg(args, "replaceAll", "replace_all", props);
}

function todosItemSchema(parameters: Record<string, unknown> | null): Record<string, unknown> | null {
  const todosProp = toRecord(propertiesOf(parameters).todos);
  return toRecord(todosProp?.items);
}

function stringFromTodoAlias(todo: Record<string, unknown>): string | undefined {
  for (const key of ["content", "title", "task", "text", "description", "summary", "name"]) {
    const value = todo[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeTodoWriteArgs(
  args: Record<string, unknown>,
  parameters: Record<string, unknown> | null,
): void {
  if (!Array.isArray(args.todos) && Array.isArray(args.tasks)) {
    args.todos = args.tasks;
    delete args.tasks;
  }
  if (!Array.isArray(args.todos) && typeof args.todos === "string") {
    const trimmed = args.todos.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) args.todos = parsed;
      } catch {
        // Keep the original value so strict client validation can report the precise schema error.
      }
    }
  }
  if (!Array.isArray(args.todos)) return;

  const itemSchema = todosItemSchema(parameters);
  const itemProps = propertiesOf(itemSchema);
  const itemRequired = requiredOf(itemSchema);
  const schemaMentionsContent = "content" in itemProps || itemRequired.has("content") || Object.keys(itemProps).length === 0;
  const schemaMentionsTitle = "title" in itemProps || itemRequired.has("title");
  const contentKey = schemaMentionsContent ? "content" : schemaMentionsTitle ? "title" : "content";

  args.todos = args.todos.map((raw, idx) => {
    const todo = typeof raw === "string"
      ? { [contentKey]: raw }
      : raw && typeof raw === "object" && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : { [contentKey]: String(raw ?? "") };

    if (!hasUsable(todo[contentKey])) {
      const aliasText = stringFromTodoAlias(todo);
      if (aliasText) todo[contentKey] = aliasText;
    }

    if (contentKey === "content" && !("title" in itemProps)) {
      delete todo.title;
    } else if (contentKey === "title" && !("content" in itemProps)) {
      delete todo.content;
    }

    if (itemRequired.has("id") && !hasUsable(todo.id)) {
      todo.id = `todo_${idx + 1}`;
    }
    if (itemRequired.has("status") && !hasUsable(todo.status)) {
      todo.status = "pending";
    }
    if (itemRequired.has("priority") && !hasUsable(todo.priority)) {
      todo.priority = "medium";
    }
    return todo;
  });
}

function defaultOpenCodeProperties(canonicalToolName: string): Record<string, unknown> | null {
  if (canonicalToolName === "Glob") {
    return { pattern: true, path: true };
  }
  return null;
}

/**
 * Governance uses a stable internal argument dialect (`glob_pattern`,
 * `file_path`, etc.). Before returning a tool call to the client, convert back
 * to the exact shape that the offered tool schema advertises so strict clients
 * such as OpenCode do not reject otherwise-valid calls.
 */
export function restoreToolArgsToClientSchema(
  toolName: string,
  input: Record<string, unknown>,
  tools: ClientToolArgDefinition[] | undefined,
  clientKind?: string,
): Record<string, unknown> {
  const out = { ...input };
  const tool = findToolDefinition(tools, toolName);
  const parameters = tool ? toolParameters(tool) : null;
  const props = parameters ? propertiesOf(parameters) : {};
  const canonical = canonicalValidationToolName(toolName);

  const fallbackProps =
    Object.keys(props).length > 0
      ? props
      : String(clientKind ?? "").toLowerCase().includes("opencode")
        ? defaultOpenCodeProperties(canonical) ?? {}
        : {};

  restoreCommonArgsToSchema(out, fallbackProps);
  if (canonical === "TodoWrite") {
    normalizeTodoWriteArgs(out, parameters);
  }
  return out;
}
