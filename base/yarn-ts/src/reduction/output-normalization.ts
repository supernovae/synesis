const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const CLOCK_TS_RE = /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const DURATION_RE = /\b\d+(?:\.\d+)?(?:ms|s|m|h)\b/g;
const TMP_PATH_RE = /(?:\/private)?\/tmp\/[^\s"']+/g;
const RANDOM_ID_RE = /\b[0-9a-f]{8,}\b/gi;

/**
 * Normalize high-churn command output fields to improve semantic dedupe/collapse.
 * This is intentionally conservative: it strips volatility (timestamps, durations,
 * temp paths, ANSI noise) while preserving error semantics and file/line context.
 */
export function normalizeCommandOutputForComparison(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(ANSI_RE, "")
    .replace(ISO_TS_RE, "<ts>")
    .replace(CLOCK_TS_RE, "<time>")
    .replace(DATE_RE, "<date>")
    .replace(DURATION_RE, "<dur>")
    .replace(TMP_PATH_RE, "<tmp_path>")
    .replace(RANDOM_ID_RE, "<id>")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

