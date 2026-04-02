function parseUnifiedDiff(raw) {
    const lines = raw.split("\n");
    let added = 0;
    let removed = 0;
    for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++"))
            added += 1;
        if (line.startsWith("-") && !line.startsWith("---"))
            removed += 1;
    }
    const gitRe = /^diff --git a\/(.+?) b\/(.+)$/;
    const boundaries = [];
    for (let i = 0; i < lines.length; i++) {
        if (gitRe.test(lines[i]))
            boundaries.push(i);
    }
    if (boundaries.length > 0) {
        const paths = [];
        const hunksByFile = [];
        for (let fi = 0; fi < boundaries.length; fi++) {
            const m = lines[boundaries[fi]].match(gitRe);
            if (m)
                paths.push(m[2]);
            const start = boundaries[fi] + 1;
            const end = boundaries[fi + 1] ?? lines.length;
            const hunks = lines.slice(start, end).filter((l) => l.startsWith("@@"));
            hunksByFile.push(hunks);
        }
        return { paths, hunksByFile, added, removed };
    }
    const paths = [];
    const hunksByFile = [];
    let i = 0;
    while (i < lines.length) {
        if (/^--- /.test(lines[i]) && /^\+\+\+ /.test(lines[i + 1] ?? "")) {
            const plus = lines[i + 1];
            const mp = plus.match(/^\+\+\+ [ab]\/(.+)$/) ?? plus.match(/^\+\+\+ (.+)$/);
            paths.push((mp?.[1] ?? "unknown").trim());
            i += 2;
            const hunks = [];
            while (i < lines.length && !/^--- /.test(lines[i])) {
                const l = lines[i];
                if (l.startsWith("@@"))
                    hunks.push(l);
                i += 1;
            }
            hunksByFile.push(hunks);
            continue;
        }
        i += 1;
    }
    if (paths.length === 0)
        return null;
    return { paths, hunksByFile, added, removed };
}
export class GitDiffReducer {
    family = "git-diff";
    reduce(input) {
        const parsed = parseUnifiedDiff(input.raw);
        if (!parsed)
            return null;
        const { paths, hunksByFile, added, removed } = parsed;
        if (paths.length === 0 && added === 0 && removed === 0)
            return null;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const parts = [
            `<TOOL_REDUCED family="git-diff" files="${paths.length}" added="${added}" removed="${removed}">`
        ];
        const n = Math.min(paths.length, limit);
        for (let fi = 0; fi < n; fi++) {
            const p = paths[fi];
            const hunks = hunksByFile[fi] ?? [];
            parts.push(`  ${p}`);
            const hLimit = input.context.profile === "ultra" ? 4 : 8;
            hunks.slice(0, hLimit).forEach((h) => parts.push(`    ${h.trim()}`));
            if (hunks.length > hLimit)
                parts.push(`    ... ${hunks.length - hLimit} more hunks`);
        }
        if (paths.length > limit)
            parts.push(`  ... ${paths.length - limit} more files`);
        parts.push("</TOOL_REDUCED>");
        const actionableCount = paths.length > 0 ? paths.length : added + removed > 0 ? 1 : 0;
        return { family: this.family, confidence: 0.92, actionableCount, summary: parts.join("\n") };
    }
}
