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
  SimulatedToolResult,
  TurnResult,
  ScenarioResult,
} from "./types.js";
import { scoreTurn, scoreScenario, detectAnomalies, computeSessionCompletionKpi } from "./turn-scorer.js";

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

interface OaiToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function buildRequestUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported");
  }
  if (base.username || base.password || base.hash || base.search) {
    throw new Error("URL base must not include credentials, query, or hash");
  }
  return new URL(path, `${trimTrailingSlashes(base.toString())}/`).toString();
}

export function buildEvalRequestHeaders(config: EvalRunnerConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    "x-synesis-client": config.adminSessionClientId
      ?? config.clientProfile?.adminSessionClientId
      ?? config.clientProfile?.id
      ?? "eval-gym",
  };
  const profileHeaders = config.clientProfile?.extraHeaders ?? {};
  const extraHeaders = config.extraHeaders ?? {};
  for (const [key, value] of Object.entries({ ...profileHeaders, ...extraHeaders })) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "content-type") continue;
    headers[key] = value;
  }
  const userAgent = config.userAgent ?? config.clientProfile?.userAgent;
  if (userAgent) {
    headers["User-Agent"] = userAgent;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Governor telemetry fetcher (Yarn-only)
// ---------------------------------------------------------------------------

async function fetchGovernorEvents(
  adminUrl: string,
  adminToken: string,
  sessionKey: string,
): Promise<{
  rules: string[];
  status: "ok" | "unreachable" | "unauthorized";
  detail?: string;
}> {
  try {
    const eventKinds = [
      "execution_governor_evaluated",
      "execution_governor_recovery_rewrite",
      "execution_governor_hard_stop",
      "phase_execution_policy_applied",
      "tool_loop_soft_fail",
    ];
    const eventsUrl = buildRequestUrl(adminUrl, "/api/v1/yarn/session-events");
    const rules = new Set<string>();
    let sawAnySuccess = false;
    let sawUnauthorized = false;
    let firstFailureDetail: string | undefined;
    for (const kind of eventKinds) {
      const url = `${eventsUrl}?session_key=${encodeURIComponent(sessionKey)}&event_kind=${encodeURIComponent(kind)}&limit=100`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          sawUnauthorized = true;
        } else if (!firstFailureDetail) {
          firstFailureDetail = `event_kind=${kind} status=${res.status}`;
        }
        continue;
      }
      sawAnySuccess = true;
      const body = (await res.json()) as {
        events?: Array<{
          event_kind?: string;
          detail?: string;
          metadata_json?: { matched_rules?: string[]; pause?: boolean };
        }>;
      };
      for (const ev of body.events ?? []) {
        if (kind === "execution_governor_evaluated") {
          const mr = ev.metadata_json?.matched_rules;
          if (Array.isArray(mr)) {
            for (const rule of mr) {
              if (rule) rules.add(rule);
            }
          }
          const detailRules = extractRulesFromDetail(ev.detail);
          for (const rule of detailRules) rules.add(rule);
          continue;
        }
        if (kind === "execution_governor_recovery_rewrite") {
          rules.add("governor:recovery_rewrite");
          const detailRules = extractRulesFromDetail(ev.detail);
          for (const rule of detailRules) rules.add(rule);
          continue;
        }
        if (kind === "execution_governor_hard_stop") {
          rules.add("governor:hard_stop");
          const detailRules = extractRulesFromDetail(ev.detail);
          for (const rule of detailRules) rules.add(rule);
          continue;
        }
        if (kind === "phase_execution_policy_applied") {
          rules.add("policy:phase_execution_policy_applied");
          continue;
        }
        if (kind === "tool_loop_soft_fail") {
          rules.add("policy:tool_loop_soft_fail");
        }
      }
    }
    if (sawAnySuccess) {
      return { rules: [...rules], status: "ok" };
    }
    if (sawUnauthorized) {
      return {
        rules: [...rules],
        status: "unauthorized",
        detail: firstFailureDetail ?? "admin auth rejected for session-events",
      };
    }
    return {
      rules: [...rules],
      status: "unreachable",
      detail: firstFailureDetail ?? "session-events endpoint unavailable",
    };
  } catch {
    return { rules: [], status: "unreachable", detail: "session-events request failed" };
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
  tools?: OaiToolSchema[],
): Promise<{ response: OaiResponse; latencyMs: number }> {
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const completionsUrl = buildRequestUrl(config.targetUrl, "/v1/chat/completions");
  const res = await fetch(completionsUrl, {
    method: "POST",
    headers: buildEvalRequestHeaders(config),
    body: JSON.stringify({
      model,
      messages,
      ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
      stream: false,
      max_tokens: 4096,
      conversation_id: conversationId,
      ...(config.clientProfile ? { metadata: { eval_client_profile: config.clientProfile.id } } : {}),
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
// Simulated tool result lookup
//
// Resolution order:
//   1. Exact/case-insensitive key match
//   2. Alias-equivalent key match (write_file -> Write, list_dir -> Glob, etc.)
//   3. Catch-all "*" key
// ---------------------------------------------------------------------------

const TOOL_NAME_EQUIVALENTS: Record<string, string[]> = {
  read: ["read_file", "readfile"],
  read_file: ["read", "readfile"],
  readfile: ["read", "read_file"],
  write: ["write_file", "file_write", "filewrite"],
  write_file: ["write", "file_write", "filewrite", "edit", "str_replace", "apply_patch"],
  file_write: ["write", "write_file", "filewrite"],
  filewrite: ["write", "write_file", "file_write"],
  edit: ["str_replace", "apply_patch", "write_file"],
  str_replace: ["edit", "apply_patch", "write", "write_file"],
  apply_patch: ["edit", "str_replace", "write", "write_file"],
  bash: ["shell"],
  shell: ["bash"],
  glob: ["list_dir", "synesis_inspect_repo", "search", "search_code", "grep"],
  list_dir: ["glob", "synesis_inspect_repo", "search", "search_code", "bash"],
  search: ["search_code", "grep", "glob", "list_dir", "synesis_inspect_repo"],
  search_code: ["search", "grep", "glob", "list_dir", "synesis_inspect_repo"],
  grep: ["search", "search_code", "glob", "list_dir"],
  synesis_inspect_repo: ["list_dir", "glob", "search", "search_code", "read", "read_file", "bash"],
};

function findCaseInsensitiveKey(map: Record<string, unknown>, candidate: string): string | undefined {
  if (candidate in map) return candidate;
  const lower = candidate.toLowerCase();
  return Object.keys(map).find((k) => k.toLowerCase() === lower);
}

interface SimulatedToolState {
  counts: Map<string, number>;
}

function nextScriptedResult(value: string | string[], counterKey: string, state: SimulatedToolState): string {
  if (typeof value === "string") return value;
  if (value.length === 0) return "";
  const idx = state.counts.get(counterKey) ?? 0;
  state.counts.set(counterKey, idx + 1);
  return value[Math.min(idx, value.length - 1)] ?? "";
}

function parseToolArgs(args: string): Record<string, unknown> | null {
  const trimmed = args.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeSignaturePart(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function toolSignatureCandidates(toolName: string, rawArgs: string): string[] {
  const normalizedTool = normalizeSignaturePart(toolName);
  const normalizedArgs = normalizeSignaturePart(rawArgs);
  const candidates = new Set<string>();
  if (normalizedTool || normalizedArgs) candidates.add(`${normalizedTool}:${normalizedArgs}`);
  const parsed = parseToolArgs(rawArgs);
  if (parsed) {
    for (const key of ["command", "cmd", "script"]) {
      const value = normalizeSignaturePart(parsed[key]);
      if (value) candidates.add(`command:${value}`);
    }
    for (const key of ["path", "file_path", "filePath", "target_file", "directory", "dir"]) {
      const value = normalizeSignaturePart(parsed[key]);
      if (value) candidates.add(`path:${value}`);
    }
    for (const key of ["pattern", "glob", "glob_pattern", "query", "search", "search_code"]) {
      const value = normalizeSignaturePart(parsed[key]);
      if (value) candidates.add(`pattern:${value}`);
    }
  }
  return [...candidates];
}

function resolveSimulatedResultValue(
  value: SimulatedToolResult,
  toolKey: string,
  signatures: string[],
  state: SimulatedToolState,
): string | undefined {
  if (typeof value === "string" || Array.isArray(value)) {
    return nextScriptedResult(value, `tool:${toolKey}`, state);
  }
  if (value.bySignature) {
    for (const signature of signatures) {
      const matched = findCaseInsensitiveKey(value.bySignature, signature);
      if (matched) {
        return nextScriptedResult(value.bySignature[matched] ?? "", `tool:${toolKey}:signature:${matched}`, state);
      }
    }
  }
  if (value.sequence) {
    return nextScriptedResult(value.sequence, `tool:${toolKey}:sequence`, state);
  }
  return value.default;
}

function lookupSimulatedResult(
  simulatedToolResults: Record<string, SimulatedToolResult>,
  toolName: string,
  rawArgs: string,
  state: SimulatedToolState,
): string | undefined {
  const normalized = toolName.trim().toLowerCase();
  const signatures = toolSignatureCandidates(toolName, rawArgs);
  if (!normalized) {
    if ("*" in simulatedToolResults) return resolveSimulatedResultValue(simulatedToolResults["*"], "*", signatures, state);
    const firstKey = Object.keys(simulatedToolResults)[0];
    return firstKey ? resolveSimulatedResultValue(simulatedToolResults[firstKey], firstKey, signatures, state) : undefined;
  }

  const direct = findCaseInsensitiveKey(simulatedToolResults, toolName.trim());
  if (direct) return resolveSimulatedResultValue(simulatedToolResults[direct], direct, signatures, state);

  const equivalents = TOOL_NAME_EQUIVALENTS[normalized] ?? [];
  for (const alias of equivalents) {
    const mapped = findCaseInsensitiveKey(simulatedToolResults, alias);
    if (mapped) return resolveSimulatedResultValue(simulatedToolResults[mapped], mapped, signatures, state);
  }

  if ("*" in simulatedToolResults) return resolveSimulatedResultValue(simulatedToolResults["*"], "*", signatures, state);
  return undefined;
}

// ---------------------------------------------------------------------------
// Content-based governor rule extractor (fallback when admin API is absent)
//
// Parses "GOVERNOR PAUSE:" blocks from assistant message content to extract
// the rule(s) that fired without needing the admin telemetry endpoint.
// ---------------------------------------------------------------------------

function extractRulesFromContent(messages: EvalChatMessage[]): string[] {
  const rules = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content !== "string") continue;
    if (!m.content.includes("GOVERNOR PAUSE:") && !m.content.includes("GOVERNOR HARD STOP")) continue;
    // "Matched rules: rule1, rule2"
    const matchedMatch = m.content.match(/Matched rules:\s*([^\n]+)/);
    if (matchedMatch) {
      for (const r of matchedMatch[1].split(",")) {
        const trimmed = r.trim();
        if (trimmed) rules.add(trimmed);
      }
    }
    // "Reason: rule_name"
    const reasonMatch = m.content.match(/Reason:\s*([^\n]+)/);
    if (reasonMatch) {
      const trimmed = reasonMatch[1].trim();
      if (trimmed) rules.add(trimmed);
    }
  }
  return [...rules];
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
  let adminTelemetryStatus: "ok" | "unreachable" | "unauthorized" | "disabled" = "disabled";
  let adminTelemetryDetail: string | undefined;
  const simulatedToolState: SimulatedToolState = { counts: new Map() };

  const working = [...conversationMessages, ...turn.messages];
  const evalTools = buildEvalToolSchemas(turn.simulatedToolResults);

  for (let round = 0; round <= maxRounds; round++) {
    const { response, latencyMs } = await chatCompletions(config, working, model, conversationId, evalTools);
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
      const simResult = lookupSimulatedResult(
        turn.simulatedToolResults,
        tc.function.name,
        tc.function.arguments,
        simulatedToolState,
      );
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
    const telemetry = await fetchGovernorEvents(config.adminUrl, config.adminToken, sessionKey);
    governorRules.push(...telemetry.rules);
    adminTelemetryStatus = telemetry.status;
    adminTelemetryDetail = telemetry.detail;
  }

  // Supplement with rules extracted from message content (works without admin API)
  const contentRules = extractRulesFromContent(allTurnMessages);
  for (const r of contentRules) {
    if (!governorRules.includes(r)) governorRules.push(r);
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
        adminTelemetryStatus,
        adminTelemetryDetail,
    },
    finalMessages: working,
  };
}

function extractRulesFromDetail(detail: string | undefined): string[] {
  if (!detail) return [];
  const out = new Set<string>();
  const rulesField = detail.match(/rules=([^\s;]+)/);
  if (rulesField?.[1]) {
    for (const token of rulesField[1].split(",")) {
      const t = token.trim();
      if (t && t !== "allow" && t !== "disabled") out.add(t);
    }
  }
  const inParens = detail.match(/\(([^)]+)\)/);
  if (inParens?.[1]) {
    for (const token of inParens[1].split(",")) {
      const t = token.trim();
      if (t && t !== "allow" && t !== "disabled") out.add(t);
    }
  }
  return [...out];
}

function buildEvalToolSchemas(simulatedToolResults?: Record<string, SimulatedToolResult>): OaiToolSchema[] | undefined {
  if (!simulatedToolResults) return undefined;
  const names = Object.keys(simulatedToolResults)
    .filter((name) => name && name !== "*")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) return undefined;
  const uniqueNames = [...new Set(names)];
  return uniqueNames.map((name) => ({
    type: "function",
    function: {
      name,
      description: `Eval harness simulated tool for ${name}`,
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          path: { type: "string" },
          command: { type: "string" },
          content: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          glob_pattern: { type: "string" },
          pattern: { type: "string" },
          start_line: { type: "number" },
          line_range: { type: "array", items: { type: "number" } },
        },
        additionalProperties: true,
      },
    },
  }));
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
  let aggregateTelemetryStatus: "ok" | "unreachable" | "unauthorized" | "disabled" = "disabled";
  let aggregateTelemetryDetail: string | undefined;

  for (let i = 0; i < scenario.turns.length; i++) {
    try {
      const { turnResult, finalMessages } = await executeTurn(
        config, scenario, i, messages, conversationId, model,
      );
      turnResults.push(turnResult);
      messages = finalMessages;
      totalToolRounds += turnResult.toolRounds;
      allGovernorRules.push(...turnResult.governorRulesFired);
      if (turnResult.adminTelemetryStatus === "unauthorized") {
        aggregateTelemetryStatus = "unauthorized";
        if (!aggregateTelemetryDetail) aggregateTelemetryDetail = turnResult.adminTelemetryDetail;
      } else if (turnResult.adminTelemetryStatus === "unreachable" && aggregateTelemetryStatus !== "unauthorized") {
        aggregateTelemetryStatus = "unreachable";
        if (!aggregateTelemetryDetail) aggregateTelemetryDetail = turnResult.adminTelemetryDetail;
      } else if (turnResult.adminTelemetryStatus === "ok" && aggregateTelemetryStatus === "disabled") {
        aggregateTelemetryStatus = "ok";
      }
    } catch (err) {
      turnResults.push({
        turnIndex: i,
        toolRounds: 0,
        messages: [],
        governorRulesFired: [],
        assertionResults: [],
        latencyMs: 0,
        anomalies: [{
          kind: "turn_execution_error",
          detail: `Turn ${i} failed: ${err instanceof Error ? err.message : String(err)}`,
          severity: "error",
        }],
        adminTelemetryStatus: "disabled",
      });
      break;
    }
  }

  const governorInterventions = allGovernorRules.filter(r => r !== "allow" && r !== "disabled").length;
  const totalAnomalies = turnResults.reduce((n, tr) => n + tr.anomalies.length, 0);

  const { passed, score, failureReasons } = scoreScenario(
    scenario.scoring, turnResults, allGovernorRules, governorInterventions,
  );
  const sessionCompletionKpi = computeSessionCompletionKpi(turnResults);

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
    clientProfileId: config.clientProfile?.id,
    evaluationPair: scenario.evaluationPair,
    sessionCompletionKpi,
    adminTelemetry: {
      status: aggregateTelemetryStatus,
      detail: aggregateTelemetryDetail,
    },
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
