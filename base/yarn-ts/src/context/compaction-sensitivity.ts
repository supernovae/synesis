/**
 * Per-backend-model compaction / reduction sensitivity for fragile coders
 * (e.g. Qwen3-Coder-Next losing literal test output after aggressive summarization).
 */

export type CompactionSensitivity = "default" | "qwen_coder" | "strict_literals";

const STRICT_LITERAL_SUBSTRINGS = ["coder-next", "qwen3-coder-next", "qwen3.6-coder-next"];

/**
 * Classify backend model id / name for compaction and tool-output retention policy.
 * - strict_literals: smallest models / "next" SKUs — keep more verbatim failure output, compact less often.
 * - qwen_coder: other Qwen3 coder variants — gentler reduction than global defaults.
 */
export function inferCompactionSensitivity(backendModel: string): CompactionSensitivity {
  const m = (backendModel || "").toLowerCase();
  if (!m) return "default";
  for (const s of STRICT_LITERAL_SUBSTRINGS) {
    if (m.includes(s)) return "strict_literals";
  }
  if (/qwen3.*coder/.test(m)) return "qwen_coder";
  return "default";
}

export type ReducerProfileName = "balanced" | "aggressive" | "ultra";

/** Demote aggressive/ultra toward balanced when models struggle with lossy tool summaries. */
export function effectiveReducerProfile(
  global: ReducerProfileName,
  sensitivity: CompactionSensitivity,
): ReducerProfileName {
  if (sensitivity === "default") return global;
  if (global === "ultra" || global === "aggressive") return "balanced";
  return global;
}

/** Raise inline cap so registry reducers keep more literal compiler/test output. */
export function effectiveMaxRawChars(base: number, sensitivity: CompactionSensitivity): number {
  if (sensitivity === "strict_literals") return Math.min(Math.max(base + 24_000, base * 2), 200_000);
  if (sensitivity === "qwen_coder") return Math.min(Math.max(base + 12_000, Math.floor(base * 1.5)), 120_000);
  return base;
}

/** Require more tool calls before sawtooth checkpoint for fragile models. */
export function effectiveSawtoothCheckpointToolCalls(base: number, sensitivity: CompactionSensitivity): number {
  if (sensitivity === "strict_literals") return Math.round(base * 1.5);
  if (sensitivity === "qwen_coder") return Math.round(base * 1.25);
  return base;
}

/** Require longer history before sawtooth checkpoint for fragile models. */
export function effectiveSawtoothHistoryLengthThreshold(base: number, sensitivity: CompactionSensitivity): number {
  if (sensitivity === "strict_literals") return Math.round(base * 1.33);
  if (sensitivity === "qwen_coder") return Math.round(base * 1.15);
  return base;
}

const COMPACTION_SYSTEM_DEFAULT = `You are a context compaction engine for a coding assistant.
Summarize the conversation trajectory into a single <ARCHITECTURAL_STATE> block.
Preserve: file paths changed, key decisions made, error resolutions, current task state, pending work.
Omit: raw tool output, redundant retries, verbose logs, greetings.
Be concise but preserve enough detail that the assistant can continue seamlessly.`;

const COMPACTION_SYSTEM_STRICT_LITERALS = `You are a context compaction engine for a coding assistant.
Summarize the conversation trajectory into a single <ARCHITECTURAL_STATE> block.

CRITICAL — literal evidence:
- Preserve VERBATIM the most recent failing test / build / typecheck output (stderr lines, FAIL lines, file:line references, assertion text). Do not paraphrase errors away.
- Preserve exact paths for files currently being edited or verified.
- Preserve the last concrete error signature (command + exit code + key stderr lines) even if verbose.

OK to compress:
- Older successful command output, repeated green test runs, duplicate directory listings, stale exploration.

Omit: greetings, redundant successful retries that match a previous success signature, huge logs unrelated to the active failure.

Be concise in narrative sections but NEVER replace the latest failure block with vague prose.`;

const COMPACTION_SYSTEM_QWEN_CODER = `You are a context compaction engine for a coding assistant.
Summarize the conversation trajectory into a single <ARCHITECTURAL_STATE> block.
Preserve: file paths changed, key decisions, error resolutions with CONCRETE error lines (keep the last failure excerpt literal), current task state, pending work.
Omit: redundant successful retries, verbose logs unrelated to the active task, greetings.
Prefer keeping short verbatim excerpts of failing commands over high-level paraphrase.`;

export function compactionSystemPromptFor(sensitivity: CompactionSensitivity): string {
  if (sensitivity === "strict_literals") return COMPACTION_SYSTEM_STRICT_LITERALS;
  if (sensitivity === "qwen_coder") return COMPACTION_SYSTEM_QWEN_CODER;
  return COMPACTION_SYSTEM_DEFAULT;
}

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
  );
}
