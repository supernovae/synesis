/**
 * LRU string store (O(1) amortized) — same eviction pattern as [`DedupeCache`](../dedupe/DedupeCache.ts).
 */
export class PrefixCacheStore {
    maxEntries;
    m = new Map();
    constructor(maxEntries) {
        this.maxEntries = Math.max(16, maxEntries);
    }
    get(key) {
        const v = this.m.get(key);
        if (v !== undefined) {
            this.m.delete(key);
            this.m.set(key, v);
        }
        return v;
    }
    set(key, value) {
        if (this.m.has(key))
            this.m.delete(key);
        this.m.set(key, value);
        while (this.m.size > this.maxEntries) {
            const first = this.m.keys().next().value;
            if (first !== undefined)
                this.m.delete(first);
        }
    }
    delete(key) {
        this.m.delete(key);
    }
    clear() {
        this.m.clear();
    }
    get size() {
        return this.m.size;
    }
}
