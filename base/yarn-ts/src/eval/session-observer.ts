/**
 * Session Observer — opt-in recording and real-time analysis of live
 * Yarn sessions. When enabled, captures full request/response pairs
 * and runs heuristic anomaly detection on each turn.
 *
 * Activation:
 *   - Env: SYNESIS_YARN_EVAL_OBSERVER_ENABLED=true
 *   - Runtime: POST /v1/eval/observe/start | /stop
 *
 * Events emitted to yarn_session_events:
 *   - eval_transcript_v1: full turn transcript
 *   - live_eval_v1: per-turn anomaly detection results
 */

import type {
  ObserverConfig,
  ObservedTurn,
  EvalChatMessage,
} from "./types.js";
import { detectAnomalies } from "./turn-scorer.js";

// ---------------------------------------------------------------------------
// Observer state (in-memory, per-process)
// ---------------------------------------------------------------------------

let observerConfig: ObserverConfig = { enabled: false };

export function isObserverEnabled(): boolean {
  return observerConfig.enabled;
}

export function getObserverConfig(): Readonly<ObserverConfig> {
  return observerConfig;
}

export function enableObserver(sessionKeyFilter?: string[]): void {
  observerConfig = { enabled: true, sessionKeyFilter };
}

export function disableObserver(): void {
  observerConfig = { enabled: false };
}

export function shouldObserveSession(sessionKey: string): boolean {
  if (!observerConfig.enabled) return false;
  if (!observerConfig.sessionKeyFilter?.length) return true;
  return observerConfig.sessionKeyFilter.some(f => sessionKey.includes(f));
}

// ---------------------------------------------------------------------------
// Annotation extractor
// ---------------------------------------------------------------------------

const KNOWN_ANNOTATIONS = [
  "SYNESIS_PLAN_LOADED",
  "SYNESIS_PLAN_UPDATED",
  "SYNESIS_PLAN_ALREADY_UPDATED",
  "SYNESIS_VERIFICATION_GAP",
  "SYNESIS_RECOVERY",
];

function extractAnnotations(messages: EvalChatMessage[]): string[] {
  const found: string[] = [];
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : "";
    for (const ann of KNOWN_ANNOTATIONS) {
      if (text.includes(ann) && !found.includes(ann)) {
        found.push(ann);
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Build observed turn from request/response data
// ---------------------------------------------------------------------------

export function buildObservedTurn(params: {
  sessionKey: string;
  requestId?: string;
  inputMessages: EvalChatMessage[];
  response: EvalChatMessage | null;
  governorDecision?: {
    pause: boolean;
    reason: string;
    matchedRules: string[];
    telemetry: Record<string, unknown>;
  };
}): ObservedTurn {
  const allMessages = [...params.inputMessages];
  if (params.response) allMessages.push(params.response);

  return {
    sessionKey: params.sessionKey,
    requestId: params.requestId,
    timestamp: new Date().toISOString(),
    inputMessages: params.inputMessages,
    response: params.response,
    governorDecision: params.governorDecision,
    annotations: extractAnnotations(allMessages),
    anomalies: detectAnomalies(allMessages),
  };
}

// ---------------------------------------------------------------------------
// Session event builders (callers pass to usageWriter.enqueueSessionEvent)
// ---------------------------------------------------------------------------

export interface ObserverSessionEvent {
  eventKind: string;
  component: string;
  detail: string;
  metadataJson: Record<string, unknown>;
}

export function buildTranscriptEvent(turn: ObservedTurn): ObserverSessionEvent {
  return {
    eventKind: "eval_transcript_v1",
    component: "eval-observer",
    detail: `turn session=${turn.sessionKey} annotations=${turn.annotations.length} anomalies=${turn.anomalies.length}`,
    metadataJson: {
      schema_version: "eval_transcript_v1",
      session_key: turn.sessionKey,
      request_id: turn.requestId,
      timestamp: turn.timestamp,
      input_message_count: turn.inputMessages.length,
      response_role: turn.response?.role ?? null,
      response_tool_calls: turn.response?.tool_calls?.length ?? 0,
      governor_pause: turn.governorDecision?.pause ?? null,
      governor_rules: turn.governorDecision?.matchedRules ?? [],
      annotations: turn.annotations,
      anomaly_count: turn.anomalies.length,
      anomalies: turn.anomalies.map(a => ({
        kind: a.kind,
        severity: a.severity,
        detail: a.detail.slice(0, 200),
      })),
    },
  };
}

export function buildLiveEvalEvent(turn: ObservedTurn): ObserverSessionEvent | null {
  if (turn.anomalies.length === 0 && !turn.governorDecision?.pause) {
    return null;
  }

  const errorAnomalies = turn.anomalies.filter(a => a.severity === "error");
  const warningAnomalies = turn.anomalies.filter(a => a.severity === "warning");

  return {
    eventKind: "live_eval_v1",
    component: "eval-observer",
    detail: `anomalies=${turn.anomalies.length} errors=${errorAnomalies.length} warnings=${warningAnomalies.length} governor_pause=${turn.governorDecision?.pause ?? false}`,
    metadataJson: {
      schema_version: "live_eval_v1",
      session_key: turn.sessionKey,
      request_id: turn.requestId,
      timestamp: turn.timestamp,
      governor_pause: turn.governorDecision?.pause ?? false,
      governor_rules: turn.governorDecision?.matchedRules ?? [],
      governor_telemetry: turn.governorDecision?.telemetry ?? {},
      annotations_present: turn.annotations,
      anomaly_count: turn.anomalies.length,
      error_anomalies: errorAnomalies.map(a => ({ kind: a.kind, detail: a.detail.slice(0, 200) })),
      warning_anomalies: warningAnomalies.map(a => ({ kind: a.kind, detail: a.detail.slice(0, 200) })),
    },
  };
}
