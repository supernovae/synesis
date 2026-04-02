import { EventEmitter } from "node:events";
import type { ParsedToolCall } from "./types.js";

export interface ToolCallQueueOptions {
  debounceMs: number;
}

/**
 * Debounced queue: collects tool calls emitted in a burst (e.g. streaming parser).
 */
export class ToolCallQueue extends EventEmitter {
  private buffer: ParsedToolCall[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(opts: ToolCallQueueOptions) {
    super();
    this.debounceMs = Math.max(0, Math.min(500, opts.debounceMs));
  }

  enqueue(call: ParsedToolCall): void {
    this.buffer.push(call);
    this.scheduleFlush();
  }

  enqueueMany(calls: ParsedToolCall[]): void {
    this.buffer.push(...calls);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.debounceMs === 0) {
      this.flushNow();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flushNow(), this.debounceMs);
  }

  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.emit("flush", batch);
  }

  /** Wait for next debounced flush (one-shot). */
  waitNextFlush(): Promise<ParsedToolCall[]> {
    return new Promise((resolve) => {
      const onFlush = (batch: ParsedToolCall[]) => {
        this.off("flush", onFlush);
        resolve(batch);
      };
      this.on("flush", onFlush);
    });
  }
}
