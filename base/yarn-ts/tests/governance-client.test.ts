import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GovernanceClient } from "../src/policy/governance-client.js";
import type { AppConfig } from "../src/config.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    PORT: 8000,
    HOST: "0.0.0.0",
    LOG_LEVEL: "info",
    SYNESIS_YARN_ADMIN_API_URL: "http://admin.test:8080",
    SYNESIS_INTERNAL_SERVICE_TOKEN: "test-token",
    SYNESIS_YARN_GOVERNANCE_ENABLED: true,
    SYNESIS_YARN_GOVERNANCE_POLL_INTERVAL_S: 60,
    ...overrides,
  } as AppConfig;
}

describe("GovernanceClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts with null snapshot before first poll", () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new GovernanceClient(makeConfig());
    expect(client.getSnapshot()).toBeNull();
    expect(client.getRules()).toEqual([]);
    client.close();
  });

  it("fetches rules on start and populates snapshot", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        rules: [
          {
            source: "policy",
            policy_id: "p-1",
            scope: "org",
            scope_precedence: 1,
            precedence: 0,
            category: "safety",
            constraint_kind: "guiding",
            rule_type: "threshold",
            rule_config: { max_tool_calls: 20 },
            priority: 10,
          },
        ],
        total: 1,
        etag: "abc123",
      }),
      headers: new Map([["etag", '"abc123"']]),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const client = new GovernanceClient(makeConfig());
    client.start();

    await vi.advanceTimersByTimeAsync(100);

    expect(client.getRules()).toHaveLength(1);
    expect(client.getRules()[0].rule_type).toBe("threshold");
    expect(client.getStats().updates).toBe(1);
    expect(client.getStats().rulesLoaded).toBe(1);
    client.close();
  });

  it("returns undefined for unknown threshold key", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        rules: [
          {
            source: "policy",
            policy_id: "p-1",
            scope: "org",
            scope_precedence: 1,
            precedence: 0,
            category: "safety",
            constraint_kind: "guiding",
            rule_type: "threshold",
            rule_config: { max_tool_calls: 20 },
            priority: 0,
          },
        ],
        total: 1,
        etag: "abc",
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const client = new GovernanceClient(makeConfig());
    client.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(client.getThreshold("threshold", "max_tool_calls")).toBe(20);
    expect(client.getThreshold("threshold", "nonexistent")).toBeUndefined();
    client.close();
  });

  it("returns feature toggle values", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        rules: [
          {
            source: "policy",
            rule_type: "feature_toggle",
            rule_config: { enable_reducers: false, enable_validation: true },
            scope: "org",
            scope_precedence: 1,
            precedence: 0,
            category: "tooling",
            constraint_kind: "advisory",
            priority: 0,
          },
        ],
        total: 1,
        etag: "def",
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const client = new GovernanceClient(makeConfig());
    client.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(client.getFeatureToggle("enable_reducers")).toBe(false);
    expect(client.getFeatureToggle("enable_validation")).toBe(true);
    expect(client.getFeatureToggle("nonexistent")).toBeUndefined();
    client.close();
  });

  it("exposes capability matrix payload from effective endpoint", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        rules: [],
        total: 0,
        etag: "matrix1",
        capability_matrix: {
          version: 1,
          mode: "enforced",
          global_optimizations_enabled: false,
          overrides: [
            {
              id: "row1",
              selector_type: "exact_model",
              selector: "qwen3.6-35b-a3b",
              capabilities: { "yarn.reducers_enabled": true },
            },
          ],
        },
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const client = new GovernanceClient(makeConfig());
    client.start();
    await vi.advanceTimersByTimeAsync(100);

    const matrix = client.getCapabilityMatrix();
    expect(matrix.mode).toBe("enforced");
    expect(matrix.global_optimizations_enabled).toBe(false);
    expect(matrix.overrides?.[0]?.id).toBe("row1");
    client.close();
  });

  it("handles 304 not modified gracefully", async () => {
    const rules = [{
      source: "policy",
      rule_type: "threshold",
      rule_config: { max_tool_calls: 10 },
      scope: "org",
      scope_precedence: 1,
      precedence: 0,
      category: "safety",
      constraint_kind: "hard",
      priority: 0,
    }];
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ rules, total: 1, etag: "v1" }),
        });
      }
      return Promise.resolve({ ok: false, status: 304 });
    }));

    const client = new GovernanceClient(makeConfig({ SYNESIS_YARN_GOVERNANCE_POLL_INTERVAL_S: 1 } as Partial<AppConfig>));
    client.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getStats().updates).toBe(1);

    await vi.advanceTimersByTimeAsync(1100);
    expect(client.getStats().polls).toBe(2);
    expect(client.getStats().updates).toBe(1);
    client.close();
  });

  it("increments errors on fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));

    const client = new GovernanceClient(makeConfig());
    client.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(client.getStats().errors).toBe(1);
    expect(client.getRules()).toEqual([]);
    client.close();
  });

  it("close stops the poll timer", () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new GovernanceClient(makeConfig());
    client.start();
    client.close();
    expect(client.getStats().polls).toBeLessThanOrEqual(1);
  });
});
