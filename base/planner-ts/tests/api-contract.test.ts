import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    ...process.env,
    SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "false",
    ...overrides
  });
}

describe("API contract", () => {
  it("lists Synesis tier model ids", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/v1/models"
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const ids = (body.data ?? []).map((m: { id?: string }) => String(m.id ?? ""));
    expect(ids).toContain("Synesis Auto");
    expect(ids).toContain("Synesis Pulse");
    expect(ids).toContain("Synesis Core");
    expect(ids).toContain("Synesis Horizon");
    await app.close();
  });

  it("normalizes response model id for selected tier", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "synesis horizon",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.model).toBe("Synesis Horizon");
    await app.close();
  });

  it("reports authz engine on health", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "GET",
      url: "/health"
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.auth?.engine).toBe("deterministic");
    expect(body.auth?.policyStats).toBeTruthy();
    expect(body.auth?.openfga).toBeTruthy();
    expect(body.auth?.openfga?.apiUrlConfigured).toBe(false);
    await app.close();
  });

  it("returns authz recent events on dedicated health endpoint", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true"
      })
    );
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer syn-test-token",
        "x-synesis-token-scopes": "coder:readonly"
      },
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    const response = await app.inject({
      method: "GET",
      url: "/health/authz-events"
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.auth?.engine).toBe("deterministic");
    expect(Array.isArray(body.auth?.recentEvents)).toBe(true);
    expect((body.auth?.recentEvents ?? []).length).toBeGreaterThanOrEqual(1);
    expect(body.auth?.recentEvents?.slice(-1)?.[0]?.allow).toBe(false);
    await app.close();
  });

  it("returns OpenAI-like non-stream response", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe("chat.completion");
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices[0]?.message?.role).toBe("assistant");
    expect(body.usage).toBeTruthy();
    expect(typeof body.authz_trace_id).toBe("string");
    expect(body.authz_trace_id.length).toBeGreaterThan(10);
    expect(response.headers["x-synesis-authz-engine"]).toBe("deterministic");
    expect(String(response.headers["x-synesis-authz-rules"] ?? "")).toContain("allow_model_scope");
    const responseTraceId = String(response.headers["x-synesis-authz-trace-id"] ?? "");
    expect(responseTraceId.length).toBeGreaterThan(10);
    expect(body.authz_trace_id).toBe(responseTraceId);
    await app.close();
  });

  it("uses the latest user message for task framing", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_LLM_ENABLED: "false"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis Auto",
        stream: false,
        messages: [
          { role: "user", content: "old prompt should not be reused" },
          { role: "assistant", content: "ack" },
          { role: "user", content: "new follow up prompt should be used" }
        ]
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const content = String(body.choices?.[0]?.message?.content ?? "");
    expect(content).toContain("new follow up prompt should be used");
    expect(content).not.toContain("old prompt should not be reused");
    await app.close();
  });

  it("enforces bearer auth when configured", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error?.type).toBe("authentication_error");
    await app.close();
  });

  it("rejects PAT without model scope", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer syn-test-token",
        "x-synesis-token-scopes": "coder:readonly"
      },
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.error?.message).toContain("required scope");
    expect(response.headers["x-synesis-authz-engine"]).toBe("deterministic");
    expect(String(response.headers["x-synesis-authz-rules"] ?? "")).toContain("deny_missing_model_scope");
    expect(String(response.headers["x-synesis-authz-trace-id"] ?? "").length).toBeGreaterThan(10);
    await app.close();
  });

  it("increments authz policy stats after denied request", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true"
      })
    );
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer syn-test-token",
        "x-synesis-token-scopes": "coder:readonly"
      },
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    const health = await app.inject({
      method: "GET",
      url: "/health"
    });
    expect(health.statusCode).toBe(200);
    const body = health.json();
    expect(Number(body.auth?.policyStats?.evaluations ?? 0)).toBeGreaterThanOrEqual(1);
    expect(Number(body.auth?.policyStats?.rejectedCount ?? 0)).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.auth?.policyStats?.recentEvents)).toBe(true);
    const lastEvent = body.auth?.policyStats?.recentEvents?.slice(-1)?.[0];
    expect(lastEvent?.allow).toBe(false);
    expect(String(lastEvent?.traceId ?? "").length).toBeGreaterThan(10);
    await app.close();
  });

  it("rejects untrusted forwarded identity headers in strict mode", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: "true",
        SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE: "true",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "internal-service-token"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer someone-else",
        "x-openwebui-user-id": "spoofed-user"
      },
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("allows trusted forwarded identity service token", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: "true",
        SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE: "true",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "internal-service-token"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer internal-service-token",
        "x-openwebui-user-id": "trusted-user",
        "x-synesis-token-scopes": "model:readonly"
      },
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("records trusted forwarded identity in authz event lineage", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_TRUST_FORWARDED_IDENTITY_HEADERS: "true",
        SYNESIS_PLANNER_TS_STRICT_FORWARDED_IDENTITY_MODE: "true",
        SYNESIS_PLANNER_TS_INTERNAL_SERVICE_TOKEN: "internal-service-token"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer internal-service-token",
        "x-openwebui-user-id": "trusted-user",
        "x-synesis-token-scopes": "model:readonly"
      },
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "lineage check" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const traceId = String(response.headers["x-synesis-authz-trace-id"] ?? "");
    expect(traceId.length).toBeGreaterThan(10);
    expect(body.authz_trace_id).toBe(traceId);

    const eventsResponse = await app.inject({
      method: "GET",
      url: "/health/authz-events"
    });
    expect(eventsResponse.statusCode).toBe(200);
    const eventsBody = eventsResponse.json();
    const matching = (eventsBody.auth?.recentEvents ?? []).find(
      (event: Record<string, unknown>) => String(event.traceId ?? "") === traceId
    );
    expect(matching).toBeTruthy();
    expect(matching?.allow).toBe(true);
    expect(String(matching?.userId ?? "")).toBe("trusted-user");
    await app.close();
  });

  it("returns 403 when openfga stub engine is selected", async () => {
    const app = buildApp(
      makeConfig({
        SYNESIS_PLANNER_TS_REQUIRE_BEARER_AUTH: "true",
        SYNESIS_PLANNER_TS_AUTHZ_ENGINE: "openfga_stub"
      })
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer syn-test-token",
        "x-synesis-token-scopes": "model:readonly"
      },
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: false
      }
    });
    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.error?.message).toContain("not configured yet");
    await app.close();
  });

  it("emits SSE status and completion chunks", async () => {
    const app = buildApp(makeConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "Synesis",
        messages: [{ role: "user", content: "hello planner" }],
        stream: true
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const payload = response.body;
    expect(payload).toContain('"event"');
    expect(payload).toContain('"authz_trace_id"');
    expect(payload).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(payload).toContain('"chat.completion.chunk"');
    expect(payload).toContain("[DONE]");
    await app.close();
  });
});
