function isEslintJson(parsed) {
    if (!Array.isArray(parsed))
        return false;
    const first = parsed[0];
    return first != null && typeof first === "object" && "filePath" in first && "messages" in first;
}
function parseEslintJson(parsed, family, max) {
    if (!isEslintJson(parsed))
        return null;
    const findings = [];
    for (const file of parsed) {
        for (const msg of file.messages ?? []) {
            if (findings.length >= max)
                return findings;
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
function isRuffJson(parsed) {
    if (!Array.isArray(parsed))
        return false;
    const first = parsed[0];
    return first != null && typeof first === "object" && "filename" in first && ("code" in first || "message" in first);
}
function parseRuffJson(parsed, family, max) {
    if (!isRuffJson(parsed))
        return null;
    const findings = [];
    for (const d of parsed) {
        if (findings.length >= max)
            return findings;
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
function isMypyJson(parsed) {
    if (!Array.isArray(parsed))
        return false;
    const first = parsed[0];
    return first != null && typeof first === "object" && "file" in first && "severity" in first;
}
function parseMypyJson(parsed, family, max) {
    if (!isMypyJson(parsed))
        return null;
    const findings = [];
    for (const d of parsed) {
        if (findings.length >= max)
            return findings;
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
function isPylintJson(parsed) {
    if (!Array.isArray(parsed))
        return false;
    const first = parsed[0];
    return first != null && typeof first === "object" && "path" in first && "message-id" in first;
}
function parsePylintJson(parsed, family, max) {
    if (!isPylintJson(parsed))
        return null;
    const findings = [];
    for (const d of parsed) {
        if (findings.length >= max)
            return findings;
        const sev = d.type === "convention" || d.type === "refactor" ? "info" : d.type === "warning" ? "warning" : "error";
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
function parseCargoJsonLines(raw, family, max) {
    const lines = raw.split("\n").filter((l) => l.trim().startsWith("{"));
    const findings = [];
    let matched = false;
    for (const line of lines) {
        if (findings.length >= max)
            break;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (obj.reason !== "compiler-message" || !obj.message)
            continue;
        matched = true;
        const msg = obj.message;
        if (msg.level === "note" || msg.level === "help")
            continue;
        const span = msg.spans?.[0];
        findings.push({
            family: "cargo",
            severity: msg.level === "warning" ? "warning" : "error",
            file: span?.file_name,
            line: span?.line_start,
            column: span?.column_start,
            ruleId: msg.code?.code ?? undefined,
            message: msg.message ?? "cargo finding"
        });
    }
    return matched ? findings : null;
}
function isGolangCI(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    return "Issues" in parsed && Array.isArray(parsed.Issues);
}
function parseGolangCI(parsed, family, max) {
    if (!isGolangCI(parsed))
        return null;
    const findings = [];
    for (const issue of parsed.Issues ?? []) {
        if (findings.length >= max)
            return findings;
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
function isTfsec(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const obj = parsed;
    return "results" in obj && Array.isArray(obj.results) &&
        obj.results.some((r) => "rule_id" in r || "rule_description" in r);
}
function parseTfsec(parsed, family, max) {
    if (!isTfsec(parsed))
        return null;
    const findings = [];
    for (const r of parsed.results ?? []) {
        if (findings.length >= max)
            return findings;
        const sev = r.severity === "LOW" || r.severity === "MEDIUM" ? "warning" : "error";
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
function isTrivy(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    return "Results" in parsed && Array.isArray(parsed.Results);
}
function parseTrivy(parsed, family, max) {
    if (!isTrivy(parsed))
        return null;
    const findings = [];
    for (const result of parsed.Results ?? []) {
        for (const vuln of result.Vulnerabilities ?? []) {
            if (findings.length >= max)
                return findings;
            const sev = vuln.Severity === "LOW" || vuln.Severity === "MEDIUM" || vuln.Severity === "UNKNOWN"
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
const OBJECT_PARSERS = [
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
export function parseJsonDiagnostics(raw, fallbackFamily, maxFindings) {
    const trimmed = raw.trim();
    // Cargo clippy emits newline-delimited JSON, not a single object/array
    if (trimmed.includes('"reason"') && trimmed.includes('"compiler-message"')) {
        const result = parseCargoJsonLines(raw, fallbackFamily, maxFindings);
        if (result)
            return result;
    }
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return null;
    }
    for (const parser of OBJECT_PARSERS) {
        const result = parser(parsed, fallbackFamily, maxFindings);
        if (result !== null)
            return result;
    }
    return null;
}
