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
function walkAz(val, acc) {
    if (val === null || val === undefined)
        return;
    if (Array.isArray(val)) {
        for (const v of val)
            walkAz(v, acc);
        return;
    }
    if (typeof val === "object") {
        const o = val;
        if (typeof o.name === "string")
            acc.names.push(o.name);
        if (typeof o.type === "string")
            acc.types.push(o.type);
        if (typeof o.location === "string")
            acc.locations.push(o.location);
        const prov = o.provisioningState;
        if (typeof prov === "string")
            acc.states.push(prov);
        const ps = o.powerState;
        if (typeof ps === "string")
            acc.states.push(ps);
        const id = o.id;
        if (typeof id === "string" && id.includes("/resourceGroups/"))
            acc.names.push(id.split("/").pop() ?? id);
        for (const k of Object.keys(o))
            walkAz(o[k], acc);
    }
}
function parseAzTable(lines) {
    let header = "";
    const rows = [];
    for (const line of lines) {
        const t = line.trim();
        if (!t)
            continue;
        if (/^Name\s+ResourceGroup\s+/i.test(t) || /^Name\s+Type\s+/i.test(t) || /^Name\s+Location/i.test(t)) {
            header = t.replace(/\s+/g, " ");
            continue;
        }
        if (header &&
            /^\S+\s+\S+/.test(t) &&
            !t.startsWith("az ") &&
            !/["'{}[\]]/.test(t)) {
            rows.push(t.replace(/\s+/g, " ").trim());
        }
    }
    return { header, rows };
}
export class AzCliReducer {
    family = "az-cli";
    reduce(input) {
        const raw = input.raw;
        const acc = {
            names: [],
            types: [],
            locations: [],
            states: []
        };
        const parsed = tryParseJson(raw);
        const detailLines = [];
        let resourceCount = 0;
        if (parsed !== null) {
            walkAz(parsed, acc);
            const uniqNames = [...new Set(acc.names)];
            resourceCount = Array.isArray(parsed) ? parsed.length : uniqNames.length > 0 ? uniqNames.length : 0;
            uniqNames.slice(0, 8).forEach((n) => detailLines.push(`name: ${n}`));
            [...new Set(acc.types)].slice(0, 6).forEach((ty) => detailLines.push(`type: ${ty}`));
            [...new Set(acc.locations)].slice(0, 4).forEach((l) => detailLines.push(`location: ${l}`));
            [...new Set(acc.states)].slice(0, 4).forEach((s) => detailLines.push(`state: ${s}`));
        }
        const table = parseAzTable(raw.split("\n"));
        if (table.header)
            detailLines.push(`table: ${table.header}`);
        if (table.rows.length > 0) {
            resourceCount = Math.max(resourceCount, table.rows.length);
            const limit = input.context.profile === "ultra" ? 6 : 12;
            table.rows.slice(0, limit).forEach((r) => detailLines.push(r));
            if (table.rows.length > limit)
                detailLines.push(`... ${table.rows.length - limit} more rows`);
        }
        if (resourceCount === 0 && detailLines.length === 0)
            return null;
        const limit = input.context.profile === "ultra" ? 8 : 18;
        const parts = [`<TOOL_REDUCED family="az-cli" resources="${resourceCount}">`];
        detailLines.slice(0, limit).forEach((d) => parts.push(`  ${d}`));
        if (detailLines.length > limit)
            parts.push(`  ... ${detailLines.length - limit} more`);
        parts.push("</TOOL_REDUCED>");
        const actionable = acc.states.filter((s) => !/succeeded|running|available/i.test(s)).length || resourceCount;
        return {
            family: this.family,
            confidence: 0.89,
            actionableCount: actionable,
            summary: parts.join("\n")
        };
    }
}
