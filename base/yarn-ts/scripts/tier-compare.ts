#!/usr/bin/env tsx
/**
 * Tier Compare Runner
 *
 * Runs identical coding-style requests against multiple Yarn model IDs
 * (typically synesis-pulse / synesis-core / synesis-horizon) and prints
 * one comparison table for:
 * - avg latency
 * - Tier C validation fallback activity
 * - tool schema pruning activity
 *
 * Env:
 *   SYNESIS_YARN_EVAL_URL / SYNESIS_YARN_URL  required (eval name matches GitHub variable)
 *   SYNESIS_TEST_PAT_TOKEN / SYNESIS_TEST_AUTH / SYNESIS_TEST_TOKEN  for /v1/chat/completions (PAT)
 *   SYNESIS_TELEMETRY_TOKEN    optional internal service token for /health/telemetry
 *   SYNESIS_TIER_MODELS        optional comma-list (default: synesis-pulse,synesis-core,synesis-horizon)
 *   SYNESIS_TIER_ROUNDS        optional requests per model (default: 6)
 */

const YARN_URL = (process.env.SYNESIS_YARN_EVAL_URL ?? process.env.SYNESIS_YARN_URL ?? "").replace(
  /\/+$/,
  "",
);
const AUTH_TOKEN = (
  process.env.SYNESIS_TEST_PAT_TOKEN ??
  process.env.SYNESIS_TEST_AUTH ??
  process.env.SYNESIS_TEST_TOKEN ??
  ""
).trim();
const TELEMETRY_TOKEN = (process.env.SYNESIS_TELEMETRY_TOKEN ?? "").trim();
const MODEL_IDS = (process.env.SYNESIS_TIER_MODELS ?? "synesis-pulse,synesis-core,synesis-horizon")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ROUNDS = Math.max(1, Number(process.env.SYNESIS_TIER_ROUNDS ?? 6));

if (!YARN_URL) {
  console.error("ERROR: SYNESIS_YARN_EVAL_URL or SYNESIS_YARN_URL is required");
  process.exit(1);
}
if (!AUTH_TOKEN) {
  console.error(
    "ERROR: SYNESIS_TEST_PAT_TOKEN, SYNESIS_TEST_AUTH, or SYNESIS_TEST_TOKEN is required",
  );
  process.exit(1);
}

type Telemetry = {
  validationNormalization?: {
    tierCAttemptCount?: number;
    tierCSuccessCount?: number;
    tierCFallbackCount?: number;
    tierCErrorCount?: number;
  };
  toolSchemaPruning?: {
    requestsConsidered?: number;
    requestsPruned?: number;
    toolsPrunedTotal?: number;
  };
};

type TierRunResult = {
  model: string;
  rounds: number;
  successes: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  tierCAttempts: number;
  tierCSuccess: number;
  tierCFallback: number;
  tierCErrors: number;
  prunedRequests: number;
  toolsPrunedTotal: number;
  pruningRatePct: number;
};

function num(v: number | undefined): number {
  return Number.isFinite(v) ? Number(v) : 0;
}

function makeTools(count = 70): Array<Record<string, unknown>> {
  const core = ["Read", "Write", "Edit", "Update", "Bash", "Glob", "Grep", "WebFetch"];
  const extras = Array.from({ length: Math.max(0, count - core.length) }, (_, i) => `ExtraTool${i + 1}`);
  const names = [...core, ...extras];
  return names.map((name) => ({
    type: "function",
    function: {
      name,
      description: `Synthetic tool ${name} for schema-pruning benchmark`,
      parameters: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
      },
    },
  }));
}

function buildPayload(model: string): Record<string, unknown> {
  const noisyValidation = [
    "Build failed with multiple diagnostics from mixed tools.",
    "source file maybe src/workflow.ts around line ~147 but parser could not lock columns.",
    "error code maybe E_X1 or E-Z9, unknown formatter, raw excerpts below:",
    ">>> token mismatch near 'workflowStep' ; expected delimiter",
    ">>> unresolved symbol maybe RetrieveCtx from package internal/planner",
    ">>> warning style maybe but severity uncertain",
    "Please infer likely findings from this unstructured output quickly.",
  ].join("\n");

  return {
    model,
    stream: false,
    max_tokens: 96,
    tools: makeTools(72),
    messages: [
      { role: "user", content: "Fix the coding issue and summarize key diagnostics." },
      {
        role: "assistant",
        content: "Running the validation tool now.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "ExtraTool13", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        name: "mystery_validator",
        tool_call_id: "call_1",
        content: noisyValidation,
      },
    ],
  };
}

