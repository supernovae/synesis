export type VerificationFailure = {
  tool: string;
  preset?: string;
  summary: string;
  category: "format_or_lint" | "build_or_typecheck" | "test" | "runtime";
  topErrorLines: string[];
};

export type VerificationAssessment = {
  verificationSignals: number;
  failingSignals: number;
  failures: VerificationFailure[];
  hasBlockingFailures: boolean;
};

export type CriticAssessment = {
  blocked: boolean;
  findings: string[];
  suggestedNextActions: string[];
  source: "deterministic" | "llm_fallback";
};

const VERIFY_TOOL_HINTS = ["run_lint", "run_build", "run_test", "format_code"];

function parseJsonIfPossible(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function classifyVerificationCategory(text: string): VerificationFailure["category"] {
  const t = text.toLowerCase();
  if (/(pytest|jest|test\b|assert|--- fail|^fail\b)/i.test(t)) return "test";
  if (/(format|fmt|prettier|ruff format|gofmt|clippy|eslint|lint|unused|never used|\bf\d{3,4}\b)/i.test(t)) return "format_or_lint";
  if (/(build|compile|type|ts\d+|mypy|vet|cargo check|go build)/i.test(t)) return "build_or_typecheck";
  return "runtime";
}

function extractBestVerificationPayload(
  value: unknown,
  toolNameHint: string,
  depth = 0,
  seen = new Set<object>(),
): { ok: boolean; preset?: string; summary: string; errorLines: string[] } | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = parseJsonIfPossible(value);
    if (!parsed) return null;
    return extractBestVerificationPayload(parsed, toolNameHint, depth + 1, seen);
  }
  if (typeof value !== "object") return null;
  if (seen.has(value as object)) return null;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const row of value) {
      const found = extractBestVerificationPayload(row, toolNameHint, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  const row = value as Record<string, unknown>;
  const ok = typeof row.ok === "boolean" ? row.ok : undefined;
  const preset = typeof row.preset === "string" ? row.preset : undefined;
  const summary = typeof row.summary === "string" ? row.summary : "";
  const errorLines = Array.isArray(row.errorLines)
    ? row.errorLines.map((l) => String(l)).filter(Boolean)
    : [];
  const command = typeof row.command === "string" ? row.command : "";
  const likelyVerify = VERIFY_TOOL_HINTS.some((x) => toolNameHint.includes(x))
    || Boolean(preset)
    || /(lint|build|test|format|compile|pytest|eslint|mypy|tsc|cargo|go test|go build)/i.test(command);
  if (ok !== undefined && likelyVerify) {
    return { ok, preset, summary: summary || command || `verification via ${toolNameHint}`, errorLines };
  }
  for (const key of ["result", "content", "data", "payload", "output", "text"]) {
    if (!(key in row)) continue;
    const nested = extractBestVerificationPayload(row[key], toolNameHint, depth + 1, seen);
    if (nested) return nested;
  }
  return null;
}

export function assessVerificationFromMessages(
  messages: Array<{ role: string; content: unknown; name?: string }>,
): VerificationAssessment {
  const failures: VerificationFailure[] = [];
  let verificationSignals = 0;
  for (const m of messages) {
    if (m.role !== "tool" && m.role !== "tool_result") continue;
    const toolName = String(m.name ?? "").toLowerCase();
    const payload = extractBestVerificationPayload(m.content, toolName);
    if (!payload) continue;
    verificationSignals += 1;
    if (payload.ok) continue;
    const category = classifyVerificationCategory(`${payload.summary}\n${payload.errorLines.join("\n")}`);
    failures.push({
      tool: toolName || "verification_tool",
      preset: payload.preset,
      summary: payload.summary || "verification failed",
      category,
      topErrorLines: payload.errorLines.slice(0, 3),
    });
  }
  return {
    verificationSignals,
    failingSignals: failures.length,
    failures,
    hasBlockingFailures: failures.length > 0,
  };
}

export function evaluateDeterministicPreFinalize(
  verification: VerificationAssessment,
  recentToolNames: string[],
): CriticAssessment {
  const findings: string[] = [];
  const next: string[] = [];
  const hasMutation = recentToolNames.some((n) => n === "str_replace" || n === "write_file");
  if (verification.hasBlockingFailures) {
    findings.push(`Blocking verification failures remain (${verification.failingSignals}).`);
    next.push("Fix failing verification diagnostics and rerun the same verification preset.");
  }
  if (hasMutation && verification.verificationSignals === 0) {
    findings.push("Code mutation detected but no verification evidence in this turn.");
    next.push("Run run_lint and run_build first, then run_test if build/typecheck is clean.");
  }
  return {
    blocked: findings.length > 0,
    findings,
    suggestedNextActions: next,
    source: "deterministic",
  };
}
