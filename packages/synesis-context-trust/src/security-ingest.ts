/**
 * Fire-and-forget POST to admin /api/v1/security/events/ingest.
 * Maps ScanResult and rejection reasons to the ingest payload shape
 * consumed by security_service.ingest_event.
 */

import type { ScanResult, EventType } from "./scanner.js";

export interface SecurityIngestPayload {
  event_id: string;
  event_type: string;
  severity: string;
  confidence: number;
  confidence_band: string;
  action_taken: string;
  scope: string;
  service: string;
  request_id: string;
  session_id: string;
  user_id: string;
  token_id: string;
  org_id: string;
  patterns_found: string[];
  excerpt: string;
  scanner_name: string;
  latency_ms: number;
  detail: Record<string, unknown>;
}

export interface SecurityIngestConfig {
  adminUrl: string;
  adminToken: string;
  timeoutMs?: number;
}

function confidenceBand(confidence: number): string {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

function severityFromEvent(eventType: EventType, confidence: number): string {
  if (confidence >= 0.8) {
    if (eventType === "system_override_attempt" || eventType === "jailbreak_roleplay") return "high";
    return "medium";
  }
  if (confidence >= 0.5) return "medium";
  return "low";
}

export function scanResultToPayload(
  result: ScanResult,
  context: {
    service: "yarn" | "planner";
    requestId: string;
    sessionId?: string;
    userId?: string;
    orgId?: string;
    tokenId?: string;
    actionTaken: "allow" | "log" | "reduce" | "block";
    latencyMs?: number;
  },
): SecurityIngestPayload {
  return {
    event_id: `${context.service}-${context.requestId}-${Date.now()}`,
    event_type: result.event_type,
    severity: severityFromEvent(result.event_type, result.confidence),
    confidence: result.confidence,
    confidence_band: confidenceBand(result.confidence),
    action_taken: context.actionTaken,
    scope: "request",
    service: context.service,
    request_id: context.requestId,
    session_id: context.sessionId ?? "",
    user_id: context.userId ?? "",
    token_id: context.tokenId ?? "",
    org_id: context.orgId ?? "",
    patterns_found: result.patterns_found,
    excerpt: result.excerpt.slice(0, 4000),
    scanner_name: "synesis_guardrails_ts",
    latency_ms: context.latencyMs ?? 0,
    detail: {
      tier: result.tier,
      source: result.source,
      patterns_count: result.patterns_found.length,
    },
  };
}

export function policyRejectToPayload(
  reason: string,
  context: {
    service: "yarn" | "planner";
    requestId: string;
    sessionId?: string;
    userId?: string;
    orgId?: string;
  },
): SecurityIngestPayload {
  return {
    event_id: `${context.service}-policy-${context.requestId}-${Date.now()}`,
    event_type: "yarn_policy_reject",
    severity: "medium",
    confidence: 1.0,
    confidence_band: "high",
    action_taken: "block",
    scope: "request",
    service: context.service,
    request_id: context.requestId,
    session_id: context.sessionId ?? "",
    user_id: context.userId ?? "",
    token_id: "",
    org_id: context.orgId ?? "",
    patterns_found: [],
    excerpt: reason.slice(0, 4000),
    scanner_name: "deterministic_policy_engine",
    latency_ms: 0,
    detail: { reason },
  };
}

/**
 * Fire-and-forget POST to the admin security events ingest endpoint.
 * Never blocks the caller; failures are logged and swallowed.
 */
export function emitSecurityEvent(
  payload: SecurityIngestPayload,
  config: SecurityIngestConfig,
  logger?: { warn: (msg: string, ...args: unknown[]) => void },
): void {
  if (!config.adminUrl) return;

  const url = `${config.adminUrl.replace(/\/$/, "")}/api/v1/security/events/ingest`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.adminToken) {
    headers["x-synesis-service-token"] = config.adminToken;
    headers["x-synesis-service-name"] = payload.service;
    headers["authorization"] = `Bearer ${config.adminToken}`;
  }

  void fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutMs ?? 3000),
  }).then((resp) => {
    if (!resp.ok) {
      logger?.warn(
        `security ingest HTTP ${resp.status} for ${payload.event_id}: ${resp.statusText}`,
      );
    }
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`security ingest failed: ${msg}`);
  });
}
