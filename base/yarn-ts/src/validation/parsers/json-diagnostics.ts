/**
 * Generic JSON diagnostics deterministic parser.
 *
 * Handles structured JSON output from:
 *   - ESLint (--format json)         → array of { filePath, messages[] }
 *   - Ruff (--output-format json)    → array of { filename, code, message, location }
 *   - mypy (--output json)           → array of { file, line, column, severity, message }
 *   - pylint (--output-format json)  → array of { path, line, column, type, message, message-id }
 *   - cargo clippy (--message-format=json) → newline-delimited JSON with "reason":"compiler-message"
 *   - golangci-lint (--out-format json)    → { Issues: [{ Pos: {Filename, Line, Column}, Text }] }
 *   - trivy (--format json)          → { Results: [{ Vulnerabilities: [...] }] }
 *   - tfsec (--format json)          → { results: [{ rule_id, description, location }] }
 *
 * Each sub-parser is tried in order; first match wins. Falls back to null
 * when JSON doesn't match any known schema.
 */
import type { ValidationFamily, ValidationFinding, ValidationSeverity } from "../types.js";

type SubParser = (parsed: unknown, family: ValidationFamily, max: number) => ValidationFinding[] | null;

/* ── ESLint JSON ───────────────────────────────────────────────── */

interface EslintFileResult {
  filePath?: string;
  messages?: Array<{
    ruleId?: string;
    severity?: number;
    message?: string;
    line?: number;
    column?: number;
  }>;
}

function isEslintJson(parsed: unknown): parsed is EslintFileResult[] {
  if (!Array.isArray(parsed)) return false;
  const first = parsed[0];
  return first != null && typeof first === "object" && "filePath" in first && "messages" in first;
}

function parseEslintJson(parsed: unknown, family: ValidationFamily, max: number): ValidationFinding[] | null {
  if (!isEslintJson(parsed)) return null;
  const findings: ValidationFinding[] = [];
  for (const file of parsed) {
    for (const msg of file.messages ?? []) {
      if (findings.length >= max) return findings;
      findings.push({
        family: "eslint",
        severity: msg.severity === 1 ? "warning" : "error",
        file: file.filePath,
        line: msg.line,
        column: msg.column,
        ruleId: msg.ruleId ?? undefined,
        message: msg.message ?? "ESLint issue"
      });
    }
  }
  return findings;
}

/* ── Ruff JSON ─────────────────────────────────────────────────── */

interface RuffDiagnostic {
  code?: string;
  message?: string;
  filename?: string;
  location?: { row?: number; column?: number };
  fix?: { message?: string };
}

function isRuffJson(parsed: unknown): parsed is RuffDiagnostic[] {
  if (!Array.isArray(parsed)) return false;
  const first = parsed[0];
  return first != null && typeof first === "object" && "filename" in first && ("code" in first || "message" in first);
}

function parseRuffJson(parsed: unknown, family: ValidationFamily, max: number): ValidationFinding[] | null {
  if (!isRuffJson(parsed)) return null;
  const findings: ValidationFinding[] = [];
  for (const d of parsed) {
    if (findings.length >= max) return findings;
    findings.push({
      family: "ruff",
      severity: "error",
      file: d.filename,
      line: d.location?.row,
      column: d.location?.column,
      ruleId: d.code ?? undefined,
      message: d.code ? `${d.code} ${d.message ?? ""}`.trim() : (d.message ?? "Ruff finding"),
      likelyFix: d.fix?.message
    });
  }
  return findings;
}

/* ── mypy JSON ─────────────────────────────────────────────────── */

interface MypyDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity?: string;
  message?: string;
  code?: string;
}

function isMypyJson(parsed: unknown): parsed is MypyDiagnostic[] {
  if (!Array.isArray(parsed)) return false;
  const first = parsed[0];
  return first != null && typeof first === "object" && "file" in first && "severity" in first;
}

function parseMypyJson(parsed: unknown, family: ValidationFamily, max: number): ValidationFinding[] | null {
  if (!isMypyJson(parsed)) return null;
  const findings: ValidationFinding[] = [];
  for (const d of parsed) {
    if (findings.length >= max) return findings;
    findings.push({
      family: "mypy",
      severity: d.severity === "warning" ? "warning" : d.severity === "note" ? "info" : "error",
      file: d.file,
      line: d.line,
      column: d.column,
      ruleId: d.code ?? undefined,
      message: d.message ?? "mypy finding"
    });
  }
  return findings;
}

