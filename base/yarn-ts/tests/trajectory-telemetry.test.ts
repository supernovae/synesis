import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("pg", () => {
  class MockPool {
    query = vi.fn().mockResolvedValue({ rows: [] });
    end = vi.fn().mockResolvedValue(undefined);
  }
  return { Pool: MockPool };
});

describe("trajectory telemetry metadata", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists completion/critic flags in session event metadata_json", async () => {
    const { UsageWriter } = await import("../src/state/usage-writer.js");
    const writer = new UsageWriter({
      SYNESIS_YARN_ADMIN_DB_URL: "postgres://localhost/test",
      SYNESIS_YARN_PERSIST_USAGE_TO_DB: true,
      SYNESIS_YARN_DB_POOL_MAX: 5,
      SYNESIS_YARN_DB_POOL_IDLE_MS: 10000,
      SYNESIS_YARN_DB_POOL_CONN_TIMEOUT_MS: 1000,
      SYNESIS_YARN_WRITE_QUEUE_MAX: 100,
      SYNESIS_YARN_WRITE_FLUSH_INTERVAL_MS: 999999,
    } as never);

    writer.enqueueSessionEvent({
      sessionKey: "synesis:alice:cursor:conv-telemetry",
      requestId: "req-telemetry-1",
      userId: "alice",
      orgId: "org1",
      eventKind: "request_trajectory_v1",
      component: "yarn",
      detail: "trajectory partial bucket=micro tools=4",
      metadataJson: {
        schema_version: "request_trajectory_v1",
        verification: {
          completion_gate_blocked: true,
          critic_blocked: false,
          structured_error_coverage: 0.5,
        },
      },
    });

    await writer.flush();

    const pool = (writer as unknown as { pool: { query: ReturnType<typeof vi.fn> } }).pool;
    const sql = pool.query.mock.calls[0]?.[0] as string;
    const params = pool.query.mock.calls[0]?.[1] as unknown[];

    expect(sql).toContain("yarn_session_events");
    expect(sql).toContain("metadata_json");
    expect(typeof params[7]).toBe("string");

    const metadata = JSON.parse(String(params[7])) as Record<string, unknown>;
    const verification = metadata.verification as Record<string, unknown>;
    expect(verification.completion_gate_blocked).toBe(true);
    expect(verification.critic_blocked).toBe(false);
    expect(verification.structured_error_coverage).toBe(0.5);

    await writer.close();
  });
});
