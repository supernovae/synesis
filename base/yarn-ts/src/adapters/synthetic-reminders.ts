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
  "A stale client plan-mode reminder was removed from this turn because plan approval has already been detected.",
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
