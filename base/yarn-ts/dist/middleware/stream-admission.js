/**
 * Global stream admission controller.
 *
 * Enforces a per-pod cap on concurrent SSE streams. Overflow requests
 * enter a bounded FIFO queue and block until a slot opens or the wait
 * timeout expires. Callers that time out receive a deterministic 503
 * with Retry-After.
 *
 * Slot release is guaranteed via the returned release callback (must be
 * called on normal completion, disconnect, or error).
 */
export class StreamAdmissionController {
    activeStreams = 0;
    maxConcurrentStreams;
    maxQueueDepth;
    queueWaitTimeoutMs;
    queue = [];
    totalAdmitted = 0;
    totalQueueTimeouts = 0;
    totalQueueRejected = 0;
    constructor(opts) {
        this.maxConcurrentStreams = opts?.maxConcurrentStreams ?? 50;
        this.maxQueueDepth = opts?.maxQueueDepth ?? 100;
        this.queueWaitTimeoutMs = opts?.queueWaitTimeoutMs ?? 30_000;
    }
    /**
     * Request admission. If a slot is available, returns immediately with
     * `admitted: true` and a `release` callback. Otherwise queues the request.
     * If the queue is full, rejects immediately.
     */
    async acquire() {
        if (this.activeStreams < this.maxConcurrentStreams) {
            return this.admit();
        }
        if (this.queue.length >= this.maxQueueDepth) {
            this.totalQueueRejected += 1;
            return {
                admitted: false,
                retryAfterSeconds: 5,
                reason: "stream_queue_full",
            };
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const idx = this.queue.findIndex((e) => e.resolve === resolve);
                if (idx !== -1) {
                    this.queue.splice(idx, 1);
                    this.totalQueueTimeouts += 1;
                    resolve({
                        admitted: false,
                        retryAfterSeconds: 5,
                        reason: "stream_queue_timeout",
                    });
                }
            }, this.queueWaitTimeoutMs);
            this.queue.push({ resolve, timer });
        });
    }
    getStats() {
        return {
            activeStreams: this.activeStreams,
            maxConcurrentStreams: this.maxConcurrentStreams,
            queuedRequests: this.queue.length,
            maxQueueDepth: this.maxQueueDepth,
            totalAdmitted: this.totalAdmitted,
            totalQueueTimeouts: this.totalQueueTimeouts,
            totalQueueRejected: this.totalQueueRejected,
        };
    }
    close() {
        for (const entry of this.queue) {
            clearTimeout(entry.timer);
            entry.resolve({
                admitted: false,
                retryAfterSeconds: 1,
                reason: "server_shutting_down",
            });
        }
        this.queue.length = 0;
    }
    admit() {
        this.activeStreams += 1;
        this.totalAdmitted += 1;
        let released = false;
        const release = () => {
            if (released)
                return;
            released = true;
            this.activeStreams -= 1;
            this.drainQueue();
        };
        return { admitted: true, release };
    }
    drainQueue() {
        while (this.queue.length > 0 && this.activeStreams < this.maxConcurrentStreams) {
            const entry = this.queue.shift();
            clearTimeout(entry.timer);
            entry.resolve(this.admit());
        }
    }
}
