function mapLevel(level) {
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
export function isSarif(parsed) {
    if (typeof parsed !== "object" || parsed === null)
        return false;
    const obj = parsed;
    if (Array.isArray(obj.runs))
        return true;
    if (typeof obj.$schema === "string" && obj.$schema.includes("sarif"))
        return true;
    return false;
}
export function parseSarif(parsed, fallbackFamily, maxFindings) {
    const findings = [];
    for (const run of parsed.runs ?? []) {
        const toolName = run.tool?.driver?.name?.toLowerCase() ?? "";
        const family = inferFamily(toolName) ?? fallbackFamily;
        for (const result of run.results ?? []) {
            if (findings.length >= maxFindings)
                return findings;
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
function inferFamily(toolName) {
    if (toolName.includes("eslint"))
        return "eslint";
    if (toolName.includes("ruff"))
        return "ruff";
    if (toolName.includes("semgrep"))
        return "semgrep";
    if (toolName.includes("tfsec"))
        return "tfsec";
    if (toolName.includes("trivy"))
        return "trivy";
    if (toolName.includes("golangci"))
        return "golangci-lint";
    if (toolName.includes("pylint"))
        return "pylint";
    if (toolName.includes("mypy"))
        return "mypy";
    return undefined;
}
