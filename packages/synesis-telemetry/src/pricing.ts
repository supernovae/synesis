import type { PricingRates, PricingSource } from "./types.js";
import { FALLBACK_BASE_RATES, hasNonZeroRates } from "./cost.js";

export interface RatesByRole {
  [role: string]: PricingRates;
}

export interface PricingRegistryConfig {
  adminUrl: string;
  adminToken: string;
  refreshIntervalMs?: number;
  cachedMultiplier?: number;
}

export interface ResolvedRates {
  rates: PricingRates;
  pricing_source: PricingSource;
}

/**
 * Fetches and caches pricing rates from the admin model registry.
 * Both planner-ts and yarn-ts share this implementation.
 *
 * When a role has no registry entry or zero rates, the fallback base
 * rates are returned so costs are never silently $0.00.
 */
export class PricingRegistry {
  private readonly adminUrl: string;
  private readonly adminToken: string;
  private readonly refreshIntervalMs: number;
  private readonly cachedMultiplier: number;
  private rates: RatesByRole = {};
  private sources: Record<string, PricingSource> = {};
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

  getRates(role: string): PricingRates {
    const registered = this.rates[role];
    if (registered && hasNonZeroRates(registered)) return registered;
    return { ...FALLBACK_BASE_RATES };
  }

  getResolvedRates(role: string): ResolvedRates {
    const registered = this.rates[role];
    if (registered && hasNonZeroRates(registered)) {
      return {
        rates: registered,
        pricing_source: this.sources[role] ?? "manual",
      };
    }
    return { rates: { ...FALLBACK_BASE_RATES }, pricing_source: "fallback_base" };
  }

  getCachedMultiplier(): number {
    return this.cachedMultiplier;
  }

  getAllRates(): RatesByRole {
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
          input_cache_write_per_million?: number | null;
          pricing_source?: string;
        }>;
        roles?: Array<{
          role: string;
          input_per_million?: number;
          output_per_million?: number;
          input_cached_per_million?: number | null;
          input_cache_write_per_million?: number | null;
          pricing_source?: string;
        }>;
      };

      const rows = body.costs ?? body.roles ?? [];
      const next: RatesByRole = {};
      const nextSources: Record<string, PricingSource> = {};
      for (const row of rows) {
        next[row.role] = {
          input_per_million: Number(row.input_per_million ?? 0),
          output_per_million: Number(row.output_per_million ?? 0),
          cached_input_per_million: row.input_cached_per_million ?? null,
          cache_write_input_per_million:
            row.input_cache_write_per_million == null
              ? null
              : Number(row.input_cache_write_per_million),
        };
        nextSources[row.role] =
          (row.pricing_source as PricingSource) ?? "manual";
      }
      this.rates = next;
      this.sources = nextSources;
      this.lastFetch = Date.now();
    } catch (err) {
      console.warn("[pricing] rate refresh failed:", (err as Error).message ?? err);
    }
  }
}
