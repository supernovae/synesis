import { enrichItems } from "../enrich-bridge.js";
const BRACKET_LOC = /^\[(.+?):(\d+)\]:\s*\((error|warning|style|performance)\)\s*(.+)$/i;
const COLON_LOC = /^(.+?):(\d+):(\d+):\s*(error|warning|style|performance|information):\s*(.+)$/i;
const CPP_ID = /\[cppcheck-([a-zA-Z0-9_-]+)\]/i;
const CWE = /\bcwe=\s*(\d+)/i;
export class CppcheckReducer {
    family = "cppcheck";
    reduce(input) {
        const lines = input.raw.split("\n");
        const findings = [];
        const items = [];
        for (const line of lines) {
            const t = line.trim();
            const b = BRACKET_LOC.exec(t);
            if (b) {
                const kind = b[3].toLowerCase();
                const isError = kind === "error";
                const cwe = CWE.exec(t);
                const id = CPP_ID.exec(t);
                const extra = [id ? id[0] : null, cwe ? `CWE-${cwe[1]}` : null].filter(Boolean).join(" ");
                findings.push({
                    line: `${b[1]}:${b[2]} (${kind}) ${b[4]}${extra ? ` ${extra}` : ""}`,
                    isError
                });
                items.push({ message: b[4], file: b[1], ruleId: id?.[1] });
                continue;
            }
            const c = COLON_LOC.exec(t);
            if (c) {
                const kind = c[4].toLowerCase();
                if (kind === "information")
                    continue;
                const isError = kind === "error";
                const cwe = CWE.exec(t);
                const id = CPP_ID.exec(t);
                const extra = [id ? id[0] : null, cwe ? `CWE-${cwe[1]}` : null].filter(Boolean).join(" ");
                findings.push({
                    line: `${c[1]}:${c[2]}:${c[3]} (${kind}) ${c[5]}${extra ? ` ${extra}` : ""}`,
                    isError
                });
                items.push({ message: c[5], file: c[1], ruleId: id?.[1] });
            }
        }
        if (findings.length === 0)
            return null;
        const errorCount = findings.filter((f) => f.isError).length;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const top = items.slice(0, limit);
        const { items: enriched, enrichedLines, bypassEligible } = enrichItems(this.family, top);
        const parts = [
            `<TOOL_REDUCED family="cppcheck" findings="${findings.length}" errors="${errorCount}">`
        ];
        if (enrichedLines.length > 0) {
            parts.push(...enrichedLines);
            if (findings.length > limit)
                parts.push(`  ... ${findings.length - limit} more`);
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.9,
            actionableCount: findings.length,
            enrichedItems: enriched,
            bypassEligible,
            summary: parts.join("\n")
        };
    }
}
