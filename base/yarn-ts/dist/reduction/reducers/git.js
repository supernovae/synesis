export class GitReducer {
    family = "git";
    reduce(input) {
        const raw = input.raw;
        const command = (input.context.command ?? "").toLowerCase();
        if (command.includes("git status") || raw.includes("Changes not staged") || raw.includes("On branch")) {
            const lines = raw.split("\n").filter((l) => /^\s*(modified|new file|deleted|renamed|both modified|M|A|D)\b/i.test(l) || /^\t/.test(l));
            const top = lines.slice(0, 16);
            return {
                family: this.family,
                confidence: 0.9,
                actionableCount: lines.length,
                summary: [
                    `<TOOL_REDUCED family="git" kind="status" items="${lines.length}">`,
                    ...top.map((l) => `- ${l.trim()}`),
                    "</TOOL_REDUCED>"
                ].join("\n")
            };
        }
        if (command.includes("git diff") || raw.includes("@@")) {
            const files = raw.split("\n").filter((l) => l.startsWith("diff --git "));
            const hunks = raw.split("\n").filter((l) => l.startsWith("@@"));
            return {
                family: this.family,
                confidence: 0.88,
                actionableCount: files.length,
                summary: [
                    `<TOOL_REDUCED family="git" kind="diff" files="${files.length}" hunks="${hunks.length}">`,
                    ...files.slice(0, 12).map((f) => `- ${f.replace("diff --git ", "")}`),
                    "</TOOL_REDUCED>"
                ].join("\n")
            };
        }
        if (command.includes("git log")) {
            const commits = raw.split("\n").filter((l) => /^[0-9a-f]{6,}\s+/i.test(l));
            if (commits.length === 0)
                return null;
            return {
                family: this.family,
                confidence: 0.95,
                actionableCount: commits.length,
                summary: [
                    `<TOOL_REDUCED family="git" kind="log" commits="${commits.length}">`,
                    ...commits.slice(0, 20).map((c) => `- ${c.trim()}`),
                    "</TOOL_REDUCED>"
                ].join("\n")
            };
        }
        return null;
    }
}
