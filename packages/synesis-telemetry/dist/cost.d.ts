import type { LlmUsage, PricingRates, CostResult } from "./types.js";
export declare const ZERO_USAGE: LlmUsage;
export declare function computeCost(usage: LlmUsage, rates: PricingRates, cachedMultiplier?: number): CostResult;
export declare function resolveEffectiveCost(estimated: number, actual: number): number;
export declare function mergeUsage(a: LlmUsage | undefined, b: LlmUsage): LlmUsage;
//# sourceMappingURL=cost.d.ts.map