export class JavaBuildReducer {
    family = "java-build";
    reduce(input) {
        const lines = input.raw.split("\n");
        const errors = [];
        const warnings = [];
        let buildResult = "";
        let downloadCount = 0;
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^\[ERROR\]/.test(trimmed)) {
                errors.push(trimmed.replace(/^\[ERROR\]\s*/, ""));
            }
            else if (/^\[WARNING\]/.test(trimmed)) {
                if (!trimmed.includes("Using platform encoding") && !trimmed.includes("not validated")) {
                    warnings.push(trimmed.replace(/^\[WARNING\]\s*/, ""));
                }
            }
            else if (/^BUILD (SUCCESS|FAILURE)/.test(trimmed) || /^(> Task|BUILD SUCCESSFUL|BUILD FAILED)/.test(trimmed)) {
                buildResult = trimmed;
            }
            else if (/^Downloading from/.test(trimmed) || /^Downloaded from/.test(trimmed)) {
                downloadCount++;
            }
            else if (/error: /.test(trimmed) && /\.java:\d+:/.test(trimmed)) {
                errors.push(trimmed);
            }
        }
        if (errors.length === 0 && warnings.length === 0 && !buildResult && downloadCount === 0)
            return null;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const parts = [`<TOOL_REDUCED family="java-build" downloads="${downloadCount}">`];
        if (buildResult)
            parts.push(buildResult);
        if (errors.length > 0) {
            parts.push(`errors (${errors.length}):`);
            errors.slice(0, limit).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
            if (errors.length > limit)
                parts.push(`  ... ${errors.length - limit} more`);
        }
        if (warnings.length > 0) {
            parts.push(`warnings (${warnings.length}):`);
            warnings.slice(0, Math.ceil(limit / 2)).forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
        }
        parts.push("</TOOL_REDUCED>");
        return { family: this.family, confidence: 0.88, actionableCount: errors.length, summary: parts.join("\n") };
    }
}
