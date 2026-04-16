#!/usr/bin/env tsx
/**
 * Governor Worker — multi-turn Yarn driver that runs Go-task scenarios
 * against the Yarn API and captures the full session transcript with
 * governor events for analysis by governor-monitor.ts.
 *
 * Modes:
 *   --mode simulated  (default) — tool results from scenario simulatedToolResults
 *   --mode live       — bash/shell tool calls forwarded to synesis-sandbox warm pool
 *
 * Env:
 *   SYNESIS_YARN_URL       required — Yarn base URL
 *   SYNESIS_YARN_TOKEN     required — Bearer token
 *   SYNESIS_ADMIN_URL      optional — Admin API for governor telemetry
 *   SYNESIS_ADMIN_TOKEN    optional — Admin bearer token
 *   SYNESIS_SANDBOX_URL    optional — Sandbox warm pool URL (live mode)
 *   SYNESIS_SANDBOX_SECRET optional — Sandbox auth secret (live mode)
 *   SYNESIS_EVAL_MODEL     optional — model override
 *
 * Usage:
 *   npx tsx scripts/governor-worker.ts \
 *     --scenario go-cli-stall-loop \
 *     --mode live \
 *     --out /tmp/worker-session.json
 *
 *   npx tsx scripts/governor-worker.ts \
 *     --all \
 *     --mode simulated \
 *     --out /tmp/worker-session.json
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runScenarios } from "../src/eval/scenario-runner.js";
import {
  GOLANG_WORKER_SCENARIOS,
  getScenarioById,
} from "../src/eval/scenarios/index.js";
import type { EvalRunnerConfig, EvalScenario, ScenarioResult } from "../src/eval/types.js";
import {
  executeSandboxToolCall,
  isSandboxReachable,
  type SandboxConfig,
  type ToolCallRef,
} from "./lib/sandbox-executor.js";

// ---------------------------------------------------------------------------
// Arg helpers
// ---------------------------------------------------------------------------

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const YARN_URL = (process.env.SYNESIS_YARN_URL ?? "").replace(/\/+$/, "");
const YARN_TOKEN = (
  process.env.SYNESIS_YARN_TOKEN ??
  process.env.SYNESIS_TEST_PAT_TOKEN ??
  process.env.SYNESIS_TEST_AUTH ??
  ""
).trim();

const SANDBOX_URL =
  process.env.SYNESIS_SANDBOX_URL ??
  "http://synesis-warm-pool.synesis-sandbox.svc.cluster.local:8080/execute";
const SANDBOX_SECRET = process.env.SYNESIS_SANDBOX_SECRET;

const config: EvalRunnerConfig = {
  targetUrl: YARN_URL,
  apiKey: YARN_TOKEN,
  model: process.env.SYNESIS_EVAL_MODEL ?? getArg("model"),
  adminUrl: process.env.SYNESIS_ADMIN_URL,
  adminToken: process.env.SYNESIS_ADMIN_TOKEN,
  timeoutMs: 120_000,
  conversationIdPrefix: "governor-worker",
};

const sandboxConfig: SandboxConfig = {
  url: SANDBOX_URL,
  secret: SANDBOX_SECRET,
};

// ---------------------------------------------------------------------------
// Live-mode tool result interceptor
//
// Patches each scenario's simulatedToolResults with a live executor that
// forwards bash/shell calls to the sandbox and leaves non-shell tools as-is
// from the simulated map.
// ---------------------------------------------------------------------------

async function patchScenariosForLiveMode(
  scenarios: EvalScenario[],
): Promise<EvalScenario[]> {
  const reachable = await isSandboxReachable(sandboxConfig);
  if (!reachable) {
    console.warn(
      `\nWARN: Sandbox at ${SANDBOX_URL} is not reachable. ` +
        "Falling back to simulated mode for all scenarios.\n",
    );
    return scenarios;
  }
  console.log(`  Sandbox reachable at ${SANDBOX_URL}`);

  return scenarios.map((scenario) => {
    const patchedTurns = scenario.turns.map((turn) => ({
      ...turn,
      // Live mode: replace the bash simulated result with a live executor hook.
      // The scenario-runner calls simulatedToolResults[toolName] to get a string;
      // we use a Proxy-like approach by overriding after the runner resolves the call.
      // NOTE: since runScenarios uses simulatedToolResults as a static map,
      //       we still provide the map for non-shell tools — shell tools get
      //       overridden via a custom executor wrapper below.
      simulatedToolResults: turn.simulatedToolResults,
      // Attach a live executor marker for the worker to detect
      _liveMode: true,
    }));
    return { ...scenario, turns: patchedTurns } as EvalScenario;
  });
}

// ---------------------------------------------------------------------------
// Live execution wrapper
//
// The scenario-runner does not natively support async tool interceptors, so
// for live mode we run scenarios with an extended tool-result hook by
// pre-executing bash tool calls and injecting the real results into
// simulatedToolResults before the runner sees them.
//
// This works because the scenario-runner resolves tool calls synchronously
// from the map. We resolve them once upfront (pessimistic), so if the model
// calls bash multiple times the first result is reused — which is the correct
// behavior for testing governor stall detection (same output → no edit → fire).
// ---------------------------------------------------------------------------

const SHELL_TOOL_NAMES = new Set(["bash", "run_command", "shell", "execute", "run_in_sandbox"]);

async function resolveLiveToolResults(
  scenario: EvalScenario,
  turnIndex: number,
): Promise<Record<string, string>> {
  const turn = scenario.turns[turnIndex];
  const base = turn.simulatedToolResults ?? {};
  const resolved: Record<string, string> = { ...base };

  // We need a representative bash command for each shell tool. Use the
  // scenario's description to pick a sensible default.
  const shellKey = [...SHELL_TOOL_NAMES].find((k) => k in base);
  if (!shellKey) return resolved;

  // Derive a command from the scenario turn messages
  const userMsg = turn.messages.find((m) => m.role === "user");
  const hint = userMsg?.content?.toString() ?? "";
  const cmd = hint.includes("go test") ? "go test ./..." : "go build ./...";

  const fakeToolCall: ToolCallRef = {
    id: `pre-${Date.now()}`,
    name: shellKey,
    arguments: JSON.stringify({ command: cmd }),
  };

  const result = await executeSandboxToolCall(fakeToolCall, sandboxConfig);
  resolved[shellKey] = result.content;
  return resolved;
}

// ---------------------------------------------------------------------------
// Session capture
// ---------------------------------------------------------------------------

interface WorkerSession {
  timestamp: string;
  mode: "simulated" | "live";
  yarnUrl: string;
  scenarioResults: ScenarioResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    avgScore: number;
    durationMs: number;
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!YARN_URL) {
    console.error("ERROR: SYNESIS_YARN_URL is required");
    process.exit(1);
  }
  if (!YARN_TOKEN) {
    console.error("ERROR: SYNESIS_YARN_TOKEN or SYNESIS_TEST_PAT_TOKEN is required");
    process.exit(1);
  }

  const mode = (getArg("mode") ?? "simulated") as "simulated" | "live";
  const outPath = getArg("out") ?? `/tmp/governor-worker-session-${Date.now()}.json`;
  const scenarioArg = getArg("scenario");
  const runAll = hasFlag("all");

  // Select scenarios
  let selected: EvalScenario[] = GOLANG_WORKER_SCENARIOS;
  if (scenarioArg) {
    const s =
      getScenarioById(scenarioArg) ??
      GOLANG_WORKER_SCENARIOS.find((sc) => sc.id === scenarioArg);
    if (!s) {
      console.error(`ERROR: Unknown scenario '${scenarioArg}'`);
      console.error("  Available:", GOLANG_WORKER_SCENARIOS.map((sc) => sc.id).join(", "));
      process.exit(1);
    }
    selected = [s];
  } else if (!runAll) {
    console.error(
      "ERROR: Specify --scenario <id> or --all\n" +
        "  Available: " +
        GOLANG_WORKER_SCENARIOS.map((sc) => sc.id).join(", "),
    );
    process.exit(1);
  }

  console.log(`\nGovernor Worker — Yarn: ${YARN_URL}`);
  console.log(`Mode: ${mode} | Scenarios: ${selected.length}`);

  // Patch scenarios for live mode
  if (mode === "live") {
    console.log("  Checking sandbox reachability...");
    selected = await patchScenariosForLiveMode(selected);

    // Pre-resolve live tool results
    for (const scenario of selected) {
      for (let i = 0; i < scenario.turns.length; i++) {
        const live = await resolveLiveToolResults(scenario, i);
        // Mutate in place — EvalScenario turns are our copies
        (scenario.turns[i] as { simulatedToolResults?: Record<string, string> }).simulatedToolResults = live;
      }
    }
  }

  const start = Date.now();
  const results = await runScenarios(config, selected);
  const durationMs = Date.now() - start;

  // Print summary
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`\nResults: ${passed}/${total} passed`);
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const rules = r.allGovernorRules.length ? ` [rules: ${r.allGovernorRules.join(", ")}]` : "";
    console.log(`  ${status}  ${r.scenarioId}  score=${r.score.toFixed(2)}${rules}`);
    if (!r.passed) {
      for (const reason of r.failureReasons) {
        console.log(`       ${reason}`);
      }
    }
  }

  // Save session
  const session: WorkerSession = {
    timestamp: new Date().toISOString(),
    mode,
    yarnUrl: YARN_URL,
    scenarioResults: results,
    summary: {
      total,
      passed,
      failed: total - passed,
      avgScore: results.reduce((s, r) => s + r.score, 0) / total,
      durationMs,
    },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(session, null, 2), "utf-8");
  console.log(`\nSession saved to ${outPath}`);

  process.exit(passed < total ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
