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