async function getTelemetry(): Promise<Telemetry | null> {
  if (!TELEMETRY_TOKEN) return null;
  try {
    const res = await fetch(`${YARN_URL}/health/telemetry`, {
      headers: { Authorization: `Bearer ${TELEMETRY_TOKEN}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as Telemetry;
  } catch {
    return null;
  }
}

async function runOne(model: string): Promise<{ ok: boolean; latencyMs: number }> {
  const payload = buildPayload(model);
  const started = Date.now();
  try {
    const res = await fetch(`${YARN_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    await res.text();
    return { ok: res.ok, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: 0 };
  }
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx] ?? 0;
}

function delta(before: Telemetry | null, after: Telemetry | null): Omit<TierRunResult, "model" | "rounds" | "successes" | "avgLatencyMs" | "p95LatencyMs"> {
  const bVal = before?.validationNormalization;
  const aVal = after?.validationNormalization;
  const bPrune = before?.toolSchemaPruning;
  const aPrune = after?.toolSchemaPruning;

  const tierCAttempts = num(aVal?.tierCAttemptCount) - num(bVal?.tierCAttemptCount);
  const tierCSuccess = num(aVal?.tierCSuccessCount) - num(bVal?.tierCSuccessCount);
  const tierCFallback = num(aVal?.tierCFallbackCount) - num(bVal?.tierCFallbackCount);
  const tierCErrors = num(aVal?.tierCErrorCount) - num(bVal?.tierCErrorCount);
  const prunedRequests = num(aPrune?.requestsPruned) - num(bPrune?.requestsPruned);
  const toolsPrunedTotal = num(aPrune?.toolsPrunedTotal) - num(bPrune?.toolsPrunedTotal);
  const considered = num(aPrune?.requestsConsidered) - num(bPrune?.requestsConsidered);
  const pruningRatePct = considered > 0 ? (prunedRequests / considered) * 100 : 0;

  return {
    tierCAttempts,
    tierCSuccess,
    tierCFallback,
    tierCErrors,
    prunedRequests,
    toolsPrunedTotal,
    pruningRatePct,
  };
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

function printTable(rows: TierRunResult[]): void {
  const headers = [
    "model".padEnd(16),
    "ok/req".padEnd(8),
    "avgMs".padEnd(8),
    "p95Ms".padEnd(8),
    "tierC".padEnd(14),
    "tierC ok/fb/err".padEnd(17),
    "prunedReq".padEnd(10),
    "toolsPruned".padEnd(12),
    "pruneRate%".padEnd(10),
  ];
  console.log(headers.join(" "));
  console.log("-".repeat(108));
  for (const r of rows) {
    const line = [
      r.model.padEnd(16),
      `${r.successes}/${r.rounds}`.padEnd(8),
      fmt(r.avgLatencyMs, 1).padEnd(8),
      fmt(r.p95LatencyMs, 1).padEnd(8),
      String(r.tierCAttempts).padEnd(14),
      `${r.tierCSuccess}/${r.tierCFallback}/${r.tierCErrors}`.padEnd(17),
      String(r.prunedRequests).padEnd(10),
      String(r.toolsPrunedTotal).padEnd(12),
      fmt(r.pruningRatePct, 1).padEnd(10),
    ];
    console.log(line.join(" "));
  }
}

async function main(): Promise<void> {
  console.log(`\n=== Yarn Tier Compare ===`);
  console.log(`URL: ${YARN_URL}`);
  console.log(`Models: ${MODEL_IDS.join(", ")}`);
  console.log(`Rounds/model: ${ROUNDS}`);
  console.log(`Telemetry token: ${TELEMETRY_TOKEN ? "set" : "not set (TierC/pruning deltas will be 0)"}\n`);

  const results: TierRunResult[] = [];
  for (const model of MODEL_IDS) {
    const before = await getTelemetry();
    const latencies: number[] = [];
    let successes = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const run = await runOne(model);
      if (run.ok) {
        successes += 1;
        latencies.push(run.latencyMs);
      }
    }
    const after = await getTelemetry();
    const d = delta(before, after);
    const avgLatencyMs = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    results.push({
      model,
      rounds: ROUNDS,
      successes,
      avgLatencyMs,
      p95LatencyMs: p95(latencies),
      ...d,
    });
  }

  printTable(results);
  console.log("\nTip: run twice after changing pruning/TierC knobs and diff rows.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
