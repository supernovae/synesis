/**
 * Scenario Runner — executes multi-turn eval scenarios against any
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Portable: when targeting Yarn, reads governor telemetry from
 * session events. Against other APIs, scoring degrades gracefully
 * to response-pattern analysis.
 */

import type {
  EvalScenario,
  EvalRunnerConfig,
  EvalChatMessage,
  EvalToolCall,
  TurnResult,
  ScenarioResult,
} from "./types.js";
import { scoreTurn, scoreScenario, detectAnomalies } from "./turn-scorer.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOOL_ROUNDS = 3;

// ---------------------------------------------------------------------------
// OpenAI response shapes (subset)
// ---------------------------------------------------------------------------

interface OaiChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: string | null;
}

interface OaiResponse {
  id: string;
  choices: OaiChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------
// Governor telemetry fetcher (Yarn-only)
// ---------------------------------------------------------------------------

async function fetchGovernorEvents(
  adminUrl: string,
  adminToken: string,
  sessionKey: string,
): Promise<string[]> {
  try {
    const url = `${adminUrl}/api/v1/yarn/session-events?session_key=${encodeURIComponent(sessionKey)}&event_kind=execution_governor_evaluated&limit=50`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${adminToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { events?: Array<{ metadata_json?: { matched_rules?: string[]; pause?: boolean } }> };
    const rules: string[] = [];
    for (const ev of body.events ?? []) {
      const mr = ev.metadata_json?.matched_rules;
      if (Array.isArray(mr)) rules.push(...mr);
    }
    return rules;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Core chat completions call
// ---------------------------------------------------------------------------

async function chatCompletions(
  config: EvalRunnerConfig,
  messages: EvalChatMessage[],
  model: string,
  conversationId: string,
): Promise<{ response: OaiResponse; latencyMs: number }> {
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const res = await fetch(`${config.targetUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "x-synesis-client": "eval-gym",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      max_tokens: 4096,
      conversation_id: conversationId,
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat completions ${res.status}: ${text.slice(0, 500)}`);
  }

  const response = (await res.json()) as OaiResponse;
  return { response, latencyMs };
}

// ---------------------------------------------------------------------------
// Single-turn executor with tool loop
// ---------------------------------------------------------------------------

async function executeTurn(
  config: EvalRunnerConfig,
  scenario: EvalScenario,
  turnIndex: number,
  conversationMessages: EvalChatMessage[],
  conversationId: string,
  model: string,
): Promise<{ turnResult: TurnResult; finalMessages: EvalChatMessage[] }> {
  const turn = scenario.turns[turnIndex];
  const maxRounds = turn.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const allTurnMessages: EvalChatMessage[] = [...turn.messages];
  let toolRounds = 0;
  let totalLatencyMs = 0;
  const governorRules: string[] = [];

  const working = [...conversationMessages, ...turn.messages];

  for (let round = 0; round <= maxRounds; round++) {
    const { response, latencyMs } = await chatCompletions(config, working, model, conversationId);
    totalLatencyMs += latencyMs;

    const choice = response.choices?.[0];
    if (!choice) break;

    const assistantMsg: EvalChatMessage = {
      role: "assistant",
      content: choice.message.content,
      tool_calls: choice.message.tool_calls as EvalToolCall[] | undefined,
    };
    working.push(assistantMsg);
    allTurnMessages.push(assistantMsg);

    if (!choice.message.tool_calls?.length || !turn.simulatedToolResults) break;

    let handledAny = false;
    for (const tc of choice.message.tool_calls) {
      const simResult = turn.simulatedToolResults[tc.function.name];
      if (simResult !== undefined) {
        const toolMsg: EvalChatMessage = {
          role: "tool",
          content: simResult,
          tool_call_id: tc.id,
        };
        working.push(toolMsg);
        allTurnMessages.push(toolMsg);
        handledAny = true;
      }
    }
    if (!handledAny) break;
    toolRounds++;
  }

  if (config.adminUrl && config.adminToken) {
    const sessionKey = `synesis:eval-gym:eval-gym:${conversationId}`;
    const rules = await fetchGovernorEvents(config.adminUrl, config.adminToken, sessionKey);
    governorRules.push(...rules);
  }

  const anomalies = detectAnomalies(allTurnMessages);
  const assertionResults = turn.assertions
    ? scoreTurn(turn.assertions, allTurnMessages, governorRules, anomalies)
    : [];

  return {
    turnResult: {
      turnIndex,
      toolRounds,
      messages: allTurnMessages,
      governorRulesFired: governorRules,
      assertionResults,
      latencyMs: totalLatencyMs,
      anomalies,
    },
    finalMessages: working,
  };
}

// ---------------------------------------------------------------------------
// Full scenario executor
// ---------------------------------------------------------------------------

export async function runScenario(
  config: EvalRunnerConfig,
  scenario: EvalScenario,
): Promise<ScenarioResult> {
  const start = Date.now();
  const model = config.model ?? scenario.target.model ?? "auto";
  const conversationId =
    scenario.target.conversation_id ??
    `${config.conversationIdPrefix ?? "eval"}-${scenario.id}-${Date.now()}`;

  let messages: EvalChatMessage[] = [];
  if (scenario.systemPrompt) {
    messages.push({ role: "system", content: scenario.systemPrompt });
  }

  const turnResults: TurnResult[] = [];
  const allGovernorRules: string[] = [];
  let totalToolRounds = 0;

  for (let i = 0; i < scenario.turns.length; i++) {
    try {
      const { turnResult, finalMessages } = await executeTurn(
        config, scenario, i, messages, conversationId, model,
      );
      turnResults.push(turnResult);
      messages = finalMessages;
      totalToolRounds += turnResult.toolRounds;
      allGovernorRules.push(...turnResult.governorRulesFired);
    } catch (err) {
      turnResults.push({
        turnIndex: i,
        toolRounds: 0,
        messages: [],
        governorRulesFired: [],
        assertionResults: [],
        latencyMs: 0,
        anomalies: [{
          kind: "repeated_content",
          detail: `Turn ${i} failed: ${err instanceof Error ? err.message : String(err)}`,
          severity: "error",
        }],
      });
      break;
    }
  }

  const governorInterventions = allGovernorRules.filter(r => r !== "allow" && r !== "disabled").length;
  const totalAnomalies = turnResults.reduce((n, tr) => n + tr.anomalies.length, 0);

  const { passed, score, failureReasons } = scoreScenario(
    scenario.scoring, turnResults, allGovernorRules, governorInterventions,
  );

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    category: scenario.category,
    passed,
    score,
    totalTurns: turnResults.length,
    totalToolRounds,
    totalAnomalies,
    governorInterventions,
    allGovernorRules: [...new Set(allGovernorRules)],
    turnResults,
    failureReasons,
    durationMs: Date.now() - start,
    targetUrl: config.targetUrl,
    model,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Batch runner
// ---------------------------------------------------------------------------

export async function runScenarios(
  config: EvalRunnerConfig,
  scenarios: EvalScenario[],
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    results.push(await runScenario(config, s));
  }
  return results;
}
