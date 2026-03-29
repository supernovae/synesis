import type {
  ValidationEnvelope,
  ValidationFamily,
  ValidationFinding,
  ValidationNormalizerInput,
  ValidationOutputFormat
} from "./types.js";
import { tryStructuredParse } from "./parsers/index.js";
import { enrichFindings } from "./enrichment.js";

/* ── Tier B: line-regex patterns for plain-text tool output ───── */

const TS_LINE = /^(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)$/;
const RUFF_LINE = /^(.+?):(\d+):(\d+):\s*([A-Z]\d+)\s+(.+)$/;
const ESLINT_LINE = /^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+?)\s{2,}([@\w/-]+)$/;
const PYTEST_HEADER = /^_{3,}\s+(.+)\s+_{3,}$/;
const MYPY_LINE = /^(.+?):(\d+):\s*(error|warning|note):\s*(.+?)(?:\s+\[(\S+)\])?$/;
const TF_ERROR_SPLIT = /\n(?=Error: )/;
const TF_LOCATION = /on\s+([^\s]+)\s+line\s+(\d+)/i;

function detectFamily(toolName: string | undefined, raw: string): ValidationFamily {
  const t = (toolName ?? "").toLowerCase();
  if (t.includes("tsc") || raw.includes("error TS")) return "typescript";
  if (t.includes("eslint") || raw.includes("eslint")) return "eslint";
  if (t.includes("ruff")) return "ruff";
  if (t.includes("mypy")) return "mypy";
  if (t.includes("pylint")) return "pylint";
  if (t.includes("jest")) return "jest";
  if (t.includes("cargo") || t.includes("clippy") || t.includes("rustc")) return "cargo";
  if (t.includes("golangci") || t.includes("golint")) return "golangci-lint";
  if (t.includes("terraform") || t.includes("tf_validate") || t.includes("tofu")) return "terraform";
  if (t.includes("tfsec")) return "tfsec";
  if (t.includes("trivy")) return "trivy";
  if (t.includes("semgrep")) return "semgrep";
  if (t.includes("pytest") || raw.includes("FAILED") || raw.includes("E       assert")) return "pytest";
  if (t.includes("go test") || t.includes("go_test")) return "go";
  if (raw.includes("Error:") && raw.includes(" on ") && raw.includes(" line ")) return "terraform";
  return "generic";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}

function parseLineFindings(
  family: ValidationFamily,
  raw: string,
  maxFindings: number,
  maxExcerptChars: number
): ValidationFinding[] {
  if (family === "terraform") {
    return parseTerraformText(raw, maxFindings, maxExcerptChars);
  }

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
          column: Number(m[3]),
          excerpt: truncate(line, maxExcerptChars),
          message: m[4]
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
          column: Number(m[3]),
          ruleId: m[4],
          excerpt: truncate(line, maxExcerptChars),
          message: `${m[4]} ${m[5]}`
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
          column: Number(m[3]),
          ruleId: m[6],
          excerpt: truncate(line, maxExcerptChars),
          message: `${m[5]} (${m[6]})`
        });
        continue;
      }
    }

    if (family === "mypy") {
      const m = MYPY_LINE.exec(line);
      if (m) {
        findings.push({
          family,
          severity: m[3] === "warning" ? "warning" : m[3] === "note" ? "info" : "error",
          file: m[1],
          line: Number(m[2]),
          ruleId: m[5] ?? undefined,
          excerpt: truncate(line, maxExcerptChars),
          message: m[4]
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
          message: pytestContext ? `${pytestContext}: ${msg}` : msg
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

/* ── Terraform text parser ─────────────────────────────────────── */

function parseTerraformText(
  raw: string,
  maxFindings: number,
  maxExcerptChars: number
): ValidationFinding[] {
  const blocks = raw
    .split(TF_ERROR_SPLIT)
    .map((b) => b.trim())
    .filter(Boolean);
  const findings: ValidationFinding[] = [];

  for (const block of blocks) {
    if (findings.length >= maxFindings) break;

    const firstLine = block.split("\n")[0]?.trim() ?? "Unknown validation error";
    if (!firstLine.toLowerCase().startsWith("error")) continue;

    const locMatch = TF_LOCATION.exec(block);
    const file = locMatch?.[1];
    const line = locMatch?.[2] ? Number(locMatch[2]) : undefined;
    const shortMessage = firstLine.replace(/^Error:\s*/i, "").trim();

    findings.push({
      family: "terraform",
      severity: "error",
      file,
      line,
      excerpt: truncate(block, maxExcerptChars),
      message: shortMessage
    });
  }

  if (findings.length === 0 && raw.trim()) {
    findings.push({
      family: "terraform",
      severity: "error",
      message: truncate(raw.trim().split("\n")[0] ?? "Validation output available", maxExcerptChars)
    });
  }

  return findings;
}

/* ── Summary builder ───────────────────────────────────────────── */

function buildSummary(family: ValidationFamily, findings: ValidationFinding[], format: ValidationOutputFormat): string {
  const summaryLines: string[] = [];
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}${f.column ? `:${f.column}` : ""}` : "unknown";
    const rule = f.ruleId ? ` [${f.ruleId}]` : "";
    summaryLines.push(`${i + 1}. [${f.severity}] ${loc} - ${f.message}${rule}`);
    if (f.likelyRootCause) summaryLines.push(`   Root cause: ${f.likelyRootCause}`);
    if (f.suggestedNextAction) summaryLines.push(`   Action: ${f.suggestedNextAction}`);
  }
  return [
    `<VALIDATION_SUMMARY family="${family}" format="${format}" findings="${findings.length}">`,
    ...summaryLines,
    "</VALIDATION_SUMMARY>"
  ].join("\n");
}

/**
 * Normalize validation output.
 *
 * Resolution order:
 *   Tier A — Structured format (SARIF, JUnit, Checkstyle, JSON)
 *   Tier B — Deterministic line-regex parsers
 *   Enrichment — error family classification, rootCause, nextAction, fingerprint, dedup
 *   Tier C — (future) small-LLM fallback
 *   Tier D — Generic single-finding fallback
 */
export function normalizeValidationOutput(input: ValidationNormalizerInput): ValidationEnvelope {
  const family = detectFamily(input.toolName, input.rawOutput);

  // Tier A: try structured formats first (deterministic, highest fidelity)
  const structured = tryStructuredParse(input.rawOutput, family, input.maxFindings);
  if (structured && structured.findings.length > 0) {
    const enriched = enrichFindings(structured.findings);
    const summary = buildSummary(family, enriched, structured.format);
    return {
      family,
      outputFormat: structured.format,
      findings: enriched,
      rawChars: input.rawOutput.length,
      normalizedChars: summary.length,
      truncated: false,
      summary
    };
  }

  // Tier B: line-regex parsers for plain-text output
  const findings = parseLineFindings(family, input.rawOutput, input.maxFindings, input.maxExcerptChars);
  const enriched = enrichFindings(findings);
  const summary = buildSummary(family, enriched, "text");
  return {
    family,
    outputFormat: "text",
    findings: enriched,
    rawChars: input.rawOutput.length,
    normalizedChars: summary.length,
    truncated: false,
    summary
  };
}
