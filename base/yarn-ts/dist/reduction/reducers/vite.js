export class ViteReducer {
    family = "vite";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        const errors = [];
        const warnings = [];
        const outputFiles = [];
        let buildTime = "";
        for (const line of lines) {
            const t = line.trim();
            if (/error during build|^error:/i.test(t) || /\[vite\].*error/i.test(t)) {
                errors.push(t.slice(0, 220));
            }
            else if (/^\[plugin:vite:|warning:/i.test(t) ||
                (/warning/i.test(t) && /vite|rollup/i.test(t))) {
                warnings.push(t.slice(0, 220));
            }
            else if (/✓\s+built\s+in\s+/i.test(t) || /built\s+in\s+[\d.]+s/i.test(t)) {
                const m = t.match(/built\s+in\s+([\d.]+(?:ms|s)?)/i);
                if (m)
                    buildTime = m[1];
            }
            else if (/^(dist\/|build\/|\.\/dist\/).+\s+[\d.]+\s*(?:kB|KiB|MB|MiB|bytes?)\b/i.test(t) ||
                /\s[\d.]+\s*kB\s*│/i.test(t)) {
                outputFiles.push(t.slice(0, 180));
            }
            else if (/chunk|asset.*\.(js|mjs|css)/i.test(t) && /\d+\.?\d*\s*(kB|KiB|MB)/i.test(t)) {
                outputFiles.push(t.slice(0, 180));
            }
        }
        const looksVite = /vite\s+v[\d.]+/i.test(raw) ||
            /✓\s+built\s+in/i.test(raw) ||
            (/(^|\n)dist\//i.test(raw) && /transformed|building\s+for\s+production/i.test(raw));
        if (!looksVite && errors.length === 0 && warnings.length === 0 && outputFiles.length === 0) {
            return null;
        }
        const fileN = outputFiles.length;
        const errN = errors.length;
        const limit = input.context.profile === "ultra" ? 4 : 8;
        const parts = [
            `<TOOL_REDUCED family="vite" files="${fileN}" errors="${errN}">`
        ];
        if (buildTime)
            parts.push(`build: ${buildTime}`);
        if (outputFiles.length > 0) {
            parts.push("output:");
            outputFiles.slice(0, limit).forEach((f) => parts.push(`  ${f}`));
            if (outputFiles.length > limit)
                parts.push(`  ... ${outputFiles.length - limit} more`);
        }
        if (errors.length > 0) {
            parts.push("errors:");
            errors.slice(0, limit).forEach((e) => parts.push(`  ${e}`));
            if (errors.length > limit)
                parts.push(`  ... ${errors.length - limit} more`);
        }
        if (warnings.length > 0) {
            parts.push("warnings:");
            warnings.slice(0, limit).forEach((w) => parts.push(`  ${w}`));
            if (warnings.length > limit)
                parts.push(`  ... ${warnings.length - limit} more`);
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.9,
            actionableCount: errN + warnings.length,
            summary: parts.join("\n")
        };
    }
}
