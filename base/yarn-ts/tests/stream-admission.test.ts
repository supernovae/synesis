import { describe, expect, it, vi } from "vitest";
import { StreamAdmissionController } from "../src/middleware/stream-admission.js";

describe("StreamAdmissionController", () => {
  it("admits requests under the concurrency cap", async () => {
    const ctrl = new StreamAdmissionController({ maxConcurrentStreams: 2 });

    const r1 = await ctrl.acquire();
    expect(r1.admitted).toBe(true);
    expect(r1.release).toBeTypeOf("function");

    const r2 = await ctrl.acquire();
    expect(r2.admitted).toBe(true);

    expect(ctrl.getStats().activeStreams).toBe(2);
    expect(ctrl.getStats().totalAdmitted).toBe(2);

    r1.release!();
    r2.release!();
    expect(ctrl.getStats().activeStreams).toBe(0);
    ctrl.close();
  });

  it("queues overflow requests and drains when slots open", async () => {
    const ctrl = new StreamAdmissionController({
      maxConcurrentStreams: 1,
      maxQueueDepth: 5,
      queueWaitTimeoutMs: 5000,
    });

    const r1 = await ctrl.acquire();
    expect(r1.admitted).toBe(true);

    const p2 = ctrl.acquire();
    expect(ctrl.getStats().queuedRequests).toBe(1);

    r1.release!();
    const r2 = await p2;
    expect(r2.admitted).toBe(true);
    expect(ctrl.getStats().queuedRequests).toBe(0);
    expect(ctrl.getStats().activeStreams).toBe(1);

    r2.release!();
    ctrl.close();
  });

  it("rejects immediately when queue is full", async () => {
    const ctrl = new StreamAdmissionController({
      maxConcurrentStreams: 1,
      maxQueueDepth: 1,
    });

    const r1 = await ctrl.acquire();
    expect(r1.admitted).toBe(true);

    const _queued = ctrl.acquire();
    expect(ctrl.getStats().queuedRequests).toBe(1);

    const r3 = await ctrl.acquire();
    expect(r3.admitted).toBe(false);
    expect(r3.reason).toBe("stream_queue_full");
    expect(r3.retryAfterSeconds).toBeDefined();
    expect(ctrl.getStats().totalQueueRejected).toBe(1);

    r1.release!();
    const queuedResult = await _queued;
    queuedResult.release!();
    ctrl.close();
  });

  it("times out queued requests after timeout period", async () => {
    vi.useFakeTimers();
    const ctrl = new StreamAdmissionController({
      maxConcurrentStreams: 1,
      maxQueueDepth: 5,
      queueWaitTimeoutMs: 100,
    });

    const r1 = await ctrl.acquire();
    expect(r1.admitted).toBe(true);

    const p2 = ctrl.acquire();
    vi.advanceTimersByTime(150);

    const r2 = await p2;
    expect(r2.admitted).toBe(false);
    expect(r2.reason).toBe("stream_queue_timeout");
    expect(ctrl.getStats().totalQueueTimeouts).toBe(1);

    r1.release!();
    ctrl.close();
    vi.useRealTimers();
  });

  it("release is idempotent — double release does not undercount", async () => {
    const ctrl = new StreamAdmissionController({ maxConcurrentStreams: 2 });

    const r1 = await ctrl.acquire();
    r1.release!();
    r1.release!();
    expect(ctrl.getStats().activeStreams).toBe(0);
    ctrl.close();
  });

  it("close resolves all queued waiters with rejection", async () => {
    const ctrl = new StreamAdmissionController({
      maxConcurrentStreams: 1,
      maxQueueDepth: 5,
      queueWaitTimeoutMs: 60_000,
    });

    const r1 = await ctrl.acquire();
    const p2 = ctrl.acquire();
    const p3 = ctrl.acquire();

    ctrl.close();

    const r2 = await p2;
    const r3 = await p3;
    expect(r2.admitted).toBe(false);
    expect(r2.reason).toBe("server_shutting_down");
    expect(r3.admitted).toBe(false);
    expect(r3.reason).toBe("server_shutting_down");

    r1.release!();
  });

  it("stats reflect all operations correctly", async () => {
    const ctrl = new StreamAdmissionController({
      maxConcurrentStreams: 2,
      maxQueueDepth: 10,
    });

    const stats0 = ctrl.getStats();
    expect(stats0.activeStreams).toBe(0);
    expect(stats0.maxConcurrentStreams).toBe(2);
    expect(stats0.maxQueueDepth).toBe(10);
    expect(stats0.totalAdmitted).toBe(0);

    const r1 = await ctrl.acquire();
    const r2 = await ctrl.acquire();

    const stats1 = ctrl.getStats();
    expect(stats1.activeStreams).toBe(2);
    expect(stats1.totalAdmitted).toBe(2);

    r1.release!();
    r2.release!();

    const stats2 = ctrl.getStats();
    expect(stats2.activeStreams).toBe(0);
    ctrl.close();
  });
});
