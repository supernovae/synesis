import { sortObjectKeys } from "../compat/sorted-tools.js";
function stableStringify(v) {
    return JSON.stringify(sortObjectKeys(v));
}
/** Extract per-path file bodies from heterogeneous executor payloads (deterministic best-effort). */
export function extractBatchReadMap(payload, paths) {
    const m = new Map();
    if (payload === null || payload === undefined)
        return m;
    if (typeof payload === "string") {
        if (paths.length === 1)
            m.set(paths[0], payload);
        return m;
    }
    if (typeof payload !== "object")
        return m;
    const o = payload;
    if (Array.isArray(o.results)) {
        for (const row of o.results) {
            if (row && typeof row === "object") {
                const r = row;
                const p = (typeof r.path === "string" && r.path) ||
                    (typeof r.file === "string" && r.file) ||
                    (typeof r.target_file === "string" && r.target_file) ||
                    null;
                const c = (typeof r.content === "string" && r.content) ||
                    (typeof r.text === "string" && r.text) ||
                    (typeof r.body === "string" && r.body) ||
                    null;
                if (p && c)
                    m.set(p, c);
            }
        }
    }
    const pathsArr = o.paths;
    const contentsArr = o.contents;
    if (Array.isArray(pathsArr) && Array.isArray(contentsArr) && pathsArr.length === contentsArr.length) {
        for (let i = 0; i < pathsArr.length; i++) {
            const p = pathsArr[i];
            const c = contentsArr[i];
            if (typeof p === "string" && typeof c === "string")
                m.set(p, c);
        }
    }
    if (Array.isArray(o.files)) {
        for (const row of o.files) {
            if (row && typeof row === "object") {
                const r = row;
                const p = typeof r.path === "string" ? r.path : null;
                const c = (typeof r.content === "string" && r.content) ||
                    (typeof r.text === "string" && r.text) ||
                    null;
                if (p && c)
                    m.set(p, c);
            }
        }
    }
    for (const p of paths) {
        const v = o[p];
        if (typeof v === "string")
            m.set(p, v);
    }
    return m;
}
export function assembleBatchReadPayload(paths, contentsByPath) {
    return {
        paths,
        contents: paths.map((p) => contentsByPath.get(p) ?? ""),
        _synesis_prefix_cache: "read_assembly",
    };
}
/** Whole-value cache for search / repo_context (JSON round-trip). */
export function stablePayloadString(payload) {
    return stableStringify(payload);
}
export function looksLikeErrorPayload(payload) {
    if (payload === null)
        return true;
    if (typeof payload === "object" && !Array.isArray(payload)) {
        const o = payload;
        if (o.ok === false)
            return true;
        if (typeof o.error === "string" && o.error.length > 0)
            return true;
        if (o.status === "error")
            return true;
    }
    if (typeof payload === "string") {
        const s = payload.trim().toLowerCase();
        if (s.startsWith("error:") || s.includes("traceback"))
            return true;
    }
    return false;
}
export function looksLikePartialPayload(payload) {
    if (payload === null || payload === undefined)
        return true;
    if (typeof payload === "object" && !Array.isArray(payload)) {
        const o = payload;
        if (o.partial === true)
            return true;
        if (o.incomplete === true)
            return true;
        if (o.streaming === true)
            return true;
        if (o.status === "in_progress" || o.status === "partial")
            return true;
    }
    return false;
}
