export class DockerComposeReducer {
    family = "docker-compose";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        const services = new Map();
        const serviceFromLogLine = (line) => {
            const m = line.match(/^([a-zA-Z0-9_.-]+)\s*\|\s*/);
            if (m)
                return m[1];
            const m2 = line.match(/^([a-zA-Z0-9_.-]+)\s+\|/);
            return m2 ? m2[1] : null;
        };
        for (const line of lines) {
            const t = line.trim();
            if (/^Attaching to\b/i.test(t)) {
                const names = t.replace(/^Attaching to\s+/i, "").split(/,\s*/);
                for (const n of names) {
                    const s = n.trim();
                    if (s)
                        services.set(s, { errors: [] });
                }
                continue;
            }
            if (/^Container\s+/.test(t) && /\bRunning\b|\bExited\b|\bCreated\b/i.test(t)) {
                const nameMatch = t.match(/Container\s+([a-zA-Z0-9_.-]+)/);
                const svc = nameMatch?.[1] ?? "unknown";
                if (!services.has(svc))
                    services.set(svc, { errors: [] });
                const st = /\bRunning\b/i.test(t) ? "running" : /\bExited\b/i.test(t) ? "exited" : "created";
                services.get(svc).status = st;
                continue;
            }
            if (/^\s*Name\s+Command\s+State\s+Ports/i.test(t) || /^NAME\s+IMAGE\s+COMMAND/i.test(t)) {
                continue;
            }
            if (/^[a-zA-Z0-9_.-]+\s+.+"(Up|Exit|Restarting|Created|Dead|Paused)/i.test(t)) {
                const cols = t.split(/\s{2,}/);
                const name = cols[0];
                if (!services.has(name))
                    services.set(name, { errors: [] });
                if (/Up/i.test(t))
                    services.get(name).status = "up";
                else if (/Exit|Exited/i.test(t))
                    services.get(name).status = "exited";
                continue;
            }
            if (/^(Started|Starting|Created|Recreating|Stopping|Stopped)\b/i.test(t)) {
                const m = t.match(/\b([a-zA-Z0-9_.-]+)\s*$/);
                if (m) {
                    const svc = m[1];
                    if (!services.has(svc))
                        services.set(svc, { errors: [] });
                    services.get(svc).status = t.split(/\s+/)[0].toLowerCase();
                }
                continue;
            }
            const svcName = serviceFromLogLine(line);
            if (svcName && /\b(ERROR|ERR!|FATAL|WARN|WARNING|Exception)\b/i.test(line)) {
                if (!services.has(svcName))
                    services.set(svcName, { errors: [] });
                services.get(svcName).errors.push(line.replace(/^[a-zA-Z0-9_.-]+\s*\|\s*/, "").trim().slice(0, 240));
            }
        }
        const errLines = lines.filter((l) => /\b(ERROR|ERR!|FATAL)\b/i.test(l) && !l.includes("|"));
        if (services.size === 0 && errLines.length === 0) {
            if (!/compose|Creating|Started|container/i.test(raw))
                return null;
        }
        const limit = input.context.profile === "ultra" ? 6 : 12;
        const parts = [`<TOOL_REDUCED family="docker-compose" services="${Math.max(services.size, errLines.length > 0 ? 1 : 0)}">`];
        let i = 0;
        for (const [name, info] of services) {
            if (i >= limit)
                break;
            const bits = [name];
            if (info.status)
                bits.push(`status=${info.status}`);
            if (info.errors.length > 0)
                bits.push(`errors=${info.errors.length}`);
            parts.push(`  ${bits.join(" ")}`);
            info.errors.slice(0, 3).forEach((e) => parts.push(`    ${e}`));
            i += 1;
        }
        if (services.size > limit)
            parts.push(`  ... ${services.size - limit} more services`);
        if (errLines.length > 0 && services.size === 0) {
            errLines.slice(0, 8).forEach((e) => parts.push(`  ${e.trim().slice(0, 200)}`));
        }
        parts.push("</TOOL_REDUCED>");
        const errorCount = [...services.values()].reduce((a, s) => a + s.errors.length, 0) + errLines.length;
        if (parts.length <= 2 && errorCount === 0)
            return null;
        return { family: this.family, confidence: 0.88, actionableCount: errorCount, summary: parts.join("\n") };
    }
}
