/**
 * Curated classifiers for CLI output (bounded patterns — not a universal parser).
 */

import type { ShapingStats } from "./output-shaper.js";

export type TerminalClassification =
  | "unknown"
  | "interactive_prompt"
  | "pager_detected"
  | "sudo_auth"
  | "network_retry"
  | "infinite_output_suspected"
  | "interactive_or_stalled";

export interface TerminalSignals {
  classification: TerminalClassification;
  hints: string[];
  shapingApplied: string[];
  shapingStats?: ShapingStats;
  killedReason?: "wall_clock_timeout";
}

/** High-signal substrings / line prefixes (case-insensitive where noted). */
const INTERACTIVE_PATTERNS: RegExp[] = [
  /\bpassword\s*:\s*$/im,
  /\bpassphrase\s*:\s*$/im,
  /\[\s*y\/n\s*\]/i,
  /\(\s*y\/N\s*\)/i,
  /\(\s*Y\/n\s*\)/i,
  /\bare you sure\b/i,
  /\boverwrite\b.*\?/i,
  /\bcontinue\s*\?/i,
  /enter\s+(?:the\s+)?(?:same\s+)?passphrase/i,
  /token\s+for\s+https?:\/\//i,
  /\bgit\s+.*\bcredential\b/i,
];

const SUDO_AUTH_PATTERNS: RegExp[] = [/\[sudo\]\s+password/i, /\bsudo:\s+.*password/i];

const PAGER_PATTERNS: RegExp[] = [
  /\bterminal pager\b/i,
  /\bless\b.*\(press/i,
  /output has been piped to/i,
  /using editor|opened in \w+/i,
];

const NETWORK_RETRY_PATTERNS: RegExp[] = [
  /\bretries?\s+exhausted\b/i,
  /\bconnection (?:refused|reset|timed out)\b/i,
  /\btemporary failure\b/i,
  /\bTLS handshake failed\b/i,
];

const TERMINAL_CLASSIFICATIONS: readonly TerminalClassification[] = [
  "unknown",
  "interactive_prompt",
  "pager_detected",
  "sudo_auth",
  "network_retry",
  "infinite_output_suspected",
  "interactive_or_stalled",
];

export interface ClassifyOptions {
  shapingStats?: ShapingStats;
  killedReason?: "wall_clock_timeout";
}

export function classifyTerminalOutput(combinedText: string, options?: ClassifyOptions): TerminalSignals {
  const hints: string[] = [];
  let classification: TerminalClassification = "unknown";

  if (options?.killedReason === "wall_clock_timeout") {
    classification = "interactive_or_stalled";
    hints.push(
      "Command hit wall-clock limit waiting for exit; it may be waiting on input, a network stall, or an unbounded process. Do not blindly retry the same command.",
    );
  }

  const st = options?.shapingStats;
  if (st && st.repeatedLineRunsCollapsed >= 5) {
    if (classification === "unknown") classification = "infinite_output_suspected";
    hints.push(
      "Output contained repeated lines (possible tight loop or spam). Prefer narrowing scope, adding timeouts, or fixing the root cause before rerunning.",
    );
  }
  if (st && st.carriageReturnSegmentsCollapsed > 200) {
    hints.push(
      "Heavy carriage-return progress output was collapsed; if results look incomplete, rerun with plain/log-friendly flags (e.g. CI=1, NO_COLOR=1, or tool-specific --progress=plain).",
    );
  }

  const text = combinedText;

  for (const re of SUDO_AUTH_PATTERNS) {
    if (re.test(text)) {
      classification = "sudo_auth";
      hints.push(
        "Sudo password prompt detected; non-interactive agents cannot supply credentials. Rerun without sudo or run in a user shell.",
      );
      break;
    }
  }

  for (const re of PAGER_PATTERNS) {
    if (re.test(text)) {
      if (classification === "unknown") classification = "pager_detected";
      hints.push("Pager or interactive viewer may be active; set GIT_PAGER=cat or use flags to force plain output.");
      break;
    }
  }

  for (const re of INTERACTIVE_PATTERNS) {
    if (re.test(text)) {
      if (classification === "unknown" || classification === "pager_detected") {
        classification = "interactive_prompt";
      }
      hints.push(
        "Interactive prompt detected in output; add non-interactive flags (e.g. --yes, -y, DEBIAN_FRONTEND=noninteractive) or ask the user to run locally.",
      );
      break;
    }
  }

  for (const re of NETWORK_RETRY_PATTERNS) {
    if (re.test(text)) {
      if (classification === "unknown") classification = "network_retry";
      hints.push("Network or retry failure pattern in output; fix connectivity or use cached/offline mode before repeating.");
      break;
    }
  }

  return {
    classification,
    hints: dedupeHints(hints),
    shapingApplied: [],
    shapingStats: st,
    killedReason: options?.killedReason,
  };
}

function dedupeHints(hints: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hints) {
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out;
}

/**
 * Append to MCP runner summary for verification tools when classification is problematic.
 */
export function formatTerminalVerificationHint(signals: TerminalSignals): string | null {
  const classification = parseTerminalClassification(signals.classification);
  if (
    classification !== "interactive_or_stalled" &&
    classification !== "interactive_prompt" &&
    classification !== "sudo_auth" &&
    classification !== "pager_detected" &&
    classification !== "infinite_output_suspected" &&
    classification !== "network_retry" &&
    signals.killedReason !== "wall_clock_timeout"
  ) {
    return null;
  }
  const parts = [
    `<synesis_terminal_signals classification="${classification ?? "interactive_or_stalled"}">`,
    ...signals.hints.map((h) => `  - ${controlText(h, 320)}`).filter((line) => line.trim() !== "-"),
    "</synesis_terminal_signals>",
  ];
  return parts.join("\n");
}

function parseTerminalClassification(value: unknown): TerminalClassification | null {
  return typeof value === "string" && (TERMINAL_CLASSIFICATIONS as readonly string[]).includes(value)
    ? value as TerminalClassification
    : null;
}

function controlText(value: string, max: number): string {
  return value
    .replace(/[\r\n\t]/g, " ")
    .replace(/[<>"`]/g, "")
    .replace(/=/g, ":")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** Merge shaping flags into terminalSignals for API responses. */
export function attachShapingToSignals(
  signals: TerminalSignals,
  shapingApplied: string[],
  shapingStats?: ShapingStats,
): TerminalSignals {
  return {
    ...signals,
    shapingApplied: [...new Set([...signals.shapingApplied, ...shapingApplied])],
    shapingStats: shapingStats ?? signals.shapingStats,
  };
}
