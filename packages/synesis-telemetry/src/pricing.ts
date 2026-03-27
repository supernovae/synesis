import type { PricingRates } from "./types.js";

interface RatesByModel {
  [model: string]: PricingRates;
}

export interface PricingRegistryConfig {
  adminUrl: string;
  adminToken: string;
  refreshIntervalMs?: number;
  cachedMultiplier?: number;
}

/**
 * Fetches and caches pricing rates from the admin model registry.
 * Both planner-ts and yarn-ts share this implementation.
 */
export class PricingRegistry {
  private readonly adminUrl: string;
  private readonly adminToken: string;
  private readonly refreshIntervalMs: number;
  private readonly cachedMultiplier: number;
  private rates: RatesByModel = {};
  private lastFetch = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: PricingRegistryConfig) {
    this.adminUrl = config.adminUrl;
    this.adminToken = config.adminToken;
    this.refreshIntervalMs = config.refreshIntervalMs ?? 300_000;
    this.cachedMultiplier = config.cachedMultiplier ?? 0.1;
  }

  async start(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  getRates(model: string): PricingRates {
    return (
      this.rates[model] ?? {
        input_per_million: 0,
        output_per_million: 0,
        cached_input_per_million: null,
      }
    );
  }

  getCachedMultiplier(): number {
    return this.cachedMultiplier;
  }

  getAllRates(): RatesByModel {
    return { ...this.rates };
  }

  isPopulated(): boolean {
    return Object.keys(this.rates).length > 0;
  }

  getLastFetchTimestamp(): number {
    return this.lastFetch;
  }

  async refresh(): Promise<void> {
    if (!this.adminUrl) return;
    try {
      const headers: Record<string, string> = {
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

      const resp = await fetch(
        `${this.adminUrl.replace(/\/$/, "")}${costsPath}`,
        { headers, signal: AbortSignal.timeout(5000) },
      );
      if (!resp.ok) return;

      const body = (await resp.json()) as {
        costs?: Array<{
          role: string;
          input_per_million?: number;
          output_per_million?: number;
          input_cached_per_million?: number | null;
        }>;
        roles?: Array<{
          role: string;
          input_per_million?: number;
          output_per_million?: number;
          input_cached_per_million?: number | null;
        }>;
      };

      const rows = body.costs ?? body.roles ?? [];
      const next: RatesByModel = {};
      for (const row of rows) {
        next[row.role] = {
          input_per_million: Number(row.input_per_million ?? 0),
          output_per_million: Number(row.output_per_million ?? 0),
          cached_input_per_million: row.input_cached_per_million ?? null,
        };
      }
      this.rates = next;
      this.lastFetch = Date.now();
    } catch {
      // Non-blocking: log-and-swallow. Tokens still tracked with zero cost.
    }
  }
}
