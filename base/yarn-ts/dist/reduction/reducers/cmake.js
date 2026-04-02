export class CmakeReducer {
    family = "cmake";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        const looksCmake = /--\s+Found\s/i.test(raw) ||
            /--\s+Could NOT find\s/i.test(raw) ||
            /-- Configuring done/i.test(raw) ||
            /-- Generating done/i.test(raw) ||
            /-- Build files have been written/i.test(raw) ||
            /CMake Error/i.test(raw) ||
            /-- The C compiler identification is/i.test(raw);
        if (!looksCmake)
            return null;
        let found = 0;
        let missing = 0;
        const foundSamples = [];
        const missingSamples = [];
        const cmakeErrors = [];
        for (const line of lines) {
            const t = line.trim();
            if (/^--\s+Found\s/i.test(t)) {
                found++;
                if (foundSamples.length < 24)
                    foundSamples.push(t.slice(0, 220));
            }
            else if (/^--\s+Could NOT find\s/i.test(t)) {
                missing++;
                if (missingSamples.length < 24)
                    missingSamples.push(t.slice(0, 220));
            }
            else if (/CMake Error/i.test(t) || /^CMake Error at\s/i.test(t)) {
                cmakeErrors.push(t.slice(0, 280));
            }
        }
        const errorN = cmakeErrors.length;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const parts = [
            `<TOOL_REDUCED family="cmake" found="${found}" missing="${missing}" errors="${errorN}">`
        ];
        if (/-- Configuring done/i.test(raw))
            parts.push("configuring: done");
        if (/-- Generating done/i.test(raw))
            parts.push("generating: done");
        if (/-- Build files have been written/i.test(raw))
            parts.push("build files written");
        if (foundSamples.length > 0) {
            parts.push("found (sample):");
            foundSamples.slice(0, Math.min(8, limit)).forEach((x, i) => parts.push(`  ${i + 1}. ${x}`));
            if (foundSamples.length > 8)
                parts.push(`  ... ${found - Math.min(8, limit)} more found lines`);
        }
        if (missingSamples.length > 0) {
            parts.push("missing (sample):");
            missingSamples.slice(0, Math.min(6, limit)).forEach((x, i) => parts.push(`  ${i + 1}. ${x}`));
        }
        if (cmakeErrors.length > 0) {
            parts.push("CMake errors:");
            cmakeErrors.slice(0, limit).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
            if (cmakeErrors.length > limit)
                parts.push(`  ... ${cmakeErrors.length - limit} more`);
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.91,
            actionableCount: missing + errorN,
            summary: parts.join("\n")
        };
    }
}
