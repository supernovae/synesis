function walkAws(val, acc) {
    if (val === null || val === undefined)
        return;
    if (typeof val === "string") {
        if (/^i-[0-9a-f]{8,17}$/i.test(val))
            acc.instanceIds.push(val);
        if (val.startsWith("arn:aws:"))
            acc.arns.push(val);
        return;
    }
    if (Array.isArray(val)) {
        for (const v of val)
            walkAws(v, acc);
        return;
    }
    if (typeof val === "object") {
        const o = val;
        if (typeof o.InstanceId === "string")
            acc.instanceIds.push(o.InstanceId);
        if (typeof o.Arn === "string")
            acc.arns.push(o.Arn);
        const st = o.State;
        if (st && typeof st === "object" && typeof st.Name === "string") {
            acc.states.push(st.Name);
        }
        const tags = o.Tags;
        if (Array.isArray(tags)) {
            for (const t of tags) {
                if (t && typeof t === "object") {
                    const tag = t;
                    if (tag.Key === "Name" && typeof tag.Value === "string")
                        acc.names.push(tag.Value);
                }
            }
        }
        for (const k of Object.keys(o))
            walkAws(o[k], acc);
    }
}
function tryParseJson(raw) {
    const t = raw.trim();
    try {
        return JSON.parse(t);
    }
    catch {
        const objStart = t.indexOf("{");
        const objEnd = t.lastIndexOf("}");
        if (objStart >= 0 && objEnd > objStart) {
            try {
                return JSON.parse(t.slice(objStart, objEnd + 1));
            }
            catch {
                /* fall through */
            }
        }
        const arrStart = t.indexOf("[");
        const arrEnd = t.lastIndexOf("]");
        if (arrStart >= 0 && arrEnd > arrStart) {
            try {
                return JSON.parse(t.slice(arrStart, arrEnd + 1));
            }
            catch {
                return null;
            }
        }
        return null;
    }
}
function parseAwsTableLines(lines) {
    const rows = [];
    const headers = [];
    for (const line of lines) {
        if (!line.includes("|"))
            continue;
        const cells = line
            .split("|")
            .map((c) => c.trim())
            .filter((c) => c.length > 0 && !/^[-+]+$/.test(c));
        if (cells.length === 0)
            continue;
        const joined = cells.join(" | ");
        if (/^(InstanceId|ARN|Name|State)\b/i.test(joined) || /^ARN\b/i.test(cells[0] ?? "")) {
            headers.push(joined);
            continue;
        }
        if (/\bi-[0-9a-f]{8,17}\b/i.test(joined) ||
            /arn:aws:[a-z0-9-]+:/i.test(joined) ||
            (cells.length >= 2 && /running|stopped|pending|terminated/i.test(joined))) {
            rows.push(joined);
        }
    }
    return { rows, headers };
}
export class AwsCliReducer {
    family = "aws-cli";
    reduce(input) {
        const raw = input.raw;
        const lines = raw.split("\n");
        const acc = { instanceIds: [], arns: [], names: [], states: [] };
        const parsed = tryParseJson(raw);
        let resourceCount = 0;
        const detailLines = [];
        if (parsed !== null) {
            walkAws(parsed, acc);
            const uniqInstances = [...new Set(acc.instanceIds)];
            const uniqArns = [...new Set(acc.arns)];
            resourceCount = uniqInstances.length > 0 ? uniqInstances.length : uniqArns.length;
            if (resourceCount === 0 && Array.isArray(parsed)) {
                resourceCount = parsed.length;
            }
            if (resourceCount === 0 && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                const o = parsed;
                if (Array.isArray(o.Reservations)) {
                    let n = 0;
                    for (const r of o.Reservations) {
                        if (r && typeof r === "object" && Array.isArray(r.Instances)) {
                            n += r.Instances.length;
                        }
                    }
                    resourceCount = n;
                }
            }
            uniqInstances.slice(0, 6).forEach((id) => detailLines.push(`instance: ${id}`));
            uniqArns.slice(0, 4).forEach((a) => detailLines.push(`arn: ${a}`));
            [...new Set(acc.names)].slice(0, 4).forEach((n) => detailLines.push(`Name: ${n}`));
            [...new Set(acc.states)].slice(0, 4).forEach((s) => detailLines.push(`state: ${s}`));
        }
        const table = parseAwsTableLines(lines);
        if (table.rows.length > 0) {
            resourceCount = Math.max(resourceCount, table.rows.length);
            table.headers.slice(0, 2).forEach((h) => detailLines.push(`header: ${h}`));
            const limit = input.context.profile === "ultra" ? 6 : 12;
            table.rows.slice(0, limit).forEach((r) => detailLines.push(r));
            if (table.rows.length > limit)
                detailLines.push(`... ${table.rows.length - limit} more rows`);
        }
        if (resourceCount === 0) {
            const arnMatches = raw.match(/arn:aws:[a-z0-9-]+:[^:\s]+:[^:\s]*:[^\s]+/gi) ?? [];
            const idMatches = raw.match(/\bi-[0-9a-f]{8,17}\b/gi) ?? [];
            const combined = [...new Set([...arnMatches, ...idMatches])];
            if (combined.length > 0) {
                resourceCount = combined.length;
                combined.slice(0, 8).forEach((x) => detailLines.push(x));
            }
        }
        if (resourceCount === 0 && detailLines.length === 0)
            return null;
        const limit = input.context.profile === "ultra" ? 8 : 16;
        const parts = [`<TOOL_REDUCED family="aws-cli" resources="${resourceCount}">`];
        detailLines.slice(0, limit).forEach((d) => parts.push(`  ${d}`));
        if (detailLines.length > limit)
            parts.push(`  ... ${detailLines.length - limit} more`);
        parts.push("</TOOL_REDUCED>");
        const badStates = acc.states.filter((s) => !/running|available|completed/i.test(s)).length;
        const actionableCount = badStates > 0 ? badStates : resourceCount;
        return {
            family: this.family,
            confidence: 0.9,
            actionableCount,
            summary: parts.join("\n")
        };
    }
}
