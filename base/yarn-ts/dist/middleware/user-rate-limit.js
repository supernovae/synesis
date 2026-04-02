/**
 * Per-user sliding-window request rate limiter.
 *
 * Maintains a ring of timestamps per userId. On each check, prunes entries
 * older than the window (default 60s) and rejects if the count exceeds the
 * configured maximum.
 *
 * Bounded: evicts users with no activity older than the window on a periodic
 * sweep so the Map does not grow unbounded over long-lived pod lifetimes.
 */
export class UserRateLimiter {
    windows = new Map();
    windowMs;
    maxRequests;
    totalRejections = 0;
    sweepEvictions = 0;
    sweepTimer = null;
    constructor(opts) {
        this.windowMs = opts?.windowMs ?? 60_000;
        this.maxRequests = opts?.maxRequests ?? 30;
        this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    }
    check(userId) {
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
    getStats() {
        return {
            trackedUsers: this.windows.size,
            totalRejections: this.totalRejections,
            sweepEvictions: this.sweepEvictions,
        };
    }
    close() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }
    sweep() {
        const cutoff = Date.now() - this.windowMs;
        for (const [userId, timestamps] of this.windows) {
            if (timestamps.length === 0 || timestamps[timestamps.length - 1] < cutoff) {
                this.windows.delete(userId);
                this.sweepEvictions += 1;
            }
        }
    }
}
