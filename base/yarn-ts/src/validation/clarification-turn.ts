/**
 * Heuristic: assistant is gathering requirements / asking follow-ups, not declaring implementation done.
 * Used to skip completion-gate text replacement so multi-turn Q&A is not overwritten.
 */
export function looksLikeClarificationTurnAssistantMessage(text: string): boolean {
  const t = text.trim();
  if (t.length < 48) return false;

  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return false;

  const linesWithQuestion = lines.filter((l) => l.includes("?")).length;
  const ratio = linesWithQuestion / lines.length;
  if (ratio >= 0.28) return true;

  if (/\bclarifying questions\b/i.test(t)) return true;
  if (/\bbefore I (?:start|implement|begin|write|code|create|build)\b/i.test(t)) return true;
  if (/\b(?:a few|some) questions\b/i.test(t) && linesWithQuestion >= 1) return true;

  const numberedQuestionBlocks = (t.match(/(?:^|\n)\s*(?:\d+[.)]|[*•-])\s+[^\n]*\?/g) ?? []).length;
  if (numberedQuestionBlocks >= 2) return true;

  return false;
}
