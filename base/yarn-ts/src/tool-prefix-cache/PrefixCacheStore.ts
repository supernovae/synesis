/**
 * LRU string store (O(1) amortized) — same eviction pattern as [`DedupeCache`](../dedupe/DedupeCache.ts).
 */
export class PrefixCacheStore {
  private readonly maxEntries: number;
  private readonly m = new Map<string, string>();

  constructor(maxEntries: number) {
    this.maxEntries = Math.max(16, maxEntries);
  }

  get(key: string): string | undefined {
    const v = this.m.get(key);
    if (v !== undefined) {
      this.m.delete(key);
      this.m.set(key, v);
    }
    return v;
  }

  set(key: string, value: string): void {
    if (this.m.has(key)) this.m.delete(key);
    this.m.set(key, value);
    while (this.m.size > this.maxEntries) {
      const first = this.m.keys().next().value;
      if (first !== undefined) this.m.delete(first);
    }
  }

  delete(key: string): void {
    this.m.delete(key);
  }

  clear(): void {
    this.m.clear();
  }

  get size(): number {
    return this.m.size;
  }
}
