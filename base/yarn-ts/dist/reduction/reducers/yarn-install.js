export class YarnInstallReducer {
    family = "yarn-install";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        const warnings = [];
        let doneIn = "";
        let packagesDelta = 0;
        let resolutionSeen = false;
        let fetchSeen = false;
        for (const line of lines) {
            const t = line.trim();
            if (/^➤\s*YN0002:/.test(t) || /^➤\s*YN0060:/.test(t) || /^➤\s*YN0061:/.test(t)) {
                warnings.push(t.slice(0, 220));
            }
            else if (/doesn't provide|peer dep|deprecated/i.test(t) && /^➤/.test(t)) {
                warnings.push(t.slice(0, 220));
            }
            else if (/Resolution step/i.test(t))
                resolutionSeen = true;
            else if (/Fetch step/i.test(t))
                fetchSeen = true;
            else if (/Done in [\d.]+s/i.test(t) || /·\s*Done in/i.test(t)) {
                const m = t.match(/Done in ([\d.]+s(?:\s*\d+ms)?|[\d.]+\s*ms)/i);
                if (m)
                    doneIn = m[1].replace(/\s+/g, " ").trim();
            }
            else if (/\+\d+\s+packages?|\d+\s+packages?\s+added/i.test(t)) {
                const m = t.match(/\+(\d+)/) || t.match(/(\d+)\s+packages?\s+added/i);
                if (m)
                    packagesDelta = Math.max(packagesDelta, parseInt(m[1], 10));
            }
            else if (/YN0013:/i.test(t)) {
                const m = t.match(/(\d+)\s+packages?\s+were\s+added/i);
                if (m)
                    packagesDelta = Math.max(packagesDelta, parseInt(m[1], 10));
            }
        }
        const looksYarnBerry = /➤\s*YN\d{4}:/.test(raw) || /Resolution step|Fetch step|Link step/i.test(raw);
        const looksClassic = /yarn install v[\d.]+/i.test(raw) ||
            /success (Saved lockfile|Already up-to-date)/i.test(raw) ||
            /\[[\d/]+\]\s+(Resolving|Fetching|Linking)/i.test(raw);
        if (!looksYarnBerry && !looksClassic && warnings.length === 0 && !doneIn) {
            return null;
        }
        const pkgN = packagesDelta > 0
            ? packagesDelta
            : fetchSeen || resolutionSeen
                ? 1
                : looksClassic
                    ? 1
                    : 0;
        const warnN = warnings.length;
        const limit = input.context.profile === "ultra" ? 3 : 6;
        const parts = [
            `<TOOL_REDUCED family="yarn-install" packages="${pkgN}" warnings="${warnN}">`
        ];
        if (resolutionSeen)
            parts.push("resolution: completed");
        if (fetchSeen)
            parts.push("fetch: completed");
        if (doneIn)
            parts.push(`timing: ${doneIn}`);
        if (warnings.length > 0) {
            parts.push("warnings:");
            warnings.slice(0, limit).forEach((w) => parts.push(`  ${w}`));
            if (warnings.length > limit)
                parts.push(`  ... ${warnings.length - limit} more`);
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.88,
            actionableCount: warnN,
            summary: parts.join("\n")
        };
    }
}
