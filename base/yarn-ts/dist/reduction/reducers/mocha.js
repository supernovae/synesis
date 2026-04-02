export class MochaReducer {
    family = "mocha";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        const passFooter = raw.match(/(\d+)\s+passing/i);
        const failFooter = raw.match(/(\d+)\s+failing/i);
        const pendFooter = raw.match(/(\d+)\s+pending/i);
        let passing = passFooter ? parseInt(passFooter[1], 10) : 0;
        let failing = failFooter ? parseInt(failFooter[1], 10) : 0;
        const pending = pendFooter ? parseInt(pendFooter[1], 10) : 0;
        if (!passFooter && !failFooter && !pendFooter) {
            let passTicks = 0;
            let failTicks = 0;
            for (const line of lines) {
                const t = line.trim();
                if (/^[✓✔]/.test(t))
                    passTicks += 1;
                if (/^[✗×]/.test(t))
                    failTicks += 1;
            }
            if (passTicks + failTicks > 0) {
                passing = passTicks;
                failing = failTicks;
            }
        }
        const dur = raw.match(/\(([\d.]+m?s)\)\s*$/m)?.[1] ??
            raw.match(/\(([\d.]+m?s)\)/)?.[1] ??
            "";
        const failureLines = [];
        let inFailureBlock = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const t = line.trim();
            if (/^\d+\)\s+/.test(t)) {
                failureLines.push(t.slice(0, 240));
                inFailureBlock = true;
                continue;
            }
            if (/^[✗×]\s+/.test(t)) {
                failureLines.push(t.slice(0, 240));
                inFailureBlock = true;
                continue;
            }
            if (inFailureBlock && (t.startsWith("AssertionError") || /^Error:/.test(t) || /expected/i.test(t))) {
                failureLines.push(t.slice(0, 240));
                inFailureBlock = false;
            }
        }
        const looksMocha = passFooter !== null ||
            failFooter !== null ||
            pendFooter !== null ||
            /^\s*[✓✔✗×]\s/m.test(raw) ||
            /^\s+\d+\)\s+/m.test(raw);
        if (!looksMocha)
            return null;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const parts = [
            `<TOOL_REDUCED family="mocha" passing="${passing}" failing="${failing}">`
        ];
        if (pending > 0)
            parts.push(`pending: ${pending}`);
        if (dur)
            parts.push(`duration: ${dur}`);
        if (failureLines.length > 0) {
            parts.push("failures:");
            failureLines.slice(0, limit).forEach((f, i) => parts.push(`  ${i + 1}. ${f}`));
            if (failureLines.length > limit)
                parts.push(`  ... ${failureLines.length - limit} more`);
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.9,
            actionableCount: failing + pending,
            summary: parts.join("\n")
        };
    }
}
