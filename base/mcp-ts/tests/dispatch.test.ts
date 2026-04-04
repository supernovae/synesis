import { describe, it, expect, vi, afterEach } from "vitest";
import { dispatchSynesisTool } from "@synesis/mcp-tools";

const deps = {
  plannerBaseUrl: "http://planner.test:8080",
  criticUrl: "http://critic.test/v1",
  criticModel: "synesis-critic",
  internalServiceToken: "svc",
};

const auth = {
  bearerToken: "syn-test",
  userId: "u1",
  orgId: "o1",
  tenantIds: [] as string[],
};

describe("dispatchSynesisTool (shared with Yarn)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls planner /v1/knowledge/search for synesis_search", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [], query: "q", total: 0 }), { status: 200 }),
    );

    await dispatchSynesisTool("synesis_search", { query: "hello" }, auth, deps);

    expect(String(fetchMock.mock.calls[0][0])).toContain("/v1/knowledge/search");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.query).toBe("hello");
    expect(body.caller_org_id).toBe("o1");
  });
});
