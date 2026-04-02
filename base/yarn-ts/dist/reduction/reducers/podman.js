function truncateRepeating(lines, maxUnique) {
    const seen = new Map();
    const out = [];
    for (const line of lines) {
        const c = (seen.get(line) ?? 0) + 1;
        seen.set(line, c);
        if (c <= 2)
            out.push(line);
        else if (c === 3)
            out.push(`  ... (${lines.filter((l) => l === line).length} similar lines omitted)`);
    }
    return out.slice(0, maxUnique);
}
export class PodmanReducer {
    family = "podman";
    reduce(input) {
        const raw = input.raw.trim();
        if (!raw)
            return null;
        const trimmedStart = raw.startsWith("{") || raw.startsWith("[");
        if (trimmedStart) {
            try {
                const data = JSON.parse(raw);
                const objs = Array.isArray(data) ? data : [data];
                const first = objs[0];
                if (!first || typeof first !== "object")
                    return null;
                const image = first.Config?.Image ??
                    first.Image ??
                    first.ImageName;
                const state = first.State?.Status;
                const ports = first.NetworkSettings && typeof first.NetworkSettings === "object"
                    ? JSON.stringify(first.NetworkSettings.Ports ?? {})
                    : "";
                const mounts = Array.isArray(first.Mounts)
                    ? first.Mounts
                        .slice(0, 6)
                        .map((m) => `${m.Source ?? "?"} -> ${m.Destination ?? "?"}`)
                    : [];
                if (!image && !state && mounts.length === 0 && !ports)
                    return null;
                const parts = [`<TOOL_REDUCED family="podman" containers="${objs.length}">`, "inspect:"];
                if (image)
                    parts.push(`  image: ${image}`);
                if (state)
                    parts.push(`  state: ${state}`);
                if (ports && ports !== "{}")
                    parts.push(`  ports: ${ports.slice(0, 400)}${ports.length > 400 ? "…" : ""}`);
                mounts.forEach((m) => parts.push(`  mount: ${m}`));
                parts.push("</TOOL_REDUCED>");
                return { family: this.family, confidence: 0.91, actionableCount: objs.length, summary: parts.join("\n") };
            }
            catch {
                /* fall through */
            }
        }
        const lines = input.raw.split("\n");
        const first = lines[0]?.trim() ?? "";
        if (/^CONTAINER ID\s+/.test(first) || /^CONTAINER ID\t/.test(first)) {
            const rows = [];
            for (let i = 1; i < lines.length; i++) {
                const row = lines[i].trim();
                if (!row || row.startsWith("CONTAINER"))
                    continue;
                const cols = row.split(/\s{2,}|\t+/);
                if (cols.length >= 3) {
                    const id = cols[0].slice(0, 12);
                    const imageCol = cols[1] ?? "";
                    const status = cols.length > 3 ? cols.slice(2, -1).join(" ") : (cols[2] ?? "");
                    const portsCol = cols[cols.length - 1] ?? "";
                    rows.push(`${id}  ${imageCol}  ${status}  ${portsCol}`.trim());
                }
                else
                    rows.push(row);
            }
            if (rows.length === 0)
                return null;
            const limit = input.context.profile === "ultra" ? 8 : 16;
            const parts = [`<TOOL_REDUCED family="podman" containers="${rows.length}">`, "ps:", ...rows.slice(0, limit).map((r) => `  ${r}`)];
            if (rows.length > limit)
                parts.push(`  ... ${rows.length - limit} more`);
            parts.push("</TOOL_REDUCED>");
            return { family: this.family, confidence: 0.88, actionableCount: rows.length, summary: parts.join("\n") };
        }
        if (/^REPOSITORY\s+/.test(first) || /^IMAGE ID\s+/.test(first)) {
            const rows = [];
            for (let i = 1; i < lines.length; i++) {
                const row = lines[i].trim();
                if (!row)
                    continue;
                rows.push(row);
            }
            if (rows.length === 0)
                return null;
            const limit = input.context.profile === "ultra" ? 10 : 20;
            const parts = [`<TOOL_REDUCED family="podman" containers="${rows.length}">`, "images:", ...rows.slice(0, limit).map((r) => `  ${r}`)];
            if (rows.length > limit)
                parts.push(`  ... ${rows.length - limit} more`);
            parts.push("</TOOL_REDUCED>");
            return { family: this.family, confidence: 0.87, actionableCount: rows.length, summary: parts.join("\n") };
        }
        const errWarn = lines.filter((l) => /\b(ERROR|WARN|WARNING|Error|Failed|fatal)\b/i.test(l));
        if (errWarn.length > 0 || lines.length >= 5) {
            const pick = errWarn.length > 0 ? errWarn : lines;
            const deduped = truncateRepeating(pick.map((l) => l.trim()).filter(Boolean), input.context.profile === "ultra" ? 12 : 24);
            if (deduped.length === 0)
                return null;
            const parts = [
                `<TOOL_REDUCED family="podman" containers="1">`,
                "logs:",
                ...deduped.map((l) => `  ${l}`),
                "</TOOL_REDUCED>"
            ];
            return { family: this.family, confidence: 0.85, actionableCount: errWarn.length, summary: parts.join("\n") };
        }
        return null;
    }
}
