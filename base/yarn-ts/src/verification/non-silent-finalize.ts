export type NonSilentFinalizeOutcome = {
  text: string;
  applied: boolean;
};

function looksNonActionableTerminalText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^(?:\.{3,}|…+)$/.test(trimmed)) return true;
  if (/^(?:thinking|cogitating|analysis)\s*(?:\.{3,}|…)?$/i.test(trimmed)) return true;
  if (!/[A-Za-z0-9]/.test(trimmed)) return true;
  return false;
}

export function enforceNonSilentFinalizeText(text: string): NonSilentFinalizeOutcome {
  if (!looksNonActionableTerminalText(text)) {
    return { text, applied: false };
  }
  const replacement = [
    "I paused before producing a usable final update.",
    "",
    "Current state:",
    "- The previous step completed, but no actionable summary was emitted.",
    "",
    "Next actions:",
    "- Continue from current workspace state and finish the pending implementation/tests.",
    "- If you want me to proceed now, reply with: continue.",
  ].join("\n");
  return { text: replacement, applied: true };
}
