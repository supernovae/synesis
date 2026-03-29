/**
 * JUnit XML deterministic parser.
 *
 * Handles output from: pytest --junitxml, jest-junit, go-junit-report,
 * cargo2junit, tfsec --format junit, and any standard JUnit XML emitter.
 *
 * Uses regex on well-defined schema elements — no XML library needed.
 */
import type { ValidationFamily, ValidationFinding, ValidationSeverity } from "../types.js";

const TESTSUITE_RE = /<testsuite\b[^>]*>/g;
const TESTCASE_RE = /<testcase\b([^>]*[^/])>([\s\S]*?)<\/testcase>/g;
const SELF_CLOSING_TESTCASE_RE = /<testcase\b([^>]*)\/>/g;
const FAILURE_RE = /<failure\b([^>]*)(?:\/>|>([\s\S]*?)<\/failure>)/;
const ERROR_RE = /<error\b([^>]*)(?:\/>|>([\s\S]*?)<\/error>)/;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function extractAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(tag)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

export function isJunit(raw: string): boolean {
  const trimmed = raw.trimStart();
  return (
    trimmed.startsWith("<?xml") && (trimmed.includes("<testsuite") || trimmed.includes("<testsuites"))
  ) || trimmed.startsWith("<testsuite") || trimmed.startsWith("<testsuites");
}

export function parseJunit(
  raw: string,
  fallbackFamily: ValidationFamily,
  maxFindings: number
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  // Self-closing testcases (no body = pass) — skip them.
  // Only extract testcases with a body that contains <failure> or <error>.
  TESTCASE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TESTCASE_RE.exec(raw)) !== null) {
    if (findings.length >= maxFindings) break;

    const attrsStr = match[1];
    const body = match[2];
    const attrs = extractAttrs(attrsStr);

    const failureMatch = FAILURE_RE.exec(body);
    const errorMatch = ERROR_RE.exec(body);
    const issueMatch = failureMatch ?? errorMatch;

    if (!issueMatch) continue;

    const severity: ValidationSeverity = errorMatch && !failureMatch ? "error" : "error";
    const issueAttrs = extractAttrs(issueMatch[1]);
    const stackTrace = (issueMatch[2] ?? "").trim();

    const testName = attrs.name ?? "unknown test";
    const className = attrs.classname;
    const message = issueAttrs.message ?? stackTrace.split("\n")[0] ?? "Test failed";
    const file = extractFileFromClassname(className);
    const line = extractLineFromTrace(stackTrace);

    findings.push({
      family: fallbackFamily,
      severity,
      file,
      line,
      ruleId: attrs.name,
      message: className ? `${className}::${testName}: ${message}` : `${testName}: ${message}`,
    });
  }

  return findings;
}

function extractFileFromClassname(classname: string | undefined): string | undefined {
  if (!classname) return undefined;
  const dotPath = classname.replace(/\./g, "/");
  if (dotPath.includes("/")) return dotPath;
  return classname;
}

/**
 * Best-effort line extraction from stack trace first line.
 * Patterns: "file.py:42", "at File.java:42", "(File.kt:42)"
 */
function extractLineFromTrace(trace: string): number | undefined {
  const m = /:(\d+)/.exec(trace);
  return m ? Number(m[1]) : undefined;
}
