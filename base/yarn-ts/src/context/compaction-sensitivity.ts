/** Shared evidence-preservation policy; model names do not determine retention. */
export const COMPACTION_SYSTEM_PROMPT = `You are a context compaction engine for a coding assistant.
Summarize the conversation trajectory into a single <ARCHITECTURAL_STATE> block.
Preserve: exact paths, key decisions, current task state, pending work, and concrete error resolutions.
Keep the latest unresolved failure excerpt literal, including command, exit code and file:line references when available.
Compress older successful output and duplicate exploration; omit greetings and logs unrelated to the active task.
Do not claim omitted source content is still visible. Record missing evidence and recovery references when available.`;

/** Heuristic: tool output likely contains a failure worth preserving verbatim. */
export function looksLikeVerificationFailureOutput(raw: string): boolean {
  if (!raw || raw.length < 8) return false;
  return (
    /\bFAIL\b/i.test(raw)
    || /---\s*FAIL/i.test(raw)
    || /\bAssertionError\b/i.test(raw)
    || /\bpanic:\b/i.test(raw)
    || /\berror\s+TS\d+/i.test(raw)
    || /\bERROR\b.*\bat\b.*\(\d+:\d+\)/i.test(raw)
    || /exit code [1-9]/i.test(raw)
    || /\btests? failed\b/i.test(raw)
    || /\bcompilation failed\b/i.test(raw)
    || /\bundefined:\s*\S+/i.test(raw)
  );
}
