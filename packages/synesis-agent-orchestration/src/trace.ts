import { randomUUID } from "node:crypto";
import { TraceEventSchema } from "./schemas.js";
import type { TraceEvent, TraceLogger } from "./types.js";

export class InMemoryTraceLogger implements TraceLogger {
  private readonly byTrace = new Map<string, TraceEvent[]>();

  async log(event: Omit<TraceEvent, "eventId" | "createdAtIso">): Promise<TraceEvent> {
    const built: TraceEvent = {
      ...event,
      eventId: `evt_${randomUUID()}`,
      createdAtIso: new Date().toISOString(),
    };
    const parsed = TraceEventSchema.parse(built);
    const current = this.byTrace.get(built.traceId) ?? [];
    current.push(parsed);
    this.byTrace.set(parsed.traceId, current);
    return parsed;
  }

  async list(traceId: string): Promise<TraceEvent[]> {
    return [...(this.byTrace.get(traceId) ?? [])];
  }
}
