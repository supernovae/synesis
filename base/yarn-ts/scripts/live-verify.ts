#!/usr/bin/env tsx
/**
 * Live Yarn Reducer Verification Suite
 *
 * Runs against a deployed Yarn instance. Two modes:
 *   safe  (default)  — health + telemetry + OpenAI chat with tool results
 *   full  (opt-in)   — adds Claude Messages API path, streaming, and
 *                       larger payloads that cost real tokens
 *
 * Env:
 *   SYNESIS_YARN_URL     https://synesis-yarn.apps.openshiftdemo.dev  (required)
 *   SYNESIS_TEST_AUTH    PAT with coder scope (raw value, no "Bearer " prefix)
 *   SYNESIS_VERIFY_MODE  safe | full                                   (default: safe)
 *   SYNESIS_VERIFY_MODEL synesis-core                                  (default)
 *
 * Auth resolution order:
 *   1. SYNESIS_TEST_AUTH   (standard live-test convention)
 *   2. SYNESIS_TEST_TOKEN  (fallback)
 *
 * Usage:
 *   npx tsx scripts/live-verify.ts
 *   SYNESIS_VERIFY_MODE=full npx tsx scripts/live-verify.ts
 *   npx tsx scripts/live-verify.ts --json report.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Configuration ───────────────────────────────────────────────────────────

const YARN_URL = (process.env.SYNESIS_YARN_URL ?? "").replace(/\/+$/, "");
const TOKEN = (process.env.SYNESIS_TEST_AUTH ?? process.env.SYNESIS_TEST_TOKEN ?? "").trim();
const MODE = (process.env.SYNESIS_VERIFY_MODE ?? "safe") as "safe" | "full";
const MODEL = process.env.SYNESIS_VERIFY_MODEL ?? "synesis-core";
const JSON_OUT = process.argv.includes("--json")
  ? process.argv[process.argv.indexOf("--json") + 1]
  : null;

if (!YARN_URL) {
  console.error("ERROR: SYNESIS_YARN_URL is required");
  process.exit(1);
}

// ── Types ───────────────────────────────────────────────────────────────────

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
  validationNormalization: Record<string, number>;
  workingFrame: Record<string, number>;
  projectManifest: Record<string, number>;
  deterministicPolicy: Record<string, number>;
  phaseOrchestrator: Record<string, number>;
  clientAdapterPacks: Record<string, number>;
  [k: string]: unknown;
}

interface ScenarioResult {
  name: string;
  family: string;
  pass: boolean;
  httpStatus: number;
  latencyMs: number;
  error?: string;
}

interface VerifyReport {
  url: string;
  mode: string;
  model: string;
  startedAt: string;
  durationMs: number;
  health: { pass: boolean; status?: string };
  models: { pass: boolean; count?: number; ids?: string[] };
  telemetryBefore: Telemetry | null;
  telemetryAfter: Telemetry | null;
  telemetryDelta: Record<string, number>;
  telemetryAssertions: TelemetryAssertion[];
  scenarios: ScenarioResult[];
  summary: { total: number; passed: number; failed: number; tokensSaved: number };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function httpGet(path: string): Promise<{ status: number; body: string }> {
  const resp = await fetch(`${YARN_URL}${path}`, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
  });
  return { status: resp.status, body: await resp.text() };
}

async function httpPost(
  path: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: string; latencyMs: number }> {
  const start = Date.now();
  const resp = await fetch(`${YARN_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...extraHeaders
    },
    body: JSON.stringify(payload)
  });
  return { status: resp.status, body: await resp.text(), latencyMs: Date.now() - start };
}

async function getTelemetry(): Promise<Telemetry | null> {
  try {
    const { status, body } = await httpGet("/health/telemetry");
    if (status !== 200) return null;
    return JSON.parse(body) as Telemetry;
  } catch {
    return null;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

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

// ── Scenario definitions ────────────────────────────────────────────────────

interface Scenario {
  name: string;
  family: string;
  toolName: string;
  toolOutput: string;
  protocol: "openai" | "claude";
  requiresFull?: boolean;
  expectedDelta?: Partial<Record<string, number>>;
}

function buildScenarios(): Scenario[] {
  const base: Scenario[] = [
    {
      name: "pytest-openai", family: "pytest", toolName: "pytest",
      toolOutput: loadFixture("pytest"), protocol: "openai",
      expectedDelta: { "family.pytest": 1 }
    },
    {
      name: "tsc-openai", family: "tsc", toolName: "tsc",
      toolOutput: loadFixture("tsc"), protocol: "openai",
      expectedDelta: { "family.tsc": 1 }
    },
    {
      name: "lint-openai", family: "lint", toolName: "ruff",
      toolOutput: loadFixture("lint"), protocol: "openai",
      expectedDelta: { "family.lint": 1 }
    },
    {
      name: "git-openai", family: "git", toolName: "bash",
      toolOutput: loadFixture("git"), protocol: "openai",
      expectedDelta: { "family.git": 1 }
    },
    {
      name: "search-openai", family: "search", toolName: "bash",
      toolOutput: loadFixture("search"), protocol: "openai",
      expectedDelta: { "family.search": 1 }
    },
  ];

  if (MODE === "full") {
    base.push(
      {
        name: "pytest-claude", family: "pytest", toolName: "pytest",
        toolOutput: loadFixture("pytest"), protocol: "claude", requiresFull: true,
        expectedDelta: { "family.pytest": 1 }
      },
      {
        name: "tsc-claude", family: "tsc", toolName: "tsc",
        toolOutput: loadFixture("tsc"), protocol: "claude", requiresFull: true,
        expectedDelta: { "family.tsc": 1 }
      },
      {
        name: "git-claude", family: "git", toolName: "bash",
        toolOutput: loadFixture("git"), protocol: "claude", requiresFull: true,
        expectedDelta: { "family.git": 1 }
      },
    );
  }
  return base;
}

// ── Scenario execution ──────────────────────────────────────────────────────

async function runOpenAIScenario(s: Scenario): Promise<ScenarioResult> {
  const payload = {
    model: MODEL,
    messages: [
      { role: "user", content: "Fix the errors below." },
      { role: "assistant", content: "Running the tool now.", tool_calls: [{ id: "call_1", type: "function", function: { name: s.toolName, arguments: "{}" } }] },
      { role: "tool", content: s.toolOutput, tool_call_id: "call_1", name: s.toolName }
    ],
    max_tokens: 32,
    stream: false
  };

  try {
    const { status, body, latencyMs } = await httpPost("/v1/chat/completions", payload);
    const ok = status === 200;
    let error: string | undefined;
    if (!ok) error = body.slice(0, 400);
    return { name: s.name, family: s.family, pass: ok, httpStatus: status, latencyMs, error };
  } catch (e) {
    return { name: s.name, family: s.family, pass: false, httpStatus: 0, latencyMs: 0, error: String(e) };
  }
}

async function runClaudeScenario(s: Scenario): Promise<ScenarioResult> {
  const payload = {
    model: MODEL,
    max_tokens: 32,
    messages: [
      { role: "user", content: [{ type: "text", text: "Fix the errors below." }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_01", name: s.toolName, input: {} }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_01", content: s.toolOutput }]
      }
    ],
    stream: false
  };

  try {
    const { status, body, latencyMs } = await httpPost("/v1/messages", payload, {
      "anthropic-version": "2023-06-01"
    });
    const ok = status === 200;
    let error: string | undefined;
    if (!ok) error = body.slice(0, 400);
    return { name: s.name, family: s.family, pass: ok, httpStatus: status, latencyMs, error };
  } catch (e) {
    return { name: s.name, family: s.family, pass: false, httpStatus: 0, latencyMs: 0, error: String(e) };
  }
}

// ── Telemetry delta ─────────────────────────────────────────────────────────

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

interface TelemetryAssertion {
  key: string;
  expected: "positive" | "zero" | "non-negative" | number;
  actual: number;
  pass: boolean;
}

function assertTelemetryDeltas(
  delta: Record<string, number>,
  scenarios: ScenarioResult[],
  scenarioDefs: Scenario[]
): TelemetryAssertion[] {
  const assertions: TelemetryAssertion[] = [];
  const passedScenarios = scenarios.filter((s) => s.pass);

  if (passedScenarios.length > 0) {
    const rc = delta.reducedCount ?? 0;
    assertions.push({
      key: "reducedCount",
      expected: "positive",
      actual: rc,
      pass: rc > 0
    });
  }

  const aggregateExpected: Record<string, number> = {};
  for (const s of passedScenarios) {
    const def = scenarioDefs.find((d) => d.name === s.name);
    if (def?.expectedDelta) {
      for (const [k, v] of Object.entries(def.expectedDelta)) {
        aggregateExpected[k] = (aggregateExpected[k] ?? 0) + (v ?? 0);
      }
    }
  }
  for (const [k, expected] of Object.entries(aggregateExpected)) {
    const actual = delta[k] ?? 0;
    assertions.push({
      key: k,
      expected,
      actual,
      pass: actual >= expected
    });
  }

  const failures = delta.reducerFailures ?? 0;
  assertions.push({
    key: "reducerFailures",
    expected: "zero",
    actual: failures,
    pass: failures === 0
  });

  return assertions;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  console.log(`\n=== Live Yarn Verification Suite ===`);
  console.log(`URL:   ${YARN_URL}`);
  console.log(`Mode:  ${MODE}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Token: ${TOKEN ? "set" : "NOT SET"}\n`);

  // 1. Health
  console.log("1. Health check...");
  const health = await httpGet("/health");
  const healthOk = health.status === 200;
  console.log(`   ${healthOk ? "PASS" : "FAIL"} (${health.status})`);

  // 2. Models
  console.log("2. Models endpoint...");
  const models = await httpGet("/v1/models");
  const modelsOk = models.status === 200;
  let modelIds: string[] = [];
  try {
    modelIds = JSON.parse(models.body).data?.map((m: { id: string }) => m.id) ?? [];
  } catch { /* ignore */ }
  console.log(`   ${modelsOk ? "PASS" : "FAIL"} (${models.status}) models=[${modelIds.join(", ")}]`);

  // 3. Telemetry snapshot (before)
  console.log("3. Telemetry snapshot (before)...");
  const telBefore = await getTelemetry();
  console.log(`   ${telBefore ? "captured" : "unavailable"}`);

  // 4. Run scenarios
  if (!TOKEN) {
    console.log("\n4. Skipping chat scenarios (SYNESIS_TEST_TOKEN not set)\n");
  }

  const scenarios = TOKEN ? buildScenarios() : [];
  const results: ScenarioResult[] = [];

  if (scenarios.length > 0) {
    console.log(`\n4. Running ${scenarios.length} reducer scenarios...\n`);
    for (const s of scenarios) {
      const result = s.protocol === "claude"
        ? await runClaudeScenario(s)
        : await runOpenAIScenario(s);
      results.push(result);
      const icon = result.pass ? "PASS" : "FAIL";
      console.log(`   [${icon}] ${result.name.padEnd(20)} ${result.latencyMs}ms  ${result.error ?? ""}`);
    }
  }

  // 5. Telemetry snapshot (after)
  console.log("\n5. Telemetry snapshot (after)...");
  const telAfter = await getTelemetry();
  console.log(`   ${telAfter ? "captured" : "unavailable"}`);

  const scenarioDefs = TOKEN ? buildScenarios() : [];
  const delta = telemetryDelta(telBefore, telAfter);
  if (Object.keys(delta).length > 0) {
    console.log("\n6. Telemetry deltas:");
    for (const [k, v] of Object.entries(delta)) {
      if (v !== 0) console.log(`   ${k}: +${v}`);
    }
  }

  // 7. Telemetry assertions
  const telAssertions = assertTelemetryDeltas(delta, results, scenarioDefs);
  if (telAssertions.length > 0) {
    console.log("\n7. Telemetry assertions:");
    for (const a of telAssertions) {
      const icon = a.pass ? "PASS" : "WARN";
      console.log(`   [${icon}] ${a.key}: expected=${a.expected} actual=${a.actual}`);
    }
  }

  // 8. Lifecycle check
  if (telAfter?.toolResultReduction?.lifecycle) {
    console.log("\n8. Reducer lifecycle:");
    for (const [fam, state] of Object.entries(telAfter.toolResultReduction.lifecycle)) {
      console.log(`   ${fam}: ${state.lifecycle} (ok=${state.successes} fail=${state.failures})`);
    }
  }

  // Build report
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const assertionsFailed = telAssertions.filter((a) => !a.pass).length;
  const report: VerifyReport = {
    url: YARN_URL,
    mode: MODE,
    model: MODEL,
    startedAt,
    durationMs: Date.now() - t0,
    health: { pass: healthOk, status: healthOk ? "ok" : `HTTP ${health.status}` },
    models: { pass: modelsOk, count: modelIds.length, ids: modelIds },
    telemetryBefore: telBefore,
    telemetryAfter: telAfter,
    telemetryDelta: delta,
    telemetryAssertions: telAssertions,
    scenarios: results,
    summary: {
      total: results.length + 2 + telAssertions.length,
      passed: passed + (healthOk ? 1 : 0) + (modelsOk ? 1 : 0) + (telAssertions.length - assertionsFailed),
      failed: failed + (healthOk ? 0 : 1) + (modelsOk ? 0 : 1) + assertionsFailed,
      tokensSaved: delta.tokensSavedEstimateTotal ?? 0
    }
  };

  console.log(`\n=== Summary ===`);
  console.log(`Total: ${report.summary.total}  Passed: ${report.summary.passed}  Failed: ${report.summary.failed}`);
  console.log(`Tokens saved (delta): ${report.summary.tokensSaved}`);
  if (assertionsFailed > 0) {
    console.log(`Telemetry assertion warnings: ${assertionsFailed}`);
  }
  console.log(`Duration: ${report.durationMs}ms\n`);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`Report written to ${JSON_OUT}`);
  }

  // Hard fail only on endpoint failures, soft warn on telemetry assertion misses
  const hardFails = failed + (healthOk ? 0 : 1) + (modelsOk ? 0 : 1);
  if (hardFails > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
