/**
 * Governance client — polls the admin API for effective governance rules
 * and caches them with ETag-based conditional requests.
 */
export class GovernanceClient {
    snapshot = null;
    pollTimer = null;
    adminUrl;
    serviceToken;
    pollIntervalMs;
    lastEtag = "";
    stats = { polls: 0, updates: 0, errors: 0 };
    constructor(config) {
        this.adminUrl = config.SYNESIS_YARN_ADMIN_API_URL.replace(/\/+$/, "");
        this.serviceToken = config.SYNESIS_INTERNAL_SERVICE_TOKEN ?? "";
        this.pollIntervalMs = (config.SYNESIS_YARN_GOVERNANCE_POLL_INTERVAL_S ?? 60) * 1000;
    }
    start() {
        this.poll();
        this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    }
    close() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }
    getSnapshot() {
        return this.snapshot;
    }
    getRules() {
        return this.snapshot?.rules ?? [];
    }
    getThreshold(ruleType, key) {
        for (const r of this.getRules()) {
            if (r.rule_type === ruleType && r.rule_config && key in r.rule_config) {
                const val = r.rule_config[key];
                if (typeof val === "number")
                    return val;
            }
        }
        return undefined;
    }
    getFeatureToggle(featureName) {
        for (const r of this.getRules()) {
            if (r.rule_type === "feature_toggle" && r.rule_config) {
                const val = r.rule_config[featureName];
                if (typeof val === "boolean")
                    return val;
            }
        }
        return undefined;
    }
    getStats() {
        return {
            ...this.stats,
            rulesLoaded: this.snapshot?.total ?? 0,
            lastEtag: this.lastEtag,
            lastFetchedAt: this.snapshot?.fetchedAt ?? 0,
        };
    }
    async poll() {
        this.stats.polls += 1;
        try {
            const headers = {
                "Accept": "application/json",
            };
            if (this.serviceToken) {
                headers["Authorization"] = `Bearer ${this.serviceToken}`;
            }
            if (this.lastEtag) {
                headers["If-None-Match"] = `"${this.lastEtag}"`;
            }
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 10_000);
            let resp;
            try {
                resp = await fetch(`${this.adminUrl}/api/v1/governance/effective`, {
                    headers,
                    signal: controller.signal,
                });
            }
            finally {
                clearTimeout(t);
            }
            if (resp.status === 304)
                return;
            if (!resp.ok) {
                this.stats.errors += 1;
                return;
            }
            const body = await resp.json();
            this.snapshot = { ...body, fetchedAt: Date.now() };
            this.lastEtag = body.etag ?? "";
            this.stats.updates += 1;
        }
        catch {
            this.stats.errors += 1;
        }
    }
}
