import type {
  ValidationEnvelope,
  ValidationFamily,
  ValidationFinding,
  ValidationNormalizerInput
} from "./types.js";

const TS_LINE = /^(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)$/;
const RUFF_LINE = /^(.+?):(\d+):(\d+):\s*([A-Z]\d+)\s+(.+)$/;
const ESLINT_LINE = /^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+?)\s{2,}([@\w/-]+)$/;
const PYTEST_HEADER = /^_{3,}\s+(.+)\s+_{3,}$/;

function detectFamily(toolName: string | undefined, raw: string): ValidationFamily {
  const t = (toolName ?? "").toLowerCase();
  if (t.includes("tsc") || raw.includes("TS")) return "typescript";
  if (t.includes("eslint") || raw.includes("eslint")) return "eslint";
  if (t.includes("ruff")) return "ruff";
  if (t.includes("pytest") || raw.includes("FAILED") || raw.includes("assert")) return "pytest";
  return "generic";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

function likelyFix(family: ValidationFamily, message: string): string | undefined {
  if (family === "typescript" && message.includes("not assignable")) return "Align types or add explicit conversion.";
  if (family === "eslint" && message.toLowerCase().includes("unused")) return "Remove unused symbol or prefix with underscore.";
  if (family === "ruff" && message.includes("unused")) return "Remove unused import/variable or refactor usage.";
  if (family === "pytest") return "Fix failing assertion or update fixture/expected output.";
  return undefined;
}

function parseFindings(family: ValidationFamily, raw: string, maxFindings: number, maxExcerptChars: number): ValidationFinding[] {
  const lines = raw.split("\n");
  const findings: ValidationFinding[] = [];
  let pytestContext = "";

  for (const line of lines) {
    if (findings.length >= maxFindings) break;

    if (family === "typescript") {
      const m = TS_LINE.exec(line);
      if (m) {
        findings.push({
          family,
          severity: "error",
          file: m[1],
          line: Number(m[2]),
          excerpt: truncate(line, maxExcerptChars),
          message: m[4],
          likelyFix: likelyFix(family, m[4])
        });
        continue;
      }
    }

    if (family === "ruff") {
      const m = RUFF_LINE.exec(line);
      if (m) {
        findings.push({
          family,
          severity: "error",
          file: m[1],
          line: Number(m[2]),
          excerpt: truncate(line, maxExcerptChars),
          message: `${m[4]} ${m[5]}`,
          likelyFix: likelyFix(family, m[5])
        });
        continue;
      }
    }

    if (family === "eslint") {
      const m = ESLINT_LINE.exec(line);
      if (m) {
        findings.push({
          family,
          severity: m[4] === "warning" ? "warning" : "error",
          file: m[1],
          line: Number(m[2]),
          excerpt: truncate(line, maxExcerptChars),
          message: `${m[5]} (${m[6]})`,
          likelyFix: likelyFix(family, m[5])
        });
        continue;
      }
    }

    if (family === "pytest") {
      const h = PYTEST_HEADER.exec(line);
      if (h) {
        pytestContext = h[1];
        continue;
      }
      if (line.trim().startsWith("E       ")) {
        const msg = line.trim().slice(8);
        findings.push({
          family,
          severity: "error",
          excerpt: truncate(line, maxExcerptChars),
          message: pytestContext ? `${pytestContext}: ${msg}` : msg,
          likelyFix: likelyFix(family, msg)
        });
        continue;
      }
    }
  }

  if (findings.length === 0 && raw.trim()) {
    findings.push({
      family,
      severity: "error",
      message: truncate(raw.trim().split("\n")[0] ?? "Validation output available", maxExcerptChars)
    });
  }

  return findings;
}

export function normalizeValidationOutput(input: ValidationNormalizerInput): ValidationEnvelope {
  const family = detectFamily(input.toolName, input.rawOutput);
  const findings = parseFindings(family, input.rawOutput, input.maxFindings, input.maxExcerptChars);
  const summaryLines = findings.map((f, i) => {
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "unknown";
    return `${i + 1}. [${f.severity}] ${loc} - ${f.message}${f.likelyFix ? ` Fix: ${f.likelyFix}` : ""}`;
  });
  const summary = [
    `<VALIDATION_SUMMARY family="${family}" findings="${findings.length}">`,
    ...summaryLines,
    "</VALIDATION_SUMMARY>"
  ].join("\n");
  return {
    family,
    findings,
    rawChars: input.rawOutput.length,
    normalizedChars: summary.length,
    truncated: false,
    summary
  };
}
