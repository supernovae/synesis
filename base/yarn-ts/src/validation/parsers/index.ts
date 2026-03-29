/**
 * Structured-format detection and parser registry.
 *
 * Detection order (Tier A first):
 *   1. JSON → SARIF check → tool-specific JSON sub-parsers
 *   2. XML  → JUnit check → Checkstyle check
 *   3. Fall through to null (caller uses Tier B line-regex parsers)
 */
import type { ValidationFamily, ValidationFinding } from "../types.js";
import { isSarif, parseSarif } from "./sarif.js";
import { isJunit, parseJunit } from "./junit.js";
import { isCheckstyle, parseCheckstyle } from "./checkstyle.js";
import { parseJsonDiagnostics } from "./json-diagnostics.js";

export type { ValidationOutputFormat } from "../types.js";

export interface StructuredParseResult {
  format: "sarif" | "junit" | "checkstyle" | "json";
  findings: ValidationFinding[];
}

/**
 * Attempt deterministic structured-format parsing.
 * Returns null when the output is not a recognized structured format
 * (caller should fall back to line-regex parsers).
 */
export function tryStructuredParse(
  raw: string,
  fallbackFamily: ValidationFamily,
  maxFindings: number
): StructuredParseResult | null {
  const trimmed = raw.trimStart();

  // JSON-shaped: try SARIF first, then tool-specific JSON schemas
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Might be newline-delimited JSON (cargo). Fall through to jsonDiagnostics.
      parsed = null;
    }

    if (parsed !== null && isSarif(parsed)) {
      return { format: "sarif", findings: parseSarif(parsed, fallbackFamily, maxFindings) };
    }

    const jsonFindings = parseJsonDiagnostics(raw, fallbackFamily, maxFindings);
    if (jsonFindings !== null) {
      return { format: "json", findings: jsonFindings };
    }
  } else if (trimmed.startsWith("{") === false) {
    // Newline-delimited JSON (cargo clippy) — lines start with `{`
    if (trimmed.includes('"reason"') && trimmed.includes('"compiler-message"')) {
      const jsonFindings = parseJsonDiagnostics(raw, fallbackFamily, maxFindings);
      if (jsonFindings !== null) {
        return { format: "json", findings: jsonFindings };
      }
    }
  }

  // XML-shaped: JUnit or Checkstyle
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<testsuite") || trimmed.startsWith("<testsuites") || trimmed.startsWith("<checkstyle")) {
    if (isJunit(raw)) {
      return { format: "junit", findings: parseJunit(raw, fallbackFamily, maxFindings) };
    }
    if (isCheckstyle(raw)) {
      return { format: "checkstyle", findings: parseCheckstyle(raw, fallbackFamily, maxFindings) };
    }
  }

  return null;
}
