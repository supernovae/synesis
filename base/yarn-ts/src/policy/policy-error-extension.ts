/**
 * Optional machine-readable metadata on deterministic policy HTTP errors.
 * Clients may read `error.synesis` (OpenAI) or `error.synesis` (Anthropic-compatible)
 * without breaking strict parsers that only look at `message` and `type`.
 */

export interface SynesisPolicyErrorExtension {
  /** Stable Synesis policy reason code */
  code: string;
  /** Whether retrying the same request body may succeed (usually false for policy hard rejects) */
  retryable: boolean;
  /** Short guidance for UI or automation */
  guidance: string;
}

/**
 * Maps policy `matchedRules` to structured client hints. Returns undefined if no mapping.
 */
export function synesisPolicyErrorExtension(matchedRules: string[]): SynesisPolicyErrorExtension | undefined {
  if (matchedRules.includes("repeat_loop_hard_reject")) {
    return {
      code: "repeat_loop_hard_reject",
      retryable: false,
      guidance:
        "The same request fingerprint repeated too many times. Start a new chat/session (not Resume), trim history, or send a materially different prompt; do not retry the identical request.",
    };
  }
  if (matchedRules.includes("session_budget_exceeded")) {
    return {
      code: "session_token_budget",
      retryable: false,
      guidance: "Session input token budget exceeded. Start a new session or reduce context size.",
    };
  }
  if (matchedRules.includes("patch_first_reject_write_file")) {
    return {
      code: "patch_first_policy",
      retryable: false,
      guidance: "Use str_replace or search-replace instead of write_file for this workspace policy.",
    };
  }
  if (matchedRules.includes("consecutive_tool_calls_limit")) {
    return {
      code: "tool_loop_hard_reject",
      retryable: false,
      guidance:
        "Too many consecutive tool rounds without progress. Start a new session or ask the user before continuing the same tool pattern.",
    };
  }
  return undefined;
}
