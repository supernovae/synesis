#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import {
  runProviderCacheCanaries,
  summarizeProviderCacheCanaries,
} from "../src/telemetry/provider-cache-canary.js";

const jsonIndex = process.argv.indexOf("--json");
const jsonOut = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : "";
const results = runProviderCacheCanaries();
const summary = summarizeProviderCacheCanaries(results);

const report = {
  generated_at: new Date().toISOString(),
  mode: "offline",
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
}

if (!summary.passed) {
  process.exit(1);
}
