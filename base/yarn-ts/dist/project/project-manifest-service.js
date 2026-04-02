function asText(content) {
    if (typeof content === "string")
        return content;
    try {
        return JSON.stringify(content);
    }
    catch {
        return String(content);
    }
}
function uniq(arr) {
    return [...new Set(arr)];
}
export class ProjectManifestService {
    builtCount = 0;
    build(messages) {
        const text = messages.map((m) => asText(m.content)).join("\n").toLowerCase();
        const languages = uniq([
            ...(text.includes(".ts") || text.includes("typescript") ? ["typescript"] : []),
            ...(text.includes(".py") || text.includes("python") ? ["python"] : []),
            ...(text.includes(".go") || text.includes("golang") ? ["go"] : []),
            ...(text.includes(".rs") || text.includes("rust") ? ["rust"] : []),
            ...(text.includes(".java") || text.includes("java") ? ["java"] : [])
        ]);
        const buildTools = uniq([
            ...(text.includes("npm") ? ["npm"] : []),
            ...(text.includes("pnpm") ? ["pnpm"] : []),
            ...(text.includes("yarn ") ? ["yarn"] : []),
            ...(text.includes("uv ") || text.includes("uv run") ? ["uv"] : []),
            ...(text.includes("cargo") ? ["cargo"] : []),
            ...(text.includes("go ") ? ["go"] : [])
        ]);
        const testCommands = uniq([
            ...(text.includes("pytest") ? ["pytest"] : []),
            ...(text.includes("vitest") ? ["vitest"] : []),
            ...(text.includes("npm test") ? ["npm test"] : []),
            ...(text.includes("go test") ? ["go test"] : []),
            ...(text.includes("cargo test") ? ["cargo test"] : [])
        ]);
        const lintCommands = uniq([
            ...(text.includes("ruff") ? ["ruff"] : []),
            ...(text.includes("eslint") ? ["eslint"] : []),
            ...(text.includes("lint") ? ["lint"] : []),
            ...(text.includes("tsc --noemit") ? ["tsc --noEmit"] : [])
        ]);
        const riskProfile = /\b(production|migration|security|critical)\b/.test(text)
            ? "high"
            : /\b(refactor|feature|bug)\b/.test(text)
                ? "standard"
                : "low";
        const manifest = {
            languages: languages.length ? languages : ["unknown"],
            buildTools: buildTools.length ? buildTools : ["unknown"],
            testCommands,
            lintCommands,
            policyProfile: "patch-first-loop-safe",
            riskProfile,
            source: "inferred"
        };
        this.builtCount += 1;
        return manifest;
    }
    toSystemBlock(manifest) {
        return [
            "<PROJECT_MANIFEST>",
            `languages=${manifest.languages.join(",")}`,
            `build_tools=${manifest.buildTools.join(",")}`,
            `test_commands=${manifest.testCommands.join(",") || "none"}`,
            `lint_commands=${manifest.lintCommands.join(",") || "none"}`,
            `policy_profile=${manifest.policyProfile}`,
            `risk_profile=${manifest.riskProfile}`,
            `source=${manifest.source}`,
            "</PROJECT_MANIFEST>"
        ].join("\n");
    }
    getStats() {
        return { builtCount: this.builtCount };
    }
}
