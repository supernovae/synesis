/**
 * Heuristic extraction of compiler/test error lines for MCP tool results.
 * Keeps tool_result payloads parseable without dumping full logs (ACI-style observation).
 */

const MAX_STREAM_CHARS = 16_000;

export interface StructuredDiagnostic {
  kind: "compile" | "test" | "runtime";
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

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

/**
 * Parse a small structured set of diagnostics for high-signal repair.
 * Supports common tsc/go test/go build patterns; safely degrades to message-only.
 */
export function extractStructuredErrors(stderr: string, stdout: string, maxItems: number): StructuredDiagnostic[] {
  const lines = [...stderr.split(/\r?\n/), ...stdout.split(/\r?\n/)];
  const out: StructuredDiagnostic[] = [];
  const seen = new Set<string>();

  const push = (row: StructuredDiagnostic): void => {
    const key = `${row.kind}|${row.file ?? ""}|${row.line ?? ""}|${row.column ?? ""}|${row.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  };

  for (const raw of lines) {
    if (out.length >= maxItems) break;
    const line = raw.trim();
    if (!line) continue;

    // tsc: src/foo.ts(12,3): error TS2322: Type 'x' is not assignable...
    const tsA = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)$/i);
    if (tsA) {
      push({
        kind: "compile",
        file: tsA[1],
        line: Number(tsA[2]),
        column: Number(tsA[3]),
        message: tsA[4],
      });
      continue;
    }

    // go/pytest-ish: path/file.go:12:34: message OR file_test.go:42: message
    const goLike = line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(.+)$/);
    if (goLike && /\.(go|ts|tsx|js|jsx|py|rs|java|kt|cs)/i.test(goLike[1])) {
      const msg = goLike[4];
      const kind: StructuredDiagnostic["kind"] =
        /^---\s*FAIL|^FAIL\b|assert|expected|got|panic/i.test(msg) ? "test" : "compile";
      push({
        kind,
        file: goLike[1],
        line: Number(goLike[2]),
        column: goLike[3] ? Number(goLike[3]) : undefined,
        message: msg,
      });
      continue;
    }

    // fallback for explicit failures/panics
    if (/^---\s*FAIL:|^FAIL\b|panic:|fatal error:/i.test(line)) {
      push({ kind: /FAIL/i.test(line) ? "test" : "runtime", message: line });
    }
  }
  return out;
}

export function truncateStream(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

export { MAX_STREAM_CHARS };
