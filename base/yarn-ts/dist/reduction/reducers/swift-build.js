export class SwiftBuildReducer {
    family = "swift-build";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        const looksSwift = /Build complete!/i.test(raw) ||
            /\berror:\s/.test(raw) ||
            /\bwarning:\s/.test(raw) ||
            /\bCompileSwift\b/.test(raw) ||
            /\bLinking\b/.test(raw) ||
            /Build target\s/i.test(raw) ||
            /Swift Compiler Error/i.test(raw) ||
            /SwiftEmitModule/i.test(raw) ||
            /xcodebuild\b/i.test(raw);
        if (!looksSwift)
            return null;
        let buildOk = null;
        if (/Build complete!/i.test(raw) && !/\berror:\s/.test(raw))
            buildOk = true;
        if (/\berror:\s/.test(raw) || /The following build commands failed:/i.test(raw))
            buildOk = false;
        const errors = [];
        const warnings = [];
        const targets = [];
        for (const line of lines) {
            const t = line.trim();
            if (/^error:\s/i.test(t) || (/\berror:\s/.test(t) && /\.swift:\d+:\d+:/.test(t))) {
                errors.push(t.slice(0, 320));
            }
            else if (/^warning:\s/i.test(t) || (/\bwarning:\s/.test(t) && /\.swift:\d+/.test(t))) {
                warnings.push(t.slice(0, 320));
            }
            else if (/^Build target\s/i.test(t) || /^CompileSwift\s/i.test(t) || /^Linking\s/i.test(t)) {
                if (targets.length < 30)
                    targets.push(t.slice(0, 200));
            }
        }
        const errorN = errors.length > 0 ? errors.length : buildOk === false ? 1 : 0;
        const warningN = warnings.length;
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const parts = [
            `<TOOL_REDUCED family="swift-build" errors="${errorN}" warnings="${warningN}">`
        ];
        if (buildOk === true)
            parts.push("build: complete");
        if (buildOk === false)
            parts.push("build: failed (errors present)");
        if (targets.length > 0) {
            parts.push("targets / compile (sample):");
            targets.slice(0, limit).forEach((x, i) => parts.push(`  ${i + 1}. ${x}`));
        }
        if (errors.length > 0) {
            parts.push("errors:");
            errors.slice(0, limit).forEach((e, i) => parts.push(`  ${i + 1}. ${e}`));
            if (errors.length > limit)
                parts.push(`  ... ${errors.length - limit} more`);
        }
        if (warnings.length > 0) {
            parts.push("warnings:");
            warnings.slice(0, Math.ceil(limit / 2)).forEach((w, i) => parts.push(`  ${i + 1}. ${w}`));
        }
        parts.push("</TOOL_REDUCED>");
        return {
            family: this.family,
            confidence: 0.88,
            actionableCount: errorN + warningN,
            summary: parts.join("\n")
        };
    }
}
