/** Shared token / USD formatters for Models & Costs and Yarn Fabric. */

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function fmtCost(n: number): string {
  if (n < 0.005 && n > 0) return `$${n.toFixed(6)}`;
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtDurationMs(ms: number): string {
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export function isFallbackPricing(source: string | undefined | null): boolean {
  return source === "fallback_base" || source === "unknown" || !source;
}

export function pricingSourceLabel(source: string | undefined | null): string {
  switch (source) {
    case "provider": return "Provider";
    case "manual": return "Registry";
    case "infra_calc": return "Infra";
    case "api_lookup": return "API";
    case "fallback_base": return "Fallback";
    default: return "Unknown";
  }
}
