function parseNpmAuditJson(raw) {
    try {
        const j = JSON.parse(raw.trim());
        const meta = j.metadata?.vulnerabilities;
        const bySev = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
        let total = 0;
        if (meta) {
            for (const k of ["critical", "high", "moderate", "low", "info"]) {
                const n = meta[k];
                if (typeof n === "number") {
                    bySev[k] = n;
                    total += n;
                }
            }
            if (total === 0 && typeof meta.total === "number")
                total = meta.total;
        }
        const packages = [];
        if (j.vulnerabilities && typeof j.vulnerabilities === "object") {
            for (const [pkg, v] of Object.entries(j.vulnerabilities)) {
                if (v && typeof v === "object" && typeof v.severity === "string") {
                    packages.push(`${pkg} (${v.severity})`);
                }
                else {
                    packages.push(pkg);
                }
            }
        }
        const fixes = [];
        if (raw.includes("audit fix"))
            fixes.push("npm audit fix");
        if (raw.includes("force"))
            fixes.push("npm audit fix --force (review)");
        if (j.metadata !== undefined || j.vulnerabilities !== undefined) {
            return { total: total || packages.length, bySev, packages, fixes };
        }
    }
    catch {
        return null;
    }
    return null;
}
function parseNpmAuditText(raw) {
    const bySev = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
    const packages = [];
    const fixes = [];
    const paren = raw.match(/(\d+)\s+vulnerabilit(?:y|ies)\s*\(([^)]+)\)/i);
    let total = 0;
    if (paren) {
        total = parseInt(paren[1], 10);
        const inner = paren[2];
        for (const m of inner.matchAll(/(\d+)\s+(critical|high|moderate|low|info)/gi)) {
            const n = parseInt(m[1], 10);
            const sev = m[2].toLowerCase();
            if (sev in bySev)
                bySev[sev] += n;
        }
    }
    const found = raw.match(/found\s+(\d+)\s+vulnerabilit/i);
    if (found)
        total = Math.max(total, parseInt(found[1], 10));
    for (const line of raw.split("\n")) {
        const sevLine = line.match(/Severity:\s*(\w+)/i);
        if (sevLine) {
            const pkgPrev = raw.split("\n").slice(0, raw.split("\n").indexOf(line)).reverse().find((l) => l.trim() && !l.startsWith("#"));
            if (pkgPrev && /^[@\w./-]+\s+[\d.]+$/i.test(pkgPrev.trim())) {
                packages.push(`${pkgPrev.trim()} [${sevLine[1]}]`);
            }
        }
    }
    const pkgBlocks = raw.matchAll(/^([@\w./-]+)\s+([\d.]+)\s*$/gm);
    for (const m of pkgBlocks) {
        if (!packages.some((p) => p.startsWith(m[1])))
            packages.push(`${m[1]} ${m[2]}`);
    }
    if (raw.includes("npm audit fix"))
        fixes.push("npm audit fix");
    if (raw.includes("yarn audit"))
        fixes.push("yarn upgrade (or apply resolutions)");
    if (raw.includes("Run `npm audit`"))
        fixes.push("npm audit for details");
    if (total === 0 && Object.values(bySev).every((v) => v === 0)) {
        const zero = raw.match(/found\s+0\s+vulnerabilities/i);
        if (zero) {
            return { total: 0, bySev, packages: [], fixes: [] };
        }
        return null;
    }
    if (total === 0)
        total = Object.values(bySev).reduce((a, b) => a + b, 0);
    if (total === 0 && packages.length > 0)
        total = packages.length;
    return { total, bySev, packages, fixes };
}
export class NpmAuditReducer {
    family = "npm-audit";
    reduce(input) {
        const raw = input.raw;
        let data = parseNpmAuditJson(raw);
        if (!data)
            data = parseNpmAuditText(raw);
        if (!data)
            return null;
        const { total, bySev, packages, fixes } = data;
        const isAudit = /vulnerabilit|npm audit|yarn audit|audit report/i.test(raw) ||
            (raw.trim().startsWith("{") && (raw.includes('"vulnerabilities"') || raw.includes('"metadata"')));
        if (!isAudit && total === 0)
            return null;
        const limit = input.context.profile === "ultra" ? 5 : 10;
        const parts = [
            `<TOOL_REDUCED family="npm-audit" vulnerabilities="${total}" critical="${bySev.critical}" high="${bySev.high}">`,
            `moderate=${bySev.moderate} low=${bySev.low} info=${bySev.info}`
        ];
        if (packages.length > 0) {
            parts.push("packages:");
            packages.slice(0, limit).forEach((p) => parts.push(`  ${p}`));
            if (packages.length > limit)
                parts.push(`  ... ${packages.length - limit} more`);
        }
        if (fixes.length > 0) {
            parts.push("suggestions:");
            fixes.forEach((f) => parts.push(`  ${f}`));
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.92,
            actionableCount: total,
            summary: parts.join("\n")
        };
    }
}
