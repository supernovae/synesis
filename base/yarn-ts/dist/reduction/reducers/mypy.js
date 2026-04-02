import { enrichItems } from "../enrich-bridge.js";
const MYPY_ERROR = /^(.+\.py):(\d+):\s*error:\s*(.+?)(?:\s+\[([^\]]+)\])?\s*$/;
export class MypyReducer {
    family = "mypy";
    reduce(input) {
        const lines = input.raw.split("\n");
        const items = [];
        const notes = [];
        let summaryLine = "";
        for (const line of lines) {
            const trimmed = line.trim();
            const m = MYPY_ERROR.exec(trimmed);
            if (m) {
                items.push({ message: m[3], file: m[1], ruleId: m[4] });
                continue;
            }
            if (/\.py:\d+: error:/.test(trimmed)) {
                items.push({ message: trimmed });
            }
            else if (/\.py:\d+: note:/.test(trimmed)) {
                notes.push(trimmed);
            }
            else if (/^Found \d+ error/.test(trimmed) || /^Success:/.test(trimmed)) {
                summaryLine = trimmed;
            }
        }
        if (items.length === 0 && !summaryLine)
            return null;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const top = items.slice(0, limit);
        const { items: enriched, enrichedLines, bypassEligible } = enrichItems(this.family, top);
        const parts = [`<TOOL_REDUCED family="mypy" errors="${items.length}">`];
        if (summaryLine)
            parts.push(summaryLine);
        if (enrichedLines.length > 0) {
            parts.push(...enrichedLines);
            if (items.length > limit)
                parts.push(`  ... ${items.length - limit} more`);
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.92,
            actionableCount: items.length,
            enrichedItems: enriched,
            bypassEligible,
            summary: parts.join("\n")
        };
    }
}
