import crypto from "node:crypto";
import path from "node:path";
import { sortObjectKeys } from "../compat/sorted-tools.js";
import { resolveSafePath } from "../tool-collapse/tool-call-validator.js";
import { PrefixCacheStore } from "./PrefixCacheStore.js";
import { assembleBatchReadPayload, extractBatchReadMap, looksLikeErrorPayload, looksLikePartialPayload, stablePayloadString, } from "./payload-extract.js";
function shaShort(s, n = 16) {
    return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);
}
function normRelPath(p) {
    const t = p.trim().replace(/\\/g, "/");
    const x = path.posix.normalize(t);
    return x.startsWith("/") ? x.slice(1) : x;
}
function utf8Bytes(s) {
    return Buffer.byteLength(s, "utf8");
}
function stableItemsKey(items) {
    const normalized = items.map((it) => sortObjectKeys({ query: it.query.trim(), path: it.path?.trim() }));
    return JSON.stringify(normalized);
}
/**
 * Shared LRU for tool results across requests. [`wrapExecutor`] scopes keys by resolved
 * `workspaceRoot` so concurrent coders do not collide; search/repo keys use a per-workspace
 * generation bumped after successful merge_patch.
 */
export class ToolPrefixCache {
    store;
    opts;
    genByNs = new Map();
    stats = {
        readHits: 0,
        readMisses: 0,
        searchHits: 0,
        searchMisses: 0,
        repoHits: 0,
        repoMisses: 0,
        skippedOversized: 0,
        skippedUnsafePath: 0,
        mutationInvalidations: 0,
    };
    constructor(opts) {
        this.opts = opts;
        this.store = new PrefixCacheStore(opts.maxEntries);
    }
    getStats() {
        return { ...this.stats };
    }
    /**
     * Wraps a real executor: cache hits avoid inner calls; successful safe payloads populate the LRU.
     * @param workspaceRoot Resolved workspace from the coder client (header); null disables caching.
     */
    wrapExecutor(inner, workspaceRoot) {
        const ws = workspaceRoot?.trim() ? path.resolve(workspaceRoot.trim()) : null;
        const ns = ws ? shaShort(ws) : null;
        if (!ns || !workspaceRoot?.trim()) {
            return inner;
        }
        const readKey = (relPath) => {
            const n = normRelPath(relPath);
            const r = resolveSafePath(workspaceRoot, n);
            if (!r.ok) {
                this.stats.skippedUnsafePath++;
                return null;
            }
            return `v1:r:${ns}:${n}`;
        };
        const generation = () => this.genByNs.get(ns) ?? 0;
        const searchKey = (items) => {
            return `v1:s:${ns}:${generation()}:${shaShort(stableItemsKey(items), 24)}`;
        };
        const repoKey = (search, readPaths) => {
            const payload = sortObjectKeys({
                q: search.query.trim(),
                p: search.path?.trim(),
                reads: readPaths.map(normRelPath),
            });
            return `v1:rc:${ns}:${generation()}:${shaShort(JSON.stringify(payload), 24)}`;
        };
        const allowStoreString = (s) => {
            if (utf8Bytes(s) > this.opts.maxEntryBytes) {
                this.stats.skippedOversized++;
                return false;
            }
            return true;
        };
        const allowStorePayload = (payload) => {
            return allowStoreString(stablePayloadString(payload));
        };
        const bumpGeneration = () => {
            const next = (this.genByNs.get(ns) ?? 0) + 1;
            this.genByNs.set(ns, next);
            this.stats.mutationInvalidations++;
        };
        return {
            batchRead: async (paths) => {
                const cached = new Map();
                const misses = [];
                for (const p of paths) {
                    const k = readKey(p);
                    if (!k) {
                        misses.push(p);
                        continue;
                    }
                    const hit = this.store.get(k);
                    if (hit !== undefined) {
                        cached.set(p, hit);
                        this.stats.readHits++;
                    }
                    else {
                        misses.push(p);
                    }
                }
                if (misses.length === 0) {
                    return assembleBatchReadPayload(paths, cached);
                }
                this.stats.readMisses += misses.length;
                const subFresh = await inner.batchRead(misses.length === paths.length ? paths : misses);
                if (looksLikeErrorPayload(subFresh) || looksLikePartialPayload(subFresh)) {
                    return misses.length === paths.length ? subFresh : inner.batchRead(paths);
                }
                let extracted = extractBatchReadMap(subFresh, misses);
                if (!misses.every((p) => extracted.has(p))) {
                    const full = await inner.batchRead(paths);
                    if (looksLikeErrorPayload(full) || looksLikePartialPayload(full))
                        return full;
                    extracted = extractBatchReadMap(full, paths);
                    if (!paths.every((p) => extracted.has(p)))
                        return full;
                    for (const p of paths) {
                        const body = extracted.get(p);
                        if (allowStoreString(body)) {
                            const rk = readKey(p);
                            if (rk)
                                this.store.set(rk, body);
                        }
                    }
                    return full;
                }
                for (const p of misses) {
                    const body = extracted.get(p);
                    if (allowStoreString(body)) {
                        const rk = readKey(p);
                        if (rk)
                            this.store.set(rk, body);
                    }
                }
                if (cached.size === 0 && misses.length === paths.length) {
                    return subFresh;
                }
                const fullMap = new Map(cached);
                for (const p of misses)
                    fullMap.set(p, extracted.get(p));
                return assembleBatchReadPayload(paths, fullMap);
            },
            batchSearch: async (items) => {
                const k = searchKey(items);
                const hit = this.store.get(k);
                if (hit !== undefined) {
                    this.stats.searchHits++;
                    try {
                        return JSON.parse(hit);
                    }
                    catch {
                        this.stats.searchMisses++;
                        return inner.batchSearch(items);
                    }
                }
                this.stats.searchMisses++;
                const out = await inner.batchSearch(items);
                if (looksLikeErrorPayload(out) || looksLikePartialPayload(out)) {
                    return out;
                }
                if (!allowStorePayload(out))
                    return out;
                this.store.set(k, stablePayloadString(out));
                return out;
            },
            repoContext: async (search, readPaths) => {
                const k = repoKey(search, readPaths);
                const hit = this.store.get(k);
                if (hit !== undefined) {
                    this.stats.repoHits++;
                    try {
                        return JSON.parse(hit);
                    }
                    catch {
                        this.stats.repoMisses++;
                        return inner.repoContext(search, readPaths);
                    }
                }
                this.stats.repoMisses++;
                const out = await inner.repoContext(search, readPaths);
                if (looksLikeErrorPayload(out) || looksLikePartialPayload(out)) {
                    return out;
                }
                if (!allowStorePayload(out))
                    return out;
                this.store.set(k, stablePayloadString(out));
                return out;
            },
            mergePatch: async (files) => {
                const out = await inner.mergePatch(files);
                if (!looksLikeErrorPayload(out) && !looksLikePartialPayload(out)) {
                    for (const f of files) {
                        const rk = readKey(f.path);
                        if (rk)
                            this.store.delete(rk);
                    }
                    bumpGeneration();
                }
                return out;
            },
            runTests: async (command) => inner.runTests(command),
        };
    }
}
