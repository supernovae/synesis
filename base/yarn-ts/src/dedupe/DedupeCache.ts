/**
 * Small LRU caches for exact tool keys, semantic keys, and response content hashes.
 * O(1) amortized per op via Map + insertion-order eviction.
 */
export class DedupeCache {
  private readonly maxEntries: number;
  private readonly exactCall = new Map<string, unknown>();
  private readonly semanticCall = new Map<string, unknown>();
  private readonly responseByKey = new Map<string, string>();

  constructor(maxEntries: number) {
    this.maxEntries = Math.max(16, maxEntries);
  }

  private touch<K, V>(m: Map<K, V>, key: K, value: V): void {
    if (m.has(key)) m.delete(key);
    m.set(key, value);
    while (m.size > this.maxEntries) {
      const first = m.keys().next().value;
      if (first !== undefined) m.delete(first);
    }
  }

  getExactCall(key: string): unknown | undefined {
    const v = this.exactCall.get(key);
    if (v !== undefined) {
      this.exactCall.delete(key);
      this.exactCall.set(key, v);
    }
    return v;
  }

  setExactCall(key: string, value: unknown): void {
    this.touch(this.exactCall, key, value);
  }

  getSemanticCall(key: string): unknown | undefined {
    const v = this.semanticCall.get(key);
    if (v !== undefined) {
      this.semanticCall.delete(key);
      this.semanticCall.set(key, v);
    }
    return v;
  }

  setSemanticCall(key: string, value: unknown): void {
    this.touch(this.semanticCall, key, value);
  }

  getResponse(key: string): string | undefined {
    const v = this.responseByKey.get(key);
    if (v !== undefined) {
      this.responseByKey.delete(key);
      this.responseByKey.set(key, v);
    }
    return v;
  }

  setResponse(key: string, payload: string): void {
    this.touch(this.responseByKey, key, payload);
  }

  clear(): void {
    this.exactCall.clear();
    this.semanticCall.clear();
    this.responseByKey.clear();
  }
}