/* ── pylint JSON ───────────────────────────────────────────────── */

interface PylintDiagnostic {
  path?: string;
  line?: number;
  column?: number;
  type?: string;
  message?: string;
  "message-id"?: string;
  symbol?: string;
}

function isPylintJson(parsed: unknown): parsed is PylintDiagnostic[] {
  if (!Array.isArray(parsed)) return false;
  const first = parsed[0];
  return first != null && typeof first === "object" && "path" in first && "message-id" in first;
}

function parsePylintJson(parsed: unknown, family: ValidationFamily, max: number): ValidationFinding[] | null {
  if (!isPylintJson(parsed)) return null;
  const findings: ValidationFinding[] = [];
  for (const d of parsed) {
    if (findings.length >= max) return findings;
    const sev: ValidationSeverity =
      d.type === "convention" || d.type === "refactor" ? "info" : d.type === "warning" ? "warning" : "error";
    findings.push({
      family: "pylint",
      severity: sev,
      file: d.path,
      line: d.line,
      column: d.column,
      ruleId: d["message-id"] ?? d.symbol ?? undefined,
      message: d.message ?? "pylint finding"
    });
  }
  return findings;
}

/* ── Cargo clippy / rustc JSON ─────────────────────────────────── */

interface CargoMessage {
  reason?: string;
  message?: {
    level?: string;
    message?: string;
    code?: { code?: string } | null;
    spans?: Array<{
      file_name?: string;
      line_start?: number;
      column_start?: number;
      label?: string;
      suggested_replacement?: string;
      suggestion_applicability?: string;
    }>;
    children?: Array<{ level?: string; message?: string }>;
  };
}

function cargoLikelyFix(msg: CargoMessage["message"]): string | undefined {
  const spanSuggestion = msg?.spans
    ?.map((span) => span.suggested_replacement?.trim())
    .find((replacement) => replacement && replacement.length > 0);
  if (spanSuggestion) return `Apply suggested replacement: ${spanSuggestion}`;
  const childSuggestion = msg?.children
    ?.find((child) => child.level === "help" && child.message?.trim())
    ?.message
    ?.trim();
  return childSuggestion || undefined;
}

function parseCargoJsonLines(raw: string, family: ValidationFamily, max: number): ValidationFinding[] | null {
  const lines = raw.split("\n").filter((l) => l.trim().startsWith("{"));
  const findings: ValidationFinding[] = [];
  let matched = false;

  for (const line of lines) {
    if (findings.length >= max) break;
    let obj: CargoMessage;
    try {
      obj = JSON.parse(line) as CargoMessage;
    } catch {
      continue;
    }
    if (obj.reason !== "compiler-message" || !obj.message) continue;
    matched = true;
    const msg = obj.message;
    if (msg.level === "note" || msg.level === "help") continue;

    const span = msg.spans?.[0];
    findings.push({
      family: "cargo",
      severity: msg.level === "warning" ? "warning" : "error",
      file: span?.file_name,
      line: span?.line_start,
      column: span?.column_start,
      ruleId: msg.code?.code ?? undefined,
      message: msg.message ?? "cargo finding",
      likelyFix: cargoLikelyFix(msg)
    });
  }
  return matched ? findings : null;
}

/* ── golangci-lint JSON ────────────────────────────────────────── */

interface GolangCIResult {
  Issues?: Array<{
    FromLinter?: string;
    Text?: string;
    Severity?: string;
    Pos?: { Filename?: string; Line?: number; Column?: number };
  }>;
}

function isGolangCI(parsed: unknown): parsed is GolangCIResult {
  if (typeof parsed !== "object" || parsed === null) return false;
  return "Issues" in parsed && Array.isArray((parsed as GolangCIResult).Issues);
}

function parseGolangCI(parsed: unknown, family: ValidationFamily, max: number): ValidationFinding[] | null {
  if (!isGolangCI(parsed)) return null;
  const findings: ValidationFinding[] = [];
  for (const issue of parsed.Issues ?? []) {
    if (findings.length >= max) return findings;
    findings.push({
      family: "golangci-lint",
      severity: issue.Severity === "warning" ? "warning" : "error",
      file: issue.Pos?.Filename,
      line: issue.Pos?.Line,
      column: issue.Pos?.Column,
      ruleId: issue.FromLinter ?? undefined,
      message: issue.Text ?? "golangci-lint finding"
    });
  }
  return findings;
}

