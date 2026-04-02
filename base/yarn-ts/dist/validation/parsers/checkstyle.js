const FILE_BLOCK_RE = /<file\b([^>]*)>([\s\S]*?)<\/file>/g;
const ERROR_TAG_RE = /<error\b([^>]*)\/?>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;
function extractAttrs(tag) {
    const attrs = {};
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(tag)) !== null) {
        attrs[m[1]] = m[2];
    }
    return attrs;
}
function mapSeverity(s) {
    switch (s) {
        case "error":
            return "error";
        case "warning":
            return "warning";
        case "info":
        case "ignore":
            return "info";
        default:
            return "error";
    }
}
export function isCheckstyle(raw) {
    const trimmed = raw.trimStart();
    return trimmed.includes("<checkstyle");
}
export function parseCheckstyle(raw, fallbackFamily, maxFindings) {
    const findings = [];
    FILE_BLOCK_RE.lastIndex = 0;
    let fileMatch;
    while ((fileMatch = FILE_BLOCK_RE.exec(raw)) !== null) {
        if (findings.length >= maxFindings)
            break;
        const fileAttrs = extractAttrs(fileMatch[1]);
        const fileName = fileAttrs.name;
        const body = fileMatch[2];
        ERROR_TAG_RE.lastIndex = 0;
        let errorMatch;
        while ((errorMatch = ERROR_TAG_RE.exec(body)) !== null) {
            if (findings.length >= maxFindings)
                break;
            const attrs = extractAttrs(errorMatch[1]);
            findings.push({
                family: fallbackFamily,
                severity: mapSeverity(attrs.severity),
                file: fileName,
                line: attrs.line ? Number(attrs.line) : undefined,
                column: attrs.column ? Number(attrs.column) : undefined,
                ruleId: attrs.source,
                message: attrs.message ?? "Checkstyle finding"
            });
        }
    }
    return findings;
}
