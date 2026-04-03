import { normalizeToolAlias } from "../tool-aliases.js";
/** Tools Yarn owns server-side — never merge with client file ops. */
export const NEVER_COLLAPSE_NAMES = new Set([
    "synesis_artifact_retrieve",
    "synesis_knowledge_search",
]);
const READ_ALIASES = new Set([
    "read_file",
    "read",
    "filesystem_read_file",
    "view_file",
    "readfile",
]);
const SEARCH_ALIASES = new Set([
    "search_code",
    "grep",
    "rg",
    "codebase_search",
    "ripgrep",
    "workspace_search",
    "semantic_search",
    "file_search",
]);
const PATCH_ALIASES = new Set([
    "apply_patch",
    "update",
    "edit",
    "str_replace_editor",
    "search_replace",
    "edit_file",
    "replace",
]);
const RUN_ALIASES = new Set([
    "run_test",
    "run_build",
    "run_lint",
    "format_code",
    "run_terminal_cmd",
    "execute_command",
    "run_tests",
    "shell",
    "bash",
]);
export function classifyTool(name) {
    const n = normalizeToolAlias(name);
    if (READ_ALIASES.has(n))
        return "read_file";
    if (SEARCH_ALIASES.has(n))
        return "search";
    if (PATCH_ALIASES.has(n))
        return "apply_patch";
    if (RUN_ALIASES.has(n))
        return "run_tests";
    return "passthrough";
}
function asRecord(input) {
    if (input && typeof input === "object" && !Array.isArray(input)) {
        return input;
    }
    if (typeof input === "string") {
        try {
            const j = JSON.parse(input);
            if (j && typeof j === "object" && !Array.isArray(j))
                return j;
        }
        catch {
            return {};
        }
    }
    return {};
}
export function extractReadPath(input) {
    const o = asRecord(input);
    const v = (typeof o.target_file === "string" && o.target_file) ||
        (typeof o.path === "string" && o.path) ||
        (typeof o.file === "string" && o.file) ||
        (typeof o.file_path === "string" && o.file_path) ||
        (typeof o.filename === "string" && o.filename);
    return v ? String(v) : null;
}
export function extractSearchQuery(input) {
    const o = asRecord(input);
    const q = (typeof o.query === "string" && o.query) ||
        (typeof o.pattern === "string" && o.pattern) ||
        (typeof o.q === "string" && o.q) ||
        (typeof o.search_term === "string" && o.search_term);
    if (!q)
        return null;
    const path = (typeof o.path === "string" && o.path) ||
        (typeof o.target_directory === "string" && o.target_directory) ||
        undefined;
    return { query: String(q), path };
}
export function extractPatch(input) {
    const o = asRecord(input);
    const path = (typeof o.path === "string" && o.path) ||
        (typeof o.file === "string" && o.file) ||
        (typeof o.target_file === "string" && o.target_file);
    const patch = (typeof o.patch === "string" && o.patch) ||
        (typeof o.diff === "string" && o.diff) ||
        (typeof o.contents === "string" && o.contents) ||
        (typeof o.new_string === "string" && o.new_string);
    if (!path || !patch)
        return null;
    return { path: String(path), patch: String(patch) };
}
export function extractCommand(input) {
    const o = asRecord(input);
    const c = (typeof o.command === "string" && o.command) ||
        (typeof o.cmd === "string" && o.cmd) ||
        (typeof o.shell === "string" && o.shell);
    return c ? String(c) : null;
}
function logEntry(phase, detail, extra) {
    return { phase, detail, atMs: Date.now(), ...extra };
}
/**
 * Dedupes by file path only (`target_file` / `path` / etc.).
 * `line_range`, `offset`/`limit`, and similar are ignored for grouping — overlapping
 * reads of the same path collapse to one entry (synthetic `synesis_batch_read` = full file per path).
 */
function buildBatchRead(chunk) {
    const pathToPrimaryId = new Map();
    const pathToAllIds = new Map();
    const order = [];
    for (const c of chunk) {
        const p = extractReadPath(c.input);
        if (!p)
            continue;
        if (!pathToPrimaryId.has(p)) {
            pathToPrimaryId.set(p, c.toolCallId);
            order.push(p);
        }
        const list = pathToAllIds.get(p) ?? [];
        list.push(c.toolCallId);
        pathToAllIds.set(p, list);
    }
    return {
        kind: "batch_read",
        paths: order,
        pathToPrimaryId,
        pathToAllIds,
    };
}
/**
 * Calls that may change workspace state — after these, a re-read of the same path is not redundant.
 */
function endsReadSearchDedupeSegment(c) {
    if (NEVER_COLLAPSE_NAMES.has(c.toolName))
        return false;
    const k = classifyTool(c.toolName);
    return k === "apply_patch" || k === "run_tests";
}
function searchDedupeKey(q) {
    return `${q.query}\0${q.path ?? ""}`;
}
/**
 * Within each segment (split on `apply_patch` / `run_terminal_cmd`, and on Synesis protected tools), drop:
 * - **Interleaved** duplicate `read_file` for the same path (e.g. `read → search → read same file`).
 *   Consecutive reads of the same path are **kept** so the main pass can `batch_read` and retain all tool IDs.
 * - **Interleaved** duplicate `search` with the same (query, path). Consecutive identical searches are kept for `batch_search`.
 *
 * Does **not** drop across segments (patch/shell may have changed files).
 */
