/**
 * Fetches and caches pricing rates from the admin model registry.
 * Both planner-ts and yarn-ts share this implementation.
 */
export class PricingRegistry {
    adminUrl;
    adminToken;
    refreshIntervalMs;
    cachedMultiplier;
    rates = {};
    lastFetch = 0;
    refreshTimer = null;
    constructor(config) {
        this.adminUrl = config.adminUrl;
        this.adminToken = config.adminToken;
        this.refreshIntervalMs = config.refreshIntervalMs ?? 300_000;
        this.cachedMultiplier = config.cachedMultiplier ?? 0.1;
    }
    async start() {
        await this.refresh();
        this.refreshTimer = setInterval(() => {
            void this.refresh();
        }, this.refreshIntervalMs);
    }
    stop() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
    getRates(model) {
        return (this.rates[model] ?? {
            input_per_million: 0,
            output_per_million: 0,
            cached_input_per_million: null,
        });
    }
    getCachedMultiplier() {
        return this.cachedMultiplier;
    }
    getAllRates() {
        return { ...this.rates };
    }
    isPopulated() {
        return Object.keys(this.rates).length > 0;
    }
    getLastFetchTimestamp() {
        return this.lastFetch;
    }
    async refresh() {
        if (!this.adminUrl)
            return;
        try {
            const headers = {
                "Content-Type": "application/json",
            };
            if (this.adminToken) {
                headers["x-synesis-service-token"] = this.adminToken;
                headers["x-synesis-service-name"] = "synesis-telemetry";
                headers["authorization"] = `Bearer ${this.adminToken}`;
            }
            const hasToken = Boolean(this.adminToken);
            const costsPath = hasToken
                ? "/api/v1/models/costs/active/internal"
                : "/api/v1/models/costs/active";
            const resp = await fetch(`${this.adminUrl.replace(/\/$/, "")}${costsPath}`, { headers, signal: AbortSignal.timeout(5000) });
            if (!resp.ok)
                return;
            const body = (await resp.json());
            const rows = body.costs ?? body.roles ?? [];
            const next = {};
            for (const row of rows) {
                next[row.role] = {
                    input_per_million: Number(row.input_per_million ?? 0),
                    output_per_million: Number(row.output_per_million ?? 0),
                    cached_input_per_million: row.input_cached_per_million ?? null,
                };
            }
            this.rates = next;
            this.lastFetch = Date.now();
        }
        catch {
            // Non-blocking: log-and-swallow. Tokens still tracked with zero cost.
        }
    }
}
//# sourceMappingURL=pricing.js.map