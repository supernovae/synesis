function parseTrailingPercent(line) {
    const percents = [...line.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
    if (percents.length === 0)
        return null;
    return Number(percents[percents.length - 1][1]);
}
export class CoverageReducer {
    family = "coverage";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        let totalPct = null;
        const fileRows = [];
        const stmtsMissCoverHeader = lines.findIndex((l) => /\bStmts\b/.test(l) && /\bMiss\b/.test(l) && /\bCover\b/.test(l));
        if (stmtsMissCoverHeader >= 0) {
            for (let i = stmtsMissCoverHeader + 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line || /^-+$/.test(line))
                    continue;
                if (/^TOTAL\b/i.test(line)) {
                    totalPct = parseTrailingPercent(line);
                    continue;
                }
                const pathMatch = line.match(/^(\S[^\s%]*\.(?:ts|tsx|js|jsx|py|go|java|cs))\b/i) ?? line.match(/^(\S+)\s+\d+/);
                const pct = parseTrailingPercent(line);
                if (pathMatch && pct !== null && !/^TOTAL$/i.test(pathMatch[1])) {
                    fileRows.push({ file: pathMatch[1], pct });
                }
            }
        }
        const pipeStmts = lines.findIndex((l) => /\b%?\s*Stmts\b/i.test(l) && l.includes("|"));
        if (fileRows.length === 0 && pipeStmts >= 0) {
            for (let i = pipeStmts + 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line || /^-+$/.test(line) || !line.includes("|"))
                    continue;
                const cells = line.split("|").map((c) => c.trim());
                const file = (cells[0] ?? "").trim();
                if (!file || /^(file|all files|total)$/i.test(file))
                    continue;
                const stmtCell = cells[1] ?? "";
                const m = stmtCell.match(/(\d+(?:\.\d+)?)/);
                if (m && /\.(ts|js|tsx|jsx|py|go|java|cs)\b/i.test(file)) {
                    fileRows.push({ file, pct: Number(m[1]) });
                }
                if (/^All files$/i.test(file) && m)
                    totalPct = Number(m[1]);
            }
        }
        if (totalPct === null) {
            const totalLine = lines.find((l) => /^TOTAL\b/i.test(l.trim()));
            if (totalLine)
                totalPct = parseTrailingPercent(totalLine);
        }
        if (totalPct === null) {
            const lf = raw.match(/^LF:(\d+)$/m);
            const lh = raw.match(/^LH:(\d+)$/m);
            if (lf && lh) {
                const a = Number(lf[1]);
                const b = Number(lh[1]);
                if (a > 0)
                    totalPct = Math.round((b / a) * 10000) / 100;
            }
        }
        const below = fileRows.filter((f) => f.pct < 50);
        const threshold = input.context.profile === "ultra" ? 8 : 16;
        if (totalPct === null && fileRows.length === 0 && !/^SF:/m.test(raw))
            return null;
        const displayTotal = totalPct ?? (fileRows.length > 0 ? Math.round((fileRows.reduce((s, f) => s + f.pct, 0) / fileRows.length) * 100) / 100 : null);
        if (displayTotal === null && below.length === 0 && !/^SF:/m.test(raw))
            return null;
        const totalStr = displayTotal !== null ? `${displayTotal}%` : "n/a";
        const parts = [
            `<TOOL_REDUCED family="coverage" total="${totalStr}" files="${fileRows.length}" below_threshold="${below.length}">`
        ];
        if (displayTotal !== null)
            parts.push(`  summary: ${displayTotal}% total`);
        below.slice(0, threshold).forEach((f) => parts.push(`  below 50%: ${f.file} (${f.pct}%)`));
        if (below.length > threshold)
            parts.push(`  ... ${below.length - threshold} more files below threshold`);
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.9,
            actionableCount: below.length,
            summary: parts.join("\n")
        };
    }
}
