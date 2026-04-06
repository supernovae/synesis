import { randomUUID } from "node:crypto";
import type { TraceEvent, TraceLogger } from "./types.js";

export class InMemoryTraceLogger implements TraceLogger {
  private readonly byTrace = new Map<string, TraceEvent[]>();

  async log(event: Omit<TraceEvent, "eventId" | "createdAtIso">): Promise<TraceEvent> {
    const built: TraceEvent = {
      ...event,
      eventId: `evt_${randomUUID()}`,
      createdAtIso: new Date().toISOString(),
    };
    const current = this.byTrace.get(built.traceId) ?? [];
    current.push(built);
    this.byTrace.set(built.traceId, current);
    return built;
  }

  async list(traceId: string): Promise<TraceEvent[]> {
    return [...(this.byTrace.get(traceId) ?? [])];
  }
}
