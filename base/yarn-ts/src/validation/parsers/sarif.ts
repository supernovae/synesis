/**
 * SARIF v2.1.0 deterministic parser.
 *
 * Handles output from: ESLint (sarif formatter), tfsec, trivy, semgrep,
 * CodeQL, checkov, and any tool emitting OASIS SARIF.
 */
import type { ValidationFamily, ValidationFinding, ValidationSeverity } from "../types.js";

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string };
    region?: { startLine?: number; startColumn?: number };
  };
}

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: SarifLocation[];
}

interface SarifRun {
  tool?: { driver?: { name?: string } };
  results?: SarifResult[];
}

interface SarifLog {
  $schema?: string;
  version?: string;
  runs?: SarifRun[];
}

function mapLevel(level: string | undefined): ValidationSeverity {
  switch (level) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "note":
    case "none":
      return "info";
    default:
      return "error";
  }
}

export function isSarif(parsed: unknown): parsed is SarifLog {
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.runs)) return true;
  if (typeof obj.$schema === "string" && obj.$schema.includes("sarif")) return true;
  return false;
}

export function parseSarif(
  parsed: SarifLog,
  fallbackFamily: ValidationFamily,
  maxFindings: number
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  for (const run of parsed.runs ?? []) {
    const toolName = run.tool?.driver?.name?.toLowerCase() ?? "";
    const family = inferFamily(toolName) ?? fallbackFamily;

    for (const result of run.results ?? []) {
      if (findings.length >= maxFindings) return findings;

      const loc = result.locations?.[0]?.physicalLocation;
      const file = loc?.artifactLocation?.uri;
      const line = loc?.region?.startLine;
      const column = loc?.region?.startColumn;

      findings.push({
        family,
        severity: mapLevel(result.level),
        file,
        line,
        column,
        ruleId: result.ruleId,
        message: result.message?.text ?? result.ruleId ?? "SARIF finding"
      });
    }
  }

  return findings;
}

function inferFamily(toolName: string): ValidationFamily | undefined {
  if (toolName.includes("eslint")) return "eslint";
  if (toolName.includes("ruff")) return "ruff";
  if (toolName.includes("semgrep")) return "semgrep";
  if (toolName.includes("tfsec")) return "tfsec";
  if (toolName.includes("trivy")) return "trivy";
  if (toolName.includes("golangci")) return "golangci-lint";
  if (toolName.includes("pylint")) return "pylint";
  if (toolName.includes("mypy")) return "mypy";
  return undefined;
}
