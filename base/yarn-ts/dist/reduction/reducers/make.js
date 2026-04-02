export class MakeReducer {
    family = "make";
    reduce(input) {
        const lines = input.raw.split("\n");
        const errors = [];
        const warnings = [];
        let targetCount = 0;
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^make(\[\d+\])?: \*\*\*/.test(trimmed) || /^(error|ERROR):/.test(trimmed)) {
                errors.push(trimmed);
            }
            else if (/: error:/.test(trimmed)) {
                errors.push(trimmed);
            }
            else if (/: warning:/.test(trimmed) || trimmed.startsWith("warning:")) {
                warnings.push(trimmed);
            }
            else if (/^make(\[\d+\])?: (Entering|Leaving) directory/.test(trimmed)) {
                targetCount++;
            }
            else if (/^(gcc|g\+\+|cc|c\+\+|clang|cmake)\s/.test(trimmed)) {
                targetCount++;
            }
        }
        if (errors.length === 0 && warnings.length === 0 && targetCount === 0)
            return null;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const parts = [`<TOOL_REDUCED family="make" targets="${targetCount}">`];
        if (errors.length > 0) {
            parts.push(`errors (${errors.length}):`);
            errors.slice(0, limit).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
        }
        if (warnings.length > 0) {
            parts.push(`warnings (${warnings.length}):`);
            warnings.slice(0, Math.ceil(limit / 2)).forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
        }
        if (errors.length === 0 && warnings.length === 0)
            parts.push("build completed successfully");
        parts.push("</TOOL_REDUCED>");
        return { family: this.family, confidence: 0.88, actionableCount: errors.length + warnings.length, summary: parts.join("\n") };
    }
}
