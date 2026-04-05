import type { YarnSessionEventRow } from "../../api/hooks";

export interface TrajectoryHighlight {
  label: string;
  value: string;
  tone?: "good" | "warn" | "neutral";
}

export type EventDiagnosticPreset = "vercel_sdk_errors" | "missing_tool_results";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(record: Record<string, unknown> | null | undefined, key: string): boolean | null {
  if (!record) return null;
  const v = record[key];
  if (typeof v === "boolean") return v;
  return null;
}

function readNumber(record: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!record) return null;
  const v = record[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!record) return null;
  const v = record[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

export function eventKinds(events: YarnSessionEventRow[]): string[] {
  return Array.from(new Set(events.map((ev) => ev.event_kind))).sort();
}

export function eventKindCount(events: YarnSessionEventRow[], kind: string): number {
  return events.filter((ev) => ev.event_kind === kind).length;
}

export function filterEventsByKinds(events: YarnSessionEventRow[], selectedKinds: string[]): YarnSessionEventRow[] {
  if (selectedKinds.length === 0) return events;
  return events.filter((ev) => selectedKinds.includes(ev.event_kind));
}

function hasTruthyFlag(record: Record<string, unknown> | null | undefined, key: string): boolean {
  if (!record) return false;
  const value = record[key];
  return value === true || value === "true" || value === 1 || value === "1";
}

function hasVercelSdkErrorFlag(ev: YarnSessionEventRow): boolean {
  if (!isRecord(ev.metadata_json)) return false;
  return hasTruthyFlag(ev.metadata_json, "vercel_ai_sdk_error");
}

function hasMissingToolResultsFlag(ev: YarnSessionEventRow): boolean {
  if (!isRecord(ev.metadata_json)) return false;
  return hasTruthyFlag(ev.metadata_json, "missing_tool_results");
}

export function filterEventsByDiagnosticPreset(
  events: YarnSessionEventRow[],
  preset: EventDiagnosticPreset | null,
): YarnSessionEventRow[] {
  if (!preset) return events;
  if (preset === "vercel_sdk_errors") return events.filter((ev) => hasVercelSdkErrorFlag(ev));
  return events.filter((ev) => hasMissingToolResultsFlag(ev));
}

export function diagnosticPresetCount(events: YarnSessionEventRow[], preset: EventDiagnosticPreset): number {
  return filterEventsByDiagnosticPreset(events, preset).length;
}

export function trajectoryHighlights(ev: YarnSessionEventRow): TrajectoryHighlight[] {
  if (ev.event_kind !== "request_trajectory_v1" || !isRecord(ev.metadata_json)) return [];
  const out: TrajectoryHighlight[] = [];
  const taskBucket = readString(ev.metadata_json, "task_bucket");
  if (taskBucket) out.push({ label: "Bucket", value: taskBucket, tone: "neutral" });
  const verification = isRecord(ev.metadata_json.verification) ? ev.metadata_json.verification : null;
  const tools = isRecord(ev.metadata_json.tools) ? ev.metadata_json.tools : null;
  const completionBlocked = readBoolean(verification, "completion_gate_blocked");
  if (completionBlocked !== null) {
    out.push({
      label: "Completion gate",
      value: completionBlocked ? "blocked" : "pass",
      tone: completionBlocked ? "warn" : "good",
    });
  }
  const criticBlocked = readBoolean(verification, "critic_blocked");
  if (criticBlocked !== null) {
    out.push({
      label: "Critic",
      value: criticBlocked ? "blocked" : "pass",
      tone: criticBlocked ? "warn" : "good",
    });
  }
  const firstPass = readBoolean(verification, "first_pass_verify_ok");
  if (firstPass !== null) {
    out.push({
      label: "First-pass verify",
      value: firstPass ? "ok" : "no",
      tone: firstPass ? "good" : "warn",
    });
  }
  const stalled = readBoolean(verification, "stalled");
  if (stalled !== null) {
    out.push({
      label: "Verification",
      value: stalled ? "stalled" : "active",
      tone: stalled ? "warn" : "neutral",
    });
  }
  const parserCoverage = readNumber(verification, "structured_error_coverage");
  if (parserCoverage !== null) {
    out.push({
      label: "Parser coverage",
      value: `${(parserCoverage * 100).toFixed(1)}%`,
      tone: parserCoverage >= 0.5 ? "good" : "warn",
    });
  }
  const blindRetryCount = readNumber(tools, "blind_retry_count");
  if (blindRetryCount !== null) {
    out.push({
      label: "Blind retries",
      value: String(blindRetryCount),
      tone: blindRetryCount > 0 ? "warn" : "good",
    });
  }
  return out;
}
