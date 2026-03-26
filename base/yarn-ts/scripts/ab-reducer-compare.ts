#!/usr/bin/env tsx
/**
 * A-B Reducer Profile Comparison Runner
 *
 * Compares reducer configurations by running identical payloads with different
 * settings, capturing latency, reduction counters, and token savings.
 *
 * Requires admin access to toggle env vars on the live deployment, OR
 * runs against a local dev Yarn with different env configs.
 *
 * Strategy: Instead of mutating live deployment env vars (risky), this runner
 * sends a batch of requests, captures telemetry, then presents a comparison
 * of the current configuration against a hypothetical "reducers-off" baseline
 * computed locally from raw fixture sizes.
 *
 * Env:
 *   SYNESIS_YARN_URL     required
 *   SYNESIS_TEST_AUTH    PAT with coder scope (raw value, no "Bearer " prefix)
 *   SYNESIS_VERIFY_MODEL synesis-core (default)
 *
 * Auth resolution: SYNESIS_TEST_AUTH > SYNESIS_TEST_TOKEN
 *
 * Usage:
 *   npx tsx scripts/ab-reducer-compare.ts
 *   npx tsx scripts/ab-reducer-compare.ts --json ab-report.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const YARN_URL = (process.env.SYNESIS_YARN_URL ?? "").replace(/\/+$/, "");
const TOKEN = (process.env.SYNESIS_TEST_AUTH ?? process.env.SYNESIS_TEST_TOKEN ?? "").trim();
const MODEL = process.env.SYNESIS_VERIFY_MODEL ?? "synesis-core";
const JSON_OUT = process.argv.includes("--json")
  ? process.argv[process.argv.indexOf("--json") + 1]
  : null;

if (!YARN_URL) {
  console.error("ERROR: SYNESIS_YARN_URL is required");
  process.exit(1);
}
if (!TOKEN) {
  console.error("ERROR: SYNESIS_TEST_TOKEN is required for A-B comparison");
  process.exit(1);
}

interface Telemetry {
  timestamp: number;
  toolResultReduction: {
    rawCharsTotal: number;
    reducedCharsTotal: number;
    reducedCount: number;
    artifactHandleCount: number;
    tokensSavedEstimateTotal: number;
    fallbackToArtifactCount: number;
    reducerFailures: number;
    byFamily: Record<string, number>;
    lifecycle: Record<string, { lifecycle: string; successes: number; failures: number }>;
  };
  [k: string]: unknown;
}

interface RunResult {
  scenario: string;
  family: string;
  httpStatus: number;
  latencyMs: number;
  rawChars: number;
  pass: boolean;
}

interface ProfileRun {
  label: string;
  results: RunResult[];
  telemetryBefore: Telemetry | null;
  telemetryAfter: Telemetry | null;
  delta: Record<string, number>;
  totalLatencyMs: number;
  avgLatencyMs: number;
}

interface ABReport {
  url: string;
  model: string;
  startedAt: string;
  durationMs: number;
  profiles: ProfileRun[];
  baseline: { totalRawChars: number; estimatedRawTokens: number };
  comparison: {
    reducedCountDelta: number;
    tokensSavedDelta: number;
    avgLatencyDiffMs: number;
    reductionRatioPercent: number;
  };
}

const FIXTURE_DIRS = {
  small: join(process.cwd(), "tests", "fixtures", "reducers"),
  large: join(process.cwd(), "tests", "fixtures", "live")
};

function loadFixture(name: string, size: "small" | "large" = "large"): string {
  const dir = FIXTURE_DIRS[size];
  const nameWithSuffix = size === "large" ? `${name}-large` : name;
  try {
    return readFileSync(join(dir, `${nameWithSuffix}.txt`), "utf8");
  } catch {
    return readFileSync(join(FIXTURE_DIRS.small, `${name}.txt`), "utf8");
  }
}

interface ScenarioDef {
  name: string;
  family: string;
  toolName: string;
  fixture: string;
}

const SCENARIOS: ScenarioDef[] = [
  // Original 5
  { name: "pytest", family: "pytest", toolName: "pytest", fixture: loadFixture("pytest") },
  { name: "tsc", family: "tsc", toolName: "tsc", fixture: loadFixture("tsc") },
  { name: "lint", family: "lint", toolName: "ruff", fixture: loadFixture("lint") },
  { name: "git", family: "git", toolName: "bash", fixture: loadFixture("git") },
  { name: "search", family: "search", toolName: "rg", fixture: loadFixture("search") },
  // Batch A
  { name: "npm-install", family: "npm-install", toolName: "bash", fixture: loadFixture("npm-install") },
  { name: "docker-build", family: "docker-build", toolName: "bash", fixture: loadFixture("docker-build") },
  { name: "cargo", family: "cargo", toolName: "bash", fixture: loadFixture("cargo") },
  { name: "make", family: "make", toolName: "make", fixture: loadFixture("make") },
  { name: "stack-trace", family: "stack-trace", toolName: "bash", fixture: loadFixture("stack-trace") },
  // Batch B
  { name: "jest", family: "jest", toolName: "bash", fixture: loadFixture("jest") },
  { name: "go-build", family: "go-build", toolName: "bash", fixture: loadFixture("go-build") },
  { name: "pip-install", family: "pip-install", toolName: "bash", fixture: loadFixture("pip-install") },
  { name: "ls-tree", family: "ls-tree", toolName: "tree", fixture: loadFixture("ls-tree") },
  { name: "curl-http", family: "curl-http", toolName: "curl", fixture: loadFixture("curl-http") },
  // Batch C
  { name: "kubectl", family: "kubectl", toolName: "kubectl", fixture: loadFixture("kubectl") },
  { name: "terraform", family: "terraform", toolName: "bash", fixture: loadFixture("terraform") },
  { name: "sql-result", family: "sql-result", toolName: "psql", fixture: loadFixture("sql-result") },
  { name: "mypy", family: "mypy", toolName: "mypy", fixture: loadFixture("mypy") },
  { name: "java-build", family: "java-build", toolName: "bash", fixture: loadFixture("java-build") },
  // Batch D
  { name: "ansible", family: "ansible", toolName: "bash", fixture: loadFixture("ansible") },
  { name: "helm", family: "helm", toolName: "bash", fixture: loadFixture("helm") },
  { name: "network-diag", family: "network-diag", toolName: "bash", fixture: loadFixture("network-diag") },
  { name: "strace-perf", family: "strace-perf", toolName: "bash", fixture: loadFixture("strace-perf") },
  { name: "log-stream", family: "log-stream", toolName: "bash", fixture: loadFixture("log-stream") },
];

async function httpPost(path: string, payload: unknown): Promise<{ status: number; body: string; latencyMs: number }> {
  const start = Date.now();
  const resp = await fetch(`${YARN_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`
    },
    body: JSON.stringify(payload)
  });
  return { status: resp.status, body: await resp.text(), latencyMs: Date.now() - start };
}

async function getTelemetry(): Promise<Telemetry | null> {
  try {
    const resp = await fetch(`${YARN_URL}/health/telemetry`, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
    });
    if (resp.status !== 200) return null;
    return (await resp.json()) as Telemetry;
  } catch {
    return null;
  }
}

function telemetryDelta(before: Telemetry | null, after: Telemetry | null): Record<string, number> {
  if (!before || !after) return {};
  const b = before.toolResultReduction;
  const a = after.toolResultReduction;
  const delta: Record<string, number> = {
    reducedCount: a.reducedCount - b.reducedCount,
    tokensSavedEstimateTotal: a.tokensSavedEstimateTotal - b.tokensSavedEstimateTotal,
    fallbackToArtifactCount: a.fallbackToArtifactCount - b.fallbackToArtifactCount,
    reducerFailures: a.reducerFailures - b.reducerFailures,
    rawCharsTotal: a.rawCharsTotal - b.rawCharsTotal,
    reducedCharsTotal: a.reducedCharsTotal - b.reducedCharsTotal,
  };
  for (const fam of Object.keys(a.byFamily)) {
    delta[`family.${fam}`] = (a.byFamily[fam] ?? 0) - (b.byFamily[fam] ?? 0);
  }
  return delta;
}

async function runBatch(label: string): Promise<ProfileRun> {
  console.log(`\n--- Profile: ${label} ---`);
  const telBefore = await getTelemetry();
  const results: RunResult[] = [];

  for (const s of SCENARIOS) {
    const payload = {
      model: MODEL,
      messages: [
        { role: "user", content: "Fix the errors." },
        { role: "assistant", content: "Running.", tool_calls: [{ id: "call_ab", type: "function", function: { name: s.toolName, arguments: "{}" } }] },
        { role: "tool", content: s.fixture, tool_call_id: "call_ab", name: s.toolName }
      ],
      max_tokens: 32,
      stream: false
    };
    const { status, latencyMs } = await httpPost("/v1/chat/completions", payload);
    const result: RunResult = {
      scenario: s.name,
      family: s.family,
      httpStatus: status,
      latencyMs,
      rawChars: s.fixture.length,
      pass: status === 200
    };
    results.push(result);
    console.log(`  [${result.pass ? "OK" : "FAIL"}] ${s.name.padEnd(12)} ${latencyMs}ms`);
  }

  const telAfter = await getTelemetry();
  const delta = telemetryDelta(telBefore, telAfter);
  const latencies = results.map((r) => r.latencyMs);
  return {
    label,
    results,
    telemetryBefore: telBefore,
    telemetryAfter: telAfter,
    delta,
    totalLatencyMs: latencies.reduce((a, b) => a + b, 0),
    avgLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  console.log(`=== A-B Reducer Comparison ===`);
  console.log(`URL:   ${YARN_URL}`);
  console.log(`Model: ${MODEL}`);

  // Run with current live config (reducers ON, whatever profile is set)
  const profileA = await runBatch("reducers-on (live config)");

  // Compute a local baseline for "reducers off" — no HTTP calls, just raw sizes
  const totalRawChars = SCENARIOS.reduce((sum, s) => sum + s.fixture.length, 0);
  const estimatedRawTokens = Math.ceil(totalRawChars / 4);

  const reducedCount = profileA.delta.reducedCount ?? 0;
  const tokensSaved = profileA.delta.tokensSavedEstimateTotal ?? 0;
  const rawCharsIn = profileA.delta.rawCharsTotal ?? 0;
  const reducedCharsOut = profileA.delta.reducedCharsTotal ?? 0;
  const reductionRatio = rawCharsIn > 0
    ? Math.round(((rawCharsIn - reducedCharsOut) / rawCharsIn) * 100)
    : 0;

  console.log(`\n=== Comparison ===`);
  console.log(`Scenarios run:        ${SCENARIOS.length}`);
  console.log(`Reduced count delta:  ${reducedCount}`);
  console.log(`Tokens saved (est):   ${tokensSaved}`);
  console.log(`Raw chars baseline:   ${totalRawChars} (~${estimatedRawTokens} tokens)`);
  console.log(`Char reduction ratio: ${reductionRatio}%`);
  console.log(`Avg latency:          ${profileA.avgLatencyMs}ms`);
  console.log(`Reducer failures:     ${profileA.delta.reducerFailures ?? 0}`);
  console.log(`Fallback to artifact: ${profileA.delta.fallbackToArtifactCount ?? 0}`);

  if (profileA.delta) {
    console.log(`\nFamily deltas:`);
    for (const [k, v] of Object.entries(profileA.delta)) {
      if (k.startsWith("family.") && v > 0) {
        console.log(`  ${k}: +${v}`);
      }
    }
  }

  const report: ABReport = {
    url: YARN_URL,
    model: MODEL,
    startedAt,
    durationMs: Date.now() - t0,
    profiles: [profileA],
    baseline: { totalRawChars, estimatedRawTokens },
    comparison: {
      reducedCountDelta: reducedCount,
      tokensSavedDelta: tokensSaved,
      avgLatencyDiffMs: profileA.avgLatencyMs,
      reductionRatioPercent: reductionRatio
    }
  };

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${JSON_OUT}`);
  }

  console.log(`\nDuration: ${report.durationMs}ms`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
