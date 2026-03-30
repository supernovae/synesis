#!/usr/bin/env node
/**
 * Lightweight concurrent-load probe for planner-ts.
 *
 * Usage:
 *   PLANNER_URL=http://localhost:8080 \
 *   PLANNER_MODEL="Synesis Auto" \
 *   PLANNER_BEARER_TOKEN="..." \
 *   node scripts/load-verify.mjs --concurrency 25 --requests 200 --stream false
 */

function parseArgs(argv) {
  const out = {
    concurrency: 25,
    requests: 200,
    stream: false,
    timeoutMs: 60000,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--concurrency" && v) out.concurrency = Number(v);
    if (a === "--requests" && v) out.requests = Number(v);
    if (a === "--stream" && v) out.stream = String(v).toLowerCase() === "true";
    if (a === "--timeout-ms" && v) out.timeoutMs = Number(v);
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function buildPayload(model, stream, i) {
  return {
    model,
    stream,
    messages: [
      {
        role: "user",
        content: `Load verification request ${i + 1}: explain planner scalability controls in 3 bullets.`,
      },
    ],
  };
}

async function runOne({ baseUrl, model, stream, token, timeoutMs, index }) {
  const start = Date.now();
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(buildPayload(model, stream, index)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, status: resp.status, latencyMs, error: text.slice(0, 200) };
    }
    if (stream) {
      // Drain stream body to include full end-to-end latency.
      await resp.text();
    } else {
      await resp.json();
    }
    return { ok: true, status: resp.status, latencyMs };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const baseUrl = process.env.PLANNER_URL ?? "http://localhost:8080";
  const model = process.env.PLANNER_MODEL ?? "Synesis Auto";
  const token = process.env.PLANNER_BEARER_TOKEN ?? "";

  const total = Math.max(1, args.requests);
  const concurrency = Math.max(1, args.concurrency);
  const workers = Math.min(concurrency, total);
  const queue = Array.from({ length: total }, (_, i) => i);
  const results = [];

  async function worker() {
    for (;;) {
      const idx = queue.shift();
      if (idx === undefined) return;
      results.push(await runOne({
        baseUrl,
        model,
        stream: args.stream,
        token,
        timeoutMs: args.timeoutMs,
        index: idx,
      }));
    }
  }

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: workers }, () => worker()));
  const elapsedMs = Date.now() - startedAt;

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const ok = results.filter((r) => r.ok).length;
  const errors = results.length - ok;
  const byStatus = {};
  for (const r of results) {
    const k = String(r.status);
    byStatus[k] = (byStatus[k] ?? 0) + 1;
  }

  const summary = {
    target: { baseUrl, model, stream: args.stream },
    run: { requests: total, concurrency, elapsedMs },
    outcome: {
      ok,
      errors,
      errorRate: Number((errors / results.length).toFixed(4)),
      statusCounts: byStatus,
    },
    latencyMs: {
      min: latencies[0] ?? 0,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] ?? 0,
      avg: Number((latencies.reduce((s, n) => s + n, 0) / Math.max(1, latencies.length)).toFixed(2)),
    },
  };

  console.log(JSON.stringify(summary, null, 2));
  if (errors > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
