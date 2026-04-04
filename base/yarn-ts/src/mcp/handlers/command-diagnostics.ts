/**
 * Heuristic extraction of compiler/test error lines for MCP tool results.
 * Keeps tool_result payloads parseable without dumping full logs (ACI-style observation).
 */

const MAX_STREAM_CHARS = 16_000;

function lineLooksDiagnostic(line: string): boolean {
  const t = line.trimEnd();
  if (t.length === 0) return false;
  if (/error TS\d+/i.test(t)) return true;
  if (/:\d+:\d+/.test(t) && (/error|warning/i.test(t) || /\.(ts|tsx|js|jsx|go|rs|py)\b/i.test(t))) return true;
  if (/\berror\b.*:/i.test(t) || /error:/i.test(t)) return true;
  if (/^\s*--- FAIL:/.test(t) || /^\s*FAIL\s/.test(t)) return true;
  if (/panic:/i.test(t) || /fatal error:/i.test(t)) return true;
  if (/^(ReferenceError|SyntaxError|TypeError|AssertionError)\b/.test(t)) return true;
  if (/^\s+\d+\)\s/.test(t)) return true;
  if (/test failed|tests failed|FAILED|Error Traceback/i.test(t)) return true;
  return false;
}

/**
 * Pull up to `maxLines` diagnostic-looking lines, stderr first then stdout.
 */
export function extractDiagnosticLines(stderr: string, stdout: string, maxLines: number): string[] {
  const stderrLines = stderr.split(/\r?\n/);
  const stdoutLines = stdout.split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of [...stderrLines, ...stdoutLines]) {
    const trimmed = line.trimEnd();
    if (!lineLooksDiagnostic(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxLines) break;
  }
  return out;
}

export function truncateStream(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

export { MAX_STREAM_CHARS };
