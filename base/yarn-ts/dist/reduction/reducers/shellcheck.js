import { enrichItems } from "../enrich-bridge.js";
const IN_FILE_LINE = /^In\s+(.+?)\s+line\s+(\d+):/i;
const CARET_SC = /\^--\s*(SC\d+)/;
const SEVERITY_PAREN = /\((error|warning|info|style)\)/i;
const GCC_STYLE = /^(.+?):(\d+):(\d+):\s*(error|warning|info|style):\s*(.+?)(?:\s*\[(SC\d+)\])?\s*$/i;
export class ShellcheckReducer {
    family = "shellcheck";
    reduce(input) {
        const lines = input.raw.split("\n");
        const findings = [];
        const items = [];
        let pendingFile = null;
        let pendingLine = null;
        for (const line of lines) {
            const t = line.trim();
            const inf = IN_FILE_LINE.exec(t);
            if (inf) {
                pendingFile = inf[1];
                pendingLine = inf[2];
                continue;
            }
            const gcc = GCC_STYLE.exec(t);
            if (gcc) {
                const sev = gcc[4].toLowerCase();
                const code = gcc[6];
                findings.push({
                    line: `${gcc[1]}:${gcc[2]}:${gcc[3]} [${sev}] ${gcc[5]}${code ? ` ${code}` : ""}`,
                    severity: sev,
                    code
                });
                items.push({ message: gcc[5], file: gcc[1], ruleId: code });
                pendingFile = null;
                pendingLine = null;
                continue;
            }
            const caret = CARET_SC.exec(t);
            if (caret && (pendingFile || t.includes("SC"))) {
                const msg = t;
                const sevM = SEVERITY_PAREN.exec(msg);
                const sev = sevM ? sevM[1].toLowerCase() : "style";
                const loc = pendingFile && pendingLine ? `${pendingFile}:${pendingLine}` : "unknown";
                findings.push({
                    line: `${loc} ${caret[1]} (${sev}) ${msg.replace(CARET_SC, "").trim()}`,
                    severity: sev,
                    code: caret[1]
                });
                items.push({
                    message: msg.replace(CARET_SC, "").trim(),
                    file: pendingFile ?? undefined,
                    ruleId: caret[1]
                });
            }
        }
        if (findings.length === 0)
            return null;
        const errorCount = findings.filter((f) => f.severity === "error").length;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const top = items.slice(0, limit);
        const { items: enriched, enrichedLines, bypassEligible } = enrichItems(this.family, top);
        const parts = [
            `<TOOL_REDUCED family="shellcheck" findings="${findings.length}" errors="${errorCount}">`
        ];
        if (enrichedLines.length > 0) {
            parts.push(...enrichedLines);
            if (findings.length > limit)
                parts.push(`  ... ${findings.length - limit} more`);
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.88,
            actionableCount: findings.length,
            enrichedItems: enriched,
            bypassEligible,
            summary: parts.join("\n")
        };
    }
}
