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
  let inPythonTraceback = false;
  let pendingPyFrame: { file?: string; line?: number } | null = null;

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

    // rustc: --> src/main.rs:12:9
    const rustArrow = line.match(/^-->\s+(.+?):(\d+):(\d+)$/);
    if (rustArrow && /\.(rs)$/i.test(rustArrow[1])) {
      pendingPyFrame = null;
      push({
        kind: "compile",
        file: rustArrow[1],
        line: Number(rustArrow[2]),
        column: Number(rustArrow[3]),
        message: "rustc diagnostic location",
      });
      continue;
    }

    // rustc/cargo one-line errors: error[E0432]: unresolved import `x` at src/main.rs:3:5
    const rustInline = line.match(/^error(?:\[[A-Z]\d+\])?:\s*(.+?)\s+at\s+(.+?):(\d+):(\d+)$/i);
    if (rustInline && /\.(rs)$/i.test(rustInline[2])) {
      pendingPyFrame = null;
      push({
        kind: "compile",
        file: rustInline[2],
        line: Number(rustInline[3]),
        column: Number(rustInline[4]),
        message: rustInline[1],
      });
      continue;
    }

    // Traceback markers.
    if (/^Traceback \(most recent call last\):$/i.test(line)) {
      inPythonTraceback = true;
      pendingPyFrame = null;
      continue;
    }
    const pyFrame = line.match(/^File "(.+?)", line (\d+)(?:, in .+)?$/);
    if (pyFrame) {
      inPythonTraceback = true;
      pendingPyFrame = { file: pyFrame[1], line: Number(pyFrame[2]) };
      continue;
    }
    // Exception line after traceback frame: ValueError: bad value
    const pyExc = line.match(/^([A-Za-z_][A-Za-z0-9_]*(?:Error|Exception|Warning)):\s+(.+)$/);
    if (pyExc && inPythonTraceback) {
      push({
        kind: "runtime",
        file: pendingPyFrame?.file,
        line: pendingPyFrame?.line,
        message: `${pyExc[1]}: ${pyExc[2]}`,
      });
      pendingPyFrame = null;
      continue;
    }

    // Pytest assertion short form: path/test_file.py:42: AssertionError: ...
    const pytestLike = line.match(/^(.+?_test\.py|.+?test_.+?\.py|.+?\.py):(\d+):\s*(AssertionError|E\s+.+|FAILED.*)$/i);
    if (pytestLike) {
      push({
        kind: "test",
        file: pytestLike[1],
        line: Number(pytestLike[2]),
        message: pytestLike[3].replace(/^E\s+/, ""),
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

    // rustc title line without explicit location.
    if (/^error(?:\[[A-Z]\d+\])?:/i.test(line) && /rust|cargo|crate|borrow/i.test(line)) {
      push({ kind: "compile", message: line.replace(/^error(?:\[[A-Z]\d+\])?:\s*/i, "") });
      continue;
    }

    // Pytest failed summary line.
    if (/^FAILED\s+.+?::.+?\s+-\s+.+$/i.test(line)) {
      push({ kind: "test", message: line });
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
