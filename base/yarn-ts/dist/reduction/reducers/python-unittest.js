export class PythonUnittestReducer {
    family = "python-unittest";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        const ran = raw.match(/Ran\s+(\d+)\s+tests?\s+in\s+([\d.]+s)/i);
        const tests = ran ? parseInt(ran[1], 10) : 0;
        const duration = ran?.[2] ?? "";
        let failures = 0;
        let errors = 0;
        const failedSummary = raw.match(/FAILED\s*\(\s*failures=(\d+)(?:,\s*errors=(\d+))?\s*\)/i);
        if (failedSummary) {
            failures = parseInt(failedSummary[1], 10);
            if (failedSummary[2])
                errors = parseInt(failedSummary[2], 10);
        }
        else {
            const tail = raw.trim().split("\n").pop() ?? "";
            if (/^OK\s*$/i.test(tail)) {
                failures = 0;
                errors = 0;
            }
            else if (/^FAILED\b/i.test(tail) && !failedSummary) {
                const failLabels = (raw.match(/^FAIL:\s/gm) ?? []).length;
                const errLabels = (raw.match(/^ERROR:\s/gm) ?? []).length;
                failures = failLabels || 1;
                errors = errLabels;
            }
        }
        const failBlocks = [];
        let capture = false;
        for (const line of lines) {
            const t = line.trim();
            if (/^FAIL:\s/.test(t) || /^ERROR:\s/.test(t)) {
                failBlocks.push(t.slice(0, 260));
                capture = true;
                continue;
            }
            if (capture && /^[-=]{10,}/.test(t)) {
                capture = false;
                continue;
            }
            if (capture && (t.startsWith("Traceback") || t.startsWith("File ") || /^AssertionError/.test(t))) {
                failBlocks.push(t.slice(0, 220));
                if (failBlocks.length > 24)
                    capture = false;
            }
        }
        const looksUnittest = /Ran\s+\d+\s+tests?\s+in/i.test(raw) ||
            /^FAIL:\s/m.test(raw) ||
            /^ERROR:\s/m.test(raw);
        if (!looksUnittest)
            return null;
        if (tests === 0 && !/^FAIL:\s|^ERROR:\s/m.test(raw)) {
            return null;
        }
        const failTotal = failures + errors;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const parts = [
            `<TOOL_REDUCED family="python-unittest" tests="${tests}" failures="${failTotal}">`
        ];
        if (duration)
            parts.push(`duration: ${duration}`);
        if (errors > 0)
            parts.push(`errors: ${errors}`);
        if (failBlocks.length > 0) {
            parts.push("details:");
            failBlocks.slice(0, limit * 3).forEach((b, i) => parts.push(`  ${i + 1}. ${b}`));
            if (failBlocks.length > limit * 3)
                parts.push(`  ... ${failBlocks.length - limit * 3} more`);
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.88,
            actionableCount: failTotal,
            summary: parts.join("\n")
        };
    }
}
