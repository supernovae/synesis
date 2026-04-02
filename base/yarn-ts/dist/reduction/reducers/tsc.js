import { enrichItems } from "../enrich-bridge.js";
const TS = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/;
export class TscReducer {
    family = "tsc";
    reduce(input) {
        const items = [];
        const byFile = new Map();
        for (const line of input.raw.split("\n")) {
            const m = TS.exec(line);
            if (!m)
                continue;
            const file = m[1];
            const msg = `${m[4]} ${m[5]}`.trim();
            byFile.set(file, [...(byFile.get(file) ?? []), msg]);
            items.push({ message: m[5].trim(), file, ruleId: m[4] });
        }
        if (byFile.size === 0)
            return null;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const top = items.slice(0, limit);
        const { items: enriched, enrichedLines, bypassEligible } = enrichItems(this.family, top);
        const fileSummary = [...byFile.entries()]
            .map(([file, msgs]) => `${file}: ${msgs.length} errors`)
            .slice(0, 6);
        return {
            family: this.family,
            confidence: 0.95,
            actionableCount: items.length,
            enrichedItems: enriched,
            bypassEligible,
            summary: [
                `<TOOL_REDUCED family="tsc" files="${byFile.size}" errors="${items.length}">`,
                ...fileSummary.map((s) => `  ${s}`),
                "findings:",
                ...enrichedLines,
                "</TOOL_REDUCED>"
            ].join("\n")
        };
    }
}
