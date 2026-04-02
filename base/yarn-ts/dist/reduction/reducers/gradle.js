export class GradleReducer {
    family = "gradle";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        const looksGradle = /> Task\s*:/.test(raw) ||
            /BUILD SUCCESSFUL/.test(raw) ||
            /BUILD FAILED/.test(raw) ||
            /actionable tasks?:/i.test(raw) ||
            /test result:/i.test(raw) ||
            /\bFAILURE:\s*Build failed/i.test(raw) ||
            /\* What went wrong:/.test(raw) ||
            /Welcome to Gradle/i.test(raw);
        if (!looksGradle)
            return null;
        let buildOk = null;
        if (/BUILD SUCCESSFUL/.test(raw))
            buildOk = true;
        if (/BUILD FAILED/.test(raw) || /\bFAILURE:\s*Build failed/i.test(raw))
            buildOk = false;
        let taskLineCount = 0;
        const taskLines = [];
        const errors = [];
        const warnings = [];
        const testLines = [];
        for (const line of lines) {
            const t = line.trim();
            if (/> Task\s*:/.test(t)) {
                taskLineCount++;
                if (taskLines.length < 40)
                    taskLines.push(t.slice(0, 200));
            }
            else if (/^>/.test(t) && /FAILED/.test(t)) {
                errors.push(t.slice(0, 280));
            }
            else if (/\* What went wrong:/.test(t) || /^FAILURE:/.test(t)) {
                errors.push(t.slice(0, 280));
            }
            else if (/error:/i.test(t) && (t.includes("Gradle") || t.includes("build") || t.includes("Task"))) {
                errors.push(t.slice(0, 280));
            }
            else if (/warning:/i.test(t) || /^Note:/.test(t)) {
                warnings.push(t.slice(0, 280));
            }
            else if (/test result:/i.test(t)) {
                testLines.push(t.slice(0, 280));
            }
        }
        const actionableM = raw.match(/(\d+)\s+actionable tasks?:/i);
        const tasksAttr = actionableM ? parseInt(actionableM[1], 10) : taskLineCount;
        let errorsAttr = errors.length;
        if (buildOk === false && errorsAttr === 0)
            errorsAttr = 1;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const parts = [
            `<TOOL_REDUCED family="gradle" tasks="${tasksAttr}" errors="${errorsAttr}">`
        ];
        if (buildOk === true)
            parts.push("BUILD SUCCESSFUL");
        if (buildOk === false)
            parts.push("BUILD FAILED");
        if (testLines.length > 0) {
            parts.push("tests:");
            testLines.slice(0, 4).forEach((x, i) => parts.push(`  ${i + 1}. ${x}`));
        }
        if (taskLines.length > 0 && input.context.profile !== "ultra") {
            parts.push("tasks (sample):");
            taskLines.slice(0, Math.min(8, limit)).forEach((x, i) => parts.push(`  ${i + 1}. ${x}`));
        }
        if (errors.length > 0) {
            parts.push("errors:");
            errors.slice(0, limit).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
            if (errors.length > limit)
                parts.push(`  ... ${errors.length - limit} more`);
        }
        if (warnings.length > 0) {
            parts.push("warnings:");
            warnings.slice(0, Math.ceil(limit / 2)).forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
        }
        parts.push("</TOOL_REDUCED>");
        const actionableCount = errorsAttr + warnings.length;
        return {
            family: this.family,
            confidence: 0.9,
            actionableCount,
            summary: parts.join("\n")
        };
    }
}
