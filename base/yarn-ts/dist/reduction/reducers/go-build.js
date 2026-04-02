import { enrichItems } from "../enrich-bridge.js";
const GO_ERROR = /^(\.\/[\w/]+\.go):(\d+):(\d+):\s*(.+)$/;
export class GoBuildReducer {
    family = "go-build";
    reduce(input) {
        const lines = input.raw.split("\n");
        const errors = [];
        const errorItems = [];
        const testFails = [];
        const testItems = [];
        let testSummary = "";
        const vetWarnings = [];
        for (const line of lines) {
            const trimmed = line.trim();
            const ge = GO_ERROR.exec(trimmed);
            if (ge) {
                errors.push(trimmed);
                errorItems.push({ message: ge[4], file: ge[1] });
            }
            else if (/^--- FAIL:/.test(trimmed)) {
                testFails.push(trimmed);
                testItems.push({ message: trimmed.replace(/^--- FAIL:\s*/, "") });
            }
            else if (/^(FAIL|ok)\s+[\w./]+/.test(trimmed)) {
                testSummary += trimmed + "\n";
            }
            else if (/^vet:/.test(trimmed) || /^#.*vet/.test(trimmed)) {
                vetWarnings.push(trimmed);
            }
            else if (/^\s+Error Trace:/.test(line) || /^\s+Error:/.test(line)) {
                testFails.push(trimmed);
                testItems.push({ message: trimmed });
            }
        }
        if (errors.length === 0 && testFails.length === 0 && !testSummary && vetWarnings.length === 0)
            return null;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const allItems = [...errorItems, ...testItems];
        const top = allItems.slice(0, limit);
        const { items: enriched, enrichedLines, bypassEligible } = enrichItems(this.family, top);
        const parts = [`<TOOL_REDUCED family="go-build">`];
        if (testSummary.trim())
            parts.push(testSummary.trim());
        if (enrichedLines.length > 0) {
            parts.push(...enrichedLines);
            if (allItems.length > limit)
                parts.push(`  ... ${allItems.length - limit} more`);
        }
        if (vetWarnings.length > 0) {
            parts.push(`vet (${vetWarnings.length}):`);
            vetWarnings.slice(0, 4).forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.9,
            actionableCount: errors.length + testFails.length,
            enrichedItems: enriched,
            bypassEligible,
            summary: parts.join("\n")
        };
    }
}
