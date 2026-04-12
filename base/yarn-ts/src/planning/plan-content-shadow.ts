import { createHash } from "node:crypto";

export type PlanTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface PlanTodoEntry {
  id: string;
  content: string;
  status: PlanTodoStatus;
}

export interface PlanContentShadow {
  path: string;
  contentHash: string;
  contentLength: number;
  todos: PlanTodoEntry[];
  lastReadAt: number;
}

const VALID_STATUSES: ReadonlySet<string> = new Set<PlanTodoStatus>([
  "pending", "in_progress", "completed", "cancelled",
]);

/**
 * Allowed status transitions. A status may only advance forward or stay the
 * same; regressions are blocked.
 */
const ALLOWED_TRANSITIONS: Record<PlanTodoStatus, ReadonlySet<PlanTodoStatus>> = {
  pending: new Set(["pending", "in_progress", "completed", "cancelled"]),
  in_progress: new Set(["in_progress", "completed", "cancelled"]),
  completed: new Set(["completed"]),
  cancelled: new Set(["cancelled"]),
};

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Parse YAML-ish `todos:` entries from plan file content.  We intentionally
 * avoid pulling in a full YAML library — plan files follow a narrow format
 * (Cursor plan frontmatter) with one-level `todos:` arrays.
 */
export function parsePlanTodos(content: string): PlanTodoEntry[] {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const fm = fmMatch[1];

  const todosIdx = fm.indexOf("\ntodos:");
  if (todosIdx < 0 && !fm.startsWith("todos:")) return [];
  const afterTodos = fm.slice(todosIdx >= 0 ? todosIdx + "\ntodos:".length : "todos:".length);

  const entries: PlanTodoEntry[] = [];
  let currentId = "";
  let currentContent = "";
  let currentStatus: PlanTodoStatus = "pending";

  for (const line of afterTodos.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- id:")) {
      if (currentId) {
        entries.push({ id: currentId, content: currentContent, status: currentStatus });
      }
      currentId = trimmed.slice("- id:".length).trim();
      currentContent = "";
      currentStatus = "pending";
      continue;
    }
    if (!currentId) {
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-")) break;
      continue;
    }
    const contentMatch = trimmed.match(/^content:\s*(.+)/);
    if (contentMatch) {
      currentContent = contentMatch[1].replace(/^["']|["']$/g, "");
      continue;
    }
    const statusMatch = trimmed.match(/^status:\s*(\S+)/);
    if (statusMatch) {
      const s = statusMatch[1].replace(/^["']|["']$/g, "");
      currentStatus = VALID_STATUSES.has(s) ? s as PlanTodoStatus : "pending";
      continue;
    }
    if (trimmed && !trimmed.startsWith("-") && !trimmed.startsWith("#")) break;
  }
  if (currentId) {
    entries.push({ id: currentId, content: currentContent, status: currentStatus });
  }
  return entries;
}

export function buildShadowFromContent(path: string, content: string): PlanContentShadow {
  return {
    path,
    contentHash: hashContent(content),
    contentLength: content.length,
    todos: parsePlanTodos(content),
    lastReadAt: Date.now(),
  };
}

export interface MonotonicityViolation {
  todoId: string;
  previousStatus: PlanTodoStatus;
  proposedStatus: PlanTodoStatus;
}

/**
 * Check proposed todos against the shadow for status regressions.
 * Returns violations (empty array = all good).
 */
export function checkMonotonicity(
  shadow: PlanContentShadow,
  proposedTodos: PlanTodoEntry[],
): MonotonicityViolation[] {
  const shadowMap = new Map(shadow.todos.map((t) => [t.id, t]));
  const violations: MonotonicityViolation[] = [];
  for (const proposed of proposedTodos) {
    const prev = shadowMap.get(proposed.id);
    if (!prev) continue;
    if (!ALLOWED_TRANSITIONS[prev.status].has(proposed.status)) {
      violations.push({
        todoId: proposed.id,
        previousStatus: prev.status,
        proposedStatus: proposed.status,
      });
    }
  }
  return violations;
}

// --- Stub / metadata phrase detection ---

const STUB_PHRASES = [
  "unchanged since last read",
  "file unchanged",
  "no plan file exists yet",
  "this is a fresh session",
  "<file_unchanged",
  "<synesis_tool_guardrail",
  "<synesis_plan_loaded",
  "read_cache_stub",
  "client_returned_cache_stub",
];

export function containsStubPhrase(text: string): string | null {
  const lower = text.toLowerCase();
  for (const phrase of STUB_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

export function hasValidPlanStructure(content: string): boolean {
  return content.includes("---") && content.length >= 20;
}

export interface PlanWriteValidationResult {
  allowed: boolean;
  reason?: string;
  violations?: MonotonicityViolation[];
}

/**
 * Validate proposed plan file write content against the shadow.
 * Returns { allowed: true } if safe, or { allowed: false, reason } if blocked.
 */
export function validatePlanWriteContent(
  proposedContent: string,
  shadow: PlanContentShadow | null,
  isPartialEdit: boolean,
): PlanWriteValidationResult {
  if (proposedContent.length < 20 && !isPartialEdit) {
    return { allowed: false, reason: "content_too_short" };
  }

  const stubPhrase = containsStubPhrase(proposedContent);
  if (stubPhrase) {
    return { allowed: false, reason: `contains_stub_phrase: ${stubPhrase}` };
  }

  if (!isPartialEdit && !hasValidPlanStructure(proposedContent)) {
    return { allowed: false, reason: "missing_yaml_frontmatter" };
  }

  if (shadow && !isPartialEdit) {
    if (shadow.contentLength > 100 && proposedContent.length < shadow.contentLength * 0.3) {
      return {
        allowed: false,
        reason: `size_regression: proposed=${proposedContent.length} vs last_read=${shadow.contentLength}`,
      };
    }

    if (shadow.todos.length > 0) {
      const proposedTodos = parsePlanTodos(proposedContent);
      if (proposedTodos.length > 0) {
        const violations = checkMonotonicity(shadow, proposedTodos);
        if (violations.length > 0) {
          return {
            allowed: false,
            reason: `monotonicity_violation: ${violations.map((v) => `${v.todoId}: ${v.previousStatus}->${v.proposedStatus}`).join(", ")}`,
            violations,
          };
        }
      }
    }
  }

  return { allowed: true };
}

export function serializeShadow(shadow: PlanContentShadow): Record<string, unknown> {
  return {
    path: shadow.path,
    contentHash: shadow.contentHash,
    contentLength: shadow.contentLength,
    todos: shadow.todos.map((t) => ({ id: t.id, content: t.content, status: t.status })),
    lastReadAt: shadow.lastReadAt,
  };
}

export function deserializeShadow(data: unknown): PlanContentShadow | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.path !== "string" || typeof d.contentHash !== "string") return null;
  const todos = Array.isArray(d.todos)
    ? (d.todos as Array<Record<string, unknown>>).map((t) => ({
        id: String(t.id ?? ""),
        content: String(t.content ?? ""),
        status: (VALID_STATUSES.has(String(t.status ?? "")) ? String(t.status) : "pending") as PlanTodoStatus,
      }))
    : [];
  return {
    path: d.path,
    contentHash: d.contentHash,
    contentLength: Number(d.contentLength ?? 0),
    todos,
    lastReadAt: Number(d.lastReadAt ?? 0),
  };
}
