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
export declare class PricingRegistry {
    private readonly adminUrl;
    private readonly adminToken;
    private readonly refreshIntervalMs;
    private readonly cachedMultiplier;
    private rates;
    private lastFetch;
    private refreshTimer;
    constructor(config: PricingRegistryConfig);
    start(): Promise<void>;
    stop(): void;
    getRates(model: string): PricingRates;
    getCachedMultiplier(): number;
    getAllRates(): RatesByModel;
    isPopulated(): boolean;
    getLastFetchTimestamp(): number;
    refresh(): Promise<void>;
}
export {};
//# sourceMappingURL=pricing.d.ts.map