export interface FailureRecord {
  stage: string;
  type: string;
  message: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
}

export interface FailureStoreStats {
  uniqueFailures: number;
  totalFailureEvents: number;
}

export class FailureStore {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly failures = new Map<string, FailureRecord>();
  private totalEvents = 0;

  constructor(opts?: { maxEntries?: number; ttlMs?: number }) {
    this.maxEntries = Math.max(1, opts?.maxEntries ?? 500);
    this.ttlMs = Math.max(1_000, opts?.ttlMs ?? 30 * 60_000);
  }

  record(stage: string, type: string, message: string): void {
    this.prune();
    const key = `${stage}:${type}:${message.slice(0, 200)}`;
    const now = Date.now();
    const existing = this.failures.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = now;
      this.totalEvents += 1;
      return;
    }
    if (this.failures.size >= this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestSeen = Number.POSITIVE_INFINITY;
      for (const [candidateKey, rec] of this.failures.entries()) {
        if (rec.lastSeenAt < oldestSeen) {
          oldestSeen = rec.lastSeenAt;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey) this.failures.delete(oldestKey);
    }
    this.failures.set(key, {
      stage,
      type,
      message,
      firstSeenAt: now,
      lastSeenAt: now,
      count: 1,
    });
    this.totalEvents += 1;
  }

  stats(): FailureStoreStats {
    this.prune();
    return {
      uniqueFailures: this.failures.size,
      totalFailureEvents: this.totalEvents,
    };
  }

  top(limit = 20): FailureRecord[] {
    this.prune();
    return [...this.failures.values()]
      .sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt)
      .slice(0, Math.max(1, limit));
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, rec] of this.failures.entries()) {
      if (rec.lastSeenAt < cutoff) this.failures.delete(key);
    }
  }
}
