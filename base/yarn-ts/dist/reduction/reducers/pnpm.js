export class PnpmReducer {
    family = "pnpm";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        const warnings = [];
        let packagesAdded = null;
        let progressLine = "";
        const pkgPlus = raw.match(/Packages:\s*\+(\d+)/i);
        if (pkgPlus)
            packagesAdded = parseInt(pkgPlus[1], 10);
        const progressAdded = raw.match(/Progress:[^\n]*\badded\s+(\d+)/i);
        if (progressAdded) {
            const n = parseInt(progressAdded[1], 10);
            packagesAdded = packagesAdded === null ? n : Math.max(packagesAdded, n);
        }
        for (const line of lines) {
            const t = line.replace(/\u2009/g, " ").trim();
            if (/^Progress:/i.test(t))
                progressLine = t.slice(0, 200);
            if (/^WARN\s/i.test(t) && (/peer|deprecated|unmet/i.test(t) || /engines/i.test(t))) {
                const clip = t.slice(0, 220);
                if (!warnings.includes(clip))
                    warnings.push(clip);
            }
            if (/unmet peer|deprecated|peer dependenc/i.test(t) && t.length > 10) {
                const clip = t.slice(0, 220);
                if (!warnings.includes(clip))
                    warnings.push(clip);
            }
        }
        const depsBlock = /^dependencies:$/m.test(raw) ||
            /^devDependencies:$/m.test(raw) ||
            /^optionalDependencies:$/m.test(raw);
        const looksPnpm = /^pnpm\s+(i|install|add|update)/im.test(raw) ||
            /Packages:\s*\+?\d+/i.test(raw) ||
            /^Progress:\s+resolved/im.test(raw);
        if (!looksPnpm && !depsBlock && warnings.length === 0 && packagesAdded === null) {
            return null;
        }
        const pkgN = packagesAdded ?? (depsBlock ? 1 : 0);
        const warnN = warnings.length;
        const limit = input.context.profile === "ultra" ? 3 : 6;
        const parts = [`<TOOL_REDUCED family="pnpm" packages="${pkgN}" warnings="${warnN}">`];
        if (progressLine)
            parts.push(progressLine);
        if (warnings.length > 0) {
            parts.push("warnings:");
            warnings.slice(0, limit).forEach((w) => parts.push(`  ${w}`));
            if (warnings.length > limit)
                parts.push(`  ... ${warnings.length - limit} more`);
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.91,
            actionableCount: warnN,
            summary: parts.join("\n")
        };
    }
}
