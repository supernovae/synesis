export class StackTraceReducer {
    family = "stack-trace";
    reduce(input) {
        const raw = input.raw;
        const frames = [];
        let errorLine = "";
        let causedBy = "";
        const pyMatch = raw.match(/^(\w+Error|\w+Exception):\s*.+$/m);
        const nodeMatch = raw.match(/^(\w+Error):\s*.+$/m);
        const javaMatch = raw.match(/^([\w.]+(?:Error|Exception)):\s*.+$/m);
        if (pyMatch)
            errorLine = pyMatch[0];
        else if (nodeMatch)
            errorLine = nodeMatch[0];
        else if (javaMatch)
            errorLine = javaMatch[0];
        for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (/^\s*File "/.test(line) || /^\s*at /.test(line) || /^\s+at [\w.$]+\(/.test(line)) {
                frames.push(trimmed);
            }
            else if (/^Caused by:/.test(trimmed)) {
                causedBy = trimmed;
            }
        }
        if (!errorLine && frames.length < 2)
            return null;
        const limit = input.context.profile === "ultra" ? 4 : 8;
        const topFrames = frames.slice(0, limit);
        const parts = [`<TOOL_REDUCED family="stack-trace" frames="${frames.length}">`];
        if (errorLine)
            parts.push(errorLine);
        if (causedBy)
            parts.push(causedBy);
        topFrames.forEach((f) => parts.push(`  ${f}`));
        if (frames.length > limit)
            parts.push(`  ... ${frames.length - limit} more frames`);
        parts.push("</TOOL_REDUCED>");
        return { family: this.family, confidence: 0.9, actionableCount: 1, summary: parts.join("\n") };
    }
}
