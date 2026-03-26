import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false",
    ...overrides
  });
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

async function measureNonStream(app: ReturnType<typeof buildApp>, iterations: number): Promise<number[]> {
  const durations: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: `latency non-stream probe ${i}` }],
        stream: false
      }
    });
    const end = performance.now();
    expect(response.statusCode).toBe(200);
    durations.push(end - start);
  }
  return durations;
}

async function measureStream(app: ReturnType<typeof buildApp>, iterations: number): Promise<number[]> {
  const durations: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: `latency stream probe ${i}` }],
        stream: true
      }
    });
    const end = performance.now();
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("[DONE]");
    durations.push(end - start);
  }
  return durations;
}

describe("latency budget", () => {
  it("meets local p50/p95 and error-rate budgets for non-stream and stream", async () => {
    const app = buildApp(makeConfig());
    const iterations = Number(process.env.SYNESIS_PLANNER_TS_LATENCY_ITERS ?? "8");
    const nonStreamP95BudgetMs = Number(process.env.SYNESIS_PLANNER_TS_NONSTREAM_P95_BUDGET_MS ?? "120");
    const streamP95BudgetMs = Number(process.env.SYNESIS_PLANNER_TS_STREAM_P95_BUDGET_MS ?? "140");

    const nonStream = await measureNonStream(app, iterations);
    const stream = await measureStream(app, iterations);

    const nonStreamP50 = percentile(nonStream, 50);
    const nonStreamP95 = percentile(nonStream, 95);
    const streamP50 = percentile(stream, 50);
    const streamP95 = percentile(stream, 95);

    expect(nonStreamP50).toBeLessThanOrEqual(nonStreamP95BudgetMs);
    expect(nonStreamP95).toBeLessThanOrEqual(nonStreamP95BudgetMs);
    expect(streamP50).toBeLessThanOrEqual(streamP95BudgetMs);
    expect(streamP95).toBeLessThanOrEqual(streamP95BudgetMs);

    await app.close();
  });
});