export function dedupeReadsAndSearchesWithinSegments(calls) {
    const droppedReadIds = [];
    const droppedSearchIds = [];
    const out = [];
    const flushSegment = (segment) => {
        const seenPaths = new Set();
        const seenSearch = new Set();
        for (let idx = 0; idx < segment.length; idx++) {
            const c = segment[idx];
            if (NEVER_COLLAPSE_NAMES.has(c.toolName)) {
                out.push(c);
                continue;
            }
            const k = classifyTool(c.toolName);
            if (k === "read_file") {
                const p = extractReadPath(c.input);
                if (p) {
                    if (seenPaths.has(p)) {
                        const prev = idx > 0 ? segment[idx - 1] : null;
                        const immediatelyAfterSamePathRead = prev !== null &&
                            !NEVER_COLLAPSE_NAMES.has(prev.toolName) &&
                            classifyTool(prev.toolName) === "read_file" &&
                            extractReadPath(prev.input) === p;
                        if (!immediatelyAfterSamePathRead) {
                            droppedReadIds.push(c.toolCallId);
                            continue;
                        }
                    }
                    else {
                        seenPaths.add(p);
                    }
                }
                out.push(c);
                continue;
            }
            if (k === "search") {
                const sq = extractSearchQuery(c.input);
                if (sq) {
                    const key = searchDedupeKey(sq);
                    if (seenSearch.has(key)) {
                        const prev = idx > 0 ? segment[idx - 1] : null;
                        const immediatelyAfterSameSearch = prev !== null &&
                            !NEVER_COLLAPSE_NAMES.has(prev.toolName) &&
                            classifyTool(prev.toolName) === "search" &&
                            extractSearchQuery(prev.input) !== null &&
                            searchDedupeKey(extractSearchQuery(prev.input)) === key;
                        if (!immediatelyAfterSameSearch) {
                            droppedSearchIds.push(c.toolCallId);
                            continue;
                        }
                    }
                    else {
                        seenSearch.add(key);
                    }
                }
                out.push(c);
                continue;
            }
            out.push(c);
        }
    };
    let segment = [];
    for (const c of calls) {
        if (NEVER_COLLAPSE_NAMES.has(c.toolName)) {
            flushSegment(segment);
            segment = [];
            out.push(c);
            continue;
        }
        segment.push(c);
        if (endsReadSearchDedupeSegment(c)) {
            flushSegment(segment);
            segment = [];
        }
    }
    if (segment.length > 0) {
        flushSegment(segment);
    }
    return { calls: out, droppedReadIds, droppedSearchIds };
}
function mergePatchGroup(chunk) {
    const byFile = new Map();
    for (const c of chunk) {
        const ex = extractPatch(c.input);
        if (!ex)
            continue;
        const cur = byFile.get(ex.path) ?? { patch: "", ids: [] };
        cur.patch = cur.patch ? `${cur.patch}\n\n${ex.patch}` : ex.patch;
        cur.ids.push(c.toolCallId);
        byFile.set(ex.path, cur);
    }
    const files = [...byFile.entries()].map(([path, v]) => ({
        path,
        patch: v.patch,
        originalIds: v.ids,
    }));
    return { kind: "merge_patch", files };
}
/**
 * Linear batching only (repo_context, batch_read, batch_search, merge_patch, …).
 * Callers that run [`dedupe/DedupeLayer`](../dedupe/DedupeLayer.ts) should pass **already segment-deduped** calls here to avoid double prepass.
 */
