export class NpmInstallReducer {
    family = "npm-install";
    reduce(input) {
        const lines = input.raw.split("\n");
        const warnings = [];
        const errors = [];
        let addedCount = 0;
        let removedCount = 0;
        let auditVulns = "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("npm warn") || trimmed.startsWith("npm WARN")) {
                if (trimmed.includes("peer dep") || trimmed.includes("ERESOLVE")) {
                    warnings.push(trimmed.replace(/^npm (warn|WARN)\s*/, ""));
                }
            }
            else if (trimmed.startsWith("npm error") || trimmed.startsWith("npm ERR!")) {
                errors.push(trimmed.replace(/^npm (error|ERR!)\s*/, ""));
            }
            else if (/^added \d+/.test(trimmed)) {
                const m = trimmed.match(/added (\d+)/);
                if (m)
                    addedCount = Number(m[1]);
                const rm = trimmed.match(/removed (\d+)/);
                if (rm)
                    removedCount = Number(rm[1]);
            }
            else if (/^\d+ vulnerabilities/.test(trimmed) || /found \d+ vulnerabilities/.test(trimmed)) {
                auditVulns = trimmed;
            }
            else if (trimmed.startsWith("yarn install") || trimmed.startsWith("success Saved lockfile")) {
                addedCount = Math.max(addedCount, 1);
            }
        }
        if (errors.length === 0 && warnings.length === 0 && addedCount === 0)
            return null;
        const parts = [`<TOOL_REDUCED family="npm-install">`];
        if (addedCount > 0)
            parts.push(`added ${addedCount} packages${removedCount > 0 ? `, removed ${removedCount}` : ""}`);
        if (auditVulns)
            parts.push(`audit: ${auditVulns}`);
        if (errors.length > 0) {
            parts.push(`errors (${errors.length}):`);
            errors.slice(0, 5).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
        }
        if (warnings.length > 0) {
            const limit = input.context.profile === "ultra" ? 3 : 6;
            parts.push(`peer/resolve warnings (${warnings.length}):`);
            warnings.slice(0, limit).forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
        }
        parts.push("</TOOL_REDUCED>");
        return { family: this.family, confidence: 0.9, actionableCount: errors.length + warnings.length, summary: parts.join("\n") };
    }
}
