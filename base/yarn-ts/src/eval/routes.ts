/**
 * Eval Gym API routes — registers /v1/eval/* endpoints on the
 * Fastify app for running scenarios, listing them, querying results,
 * and toggling the session observer.
 */

import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { runScenario, runScenarios } from "./scenario-runner.js";
import { ALL_SCENARIOS, getScenariosByCategory, getScenarioById, listScenarios } from "./scenarios/index.js";
import { enableObserver, disableObserver, getObserverConfig } from "./session-observer.js";
import { materialize, toJsonl, scenarioResultToTrajectoryRow } from "./training-materializer.js";
import type { EvalCategory, EvalRunnerConfig, TrainingFormat } from "./types.js";

export function registerEvalRoutes(app: FastifyInstance, config: AppConfig): void {
  if (!config.SYNESIS_YARN_EVAL_API_ENABLED) return;

  // -----------------------------------------------------------------------
  // GET /v1/eval/scenarios — list available scenarios
  // -----------------------------------------------------------------------
  app.get("/v1/eval/scenarios", async () => {
    return { scenarios: listScenarios(), total: ALL_SCENARIOS.length };
  });

  // -----------------------------------------------------------------------
  // POST /v1/eval/run — execute scenario(s)
  // -----------------------------------------------------------------------
  app.post("/v1/eval/run", async (request) => {
    const body = request.body as {
      scenario_id?: string;
      category?: EvalCategory;
      target_url?: string;
      api_key?: string;
      model?: string;
      admin_url?: string;
      admin_token?: string;
    };

    const targetUrl = (body.target_url ?? config.SYNESIS_YARN_OPENAI_COMPAT_BASE_URL).replace(/\/+$/, "");
    const apiKey = body.api_key ?? config.SYNESIS_YARN_OPENAI_COMPAT_API_KEY;

    if (!targetUrl) {
      return { error: "target_url is required (or set SYNESIS_YARN_OPENAI_COMPAT_BASE_URL)" };
    }

    const runnerConfig: EvalRunnerConfig = {
      targetUrl,
      apiKey,
      model: body.model,
      adminUrl: body.admin_url ?? config.SYNESIS_YARN_ADMIN_API_URL,
      adminToken: body.admin_token ?? config.SYNESIS_INTERNAL_SERVICE_TOKEN,
      timeoutMs: 120_000,
      conversationIdPrefix: "eval-api",
    };

    let scenarios = ALL_SCENARIOS;
    if (body.scenario_id) {
      const s = getScenarioById(body.scenario_id);
      if (!s) return { error: `Unknown scenario: ${body.scenario_id}` };
      scenarios = [s];
    } else if (body.category) {
      scenarios = getScenariosByCategory(body.category);
      if (scenarios.length === 0) return { error: `No scenarios for category: ${body.category}` };
    }

    const results = await runScenarios(runnerConfig, scenarios);

    return {
      summary: {
        total: results.length,
        passed: results.filter(r => r.passed).length,
        failed: results.filter(r => !r.passed).length,
        avgScore: Number((results.reduce((s, r) => s + r.score, 0) / results.length).toFixed(3)),
      },
      results,
    };
  });

  // -----------------------------------------------------------------------
  // GET /v1/eval/results — query past results from session events
  // -----------------------------------------------------------------------
  app.get("/v1/eval/results", async (request) => {
    const query = request.query as { session_key?: string; limit?: string };
    return {
      message: "Query past eval results from yarn_session_events using event_kind='scenario_eval_v1'",
      hint: "Use admin API: GET /api/v1/yarn/session-events?event_kind=scenario_eval_v1",
      session_key: query.session_key ?? null,
      limit: Number(query.limit ?? 50),
    };
  });

  // -----------------------------------------------------------------------
  // POST /v1/eval/observe/start — enable session observer
  // -----------------------------------------------------------------------
  app.post("/v1/eval/observe/start", async (request) => {
    const body = request.body as { session_key_filter?: string[] } | null;
    enableObserver(body?.session_key_filter);
    return { status: "observer_enabled", config: getObserverConfig() };
  });

  // -----------------------------------------------------------------------
  // POST /v1/eval/observe/stop — disable session observer
  // -----------------------------------------------------------------------
  app.post("/v1/eval/observe/stop", async () => {
    disableObserver();
    return { status: "observer_disabled" };
  });

  // -----------------------------------------------------------------------
  // GET /v1/eval/observe/status — check observer state
  // -----------------------------------------------------------------------
  app.get("/v1/eval/observe/status", async () => {
    return { config: getObserverConfig() };
  });

  // -----------------------------------------------------------------------
  // POST /v1/eval/export — materialize training data from scenario results
  // -----------------------------------------------------------------------
  app.post("/v1/eval/export", async (request) => {
    const body = request.body as {
      results: unknown[];
      format: TrainingFormat;
    };

    if (!body.results?.length || !body.format) {
      return { error: "Provide results (ScenarioResult[]) and format (sft|dpo|rlaif)" };
    }

    const examples = materialize(body.results as never[], body.format);
    return {
      format: body.format,
      count: examples.length,
      examples,
      jsonl: toJsonl(examples),
    };
  });
}
