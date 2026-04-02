export class SqlResultReducer {
    family = "sql-result";
    reduce(input) {
        const lines = input.raw.split("\n");
        let headerLine = "";
        let rowCount = 0;
        let colCount = 0;
        const sampleRows = [];
        let affectedRows = "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^\+[-+]+\+$/.test(trimmed) || /^[-]{3,}$/.test(trimmed))
                continue;
            if (/^\|.*\|$/.test(trimmed)) {
                if (!headerLine) {
                    headerLine = trimmed;
                    colCount = (trimmed.match(/\|/g) ?? []).length - 1;
                }
                else {
                    rowCount++;
                    if (sampleRows.length < 5)
                        sampleRows.push(trimmed);
                }
            }
            else if (/^\(\d+ rows?\)/.test(trimmed) || /^(\d+) rows? (in set|affected|selected)/.test(trimmed)) {
                const m = trimmed.match(/(\d+)/);
                if (m)
                    rowCount = Math.max(rowCount, Number(m[1]));
                affectedRows = trimmed;
            }
            else if (/^Query OK/.test(trimmed) || /^INSERT|UPDATE|DELETE/.test(trimmed)) {
                affectedRows = trimmed;
            }
            else if (/\t/.test(trimmed) && !headerLine) {
                headerLine = trimmed;
                colCount = trimmed.split("\t").length;
            }
            else if (/\t/.test(trimmed) && headerLine) {
                rowCount++;
                if (sampleRows.length < 5)
                    sampleRows.push(trimmed);
            }
        }
        if (rowCount < 5 && !affectedRows)
            return null;
        const parts = [`<TOOL_REDUCED family="sql-result" rows="${rowCount}" cols="${colCount}">`];
        if (headerLine)
            parts.push(`columns: ${headerLine}`);
        if (sampleRows.length > 0) {
            parts.push("sample:");
            sampleRows.forEach((r) => parts.push(`  ${r}`));
            if (rowCount > sampleRows.length)
                parts.push(`  ... ${rowCount - sampleRows.length} more rows`);
        }
        if (affectedRows)
            parts.push(affectedRows);
        parts.push("</TOOL_REDUCED>");
        return { family: this.family, confidence: 0.85, actionableCount: 0, summary: parts.join("\n") };
    }
}
