export class NetworkDiagReducer {
    family = "network-diag";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        const findings = [];
        let isPing = false;
        let isTrace = false;
        let isDig = false;
        let pingStats = "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^PING\s/.test(trimmed) || /^ping\s/i.test(trimmed))
                isPing = true;
            if (/^traceroute\s/i.test(trimmed) || /^tracert\s/i.test(trimmed))
                isTrace = true;
            if (/^;\s*(<<>>|DiG)\s/i.test(trimmed) || /^;.*QUERY/.test(trimmed))
                isDig = true;
            if (isPing && /packet loss|packets transmitted|rtt min/.test(trimmed)) {
                pingStats += trimmed + "\n";
            }
            else if (isTrace && /^\s*\d+\s/.test(trimmed)) {
                findings.push(trimmed);
            }
            else if (isDig && /^[\w.-]+\.\s+\d+\s+IN\s+/.test(trimmed)) {
                findings.push(trimmed);
            }
            else if (/^;; ANSWER SECTION/.test(trimmed) || /^;; AUTHORITY SECTION/.test(trimmed)) {
                findings.push(trimmed);
            }
            else if (/^Server:\s|^Address:\s/.test(trimmed) && isDig) {
                findings.push(trimmed);
            }
        }
        if (!pingStats && findings.length === 0)
            return null;
        const limit = input.context.profile === "ultra" ? 8 : 16;
        const tool = isPing ? "ping" : isTrace ? "traceroute" : isDig ? "dig" : "network";
        const parts = [`<TOOL_REDUCED family="network-diag" tool="${tool}">`];
        if (pingStats.trim())
            parts.push(pingStats.trim());
        findings.slice(0, limit).forEach((f) => parts.push(`  ${f}`));
        if (findings.length > limit)
            parts.push(`  ... ${findings.length - limit} more`);
        parts.push("</TOOL_REDUCED>");
        return { family: this.family, confidence: 0.85, actionableCount: 0, summary: parts.join("\n") };
    }
}
