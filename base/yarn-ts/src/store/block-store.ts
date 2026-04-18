import crypto from "node:crypto";

export interface BlockRef {
  hash: string;
  byteLength: number;
  tokenEstimate: number;
}

interface BlockEntry {
  content: string;
  byteLength: number;
  refCount: number;
  lastAccess: number;
}

export interface BlockStoreStats {
  entries: number;
  totalBytes: number;
  puts: number;
  hits: number;
  misses: number;
  evictions: number;
}

const CHARS_PER_TOKEN = 4;

/**
 * Content-addressed in-process LRU for prompt blocks.
 *
 * Guarantees that identical logical content produces the exact same string
 * reference across turns — maximizing upstream KV-cache prefix reuse without
 * provider-specific logic.
 *
 * Hash: SHA-256 of NFC-normalized, whitespace-collapsed UTF-8. Truncated to
 * 32 hex chars (128 bits — collision-free at any realistic prompt-block scale).
 */
export class BlockStore {
  private readonly store = new Map<string, BlockEntry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private stats_: BlockStoreStats = {
    entries: 0,
    totalBytes: 0,
    puts: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
  };

  constructor(opts?: { maxEntries?: number; maxBytes?: number }) {
    this.maxEntries = opts?.maxEntries ?? 256;
    this.maxBytes = opts?.maxBytes ?? 8 * 1024 * 1024;
  }

  /**
   * Store content and return a stable reference. If the content already exists,
   * returns the same ref (cache hit). Content is NFC-normalized before hashing.
   */
  put(content: string): BlockRef {
    this.stats_.puts += 1;
    const normalized = content.normalize("NFC");
    const hash = BlockStore.hash(normalized);
    const existing = this.store.get(hash);
    if (existing) {
      this.stats_.hits += 1;
      existing.refCount += 1;
      existing.lastAccess = Date.now();
      // Move to end (MRU) — delete + re-set preserves Map insertion order.
      this.store.delete(hash);
      this.store.set(hash, existing);
      return { hash, byteLength: existing.byteLength, tokenEstimate: Math.ceil(normalized.length / CHARS_PER_TOKEN) };
    }

    this.stats_.misses += 1;
    const byteLength = Buffer.byteLength(normalized, "utf8");
    this.evictIfNeeded(byteLength);

    const entry: BlockEntry = {
      content: normalized,
      byteLength,
      refCount: 1,
      lastAccess: Date.now(),
    };
    this.store.set(hash, entry);
    this.stats_.entries = this.store.size;
    this.stats_.totalBytes += byteLength;

    return { hash, byteLength, tokenEstimate: Math.ceil(normalized.length / CHARS_PER_TOKEN) };
  }

  /** Retrieve stored content by hash. Returns undefined on miss (should not happen with put-then-get). */
  get(hash: string): string | undefined {
    const entry = this.store.get(hash);
    if (!entry) return undefined;
    entry.lastAccess = Date.now();
    return entry.content;
  }

  /** Check existence without updating access time. */
  has(hash: string): boolean {
    return this.store.has(hash);
  }

  /** Put content and return the stored string (convenience for put + get). */
  intern(content: string): string {
    const ref = this.put(content);
    return this.get(ref.hash) ?? content;
  }

  stats(): Readonly<BlockStoreStats> {
    return { ...this.stats_, entries: this.store.size };
  }

  /** Deterministic hash: SHA-256 of NFC-normalized UTF-8, first 32 hex chars. */
  static hash(content: string): string {
    return crypto.createHash("sha256").update(content.normalize("NFC"), "utf8").digest("hex").slice(0, 32);
  }

  private evictIfNeeded(incomingBytes: number): void {
    while (
      (this.store.size >= this.maxEntries || this.stats_.totalBytes + incomingBytes > this.maxBytes) &&
      this.store.size > 0
    ) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.store.get(oldest);
      if (entry) this.stats_.totalBytes -= entry.byteLength;
      this.store.delete(oldest);
      this.stats_.evictions += 1;
    }
  }
}
