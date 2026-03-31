/**
 * Governance client — polls the admin API for effective governance rules
 * and caches them with ETag-based conditional requests.
 */

import type { AppConfig } from "../config.js";

export interface GovernanceRule {
  source: string;
  constitution_id?: string;
  constitution_name?: string;
  policy_id?: string;
  policy_name?: string;
  maturity_mode?: string;
  scope: string;
  scope_precedence: number;
  precedence: number;
  clause_id?: string;
  category: string;
  constraint_kind: string;
  statement?: string;
  machine_rule?: Record<string, unknown>;
  rule_type?: string;
  rule_config?: Record<string, unknown>;
  priority: number;
}

export interface GovernanceSnapshot {
  rules: GovernanceRule[];
  total: number;
  etag: string;
  fetchedAt: number;
}

export class GovernanceClient {
  private snapshot: GovernanceSnapshot | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly adminUrl: string;
  private readonly serviceToken: string;
  private readonly pollIntervalMs: number;
  private lastEtag = "";
  private stats = { polls: 0, updates: 0, errors: 0 };

  constructor(config: AppConfig) {
    this.adminUrl = config.SYNESIS_YARN_ADMIN_API_URL.replace(/\/+$/, "");
    this.serviceToken = config.SYNESIS_INTERNAL_SERVICE_TOKEN ?? "";
    this.pollIntervalMs = (config.SYNESIS_YARN_GOVERNANCE_POLL_INTERVAL_S ?? 60) * 1000;
  }

  start(): void {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  close(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getSnapshot(): GovernanceSnapshot | null {
    return this.snapshot;
  }

  getRules(): GovernanceRule[] {
    return this.snapshot?.rules ?? [];
  }

  getThreshold(ruleType: string, key: string): number | undefined {
    for (const r of this.getRules()) {
      if (r.rule_type === ruleType && r.rule_config && key in r.rule_config) {
        const val = r.rule_config[key];
        if (typeof val === "number") return val;
      }
    }
    return undefined;
  }

  getFeatureToggle(featureName: string): boolean | undefined {
    for (const r of this.getRules()) {
      if (r.rule_type === "feature_toggle" && r.rule_config) {
        const val = r.rule_config[featureName];
        if (typeof val === "boolean") return val;
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

  private async poll(): Promise<void> {
    this.stats.polls += 1;
    try {
      const headers: Record<string, string> = {
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
      let resp: Response;
      try {
        resp = await fetch(`${this.adminUrl}/api/v1/governance/effective`, {
          headers,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(t);
      }

      if (resp.status === 304) return;
      if (!resp.ok) {
        this.stats.errors += 1;
        return;
      }

      const body = await resp.json() as { rules: GovernanceRule[]; total: number; etag: string };
      this.snapshot = { ...body, fetchedAt: Date.now() };
      this.lastEtag = body.etag ?? "";
      this.stats.updates += 1;
    } catch {
      this.stats.errors += 1;
    }
  }
}