/* ── tfsec JSON ────────────────────────────────────────────────── */

interface TfsecResult {
  results?: Array<{
    rule_id?: string;
    rule_description?: string;
    description?: string;
    severity?: string;
    location?: { filename?: string; start_line?: number; end_line?: number };
  }>;
}

function isTfsec(parsed: unknown): parsed is TfsecResult {
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return "results" in obj && Array.isArray(obj.results) &&
    (obj.results as Array<Record<string, unknown>>).some((r) => "rule_id" in r || "rule_description" in r);
}

function parseTfsec(parsed: unknown, family: ValidationFamily, max: number): ValidationFinding[] | null {
  if (!isTfsec(parsed)) return null;
  const findings: ValidationFinding[] = [];
  for (const r of parsed.results ?? []) {
    if (findings.length >= max) return findings;
    const sev: ValidationSeverity =
      r.severity === "LOW" || r.severity === "MEDIUM" ? "warning" : "error";
    findings.push({
      family: "tfsec",
      severity: sev,
      file: r.location?.filename,
      line: r.location?.start_line,
      ruleId: r.rule_id ?? undefined,
      message: r.description ?? r.rule_description ?? "tfsec finding"
    });
  }
  return findings;
}

/* ── trivy JSON ────────────────────────────────────────────────── */

interface TrivyResult {
  Results?: Array<{
    Target?: string;
    Vulnerabilities?: Array<{
      VulnerabilityID?: string;
      Severity?: string;
      Title?: string;
      PkgName?: string;
      InstalledVersion?: string;
      FixedVersion?: string;
    }>;
  }>;
}

function isTrivy(parsed: unknown): parsed is TrivyResult {
  if (typeof parsed !== "object" || parsed === null) return false;
  return "Results" in parsed && Array.isArray((parsed as TrivyResult).Results);
}

function parseTrivy(parsed: unknown, family: ValidationFamily, max: number): ValidationFinding[] | null {
  if (!isTrivy(parsed)) return null;
  const findings: ValidationFinding[] = [];
  for (const result of parsed.Results ?? []) {
    for (const vuln of result.Vulnerabilities ?? []) {
      if (findings.length >= max) return findings;
      const sev: ValidationSeverity =
        vuln.Severity === "LOW" || vuln.Severity === "MEDIUM" || vuln.Severity === "UNKNOWN"
          ? "warning"
          : "error";
      const fix = vuln.FixedVersion ? `Upgrade ${vuln.PkgName ?? "package"} to ${vuln.FixedVersion}` : undefined;
      findings.push({
        family: "trivy",
        severity: sev,
        file: result.Target,
        ruleId: vuln.VulnerabilityID ?? undefined,
        message: vuln.Title
          ? `${vuln.VulnerabilityID ?? ""} ${vuln.Title} (${vuln.PkgName ?? ""}@${vuln.InstalledVersion ?? ""})`.trim()
          : `${vuln.VulnerabilityID ?? "trivy finding"}`,
        likelyFix: fix
      });
    }
  }
  return findings;
}

/* ── Registry ──────────────────────────────────────────────────── */

const OBJECT_PARSERS: SubParser[] = [
  parseEslintJson,
  parseRuffJson,
  parseMypyJson,
  parsePylintJson,
  parseGolangCI,
  parseTfsec,
  parseTrivy
];

/**
 * Try to parse JSON diagnostic output.
 * Returns findings if any sub-parser matches, null otherwise.
 *
 * `raw` is the original string — needed for cargo's newline-delimited JSON.
 */
export function parseJsonDiagnostics(
  raw: string,
  fallbackFamily: ValidationFamily,
  maxFindings: number
): ValidationFinding[] | null {
  const trimmed = raw.trim();

  // Cargo clippy emits newline-delimited JSON, not a single object/array
  if (trimmed.includes('"reason"') && trimmed.includes('"compiler-message"')) {
    const result = parseCargoJsonLines(raw, fallbackFamily, maxFindings);
    if (result) return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  for (const parser of OBJECT_PARSERS) {
    const result = parser(parsed, fallbackFamily, maxFindings);
    if (result !== null) return result;
  }

  return null;
}
