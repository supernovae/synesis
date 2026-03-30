/**
 * Global stream admission controller.
 *
 * Enforces per-pod limits for streaming requests. Overflow is queued in a
 * bounded FIFO queue with timeout-based rejection.
 */
export interface StreamAdmissionStats {
  activeStreams: number;
  maxConcurrentStreams: number;
  queuedRequests: number;
  maxQueueDepth: number;
  totalAdmitted: number;
  totalQueueTimeouts: number;
  totalQueueRejected: number;
}

export interface AdmissionResult {
  admitted: boolean;
  release?: () => void;
  retryAfterSeconds?: number;
  reason?: string;
}

interface QueueEntry {
  resolve: (result: AdmissionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class StreamAdmissionController {
  private activeStreams = 0;
  private readonly maxConcurrentStreams: number;
  private readonly maxQueueDepth: number;
  private readonly queueWaitTimeoutMs: number;
  private readonly queue: QueueEntry[] = [];

  private totalAdmitted = 0;
  private totalQueueTimeouts = 0;
  private totalQueueRejected = 0;

  constructor(opts?: {
    maxConcurrentStreams?: number;
    maxQueueDepth?: number;
    queueWaitTimeoutMs?: number;
  }) {
    this.maxConcurrentStreams = opts?.maxConcurrentStreams ?? 50;
    this.maxQueueDepth = opts?.maxQueueDepth ?? 100;
    this.queueWaitTimeoutMs = opts?.queueWaitTimeoutMs ?? 30_000;
  }

  async acquire(): Promise<AdmissionResult> {
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

    return new Promise<AdmissionResult>((resolve) => {
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

  getStats(): StreamAdmissionStats {
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

  close(): void {
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

  private admit(): AdmissionResult {
    this.activeStreams += 1;
    this.totalAdmitted += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeStreams -= 1;
      this.drainQueue();
    };
    return { admitted: true, release };
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.activeStreams < this.maxConcurrentStreams) {
      const entry = this.queue.shift();
      if (!entry) break;
      clearTimeout(entry.timer);
      entry.resolve(this.admit());
    }
  }
}
