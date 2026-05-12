import { describe, expect, it } from "vitest";
import type { YarnSessionEventRow } from "../../api/hooks";
import {
  diagnosticPresetCount,
  eventKindCount,
  eventKinds,
  filterEventsByDiagnosticPreset,
  filterEventsByKinds,
  trajectoryHighlights,
} from "./eventDrilldown";

const events: YarnSessionEventRow[] = [
  {
    id: 1,
    event_kind: "request_trajectory_v1",
    component: "planner",
    detail: "trajectory",
    request_id: "rq-1",
    metadata_json: {
      task_bucket: "go_app",
      verification: {
        completion_gate_blocked: true,
        critic_blocked: false,
        first_pass_verify_ok: false,
        stalled: false,
        structured_error_coverage: 0.62,
      },
      tools: {
        blind_retry_count: 1,
      },
      training_signals: {
        state_transition_quality_label: "regressed",
        state_transition_quality_score: -0.12,
        state_transition_quality_global_scope: "model",
        state_transition_quality_calibration_samples: 18,
      },
    },
    created_at: "2026-04-01T10:00:00Z",
  },
  {
    id: 2,
    event_kind: "runtime_error",
    component: "executor",
    detail: "failed",
    request_id: "rq-1",
    metadata_json: { exit_code: 1, vercel_ai_sdk_error: true },
    created_at: "2026-04-01T10:00:01Z",
  },
  {
    id: 3,
    event_kind: "stream_error",
    component: "streamText",
    detail: "tool mismatch",
    request_id: "rq-1",
    metadata_json: { missing_tool_results: true, vercel_ai_sdk_error: true },
    created_at: "2026-04-01T10:00:01Z",
  },
  {
    id: 4,
    event_kind: "client_tool_error_observed",
    component: "tool-result-monitor",
    detail: "tool=Edit reason=edit_context_miss String to replace not found in file",
    request_id: "rq-2",
    metadata_json: { reason: "edit_context_miss", toolName: "Edit", filePath: "cmd/synesis/ask.go" },
    created_at: "2026-04-01T10:00:02Z",
  },
  {
    id: 5,
    event_kind: "state_transition_quality_global_calibration_v1",
    component: "state-ledger",
    detail: "global quality calibration scope=model samples=24",
    request_id: "rq-3",
    metadata_json: { resolution: { selected_scope: "model" } },
    created_at: "2026-04-01T10:00:03Z",
  },
];

describe("event drilldown helpers", () => {
  it("lists and filters event kinds", () => {
    expect(eventKinds(events)).toEqual([
      "client_tool_error_observed",
      "request_trajectory_v1",
      "runtime_error",
      "state_transition_quality_global_calibration_v1",
      "stream_error",
    ]);
    expect(eventKindCount(events, "runtime_error")).toBe(1);
    expect(filterEventsByKinds(events, ["runtime_error"]).map((ev) => ev.id)).toEqual([2]);
    expect(filterEventsByKinds(events, []).map((ev) => ev.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("extracts trajectory highlights for metadata rendering", () => {
    const firstEvent = events[0];
    expect(firstEvent).toBeDefined();
    const highlights = trajectoryHighlights(firstEvent!);
    expect(highlights).toEqual(
      expect.arrayContaining([
        { label: "Bucket", value: "go_app", tone: "neutral" },
        { label: "Completion gate", value: "blocked", tone: "warn" },
        { label: "Critic", value: "pass", tone: "good" },
        { label: "Parser coverage", value: "62.0%", tone: "good" },
        { label: "Blind retries", value: "1", tone: "warn" },
        { label: "Transition", value: "regressed", tone: "warn" },
        { label: "Quality score", value: "-0.120", tone: "warn" },
        { label: "Global scope", value: "model", tone: "neutral" },
        { label: "Calibration samples", value: "18", tone: "good" },
      ]),
    );
  });

  it("filters event diagnostics presets for Vercel SDK and missing tool results", () => {
    expect(filterEventsByDiagnosticPreset(events, "vercel_sdk_errors").map((ev) => ev.id)).toEqual([2, 3]);
    expect(filterEventsByDiagnosticPreset(events, "missing_tool_results").map((ev) => ev.id)).toEqual([3]);
    expect(filterEventsByDiagnosticPreset(events, "edit_context_miss").map((ev) => ev.id)).toEqual([4]);
    expect(filterEventsByDiagnosticPreset(events, "transition_quality_risk").map((ev) => ev.id)).toEqual([1, 5]);
    expect(diagnosticPresetCount(events, "vercel_sdk_errors")).toBe(2);
    expect(diagnosticPresetCount(events, "missing_tool_results")).toBe(1);
    expect(diagnosticPresetCount(events, "edit_context_miss")).toBe(1);
    expect(diagnosticPresetCount(events, "transition_quality_risk")).toBe(2);
  });
});
