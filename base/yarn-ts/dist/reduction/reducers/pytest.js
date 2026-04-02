import { enrichItems } from "../enrich-bridge.js";
const FAIL_HEADER = /^_{3,}\s+(.+?)\s+_{3,}$/;
export class PytestReducer {
    family = "pytest";
    reduce(input) {
        const lines = input.raw.split("\n");
        const items = [];
        let currentTest = "";
        for (const line of lines) {
            const h = FAIL_HEADER.exec(line);
            if (h) {
                currentTest = h[1];
                continue;
            }
            if (line.trim().startsWith("E       ")) {
                const msg = line.trim().slice(8);
                items.push({ message: `${currentTest || "test"}: ${msg}` });
            }
        }
        if (items.length === 0)
            return null;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const top = items.slice(0, limit);
        const { items: enriched, enrichedLines, bypassEligible } = enrichItems(this.family, top);
        return {
            family: this.family,
            confidence: 0.95,
            actionableCount: items.length,
            enrichedItems: enriched,
            bypassEligible,
            summary: [
                `<TOOL_REDUCED family="pytest" findings="${items.length}">`,
                ...enrichedLines,
                "</TOOL_REDUCED>"
            ].join("\n")
        };
    }
}
