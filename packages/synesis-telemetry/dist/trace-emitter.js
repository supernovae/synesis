/**
 * Fire-and-forget POST to admin /api/v1/traces/ingest.
 * Never blocks the response path; failures are logged and swallowed.
 */
export function emitTrace(trace, config, logger) {
    if (!config.adminUrl)
        return;
    const url = `${config.adminUrl.replace(/\/$/, "")}/api/v1/traces/ingest`;
    const headers = {
        "Content-Type": "application/json",
    };
    if (config.adminToken) {
        headers["x-synesis-service-token"] = config.adminToken;
        headers["x-synesis-service-name"] = trace.service;
        headers["authorization"] = `Bearer ${config.adminToken}`;
    }
    void fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(trace),
        signal: AbortSignal.timeout(config.timeoutMs ?? 3000),
    }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger?.warn(`trace emit failed: ${msg}`);
    });
}
//# sourceMappingURL=trace-emitter.js.map