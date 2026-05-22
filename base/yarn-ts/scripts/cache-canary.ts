#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import {
  PROVIDER_CACHE_CANARY_CASES,
  runProviderCacheCanaries,
  runProviderCacheLiveCanaries,
  summarizeProviderCacheCanaries,
  summarizeProviderCacheLiveCanaries,
  type ProviderCacheLiveEndpoint,
} from "../src/telemetry/provider-cache-canary.js";

const jsonIndex = process.argv.indexOf("--json");
const jsonOut = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : "";
const live = process.argv.includes("--live") || process.env.SYNESIS_CACHE_CANARY_LIVE === "1";
const costAck = process.argv.includes("--ack-cost") || process.env.SYNESIS_CACHE_CANARY_ACK_COST === "1";
const requireCacheHit =
  process.argv.includes("--require-cache-hit") || process.env.SYNESIS_CACHE_CANARY_REQUIRE_HIT === "1";
const allowIndex = process.argv.indexOf("--allow");
const inlineAllow = process.argv.find((arg) => arg.startsWith("--allow="))?.slice("--allow=".length);
const allowedProviderIds = (
  inlineAllow
    ? inlineAllow
    : allowIndex >= 0
    ? process.argv[allowIndex + 1] ?? ""
    : process.env.SYNESIS_CACHE_CANARY_ALLOW ?? ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function envPrefix(providerId: string): string {
  return `SYNESIS_CACHE_CANARY_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function endpointFromEnv(providerId: string): ProviderCacheLiveEndpoint | undefined {
  const prefix = envPrefix(providerId);
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  if (!baseUrl) return undefined;
  const apiKey = process.env[`${prefix}_API_KEY`] ?? process.env.SYNESIS_CACHE_CANARY_API_KEY;
  const model = process.env[`${prefix}_MODEL`];
  return {
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
  };
}

function liveEndpointsFromEnv(): Record<string, ProviderCacheLiveEndpoint | undefined> {
  return Object.fromEntries(
    PROVIDER_CACHE_CANARY_CASES.map((canary) => [canary.id, endpointFromEnv(canary.id)]),
  );
}

const results = runProviderCacheCanaries();
const summary = summarizeProviderCacheCanaries(results);
const liveResults = await runProviderCacheLiveCanaries({
  enabled: live,
  costAck,
  allowedProviderIds,
  endpoints: liveEndpointsFromEnv(),
  maxCompletionTokens: Number(process.env.SYNESIS_CACHE_CANARY_MAX_TOKENS ?? 32),
  timeoutMs: Number(process.env.SYNESIS_CACHE_CANARY_TIMEOUT_MS ?? 30_000),
  requireCacheHit,
});
const liveSummary = summarizeProviderCacheLiveCanaries(liveResults);

const report = {
  generated_at: new Date().toISOString(),
  mode: live ? "offline+live" : "offline",
  summary,
  results: results.map((result) => ({
    id: result.id,
    display_name: result.displayName,
    passed: result.passed,
    failures: result.failures,
    marker_backend: result.markerBackend,
    provider_strategy: result.providerStrategy,
    cache_hint_strategy: result.cacheHintStrategy,
    prefix_stable_bytes: result.prefixStableBytes,
    marker_indices_first: result.markerIndicesFirst,
    marker_indices_second: result.markerIndicesSecond,
    marker_stable: result.markerStable,
    annotations: result.annotations,
    hit_recommendation: result.decisions.hit.recommendation,
    miss_recommendation: result.decisions.miss.recommendation,
    write_without_read_recommendation: result.decisions.writeWithoutRead?.recommendation ?? null,
  })),
  live_summary: liveSummary,
  live_results: liveResults.map((result) => ({
    id: result.id,
    display_name: result.displayName,
    status: result.status,
    reason: result.reason ?? null,
    failures: result.failures,
    warnings: result.warnings,
    http_statuses: result.httpStatuses,
    prompt_tokens: result.promptTokens,
    cached_prompt_tokens: result.cachedPromptTokens,
    cache_creation_tokens: result.cacheCreationTokens,
    cache_hit_pct: result.cacheHitPct,
    recommendation: result.recommendation,
  })),
};

if (jsonIndex >= 0) {
  const serialized = JSON.stringify(report, null, 2);
  if (jsonOut && !jsonOut.startsWith("--")) {
    writeFileSync(jsonOut, `${serialized}\n`, "utf8");
  } else {
    console.log(serialized);
  }
} else {
  console.log(`Provider cache canaries: ${summary.total - summary.failed}/${summary.total} passed`);
  for (const result of report.results) {
    const status = result.passed ? "PASS" : "FAIL";
    console.log(
      `${status} ${result.id} strategy=${result.provider_strategy} hint=${result.cache_hint_strategy} `
      + `prefix=${result.prefix_stable_bytes} markers=${result.marker_indices_second.join(",") || "none"}`,
    );
    for (const failure of result.failures) {
      console.log(`  - ${failure}`);
    }
  }
  if (live) {
    console.log(
      `Live provider cache canaries: ${liveSummary.total - liveSummary.failed - liveSummary.skipped}/`
      + `${liveSummary.total} passed, ${liveSummary.skipped} skipped, ${liveSummary.failed} failed`,
    );
    for (const result of report.live_results) {
      const suffix = result.reason ? ` reason=${result.reason}` : "";
      console.log(
        `${result.status.toUpperCase()} ${result.id}${suffix} http=${result.http_statuses.join(",") || "none"} `
        + `hit=${result.cache_hit_pct}% cached=${result.cached_prompt_tokens} recommendation=${result.recommendation}`,
      );
      for (const warning of result.warnings) {
        console.log(`  warning: ${warning}`);
      }
      for (const failure of result.failures) {
        console.log(`  failure: ${failure}`);
      }
    }
  } else {
    console.log("Live provider cache canaries are disabled. Pass --live, --ack-cost, and --allow=<ids> to opt in.");
  }
}

if (!summary.passed || !liveSummary.passed) {
  process.exit(1);
}
