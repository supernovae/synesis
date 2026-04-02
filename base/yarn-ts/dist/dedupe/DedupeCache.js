/**
 * Small LRU caches for exact tool keys, semantic keys, and response content hashes.
 * O(1) amortized per op via Map + insertion-order eviction.
 */
export class DedupeCache {
    maxEntries;
    exactCall = new Map();
    semanticCall = new Map();
    responseByKey = new Map();
    constructor(maxEntries) {
        this.maxEntries = Math.max(16, maxEntries);
    }
    touch(m, key, value) {
        if (m.has(key))
            m.delete(key);
        m.set(key, value);
        while (m.size > this.maxEntries) {
            const first = m.keys().next().value;
            if (first !== undefined)
                m.delete(first);
        }
    }
    getExactCall(key) {
        const v = this.exactCall.get(key);
        if (v !== undefined) {
            this.exactCall.delete(key);
            this.exactCall.set(key, v);
        }
        return v;
    }
    setExactCall(key, value) {
        this.touch(this.exactCall, key, value);
    }
    getSemanticCall(key) {
        const v = this.semanticCall.get(key);
        if (v !== undefined) {
            this.semanticCall.delete(key);
            this.semanticCall.set(key, v);
        }
        return v;
    }
    setSemanticCall(key, value) {
        this.touch(this.semanticCall, key, value);
    }
    getResponse(key) {
        const v = this.responseByKey.get(key);
        if (v !== undefined) {
            this.responseByKey.delete(key);
            this.responseByKey.set(key, v);
        }
        return v;
    }
    setResponse(key, payload) {
        this.touch(this.responseByKey, key, payload);
    }
    clear() {
        this.exactCall.clear();
        this.semanticCall.clear();
        this.responseByKey.clear();
    }
}
