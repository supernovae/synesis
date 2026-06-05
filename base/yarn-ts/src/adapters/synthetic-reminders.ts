export function isSyntheticHarnessReminderText(text: string | undefined | null): boolean {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  return lower.includes("<system-reminder>")
    || lower.includes("<system_reminder>")
    || lower.startsWith("system-reminder:")
    || lower.startsWith("system reminder:")
    || (
      lower.includes("plan mode is active")
      && (
        lower.includes("must not make any edits")
        || lower.includes("only file you are allowed to edit")
        || lower.includes("only edit the plan file")
      )
    );
}

export interface SyntheticReminderMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface NeutralizeSyntheticPlanReminderResult<T extends SyntheticReminderMessage> {
  messages: T[];
  neutralizedCount: number;
}

const PLAN_APPROVED_REPLACEMENT = [
  "<SYNESIS_STALE_CLIENT_REMINDER neutralized=\"true\" reason=\"plan_approval_detected\">",
  "A stale client plan-mode reminder was removed from this turn because plan approval or implementation progress has already been detected.",
  "Treat plan mode as closed. Do not update/re-read the plan file or call ExitPlanMode again unless the user explicitly asks to change the plan.",
  "Continue with native task setup or the next concrete implementation edit.",
  "</SYNESIS_STALE_CLIENT_REMINDER>",
].join("\n");

export function neutralizeSyntheticPlanModeRemindersAfterApproval<T extends SyntheticReminderMessage>(
  messages: T[],
): NeutralizeSyntheticPlanReminderResult<T> {
  let neutralizedCount = 0;
  const neutralized = messages.map((message) => {
    const text = contentText(message.content);
    if (!isSyntheticHarnessReminderText(text)) return message;
    neutralizedCount += 1;
    return {
      ...message,
      content: PLAN_APPROVED_REPLACEMENT,
    };
  });
  return { messages: neutralized, neutralizedCount };
}

export function hasNonPlanImplementationWriteAfterPlanTransition(
  messages: SyntheticReminderMessage[] | undefined | null,
): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const text = messages.map((message) => contentText(message.content).toLowerCase()).join("\n");
  if (!/\b(?:plan approved|plan was approved|plan is approved|plan mode is closed|user has approved your plan|you can now start coding|continue with implementation|starting implementation|start(?:ing)? coding)\b/.test(text)) {
    return false;
  }
  return messages.some((message) => hasNonPlanWriteToolUse(message));
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(contentText).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    const row = content as Record<string, unknown>;
    return typeof row.text === "string" ? row.text
      : typeof row.content === "string" ? row.content
      : JSON.stringify(row);
  }
  return "";
}

function hasNonPlanWriteToolUse(message: SyntheticReminderMessage): boolean {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!call || typeof call !== "object") continue;
    const row = call as Record<string, unknown>;
    const fn = row.function && typeof row.function === "object" ? row.function as Record<string, unknown> : {};
    const toolName = normalizeToolName(fn.name ?? row.name);
    const rawArgs = fn.arguments ?? row.input;
    if (isWriteLikeTool(toolName) && isNonPlanPath(extractPathFromArgs(rawArgs))) return true;
  }

  const content = Array.isArray(message.content) ? message.content : [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const row = part as Record<string, unknown>;
    if (row.type !== "tool_use") continue;
    const toolName = normalizeToolName(row.name);
    if (isWriteLikeTool(toolName) && isNonPlanPath(extractPathFromArgs(row.input))) return true;
  }
  return false;
}

function isWriteLikeTool(toolName: string): boolean {
  return toolName === "write"
    || toolName === "edit"
    || toolName === "multiedit"
    || toolName === "multi_edit"
    || toolName === "applypatch"
    || toolName === "apply_patch"
    || toolName === "strreplace"
    || toolName === "str_replace";
}

function normalizeToolName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[-\s]/g, "_");
}

function extractPathFromArgs(args: unknown): string {
  const row = parseArgsObject(args);
  if (!row) return "";
  for (const key of ["file_path", "filepath", "path", "filename", "file"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function parseArgsObject(args: unknown): Record<string, unknown> | null {
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args !== "string") return null;
  const trimmed = args.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isNonPlanPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (!normalized) return false;
  return !normalized.includes("/.claude/plans/") && !normalized.includes(".claude/plans/");
}
