/**
 * Yarn Eval Gym — type definitions for scenarios, scoring, and results.
 *
 * Portable: scenarios use only the standard OpenAI chat completions
 * interface so they can target Yarn, OpenRouter, vLLM, Ollama, or
 * any other /v1/chat/completions endpoint.
 */

// ---------------------------------------------------------------------------
// OpenAI-compatible message subset (kept minimal to avoid coupling to Zod schemas)
// ---------------------------------------------------------------------------

export interface EvalChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: EvalToolCall[];
}

export interface EvalToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ---------------------------------------------------------------------------
// Scenario definition
// ---------------------------------------------------------------------------

export type EvalCategory =
  | "governor_regression"
  | "e2e_build"
  | "recovery"
  | "plan_management";

export interface EvalScenario {
  id: string;
  name: string;
  category: EvalCategory;
  description: string;
  target: {
    model?: string;
    conversation_id?: string;
  };
  /** System message prepended to the first turn. */
  systemPrompt?: string;
  turns: EvalTurn[];
  scoring: ScoringCriteria;
}

export interface EvalTurn {
  /** Messages the exerciser sends (user prompts + tool results). */
  messages: EvalChatMessage[];
  /**
   * Map from tool name → simulated result content.
   * When the model issues a tool_call with a matching name, the runner
   * injects a tool-role message with this content and re-sends.
   */
  simulatedToolResults?: Record<string, string>;
  /** Maximum tool-call round-trips before the runner moves on (default 3). */
  maxToolRounds?: number;
  /** Per-turn assertions evaluated after the model responds. */
  assertions?: TurnAssertion[];
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export type TurnAssertionType =
  | "governor_paused"
  | "governor_not_paused"
  | "contains_edit"
  | "no_repeated_tool"
  | "recovery_block_present"
  | "annotation_present"
  | "tool_count_lte"
  | "no_stub_content"
  | "content_matches"
  | "no_waffling_markers"
  | "tool_name_present"
  | "tool_name_absent";

export interface TurnAssertion {
  type: TurnAssertionType;
  params?: Record<string, unknown>;
}

export interface AssertionResult {
  assertion: TurnAssertion;
  passed: boolean;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoringCriteria {
  /** Hard limit on total model response turns across the scenario. */
  maxTotalTurns: number;
  /** Fail if the governor intervenes more than this many times. */
  maxGovernorInterventions?: number;
  /** Expected terminal state. */
  requiredOutcome?: "completed" | "governor_stopped";
  /** Fail the scenario if any of these governor rules fire. */
  failIfRules?: string[];
  /** Pass only if ALL of these governor rules fire (regression tests). */
  passIfRules?: string[];
}

// ---------------------------------------------------------------------------
// Runner output
// ---------------------------------------------------------------------------

export interface TurnResult {
  turnIndex: number;
  toolRounds: number;
  /** Messages accumulated during this turn (user + assistant + tool). */
  messages: EvalChatMessage[];
  /** Governor rules that fired during this turn (Yarn-only, empty otherwise). */
  governorRulesFired: string[];
  /** Per-assertion results. */
  assertionResults: AssertionResult[];
  /** Latency in ms for the primary model response. */
  latencyMs: number;
  /** Heuristic anomalies detected by the turn scorer. */
  anomalies: Anomaly[];
  /** Admin telemetry fetch status for this turn. */
  adminTelemetryStatus?: "ok" | "unreachable" | "unauthorized" | "disabled";
  adminTelemetryDetail?: string;
}

export interface Anomaly {
  kind:
    | "repeated_content"
    | "repeated_tool_call"
    | "waffling_marker"
    | "annotation_ignored"
    | "excessive_tool_rounds"
    | "stub_content_detected"
    | "plan_re_read_after_update";
  detail: string;
  severity: "info" | "warning" | "error";
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  category: EvalCategory;
  passed: boolean;
  score: number;
  totalTurns: number;
  totalToolRounds: number;
  totalAnomalies: number;
  governorInterventions: number;
  allGovernorRules: string[];
  turnResults: TurnResult[];
  failureReasons: string[];
  durationMs: number;
  targetUrl: string;
  model: string;
  timestamp: string;
  adminTelemetry?: {
    status: "ok" | "unreachable" | "unauthorized" | "disabled";
    detail?: string;
  };
}

// ---------------------------------------------------------------------------
// Runner config
// ---------------------------------------------------------------------------

export interface EvalRunnerConfig {
  /** OpenAI-compatible base URL (e.g. http://yarn:8000 or https://openrouter.ai/api/v1). */
  targetUrl: string;
  /** Bearer token for the target. */
  apiKey: string;
  /** Override model for all scenarios. */
  model?: string;
  /** Admin API URL for reading governor telemetry (Yarn-only, optional). */
  adminUrl?: string;
  /** Admin bearer token. */
  adminToken?: string;
  /** Request timeout per turn in ms (default 120_000). */
  timeoutMs?: number;
  /** Conversation ID prefix for session isolation. */
  conversationIdPrefix?: string;
}

// ---------------------------------------------------------------------------
// Session observer types
// ---------------------------------------------------------------------------

export interface ObserverConfig {
  enabled: boolean;
  /** Session keys to observe (empty = all sessions). */
  sessionKeyFilter?: string[];
}

export interface ObservedTurn {
  sessionKey: string;
  requestId?: string;
  timestamp: string;
  /** Normalized messages sent to the model. */
  inputMessages: EvalChatMessage[];
  /** Model response. */
  response: EvalChatMessage | null;
  /** Governor decision if available. */
  governorDecision?: {
    pause: boolean;
    reason: string;
    matchedRules: string[];
    telemetry: Record<string, unknown>;
  };
  /** Annotations injected by Yarn. */
  annotations: string[];
  /** Heuristic anomalies. */
  anomalies: Anomaly[];
}

// ---------------------------------------------------------------------------
// Training data materializer types
// ---------------------------------------------------------------------------

export type TrainingFormat = "sft" | "dpo" | "rlaif";

export interface SftExample {
  messages: Array<{ role: string; content: string }>;
  source: string;
  scenario_id?: string;
  quality_label: "positive" | "negative";
}

export interface DpoExample {
  prompt: Array<{ role: string; content: string }>;
  chosen: string;
  rejected: string;
  source: string;
  scenario_id?: string;
}

export interface RlaifExample {
  messages: Array<{ role: string; content: string }>;
  reward: number;
  anomaly_count: number;
  source: string;
  scenario_id?: string;
}

export type TrainingExample = SftExample | DpoExample | RlaifExample;

// ---------------------------------------------------------------------------
// Event kinds emitted to yarn_session_events
// ---------------------------------------------------------------------------

export const EVAL_EVENT_KINDS = {
  SCENARIO_EVAL: "scenario_eval_v1",
  LIVE_EVAL: "live_eval_v1",
  EVAL_TRANSCRIPT: "eval_transcript_v1",
} as const;
