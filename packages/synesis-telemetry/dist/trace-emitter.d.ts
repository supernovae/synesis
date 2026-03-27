import type { TraceRecord } from "./types.js";
export interface TraceEmitterConfig {
    adminUrl: string;
    adminToken: string;
    timeoutMs?: number;
}
/**
 * Fire-and-forget POST to admin /api/v1/traces/ingest.
 * Never blocks the response path; failures are logged and swallowed.
 */
export declare function emitTrace(trace: TraceRecord, config: TraceEmitterConfig, logger?: {
    warn: (msg: string, ...args: unknown[]) => void;
}): void;
//# sourceMappingURL=trace-emitter.d.ts.map