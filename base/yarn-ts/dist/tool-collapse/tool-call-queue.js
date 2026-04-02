import { EventEmitter } from "node:events";
/**
 * Debounced queue: collects tool calls emitted in a burst (e.g. streaming parser).
 */
export class ToolCallQueue extends EventEmitter {
    buffer = [];
    timer = null;
    debounceMs;
    constructor(opts) {
        super();
        this.debounceMs = Math.max(0, Math.min(500, opts.debounceMs));
    }
    enqueue(call) {
        this.buffer.push(call);
        this.scheduleFlush();
    }
    enqueueMany(calls) {
        this.buffer.push(...calls);
        this.scheduleFlush();
    }
    scheduleFlush() {
        if (this.debounceMs === 0) {
            this.flushNow();
            return;
        }
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flushNow(), this.debounceMs);
    }
    flushNow() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.buffer.length === 0)
            return;
        const batch = this.buffer;
        this.buffer = [];
        this.emit("flush", batch);
    }
    /** Wait for next debounced flush (one-shot). */
    waitNextFlush() {
        return new Promise((resolve) => {
            const onFlush = (batch) => {
                this.off("flush", onFlush);
                resolve(batch);
            };
            this.on("flush", onFlush);
        });
    }
}
