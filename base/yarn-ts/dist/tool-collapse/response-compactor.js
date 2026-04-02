function sortKeysDeep(v) {
    if (v === null || v === undefined)
        return v;
    if (Array.isArray(v))
        return v.map(sortKeysDeep);
    if (typeof v === "object") {
        const o = v;
        const out = {};
        for (const k of Object.keys(o).sort()) {
            out[k] = sortKeysDeep(o[k]);
        }
        return out;
    }
    return v;
}
/**
 * Single JSON envelope for the LLM / client (deterministic key order).
 */
export function compactExecutionResults(results) {
    const payload = {
        version: 1,
        results: results.map((r) => ({
            operationIndex: r.operationIndex,
            kind: r.kind,
            ok: !r.error,
            error: r.error ?? null,
            payload: r.payload,
        })),
    };
    return JSON.stringify(sortKeysDeep(payload));
}
