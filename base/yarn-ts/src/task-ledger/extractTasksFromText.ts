import type { PlanTodoEntry } from "../planning/plan-content-shadow.js";
import type { HarnessTask, TaskSource, TaskStatus } from "./types.js";

/**
 * Actionable verb patterns that distinguish implementation steps from commentary.
 */
const ACTIONABLE_VERB_RE = /\b(implement|create|add|build|write|update|fix|refactor|remove|delete|migrate|configure|set\s?up|wire|integrate|test|verify|deploy|install|rename|extract|move|split)\b/i;

/**
 * Markdown checkbox pattern: `- [ ] text` or `- [x] text` (with optional leading whitespace).
 */
const CHECKBOX_RE = /^[\t ]*[-*]\s+\[([ xX])\]\s+(.+)/;

/**
 * Numbered plan step: `1. Do something` or `1) Do something`.
 */
const NUMBERED_STEP_RE = /^[\t ]*(\d+)[.)]\s+(.+)/;

interface ExtractedTask {
  title: string;
  status: TaskStatus;
  confidence: number;
}

function extractCheckboxTasks(text: string): ExtractedTask[] {
  const results: ExtractedTask[] = [];
  for (const line of text.split("\n")) {
    const m = CHECKBOX_RE.exec(line);
    if (!m) continue;
    const checked = m[1].toLowerCase() === "x";
    const title = m[2].trim();
    if (title.length < 5) continue;
    results.push({
      title,
      status: checked ? "completed" : "pending",
      confidence: 0.9,
    });
  }
  return results;
}

function extractNumberedPlanTasks(text: string): ExtractedTask[] {
  const results: ExtractedTask[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const m = NUMBERED_STEP_RE.exec(line);
    if (!m) continue;
    const title = m[2].trim();
    if (title.length < 8) continue;
    if (!ACTIONABLE_VERB_RE.test(title)) continue;
    results.push({
      title,
      status: "pending",
      confidence: 0.7,
    });
  }

  // Only treat as a plan if at least 2 actionable numbered items were found
  if (results.length < 2) return [];
  return results;
}

/**
 * Extract tasks from free-form assistant text.
 * Returns tasks only when the text contains recognizable structured task patterns.
 * Vague commentary or conversational text is intentionally ignored.
 */
export function extractTasksFromText(
  text: string,
  source: TaskSource,
  turn: number,
): HarnessTask[] {
  if (!text || text.length < 20) return [];

  const checkboxTasks = extractCheckboxTasks(text);
  if (checkboxTasks.length >= 2) {
    return checkboxTasks.map((t, i) => ({
      id: `md_${turn}_${i}`,
      title: t.title,
      status: t.status,
      source: source === "unknown" ? "markdown_task_list" : source,
      evidence: t.status === "completed" ? ["checked in markdown checklist"] : [],
      lastUpdatedTurn: turn,
      createdTurn: turn,
      confidence: t.confidence,
    }));
  }

  const numberedTasks = extractNumberedPlanTasks(text);
  if (numberedTasks.length >= 2) {
    return numberedTasks.map((t, i) => ({
      id: `plan_${turn}_${i}`,
      title: t.title,
      status: t.status,
      source: source === "unknown" ? "model_plan_text" : source,
      evidence: [],
      lastUpdatedTurn: turn,
      createdTurn: turn,
      confidence: t.confidence,
    }));
  }

  return [];
}

/**
 * Bridge PlanTodoEntry[] (from plan-content-shadow YAML frontmatter)
 * into HarnessTask[] for the task ledger.
 */
export function bridgePlanTodoEntries(
  entries: PlanTodoEntry[],
  turn: number,
): HarnessTask[] {
  const STATUS_BRIDGE: Record<string, TaskStatus> = {
    pending: "pending",
    in_progress: "in_progress",
    completed: "completed",
    cancelled: "obsolete",
  };

  return entries.map((e) => ({
    id: `plantodo_${e.id}`,
    title: e.content,
    status: STATUS_BRIDGE[e.status] ?? "unknown",
    source: "cursor_plan" as TaskSource,
    clientTaskId: e.id,
    evidence: e.status === "completed" ? ["marked completed in plan file"] : [],
    lastUpdatedTurn: turn,
    createdTurn: turn,
    confidence: 1.0,
  }));
}
