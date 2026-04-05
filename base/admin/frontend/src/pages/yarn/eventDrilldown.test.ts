import { describe, expect, it } from "vitest";
import type { YarnSessionEventRow } from "../../api/hooks";
import { eventKindCount, eventKinds, filterEventsByKinds, trajectoryHighlights } from "./eventDrilldown";

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
    },
    created_at: "2026-04-01T10:00:00Z",
  },
  {
    id: 2,
    event_kind: "runtime_error",
    component: "executor",
    detail: "failed",
    request_id: "rq-1",
    metadata_json: { exit_code: 1 },
    created_at: "2026-04-01T10:00:01Z",
  },
];

describe("event drilldown helpers", () => {
  it("lists and filters event kinds", () => {
    expect(eventKinds(events)).toEqual(["request_trajectory_v1", "runtime_error"]);
    expect(eventKindCount(events, "runtime_error")).toBe(1);
    expect(filterEventsByKinds(events, ["runtime_error"]).map((ev) => ev.id)).toEqual([2]);
    expect(filterEventsByKinds(events, []).map((ev) => ev.id)).toEqual([1, 2]);
  });

  it("extracts trajectory highlights for metadata rendering", () => {
    const highlights = trajectoryHighlights(events[0]);
    expect(highlights).toEqual(
      expect.arrayContaining([
        { label: "Bucket", value: "go_app", tone: "neutral" },
        { label: "Completion gate", value: "blocked", tone: "warn" },
        { label: "Critic", value: "pass", tone: "good" },
        { label: "Parser coverage", value: "62.0%", tone: "good" },
        { label: "Blind retries", value: "1", tone: "warn" },
      ]),
    );
  });
});
