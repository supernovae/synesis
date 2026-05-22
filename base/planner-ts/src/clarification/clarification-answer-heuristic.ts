/**
 * Heuristic: does this user message look like an answer to a pending clarification round?
 * Used before merging task text and clearing session state.
 */

export type PendingClarificationShape = {
  question: string;
  options: string[];
  assumptions: string[];
  originalTaskDescription?: string;
};

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

/** Short affirmations that should count as "I'll use your assumptions / proceed". */
const AFFIRM_RE =
  /^(yes|yeah|yep|yup|ok|okay|sure|fine|sounds?\s+good|go\s+ahead|that\s+works|please\s+proceed)\b/i;

/**
 * Returns true when the message is plausibly answering the pending clarification
 * (long enough, waiver phrase, overlap with question/options, or common short affirmations).
 */
export function isLikelyClarificationAnswer(
  answer: string,
  pending: PendingClarificationShape,
): boolean {
  const trimmed = answer.trim();
  if (!trimmed) return false;
  if (/^([a-z]|[0-9]{1,2})[).]?$/i.test(trimmed)) return false;
  if (/\b(proceed|go ahead|use assumptions|continue)\b/i.test(trimmed)) return true;
  if (AFFIRM_RE.test(trimmed)) return true;
  if (trimmed.length >= 24) return true;

  const haystack = `${pending.question} ${pending.options.join(" ")}`.toLowerCase();
  const words = normalizeWords(trimmed);
  return words.some((w) => haystack.includes(w));
}
