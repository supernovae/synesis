/**
 * Eval Gym API routes — registers /v1/eval/* endpoints on the
 * Fastify app for running scenarios, listing them, querying results,
 * and toggling the session observer.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { runScenarios } from "./scenario-runner.js";
import { ALL_SCENARIOS, getScenariosByCategory, getScenarioById, listScenarios } from "./scenarios/index.js";
import { enableObserver, disableObserver, getObserverConfig } from "./session-observer.js";
import { materialize, toJsonl } from "./training-materializer.js";
import type { EvalCategory, EvalRunnerConfig, TrainingFormat } from "./types.js";

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function normalizeBaseUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("must not include credentials, query, or hash");
  }

  const normalizedPath = stripTrailingSlashes(parsed.pathname);
  return `${parsed.origin}${normalizedPath}`;
}

export interface EvalRouteOptions {
  requireInternalToken: (request: { headers: Record<string, unknown> }) => boolean;
}

export function registerEvalRoutes(app: FastifyInstance, config: AppConfig, opts: EvalRouteOptions): void {
  if (!config.SYNESIS_YARN_EVAL_API_ENABLED) return;

  async function requireEvalAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!opts.requireInternalToken(request as never)) {
      reply.code(401).send({ error: { type: "auth_error", message: "Internal service token required" } });
    }
  }

  let configuredTargetUrl = "";
  let configuredAdminUrl = "";
  try {
    configuredTargetUrl = normalizeBaseUrl(config.SYNESIS_YARN_OPENAI_COMPAT_BASE_URL);
    configuredAdminUrl = normalizeBaseUrl(config.SYNESIS_YARN_ADMIN_API_URL);
  } catch (error) {
    app.log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Invalid eval endpoint base URL configuration",
    );
    return;
  }

  // -----------------------------------------------------------------------
  // GET /v1/eval/scenarios — list available scenarios
  // -----------------------------------------------------------------------
  app.get("/v1/eval/scenarios", { preHandler: requireEvalAuth }, async () => {
    return { scenarios: listScenarios(), total: ALL_SCENARIOS.length };
  });

  // -----------------------------------------------------------------------
  // POST /v1/eval/run — execute scenario(s)
  // -----------------------------------------------------------------------
  app.post("/v1/eval/run", { preHandler: requireEvalAuth }, async (request) => {
    const body = request.body as {
      scenario_id?: string;
      category?: EvalCategory;
      target_url?: string;
      api_key?: string;
      model?: string;
      admin_url?: string;
      admin_token?: string;
    };

    if (body.target_url) {
      try {
        const requestedTargetUrl = normalizeBaseUrl(body.target_url);
        if (requestedTargetUrl !== configuredTargetUrl) {
          return { error: "target_url must match configured SYNESIS_YARN_OPENAI_COMPAT_BASE_URL origin/path" };
        }
      } catch {
        return { error: "target_url must be a valid http(s) URL without credentials, query, or hash" };
      }
    }
    if (body.admin_url) {
      try {
        const requestedAdminUrl = normalizeBaseUrl(body.admin_url);
        if (requestedAdminUrl !== configuredAdminUrl) {
          return { error: "admin_url must match configured SYNESIS_YARN_ADMIN_API_URL origin/path" };
        }
      } catch {
        return { error: "admin_url must be a valid http(s) URL without credentials, query, or hash" };
      }
    }

    const targetUrl = configuredTargetUrl;
    const apiKey = body.api_key ?? config.SYNESIS_YARN_OPENAI_COMPAT_API_KEY;

    if (!targetUrl) {
      return { error: "target_url is required (or set SYNESIS_YARN_OPENAI_COMPAT_BASE_URL)" };
    }

    const runnerConfig: EvalRunnerConfig = {
      targetUrl,
      apiKey,
      model: body.model,
      adminUrl: configuredAdminUrl,
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
  app.get("/v1/eval/results", { preHandler: requireEvalAuth }, async (request) => {
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
  app.post("/v1/eval/observe/start", { preHandler: requireEvalAuth }, async (request) => {
    const body = request.body as { session_key_filter?: string[] } | null;
    enableObserver(body?.session_key_filter);
    return { status: "observer_enabled", config: getObserverConfig() };
  });

  // -----------------------------------------------------------------------
  // POST /v1/eval/observe/stop — disable session observer
  // -----------------------------------------------------------------------
  app.post("/v1/eval/observe/stop", { preHandler: requireEvalAuth }, async () => {
    disableObserver();
    return { status: "observer_disabled" };
  });

  // -----------------------------------------------------------------------
  // GET /v1/eval/observe/status — check observer state
  // -----------------------------------------------------------------------
  app.get("/v1/eval/observe/status", { preHandler: requireEvalAuth }, async () => {
    return { config: getObserverConfig() };
  });

  // -----------------------------------------------------------------------
  // POST /v1/eval/export — materialize training data from scenario results
  // -----------------------------------------------------------------------
  app.post("/v1/eval/export", { preHandler: requireEvalAuth }, async (request) => {
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