export function collapseToolCallsLinear(slim, log, originalIncomingCount) {
    const operations = [];
    log.push(logEntry("receive", `incoming ${slim.length} tool call(s) (${originalIncomingCount} original before dedupe pipeline)`));
    let i = 0;
    while (i < slim.length) {
        const c = slim[i];
        if (NEVER_COLLAPSE_NAMES.has(c.toolName)) {
            operations.push({ kind: "passthrough", calls: [c] });
            log.push(logEntry("collapse", `passthrough protected: ${c.toolName}`, { originalIds: [c.toolCallId] }));
            i += 1;
            continue;
        }
        const k = classifyTool(c.toolName);
        if (k === "passthrough") {
            operations.push({ kind: "passthrough", calls: [c] });
            i += 1;
            continue;
        }
        if (k === "search") {
            const next = slim[i + 1];
            const nk = next ? classifyTool(next.toolName) : "passthrough";
            if (next && nk === "read_file" && !NEVER_COLLAPSE_NAMES.has(next.toolName)) {
                const sq = extractSearchQuery(c.input);
                const rp = extractReadPath(next.input);
                if (sq && rp) {
                    const rc = {
                        kind: "repo_context",
                        search: { query: sq.query, path: sq.path },
                        reads: [{ path: rp, toolCallId: next.toolCallId }],
                        originalIds: [c.toolCallId, next.toolCallId],
                    };
                    operations.push(rc);
                    log.push(logEntry("collapse", "repo_context: search + read_file", { originalIds: rc.originalIds, syntheticName: "synesis_repo_context" }));
                    i += 2;
                    continue;
                }
            }
            const chunk = [];
            while (i < slim.length) {
                const x = slim[i];
                if (NEVER_COLLAPSE_NAMES.has(x.toolName))
                    break;
                if (classifyTool(x.toolName) !== "search")
                    break;
                chunk.push(x);
                i += 1;
            }
            if (chunk.length >= 2) {
                const items = chunk
                    .map((x) => extractSearchQuery(x.input))
                    .filter((q) => q != null);
                if (items.length >= 2) {
                    const bs = {
                        kind: "batch_search",
                        items,
                        originalIds: chunk.map((x) => x.toolCallId),
                    };
                    operations.push(bs);
                    log.push(logEntry("collapse", `batch_search: ${items.length} quer(ies)`, {
                        originalIds: bs.originalIds,
                        syntheticName: "synesis_batch_search",
                    }));
                }
                else {
                    operations.push({ kind: "passthrough", calls: chunk });
                }
            }
            else if (chunk.length === 1) {
                operations.push({ kind: "passthrough", calls: chunk });
            }
            continue;
        }
        if (k === "read_file") {
            const chunk = [];
            while (i < slim.length) {
                const x = slim[i];
                if (NEVER_COLLAPSE_NAMES.has(x.toolName))
                    break;
                if (classifyTool(x.toolName) !== "read_file")
                    break;
                chunk.push(x);
                i += 1;
            }
            if (chunk.length === 0)
                continue;
            if (chunk.length === 1) {
                operations.push({ kind: "passthrough", calls: chunk });
                log.push(logEntry("collapse", "single read_file passthrough", { originalIds: [chunk[0].toolCallId] }));
            }
            else {
                const br = buildBatchRead(chunk);
                operations.push(br);
                log.push(logEntry("collapse", `batch_read: ${br.paths.length} path(s)`, {
                    originalIds: chunk.map((x) => x.toolCallId),
                    syntheticName: "synesis_batch_read",
                }));
            }
            continue;
        }
        if (k === "apply_patch") {
            const chunk = [];
            while (i < slim.length) {
                const x = slim[i];
                if (NEVER_COLLAPSE_NAMES.has(x.toolName))
                    break;
                if (classifyTool(x.toolName) !== "apply_patch")
                    break;
                chunk.push(x);
                i += 1;
            }
            if (chunk.length === 1) {
                operations.push({ kind: "passthrough", calls: chunk });
            }
            else {
                const mp = mergePatchGroup(chunk);
                operations.push(mp);
                log.push(logEntry("collapse", `merge_patch: ${mp.files.length} file(s)`, {
                    originalIds: chunk.map((x) => x.toolCallId),
                    syntheticName: "synesis_merge_patch",
                }));
            }
            continue;
        }
        if (k === "run_tests") {
            const cmd = extractCommand(c.input);
            if (!cmd) {
                operations.push({ kind: "passthrough", calls: [c] });
                i += 1;
                continue;
            }
            const chunkIds = [c.toolCallId];
            let j = i + 1;
            while (j < slim.length) {
                const x = slim[j];
                if (NEVER_COLLAPSE_NAMES.has(x.toolName))
                    break;
                if (classifyTool(x.toolName) !== "run_tests")
                    break;
                const c2 = extractCommand(x.input);
                if (c2 !== cmd)
                    break;
                chunkIds.push(x.toolCallId);
                j += 1;
            }
            if (j > i + 1) {
                operations.push({ kind: "run_tests", command: cmd, originalIds: chunkIds });
                log.push(logEntry("collapse", "run_tests: deduped identical command", { originalIds: chunkIds, syntheticName: "synesis_run_tests" }));
                i = j;
            }
            else {
                operations.push({ kind: "passthrough", calls: [c] });
                i += 1;
            }
            continue;
        }
        operations.push({ kind: "passthrough", calls: [c] });
        i += 1;
    }
    return { operations, log };
}
/**
 * Full pipeline: segment read/search prepass + linear collapse. Used by tests and callers that do not use DedupeLayer.
 */
export function collapseToolCalls(calls) {
    const log = [];
    const prepass = dedupeReadsAndSearchesWithinSegments(calls);
    const nDrop = prepass.droppedReadIds.length + prepass.droppedSearchIds.length;
    if (nDrop > 0) {
        log.push(logEntry("collapse", `prepass_segment_dedupe: dropped ${prepass.droppedReadIds.length} read(s), ${prepass.droppedSearchIds.length} search(es)`, {
            originalIds: [...prepass.droppedReadIds, ...prepass.droppedSearchIds],
        }));
    }
    const plan = collapseToolCallsLinear(prepass.calls, log, calls.length);
    return { operations: plan.operations, log };
}
