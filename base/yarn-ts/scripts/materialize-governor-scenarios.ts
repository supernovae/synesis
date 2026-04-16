#!/usr/bin/env tsx
/**
 * Materialize candidate EvalScenario stubs from observed session events.
 *
 * Input supports:
 * - { events: [...] } payloads from admin exports
 * - bare event arrays
 *
 * Output:
 * - JSON containing generated EvalScenario stubs suitable for copy/adapt
 *   into src/eval/scenarios/governor-regression.ts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { EvalChatMessage, EvalScenario } from "../src/eval/types.js";

interface SessionEvent {
  event_kind?: string;
  eventKind?: string;
  detail?: string;
  metadata_json?: Record<string, unknown>;
  metadataJson?: Record<string, unknown>;
  created_at?: string;
  createdAt?: string;
  session_key?: string;
  sessionKey?: string;
}

interface MaterializedOutput {
  generated_at: string;
  source_file: string;
  total_input_events: number;
  total_candidate_scenarios: number;
  scenarios: EvalScenario[];
}

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

function sanitizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "governor-session";
}

function toMetadata(event: SessionEvent): Record<string, unknown> {
  return (event.metadata_json ?? event.metadataJson ?? {}) as Record<string, unknown>;
}

function toEventKind(event: SessionEvent): string {
  return String(event.event_kind ?? event.eventKind ?? "").toLowerCase();
}

function toSessionKey(event: SessionEvent): string {
  const md = toMetadata(event);
  const fromMeta = String(md.session_key ?? "");
  return String(event.session_key ?? event.sessionKey ?? fromMeta ?? "");
}

function extractEvents(payload: unknown): SessionEvent[] {
  if (Array.isArray(payload)) return payload as SessionEvent[];
  if (payload && typeof payload === "object") {
    const maybe = payload as { events?: unknown };
    if (Array.isArray(maybe.events)) return maybe.events as SessionEvent[];
  }
  return [];
}

function asMessages(md: Record<string, unknown>): EvalChatMessage[] {
  const candidates = [
    md.input_messages,
    md.messages,
    md.turn_messages,
    md.request_messages,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const messages: EvalChatMessage[] = [];
    for (const row of candidate) {
      if (!row || typeof row !== "object") continue;
      const obj = row as Record<string, unknown>;
      const role = String(obj.role ?? "");
      if (!role) continue;
      messages.push({
        role: (role as EvalChatMessage["role"]),
        content: typeof obj.content === "string" ? obj.content : null,
        tool_call_id: typeof obj.tool_call_id === "string" ? obj.tool_call_id : undefined,
        name: typeof obj.name === "string" ? obj.name : undefined,
        tool_calls: Array.isArray(obj.tool_calls) ? (obj.tool_calls as EvalChatMessage["tool_calls"]) : undefined,
      });
    }
    if (messages.length > 0) return messages;
  }
  return [];
}

function inferToolResults(md: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const direct = md.simulated_tool_results;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    for (const [k, v] of Object.entries(direct)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  const anomalies = md.anomalies;
  if (Array.isArray(anomalies)) {
    for (const item of anomalies) {
      if (!item || typeof item !== "object") continue;
      const detail = String((item as Record<string, unknown>).detail ?? "");
      const m = detail.match(/tool\s+"([^"]+)"/i);
      if (!m) continue;
      const name = m[1];
      if (!out[name]) out[name] = `Synthetic replay result from anomaly: ${detail.slice(0, 180)}`;
    }
  }
  return out;
}

function inferUserMessage(md: Record<string, unknown>, fallbackDetail: string): string {
  const userMsg = md.user_message;
  if (typeof userMsg === "string" && userMsg.trim()) return userMsg.trim();
  const messages = asMessages(md);
  const found = messages.find((m) => m.role === "user" && typeof m.content === "string" && m.content.trim());
  if (found && typeof found.content === "string") return found.content;
  return fallbackDetail || "Replay this prior governor incident and avoid looping.";
}

function inferRule(md: Record<string, unknown>): string | undefined {
  const candidates = [md.governor_rules, md.matched_rules];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const first = candidate.find((v) => typeof v === "string" && v.trim());
    if (typeof first === "string") return first;
  }
  return undefined;
}

function buildScenarioFromSession(sessionKey: string, events: SessionEvent[]): EvalScenario | null {
  const transcript = events.find((e) => toEventKind(e) === "eval_transcript_v1");
  const governorEval = events.find((e) => toEventKind(e) === "execution_governor_evaluated");
  const source = transcript ?? governorEval;
  if (!source) return null;

  const md = {
    ...toMetadata(source),
    ...(governorEval ? toMetadata(governorEval) : {}),
  };
  const userContent = inferUserMessage(md, String(source.detail ?? ""));
  const inferredRule = inferRule(md);
  const simulatedToolResults = inferToolResults(md);
  const sessionSuffix = sanitizeId(sessionKey.split(":").slice(-1).join("-") || sessionKey || "session");
  const scenarioId = `replay-${sessionSuffix}`;

  return {
    id: scenarioId,
    name: `Replay ${sessionSuffix}`,
    category: "governor_regression",
    description: `Auto-materialized from observed session ${sessionKey || "unknown-session"}.`,
    target: {},
    systemPrompt:
      "You are a coding assistant. Use this replay to avoid repeated tool loops and move directly to concrete corrective action.",
    turns: [
      {
        messages: [{ role: "user", content: userContent }],
        simulatedToolResults: Object.keys(simulatedToolResults).length > 0 ? simulatedToolResults : undefined,
        maxToolRounds: 3,
        assertions: [
          { type: "no_repeated_tool" },
          { type: "tool_count_lte", params: { max: 6 } },
        ],
      },
    ],
    scoring: {
      maxTotalTurns: 2,
      ...(inferredRule ? { passIfRules: [inferredRule] } : {}),
    },
  };
}

function groupBySession(events: SessionEvent[]): Map<string, SessionEvent[]> {
  const grouped = new Map<string, SessionEvent[]>();
  for (const ev of events) {
    const key = toSessionKey(ev);
    if (!key) continue;
    const list = grouped.get(key) ?? [];
    list.push(ev);
    grouped.set(key, list);
  }
  return grouped;
}

const inputPath = getArg("input");
if (!inputPath) {
  console.error("ERROR: --input <events.json> is required");
  process.exit(1);
}
const outputPath = getArg("out") ?? "governor-regression-candidates.json";
const limit = Number(getArg("limit") ?? 25);

const raw = readFileSync(inputPath, "utf8");
const parsed = JSON.parse(raw) as unknown;
const events = extractEvents(parsed);
if (events.length === 0) {
  console.error("No events found in input payload");
  process.exit(1);
}

const grouped = groupBySession(events);
const scenarios: EvalScenario[] = [];
for (const [sessionKey, sessionEvents] of grouped.entries()) {
  const scenario = buildScenarioFromSession(sessionKey, sessionEvents);
  if (!scenario) continue;
  scenarios.push(scenario);
  if (scenarios.length >= limit) break;
}

const output: MaterializedOutput = {
  generated_at: new Date().toISOString(),
  source_file: inputPath,
  total_input_events: events.length,
  total_candidate_scenarios: scenarios.length,
  scenarios,
};

writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
console.log(`Materialized ${scenarios.length} scenario candidates -> ${outputPath}`);
