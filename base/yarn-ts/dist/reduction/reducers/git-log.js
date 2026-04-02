export class GitLogReducer {
    family = "git-log";
    reduce(input) {
        const raw = input.raw.trim();
        if (!raw)
            return null;
        const lines = raw.split("\n");
        const authors = new Set();
        const subjects = [];
        const dates = [];
        let commitBlocks = 0;
        const onelineCommit = /^[0-9a-f]{7,64}\s+.+/i;
        const fullCommit = /^commit\s+[0-9a-f]{7,64}/i;
        let looksGitLog = false;
        for (const line of lines) {
            const t = line.trim();
            if (onelineCommit.test(t) || fullCommit.test(t)) {
                looksGitLog = true;
                break;
            }
        }
        if (!looksGitLog)
            return null;
        let inBody = false;
        let currentSubject = "";
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const t = line.trim();
            if (fullCommit.test(t)) {
                commitBlocks++;
                inBody = false;
                currentSubject = "";
                continue;
            }
            if (onelineCommit.test(t) && !/^commit\s/i.test(t)) {
                commitBlocks++;
                const rest = t.replace(/^[0-9a-f]{7,40}\s+/, "");
                subjects.push(rest.slice(0, 200));
                inBody = false;
                continue;
            }
            if (/^Author:\s+/i.test(t)) {
                authors.add(t.replace(/^Author:\s+/i, "").slice(0, 160));
                inBody = false;
                continue;
            }
            if (/^Date:\s+/i.test(t)) {
                dates.push(t.replace(/^Date:\s+/i, "").slice(0, 120));
                inBody = true;
                continue;
            }
            if (commitBlocks > 0 && inBody && t && !t.startsWith("commit ")) {
                if (!currentSubject && !t.startsWith("Merge:")) {
                    currentSubject = t.slice(0, 200);
                    subjects.push(currentSubject);
                }
            }
        }
        const commitsAttr = commitBlocks > 0 ? commitBlocks : (onelineCommit.test(lines[0].trim()) ? 1 : 0);
        const authorsAttr = authors.size;
        if (commitsAttr === 0)
            return null;
        const limit = input.context.profile === "ultra" ? 8 : 16;
        const parts = [
            `<TOOL_REDUCED family="git-log" commits="${commitsAttr}" authors="${authorsAttr}">`
        ];
        if (dates.length > 0) {
            parts.push(`date range: ${dates[dates.length - 1]} .. ${dates[0]}`);
        }
        if (authors.size > 0) {
            parts.push("authors:");
            [...authors].slice(0, 10).forEach((a, idx) => parts.push(`  ${idx + 1}. ${a}`));
        }
        if (subjects.length > 0) {
            parts.push("subjects (truncated):");
            subjects.slice(0, limit).forEach((s, idx) => parts.push(`  ${idx + 1}. ${s}`));
            if (subjects.length > limit)
                parts.push(`  ... ${subjects.length - limit} more`);
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.93,
            actionableCount: commitsAttr,
            summary: parts.join("\n")
        };
    }
}
