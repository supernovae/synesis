/**
 * Per-user sliding-window request rate limiter.
 *
 * Keeps timestamp windows per user and rejects when the request count exceeds
 * the configured limit within the active window.
 */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  currentCount: number;
  limit: number;
}

export interface RateLimiterStats {
  trackedUsers: number;
  totalRejections: number;
  sweepEvictions: number;
}

export class UserRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private totalRejections = 0;
  private sweepEvictions = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: { windowMs?: number; maxRequests?: number }) {
    this.windowMs = opts?.windowMs ?? 60_000;
    this.maxRequests = opts?.maxRequests ?? 30;
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
  }

  check(userId: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.windows.get(userId);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(userId, timestamps);
    }

    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxRequests) {
      this.totalRejections += 1;
      const oldest = timestamps[0];
      const retryAfterSeconds = Math.ceil((oldest + this.windowMs - now) / 1000);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, retryAfterSeconds),
        currentCount: timestamps.length,
        limit: this.maxRequests,
      };
    }

    timestamps.push(now);
    return {
      allowed: true,
      currentCount: timestamps.length,
      limit: this.maxRequests,
    };
  }

  getStats(): RateLimiterStats {
    return {
      trackedUsers: this.windows.size,
      totalRejections: this.totalRejections,
      sweepEvictions: this.sweepEvictions,
    };
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [userId, timestamps] of this.windows) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] < cutoff) {
        this.windows.delete(userId);
        this.sweepEvictions += 1;
      }
    }
  }
}
